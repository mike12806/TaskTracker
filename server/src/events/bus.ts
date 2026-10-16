import type { Env } from "../types/env.js";
import type { DomainEvent } from "./types.js";
import { SUBSCRIBERS } from "./subscribers.js";

/**
 * The domain event bus: one queue, one dispatching consumer.
 *
 * `emit` puts the event on `task-tracker-events` and returns. It never throws
 * and never blocks the response on a subscriber: everything on this bus is
 * work the write path has declared non-critical — a reminder left on the bell
 * a few seconds after its task was completed is a stale bell, not a lost task.
 *
 * One queue rather than one per subscriber, because Queues gives one consumer
 * per queue. The cost is a shared retry fate — when one subscriber fails the
 * message is retried and every subscriber on it runs again — which is why
 * every subscriber must be idempotent.
 *
 * The live nudge is deliberately *not* on the bus: `announceChange` stays
 * inline because a queue hop is latency and the nudge is the one piece whose
 * job is to feel instant.
 *
 * `EVENTS` is optional, and without it `emit` dispatches inline — so tests and
 * local dev see subscribers run before the response, in order.
 */

/** The queue name, as declared in `wrangler.toml`. */
export const EVENTS_QUEUE = "task-tracker-events";

/**
 * Publish one event.
 *
 * Swallows its own failures. A queue send that fails means a subscriber does
 * not run, and every subscriber on this bus is doing work the write path
 * already declared must not be able to fail the save — so raising here would
 * turn a stale bell into a failed save, which is strictly the worse outcome.
 *
 * Pass `waitUntil` from anything serving a request. The send is not awaited
 * then, so publishing costs the response nothing at all; without it the send
 * is awaited, which is correct but puts a queue round trip back on the path.
 */
export async function emit(
  env: Env,
  event: DomainEvent,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (!env.EVENTS) {
    // No queue bound — tests, local dev. Run the subscribers here and now, so
    // behaviour matches what the inline calls did before the bus.
    await dispatch(env, event);
    return;
  }

  const send = env.EVENTS.send(event).catch((error) => {
    console.error(`Event publish failed for ${event.type}:`, error);
  });
  if (waitUntil) waitUntil(send);
  else await send;
}

/**
 * Run every subscriber that cares about this event.
 *
 * Each one is isolated, so a subscriber that throws cannot stop the others
 * from running — a failure should cost its own reaction and no one else's.
 * Once they have all had their turn, a failure is rethrown so the consumer
 * retries the message; with subscribers required to be idempotent, the ones
 * that already succeeded simply do nothing the second time.
 */
export async function dispatch(env: Env, event: DomainEvent): Promise<void> {
  const interested = SUBSCRIBERS.filter((subscriber) => subscriber.handles(event));
  const failures: string[] = [];

  for (const subscriber of interested) {
    try {
      await subscriber.handle(env, event);
    } catch (error) {
      failures.push(
        `${subscriber.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`Subscriber "${subscriber.name}" failed on ${event.type}:`, error);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} subscriber(s) failed: ${failures.join("; ")}`);
  }
}
