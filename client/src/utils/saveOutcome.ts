/**
 * What to say after a save that didn't reach the server.
 *
 * One sentence, shared by every form, and worded to answer the question the
 * user is actually asking: not "did the request succeed" — they don't care —
 * but "is what I typed safe, and do I need to do anything?". "Saved" answers
 * the first, "will sync" answers the second, and naming the device is what
 * stops it being read as "the other phone has this now", which it doesn't.
 *
 * Shown as a warning rather than a success: the entry is safe, but the day is
 * not over until it lands, and a green tick would say otherwise.
 */
export const QUEUED_SAVE_MESSAGE =
  "Saved on this device — it'll sync when the server is back.";

/** The same for an entry the user will look for on someone else's screen. */
export const QUEUED_SAVE_SEVERITY = "warning" as const;
