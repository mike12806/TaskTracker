/**
 * How long each cached value is allowed to be wrong for.
 *
 * Every one of these is a *backstop*, not the mechanism: each value is dropped
 * explicitly by whatever writes it, and the TTL bounds the damage when that
 * invalidation is missed.
 */

/**
 * Cloudflare Access's signing keys.
 *
 * A *new* key is picked up in a single request — `signingKeyFor` re-fetches on
 * an unknown `kid` — so rotation never waits on this. What it alone bounds is
 * how long a key Cloudflare has **withdrawn** goes on being trusted. Five
 * minutes, because that is a security window rather than a freshness one.
 */
export const JWKS_TTL_SECONDS = 300;

/** The user's `users` row. The JWT name is compared on every request anyway. */
export const USER_TTL_SECONDS = 300;

/**
 * The daily briefing. Written once a day by the cron (twice, counting the
 * template the AI version replaces); both writers drop the key.
 */
export const BRIEFING_TTL_SECONDS = 3600;
