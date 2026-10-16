#!/usr/bin/env node
/**
 * KV migration runner.
 *
 * KV has no `wrangler kv migrations apply` the way D1 does, and it has no
 * schema to migrate in the first place — so this is not a port of the D1
 * runner, it is the two things a schemaless namespace actually needs:
 *
 * 1. **Ledgered migrations** (`kv-migrations/NNNN_*.mjs`), run once each, in
 *    filename order, with a marker written under `__kv_migration:<id>` so the
 *    next deploy skips them. This is where a one-off goes: seeding a key,
 *    renaming a prefix, backfilling a value the code now expects to find.
 * 2. **The version sweep**, run on *every* invocation and never ledgered,
 *    which deletes every key belonging to a `KV_SCHEMA_VERSION` older than the
 *    one `src/kv/keys.ts` currently declares. Changing the shape of a cached
 *    value is handled by bumping that constant — the new Worker simply stops
 *    reading the old keys — and this is what stops the abandoned ones sitting
 *    in the namespace forever. It is idempotent by construction, so it does
 *    not want a ledger entry: the whole point is that it runs again after the
 *    *next* bump, with no new file to remember to write.
 *
 * Run it AFTER `wrangler deploy`, which is what `deploy-server.yml` does.
 * Nothing in this namespace is a source of truth — every value is derived from
 * D1 or from Cloudflare Access — so a migration can never be a precondition
 * for new code to be correct, only a tidy-up after it. The sweep in particular
 * has to run after: before the upload, the "abandoned" keys are still the ones
 * the live Worker is reading from.
 *
 *   node scripts/kv-migrate.mjs --local     # miniflare's local KV
 *   node scripts/kv-migrate.mjs --remote    # the real namespace
 *   node scripts/kv-migrate.mjs --remote --dry-run
 *
 * `--remote` needs CLOUDFLARE_API_TOKEN (with Workers KV Storage:Edit) and
 * CLOUDFLARE_ACCOUNT_ID in the environment, same as every other wrangler call
 * in the deploy workflow.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(SERVER_DIR, "kv-migrations");
const KEYS_FILE = path.join(SERVER_DIR, "src", "kv", "keys.ts");

/** Must match `MIGRATION_KEY_PREFIX` in src/kv/keys.ts. */
const LEDGER_PREFIX = "__kv_migration:";
/** The binding name in wrangler.toml. Every wrangler call resolves the
 *  namespace id through it, so the id lives in exactly one place. */
const BINDING = "CACHE";

// ── argv ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const remote = argv.includes("--remote");
const local = argv.includes("--local");

if (remote === local) {
  console.error("Pass exactly one of --remote or --local.");
  process.exit(2);
}

const TARGET_FLAG = remote ? "--remote" : "--local";

// ── wrangler ─────────────────────────────────────────────────────────────────

function wranglerBin() {
  for (const candidate of [
    path.join(SERVER_DIR, "node_modules", ".bin", "wrangler"),
    path.join(SERVER_DIR, "..", "node_modules", ".bin", "wrangler"),
  ]) {
    if (existsSync(candidate)) return { command: candidate, prefix: [] };
  }
  // Workspaces hoist wrangler to the repo root, so the loop above almost
  // always wins; npx is the fallback for a checkout that installed differently.
  return { command: "npx", prefix: ["wrangler"] };
}

const WRANGLER = wranglerBin();

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync(WRANGLER.command, [...WRANGLER.prefix, ...args], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(`wrangler ${args.join(" ")} failed (exit ${result.status})\n${detail}`);
  }
  return result.stdout ?? "";
}

/**
 * Pull the JSON payload out of a wrangler invocation's stdout.
 *
 * wrangler writes advisory banners (update notices, "Proxy environment
 * variables detected") alongside the payload, so the JSON has to be found
 * rather than parsed from the first byte. It is found by line — scanning for
 * the first `[` or `{` character would happily match the `[` inside an ANSI
 * colour escape and parse nothing.
 *
 * A miss throws instead of returning an empty list, which is the important
 * part: "wrangler said something I could not read" and "the namespace is
 * empty" lead to very different places, and quietly reporting the second would
 * make the sweep think there is nothing to clean up and the ledger think no
 * migration has ever run.
 */
function parseJsonOutput(stdout, what) {
  const clean = (stdout ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));

  if (start !== -1) {
    try {
      return JSON.parse(lines.slice(start).join("\n"));
    } catch {
      // fall through to the throw below
    }
  }
  throw new Error(`Could not read ${what} from wrangler's output:\n${clean.trim()}`);
}

// ── the handle migrations are handed ─────────────────────────────────────────

