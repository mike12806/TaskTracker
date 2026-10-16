import { useCallback, useRef, useState } from "react";

/**
 * Stops one save from being logged twice.
 *
 * Two things could duplicate an entry, and this covers both:
 *
 *   - A second tap. The Save button stayed live while the first request was in
 *     flight, and on a phone with a slow connection tapping again is the
 *     obvious thing to do when nothing appears to happen. Two taps, two POSTs,
 *     two feeds in the log.
 *
 *   - A retry after a save that looked like it failed. A request that fails on
 *     the way *back* has already been applied, so the app has never been able
 *     to offer a retry: it might duplicate the entry instead of recovering it.
 *
 * The in-flight lock handles the first. The key handles the second: it goes
 * with the request, the server records it against the row it creates, and a
 * second request carrying the same key is answered with that same row rather
 * than making another one.
 *
 * The key deliberately covers the *content* as well as the attempt. Retrying an
 * unchanged form is the same save and must deduplicate; editing the form first
 * makes it a different save, which must be allowed through — otherwise a
 * correction typed after an error would be silently answered with the original
 * entry.
 */

function newAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * djb2. Not a checksum against tampering — just enough to tell "they pressed
 * Save again" apart from "they changed something and pressed Save".
 */
function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload) ?? "";
  let hash = 5381;
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export interface SaveGuard {
  /** True while a save is in flight — drive the Save button's disabled state. */
  saving: boolean;
  /**
   * Run a save, at most one at a time.
   *
   * `submit` receives the idempotency key to send with a create. Errors
   * propagate, so callers keep their own `try`/`catch` and their own toast.
   */
  save: (payload: unknown, submit: (idempotencyKey: string) => Promise<void>) => Promise<void>;
}

export function useSaveGuard(): SaveGuard {
  const [saving, setSaving] = useState(false);
  // A ref, not the state above: two taps in the same frame both read the state
  // before React re-renders, and both would get through.
  const inFlight = useRef(false);
  const attemptId = useRef(newAttemptId());

  const save = useCallback(
    async (payload: unknown, submit: (idempotencyKey: string) => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSaving(true);
      try {
        await submit(`${attemptId.current}.${hashPayload(payload)}`);
        // Saved. Anything logged from here on is a new entry, so the next save
        // must not be mistaken for a replay of this one.
        attemptId.current = newAttemptId();
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    []
  );

  return { saving, save };
}
