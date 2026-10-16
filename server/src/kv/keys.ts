/**
 * Every key this Worker reads or writes in KV, built in one place.
 *
 * Two rules hold for all of them:
 *
 * 1. **Every key is namespaced by `KV_SCHEMA_VERSION`.** KV has no schema, so
 *    the only way to change the *shape* of a stored value is to stop reading
 *    the old one. Bumping the version does that for the whole namespace at the
 *    instant the new Worker goes live; the stranded keys are swept afterwards
 *    by `scripts/kv-migrate.mjs`.
 * 2. **Nothing here is a source of truth.** Every value is derived from D1 (or,
 *    for the JWKS, from Cloudflare Access) and can be thrown away at any moment.
 */

/**
 * Bump this when the *shape* of anything stored under these keys changes. Do
 * not bump it to expire stale data — that is what TTLs are for.
 */
export const KV_SCHEMA_VERSION = 1;

/** Prefix every cache key carries, e.g. `v1:`. */
export const KV_PREFIX = `v${KV_SCHEMA_VERSION}:`;

/**
 * The migration ledger's prefix, deliberately *outside* `KV_PREFIX`: a schema
 * bump that abandoned it would re-run every migration ever written.
 */
export const MIGRATION_KEY_PREFIX = "__kv_migration:";

/** Metadata about the namespace itself, written by the initial migration. */
export const META_KEY = "__kv_meta";

/** Cloudflare Access's JWT signing keys. */
export function jwksKey(): string {
  return `${KV_PREFIX}access-jwks`;
}

/**
 * One user's resolved `users` row, keyed by the email in their Access JWT —
 * verbatim, because `users.email` is a case-sensitive column.
 */
export function userKey(email: string): string {
  return `${KV_PREFIX}user:${email}`;
}

/** One user's newest daily briefing, whatever date it carries. */
export function briefingKey(userId: number): string {
  return `${KV_PREFIX}briefing:${userId}`;
}