const kv = {
  /** Key names under `prefix`, oldest-listing-order, as a flat array. */
  list(prefix = "") {
    const args = ["kv", "key", "list", "--binding", BINDING, TARGET_FLAG];
    if (prefix) args.push("--prefix", prefix);
    const parsed = parseJsonOutput(wrangler(args), `the key list for "${prefix || "*"}"`);
    return Array.isArray(parsed) ? parsed.map((entry) => entry.name) : [];
  },

  /** One value as a string, or `null` when the key is absent. */
  get(key) {
    const out = wrangler(["kv", "key", "get", key, "--binding", BINDING, TARGET_FLAG], {
      allowFailure: true,
    });
    return out === null ? null : out;
  },

  put(key, value, { ttl } = {}) {
    const args = ["kv", "key", "put", key, value, "--binding", BINDING, TARGET_FLAG];
    if (ttl) args.push("--ttl", String(ttl));
    wrangler(args);
  },

  delete(key) {
    wrangler(["kv", "key", "delete", key, "--binding", BINDING, TARGET_FLAG]);
  },

  /**
   * Delete every key under `prefix`, in one bulk call rather than one process
   * spawn per key. Returns how many were removed.
   */
  deletePrefix(prefix) {
    const keys = kv.list(prefix);
    if (keys.length === 0) return 0;

    const dir = mkdtempSync(path.join(tmpdir(), "kv-migrate-"));
    const file = path.join(dir, "keys.json");
    try {
      writeFileSync(file, JSON.stringify(keys));
      wrangler(["kv", "bulk", "delete", file, "--binding", BINDING, TARGET_FLAG, "--force"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return keys.length;
  },
};

// ── schema version ───────────────────────────────────────────────────────────

/**
 * The version `src/kv/keys.ts` declares, read out of the source rather than
 * imported from it.
 *
 * Importing would mean this script could only run on a Node new enough to strip
 * TypeScript types from a `.ts` file it is handed; a five-line read keeps the
 * runner working on whatever Node a contributor happens to have, and there is
 * exactly one declaration to find.
 */
function currentSchemaVersion() {
  const source = readFileSync(KEYS_FILE, "utf8");
  const match = source.match(/export const KV_SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!match) {
    throw new Error(`Could not find KV_SCHEMA_VERSION in ${KEYS_FILE}`);
  }
  return Number(match[1]);
}

/**
 * Delete every `v<N>:` key where N is not the current version.
 *
 * Deliberately not ledgered: it has to run again after the next bump, and it
 * costs one `list` when there is nothing to do.
 */
function sweepAbandonedVersions(version) {
  const live = `v${version}:`;
  const keys = kv.list("v");
  const abandoned = keys.filter((name) => /^v\d+:/.test(name) && !name.startsWith(live));

  if (abandoned.length === 0) {
    console.log(`Sweep: nothing to remove — every versioned key is already ${live}*`);
    return;
  }

  const prefixes = [...new Set(abandoned.map((name) => name.slice(0, name.indexOf(":") + 1)))];
  if (dryRun) {
    console.log(`Sweep (dry run): would remove ${abandoned.length} key(s) under ${prefixes.join(", ")}`);
    return;
  }

  for (const prefix of prefixes) {
    const removed = kv.deletePrefix(prefix);
    console.log(`Sweep: removed ${removed} key(s) under ${prefix}`);
  }
}

// ── migrations ───────────────────────────────────────────────────────────────

function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

async function run() {
  const version = currentSchemaVersion();
  console.log(`KV migrations — binding ${BINDING}, ${TARGET_FLAG.slice(2)}, schema v${version}`);

  const applied = new Set(
    kv.list(LEDGER_PREFIX).map((name) => name.slice(LEDGER_PREFIX.length)),
  );

  const files = migrationFiles();
  const pending = files.filter((name) => !applied.has(name.replace(/\.mjs$/, "")));

  if (pending.length === 0) {
    console.log(`No pending migrations (${files.length} already applied).`);
  }

  for (const file of pending) {
    const id = file.replace(/\.mjs$/, "");
    if (dryRun) {
      console.log(`Pending (dry run): ${id}`);
      continue;
    }

    const module = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
    if (typeof module.up !== "function") {
      throw new Error(`${file} does not export an \`up\` function`);
    }

    console.log(`Applying ${id}...`);
    await module.up({ kv, version, log: (message) => console.log(`  ${message}`) });

    // Written only after `up` resolves, so a migration that threw halfway is
    // retried on the next deploy rather than being recorded as done. That
    // makes "migrations must be idempotent" a real requirement here, not a
    // nicety — see kv-migrations/README.md.
    kv.put(`${LEDGER_PREFIX}${id}`, JSON.stringify({ applied_at: new Date().toISOString() }));
    console.log(`Applied ${id}`);
  }

  sweepAbandonedVersions(version);
  console.log("KV migrations complete.");
}

run().catch((error) => {
  const message = error?.message ?? String(error);
  console.error(`\nKV migration failed: ${message}`);

  // Two failures are common enough, and unhelpful enough on their own, to be
  // worth naming. Credentials are checked first: every wrangler call here
  // carries `--binding`, so a token problem would otherwise match a
  // namespace-shaped hint and send someone off creating a namespace they
  // already have.
  if (/CLOUDFLARE_API_TOKEN|not authori[sz]ed|authentication|\[code: 10000\]/i.test(message)) {
    console.error(
      [
        "",
        "wrangler could not authenticate. --remote needs both of these in the",
        "environment, and the token needs the Workers KV Storage:Edit permission:",
        "",
        "  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
        "",
      ].join("\n"),
    );
  } else if (/namespace.*(not found|does not exist)|10041|10013/i.test(message)) {
    console.error(
      [
        "",
        `The "${BINDING}" namespace in wrangler.toml does not exist on this account.`,
        "Create it and put the id it prints into the [[kv_namespaces]] block:",
        "",
        "  npx wrangler kv namespace create task-tracker-cache",
        "",
      ].join("\n"),
    );
  }
  process.exit(1);
});
