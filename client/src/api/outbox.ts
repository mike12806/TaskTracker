/**
 * Tasks added while the server was unreachable, waiting to be sent.
 *
 * This is the one piece of local storage the "never cache API data" rule does
 * not cover, and the distinction matters. The service worker keeps no copy of
 * server data because a saved copy of *the server's* answer can be false — the
 * task may have been completed on the laptop since. An entry sitting in here
 * is the opposite thing: it is the user's own write, on the device that made
 * it, which the server has not seen yet. Nothing about it can be contradicted
 * by a server the app cannot reach, and dropping it on the floor because the
 * radio was down — the task jotted down on the subway — is straightforwardly
 * losing what the user typed.
 *
 * So: reads stay honest by keeping nothing, writes stay honest by keeping
 * everything, and the UI is required to label anything in here as not yet
 * synced (see `pendingRowsFor` and `PendingSyncBanner`) so it is never mistaken
 * for something the user's other devices can see.
 *
 * Safety rests entirely on the idempotency key already built for retries (see
 * `server/src/routes/idempotency.ts`). Every queued create carries the
 * `client_request_id` it was given when the user pressed Save, so a flush can
 * be attempted any number of times, from any number of tabs, against a server
 * that may already have applied it — the second attempt is answered with the
 * row the first one created. That is what makes "retry until it lands" a safe
 * policy rather than a way to add the same task five times.
 *
 * ## Why localStorage and not IndexedDB
 *
 * A queue is a natural fit for IndexedDB, and IndexedDB is the only storage a
 * service worker can reach — which is what a Background Sync implementation
 * would need. Background Sync is not available on iOS Safari, where this app
 * lives on the phone, so the queue has to drain from the foreground anyway;
 * paying for a store the foreground doesn't need buys nothing. localStorage is
 * synchronous (so an enqueue cannot lose a race with the page being torn
 * down), shared across tabs with a change event, and matches `formDraft.ts`.
 * The volume is a handful of small objects during an outage, nowhere near the
 * quota. If Background Sync ever becomes worth having, moving to IndexedDB is
 * a change behind this module's exports.
 *
 * ## What is deliberately not queued
 *
 * Only creates. An edit, a completion or a delete offline is an operation *on
 * a row the server owns*, and the row may have been changed on another device
 * in the meantime — replaying it later would silently overwrite work this
 * device never saw. Creates have no such hazard: a task that did not exist
 * cannot have been concurrently modified.
 */

import { api } from "./client";
import { ApiError } from "./errors";

/**
 * The entities a create can be queued for, keyed by their server table name.
 *
 * Only tasks. A list created offline would hand its tasks a list id the
 * server has never issued, so lists are created online or not at all.
 */
export const OUTBOX_RESOURCES = {
  tasks: { path: "/tasks", label: "Task" },
} as const;

export type OutboxResource = keyof typeof OUTBOX_RESOURCES;

export interface OutboxEntry {
  /** Local identity, for discarding and for React keys. */
  localId: string;
  /**
   * Stand-in row id, always negative.
   *
   * Real ids are positive, so `id < 0` is the whole test for "this row has
   * never reached the server" — which is what stops a pending row being
   * offered an edit form or an `?edit=` link it could not possibly satisfy.
   */
  rowId: number;
  resource: OutboxResource;
  /** The POST body exactly as it would have been sent, key included. */
  body: Record<string, unknown>;
  /** When the user pressed Save (local ms). */
  queuedAt: number;
  /**
   * Failed attempts where the server actually answered.
   *
   * A dropped connection deliberately does not count: the server being
   * unreachable says nothing about whether this entry is any good, and
   * counting it would dead-letter a perfectly valid task for the crime of
   * being added on a plane.
   */
  serverAttempts: number;
  /**
   * Why this entry stopped being retried, if it has.
   *
   * Set only when the server rejected it in a way another attempt cannot fix.
   * The entry stays in the queue — it is the user's data and nothing may throw
   * it away silently — but it no longer flushes, and the banner asks the user
   * what to do with it.
   */
  failure?: string;
}

