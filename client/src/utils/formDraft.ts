/**
 * Keeps an in-progress form around when something takes the page out from
 * under it.
 *
 * Most interruptions are now held off until the user is done (see
 * `deferredReload`), but a couple can't be: an expired Cloudflare Access
 * session has to navigate to re-auth, and iOS will evict a backgrounded PWA
 * whenever it likes. A draft costs nothing and makes those non-destructive.
 *
 * localStorage rather than sessionStorage, so an evicted app still has it on
 * relaunch. Drafts are per child, expire on their own, and are cleared the
 * moment the form is saved or dismissed — the only way one survives is if the
 * user never got to finish with it.
 */

const KEY_PREFIX = "babytracker.draft.";

/** Drop a draft older than this rather than restoring something forgotten. */
export const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

interface StoredDraft<T> {
  savedAt: number;
  form: T;
}

function keyFor(name: string, childId: number | null): string {
  return `${KEY_PREFIX}${name}.${childId ?? "none"}`;
}

export function saveDraft<T>(name: string, childId: number | null, form: T): void {
  try {
    const draft: StoredDraft<T> = { savedAt: Date.now(), form };
    localStorage.setItem(keyFor(name, childId), JSON.stringify(draft));
  } catch {
    // Storage can be full or blocked (private browsing) — a draft is a bonus,
    // never a reason to break the form.
  }
}

export function loadDraft<T>(name: string, childId: number | null): T | null {
  const key = keyFor(name, childId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const draft = JSON.parse(raw) as StoredDraft<T>;
    if (!draft?.form || typeof draft.savedAt !== "number") {
      localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return draft.form;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore — nothing to recover.
    }
    return null;
  }
}

export function clearDraft(name: string, childId: number | null): void {
  try {
    localStorage.removeItem(keyFor(name, childId));
  } catch {
    // Ignore.
  }
}
