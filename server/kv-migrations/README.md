# KV migrations

Applied by `scripts/kv-migrate.mjs`, which `deploy-server.yml` runs **after**
`wrangler deploy` on every push to `main`. Like the D1 migrations, merging a
file here is all it takes to ship it — there is no manual step.

## The two mechanisms

Most of what you would reach for a migration for in a database, you do not need
here, because **nothing in this namespace is a source of truth**. Every value is
a read-through cache of something D1 or Cloudflare Access already holds (see
`src/kv/cache.ts`), so an empty namespace is a cold one, not a broken one.

That leaves two real jobs, and the runner does them in this order:

### 1. Numbered migrations, run once each

`NNNN_description.mjs`, applied in filename order, each recorded under
`__kv_migration:<id>` so later deploys skip it. Use one for a genuine one-off:

```js
export async function up({ kv, version, log }) {
  // kv.list(prefix) -> string[]      kv.get(key) -> string | null
  // kv.put(key, value, { ttl })      kv.delete(key)
  // kv.deletePrefix(prefix) -> number
}
```

The marker is only written once `up` resolves, so a migration that throws
halfway is retried on the next deploy. **Write them to be safe to re-run** —
that is a requirement, not a style preference.

### 2. The version sweep, run every time

`src/kv/keys.ts` puts every cache key behind `KV_SCHEMA_VERSION`. To change the
*shape* of a stored value you bump that constant: the deployed Worker simply
stops reading the old keys, at the instant it goes live, with no window in
which new code could deserialize a value written by old code. The sweep then
deletes every `v<older>:` key that is left over.

So the ongoing workflow for a shape change is:

1. Change the type, and bump `KV_SCHEMA_VERSION` in `src/kv/keys.ts`.
2. Merge. The deploy ships the new Worker, then the sweep clears the old keys.

No migration file is involved — the sweep is not ledgered precisely so that it
runs again after the *next* bump.

## Why after the deploy, not before

The D1 migrations run before `wrangler deploy` because the new code may depend
on the new schema. The opposite holds here: a cache migration can never be a
precondition for correctness, and the sweep specifically *must* run afterwards,
since until the upload lands the "abandoned" keys are still the ones the live
Worker is reading.

If a migration here ever genuinely needed to run first, that would mean
something in KV had become a source of truth — which is the one thing this
namespace is not for.

## Running it by hand

```bash
npm run kv:migrate -w server            # miniflare's local KV
npm run kv:migrate:remote -w server     # the real namespace
npm run kv:status -w server             # what a remote run would do
```

`--remote` needs `CLOUDFLARE_API_TOKEN` (with **Workers KV Storage:Edit**) and
`CLOUDFLARE_ACCOUNT_ID` in the environment.