const STORAGE_KEY = "tasktracker.outbox.v1";

/**
 * Most entries a device will hold before it refuses to take more.
 *
 * Far above any real outage — a heavy day is a few dozen entries — and there
 * purely so a bug that queues in a loop cannot fill the origin's quota and
 * take the drafts and settings down with it. Hitting it is reported to the
 * user as a failed save, never as a silent drop.
 */
export const MAX_OUTBOX_ENTRIES = 200;

/**
 * How many answered-and-failed attempts an entry gets before it is set aside.
 *
 * Only 5xx and 429 reach this count, so it takes a server that is up and
 * consistently failing on this specific entry. At that point retrying is not
 * going to start working, and the honest thing is to stop and say so rather
 * than keep a queue that never drains and a banner that never clears.
 */
export const MAX_SERVER_ATTEMPTS = 8;

/**
 * Parsed queue, cached so `getOutboxSnapshot` can hand `useSyncExternalStore`
 * the same array identity between changes — returning a fresh array each call
 * makes React re-render forever.
 */
let cache: OutboxEntry[] | null = null;

const listeners = new Set<() => void>();

function readStorage(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // A stored entry that no longer makes sense (a build that changed the
    // shape, a half-written value) is dropped rather than crashing every
    // render that touches the queue.
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function isValidEntry(value: unknown): value is OutboxEntry {
  const entry = value as OutboxEntry | null;
  return (
    !!entry &&
    typeof entry.localId === "string" &&
    typeof entry.rowId === "number" &&
    typeof entry.queuedAt === "number" &&
    typeof entry.body === "object" &&
    entry.body !== null &&
    typeof entry.resource === "string" &&
    entry.resource in OUTBOX_RESOURCES
  );
}

/** The queue, oldest first. Cached — do not mutate the returned array. */
export function getOutboxSnapshot(): OutboxEntry[] {
  if (cache === null) cache = readStorage();
  return cache;
}

/**
 * Replace the queue.
 *
 * Returns false when storage refused the write (quota exhausted, Safari
 * private browsing). Callers must treat that as the save having failed —
 * pretending an entry is safely queued when nothing recorded it is the one
 * outcome worse than an error toast.
 */
function writeStorage(entries: OutboxEntry[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    return false;
  }
  cache = entries;
  notifyListeners();
  return true;
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to queue changes. Returns an unsubscribe function. */
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Pick up a change made by another tab.
 *
 * Two tabs of an installed PWA share one queue. Without this, a tab that was
 * open while the other one drained the queue keeps rendering pending rows for
 * entries that are already saved — the same entry twice once its refetch lands.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cache = null;
    notifyListeners();
  });
}

/** Next stand-in row id: one below anything already queued. */
function nextRowId(entries: OutboxEntry[]): number {
  const lowest = entries.reduce((min, entry) => Math.min(min, entry.rowId), 0);
  return lowest - 1;
}

function newLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Add a create to the queue.
 *
 * Returns the stored entry, or null if storage would not take it — in which
 * case the caller must report the original failure, because nothing was kept.
 */
export function enqueue(
  resource: OutboxResource,
  body: Record<string, unknown>,
): OutboxEntry | null {
  const entries = getOutboxSnapshot();
  if (entries.length >= MAX_OUTBOX_ENTRIES) return null;

  const entry: OutboxEntry = {
    localId: newLocalId(),
    rowId: nextRowId(entries),
    resource,
    body,
    queuedAt: Date.now(),
    serverAttempts: 0,
  };
  return writeStorage([...entries, entry]) ? entry : null;
}

/** Throw an entry away at the user's request. The only way one is ever lost. */
export function discardEntry(localId: string): void {
  writeStorage(getOutboxSnapshot().filter((entry) => entry.localId !== localId));
}

/** Put a set-aside entry back in the running. */
export function retryEntry(localId: string): void {
  writeStorage(
    getOutboxSnapshot().map((entry) =>
      entry.localId === localId ? { ...entry, failure: undefined, serverAttempts: 0 } : entry,
    ),
  );
}

