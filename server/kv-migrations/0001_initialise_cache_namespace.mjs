/**
 * 0001 — establish the cache namespace.
 *
 * There is deliberately nothing to backfill. Every value the Worker keeps in
 * KV is a read-through cache of something D1 (or Cloudflare Access) already
 * holds, so a namespace that starts out completely empty is not a broken
 * namespace — it is a cold one, and it warms up on the first request that
 * misses. Pre-populating it would mean this script had to know how to build
 * every cached value, which is exactly the duplication the read-through
 * pattern exists to avoid.
 *
 * What it does write is a description of the namespace, under a key the Worker
 * never reads. It costs nothing and it answers the question someone will
 * eventually have while staring at an unfamiliar namespace in the dashboard:
 * what is this, who writes it, and is anything in here load-bearing.
 */

export async function up({ kv, version, log }) {
  const meta = {
    app: "task-tracker",
    purpose:
      "Read-through cache in front of D1 and the Cloudflare Access JWKS. Nothing here is a source of truth — the namespace can be emptied at any time and will rebuild itself.",
    binding: "CACHE",
    initialised_at: new Date().toISOString(),
    schema_version: version,
  };

  kv.put("__kv_meta", JSON.stringify(meta, null, 2));
  log(`wrote __kv_meta (schema v${version})`);
}
