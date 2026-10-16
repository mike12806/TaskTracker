/**
 * A failed request, carrying the status that explains *why* it failed.
 *
 * Every rejection from `client.ts` is one of these. The message is unchanged
 * from what callers already show the user; the status is for code that has to
 * tell the failures apart rather than just report them — the offline outbox
 * (`outbox.ts`) is the whole reason it exists. "The connection dropped" is
 * worth holding the write and retrying; "the server rejected this payload" is
 * not, and retrying it forever would bury a real problem under a queue that
 * never drains.
 *
 * `status` is absent when the request never got an answer at all — a dropped
 * connection or the deadline in `REQUEST_TIMEOUT_MS` — which is exactly the
 * case that should be retried.
 *
 * Its own module rather than a second export from `client.ts` because it is a
 * type, not behaviour: tests routinely replace the whole fetch wrapper with a
 * stub, and a class reached through that stub is `undefined` — which turns
 * every `instanceof` check downstream into a TypeError at the exact moment a
 * request has already gone wrong. Nothing here is worth mocking, so nothing
 * here should be mockable.
 */
export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