function updateEntry(localId: string, patch: Partial<OutboxEntry>): void {
  writeStorage(
    getOutboxSnapshot().map((entry) =>
      entry.localId === localId ? { ...entry, ...patch } : entry,
    ),
  );
}

/** Queued entries still waiting on the server — excludes the set-aside ones. */
export function pendingEntries(): OutboxEntry[] {
  return getOutboxSnapshot().filter((entry) => !entry.failure);
}

/** Entries the server rejected, which now need the user to decide. */
export function failedEntries(): OutboxEntry[] {
  return getOutboxSnapshot().filter((entry) => entry.failure);
}

/** Test seam — drops the queue and its cache. */
export function resetOutbox(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
  cache = null;
  notifyListeners();
}

/* ------------------------------------------------------------------ */
/* Rendering pending entries                                           */
/* ------------------------------------------------------------------ */

/** The extra fields a pending row carries on top of its entity's shape. */
export interface PendingRow {
  id: number;
  /** Present and true only on rows that have not reached the server. */
  pending: true;
  pending_local_id: string;
  pending_queued_at: number;
  pending_failure?: string;
}

/** Has this row only ever existed on this device? */
export function isPending(row: { id: number }): boolean {
  return row.id < 0;
}

/**
 * Delete a row that only exists here, given the id the list rendered it with.
 *
 * Returns false for a real row, so a page's delete handler can lead with this
 * and fall through to the API for everything else. A pending row has nothing
 * on the server to delete — dropping the queued entry *is* the delete, and
 * doing it locally is also the only version that works while offline, which
 * is exactly when a mistyped entry needs taking back.
 */
export function discardPendingRow(rowId: number): boolean {
  if (rowId >= 0) return false;
  const entry = getOutboxSnapshot().find((queued) => queued.rowId === rowId);
  if (!entry) return false;
  discardEntry(entry.localId);
  return true;
}

/**
 * Queued creates for one resource, shaped like the rows the server would
 * return.
 *
 * The body already has every column the entity has, because it is the POST
 * that would have created the row — so spreading it produces something the
 * page can render with no special case beyond the `pending` flag it must show.
 * The idempotency key is stripped: it is transport, not part of the entry.
 */
export function pendingRowsFor<T>(resource: OutboxResource): (T & PendingRow)[] {
  return getOutboxSnapshot()
    .filter((entry) => entry.resource === resource)
    .map((entry) => {
      const { client_request_id: _key, ...columns } = entry.body;
      const queuedAtIso = new Date(entry.queuedAt).toISOString();
      return {
        ...(columns as unknown as T),
        id: entry.rowId,
        created_at: queuedAtIso,
        updated_at: queuedAtIso,
        pending: true as const,
        pending_local_id: entry.localId,
        pending_queued_at: entry.queuedAt,
        ...(entry.failure ? { pending_failure: entry.failure } : {}),
      };
    });
}

/* ------------------------------------------------------------------ */
/* Saving, and draining what could not be saved                        */
/* ------------------------------------------------------------------ */

export type CreateOutcome<T> =
  | { status: "saved"; row: T }
  | { status: "queued"; entry: OutboxEntry }
  | { status: "failed"; error: Error };

/**
 * Is this failure one where holding the write and trying again later is the
 * right answer?
 *
 * Yes for anything that never got an answer (no status), for a server that is
 * up but broken (5xx), for being asked to slow down (429), and — less
 * obviously — for an expired session. A 401 sends the user through Cloudflare
 * Access, which navigates the page away and takes the open form with it, so
 * queueing first is the difference between the entry surviving the round trip
 * and being retyped.
 *
 * No for the rest of 4xx. A rejected payload is rejected the same way in ten
 * minutes; queueing it would trade a clear error for a queue that never
 * drains.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const { status } = error;
  if (status === undefined) return true;
  if (status === 401 || status === 403 || status === 429) return true;
  return status >= 500;
}

/**
 * Create an entry, falling back to the queue when the server can't take it.
 *
 * `body` must already carry the `client_request_id` from `useSaveGuard` — the
 * same key whether this lands now or in three hours, which is what makes the
 * flush safe to repeat.
 */
export async function createEntry<T>(
  resource: OutboxResource,
  body: Record<string, unknown>,
): Promise<CreateOutcome<T>> {
  try {
    const row = await api.post<T>(OUTBOX_RESOURCES[resource].path, body);
    return { status: "saved", row };
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Failed to save.");
    if (!isRetryable(error)) return { status: "failed", error: err };

    const entry = enqueue(resource, body);
    // Storage refused it, so nothing was kept — report the real failure rather
    // than telling the user it is safe on the device when it isn't.
    if (!entry) return { status: "failed", error: err };
    return { status: "queued", entry };
  }
}

/** Why a flush stopped before reaching the end of the queue. */
export type FlushStop = "offline" | "auth" | "server";

export interface FlushSummary {
  /** Entries the server accepted (or recognised as already applied). */
  synced: number;
  /** Entries set aside this pass because the server rejected them. */
  rejected: number;
  /** Still queued and still flushable afterwards. */
  remaining: number;
  /** Set when the run gave up early rather than emptying the queue. */
  stoppedBecause: FlushStop | null;
}

const EMPTY_SUMMARY: FlushSummary = {
  synced: 0,
  rejected: 0,
  remaining: 0,
  stoppedBecause: null,
};

/**
 * One flush at a time.
 *
 * Overlapping runs are safe — the idempotency key means the loser's POST is
 * answered with the winner's row — but they are wasted requests on a
 * connection that has just proved itself unreliable, and every trigger in
 * `DataRefreshProvider` can fire at once when an app is foregrounded.
 */
let inFlight: Promise<FlushSummary> | null = null;

/**
 * Send everything queued, oldest first.
 *
 * Stops early on anything that means the *next* entry would fail for the same
 * reason — a dead connection, a dead session, a server returning 5xx — because
 * marching the whole queue into the same wall costs a request each and teaches
 * us nothing. A rejection specific to one entry is different: that entry is
 * set aside and the run carries on, since the server is plainly reachable.
 */
export async function flushOutbox(): Promise<FlushSummary> {
  if (inFlight) return inFlight;
  inFlight = runFlush();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runFlush(): Promise<FlushSummary> {
  const queued = pendingEntries();
  if (queued.length === 0) return { ...EMPTY_SUMMARY };

  let synced = 0;
  let rejected = 0;
  let stoppedBecause: FlushStop | null = null;

  for (const entry of queued) {
    try {
      await api.post(OUTBOX_RESOURCES[entry.resource].path, entry.body);
      // Accepted, or recognised as one this device already sent — the server
      // answers a replayed key with the original row either way, so there is
      // nothing here to tell apart and nothing that could have duplicated.
      discardEntry(entry.localId);
      synced++;
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const message = error instanceof Error ? error.message : "Failed to sync.";

      if (status === undefined) {
        stoppedBecause = "offline";
        break;
      }
      if (status === 401 || status === 403) {
        // The user is on their way to Cloudflare Access. The queue is on disk
        // and will still be here on the way back.
        stoppedBecause = "auth";
        break;
      }
      if (status === 429 || status >= 500) {
        const serverAttempts = entry.serverAttempts + 1;
        updateEntry(entry.localId, {
          serverAttempts,
          ...(serverAttempts >= MAX_SERVER_ATTEMPTS ? { failure: message } : {}),
        });
        if (serverAttempts >= MAX_SERVER_ATTEMPTS) rejected++;
        stoppedBecause = "server";
        break;
      }

      // A 4xx aimed at this entry — its list was deleted while the device was
      // offline, or the payload is one this server version won't take. Set it
      // aside for the user and keep going; the rest of the queue is unrelated.
      updateEntry(entry.localId, { failure: message });
      rejected++;
    }
  }

  return { synced, rejected, remaining: pendingEntries().length, stoppedBecause };
}
