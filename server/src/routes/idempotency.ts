
/**
 * Making a create request safe to send twice.
 *
 * The client cannot retry a POST on its own: a request that failed on the way
 * *back* has already been applied, and retrying it adds the task a second time.
 * That left every write one dropped response away from being lost, and every
 * double-tap one row away from being duplicated.
 *
 * A key supplied by the client closes both. It is recorded in the same
 * transaction as the row it describes, under a unique index, so a replay of the
 * same key cannot insert anything — it finds the original row and returns it.
 * The client then sees the same 201 and the same entry it would have seen if
 * the first response had arrived.
 *
 * Requests without a key behave exactly as they always did. An installed PWA
 * updates on its own schedule, so the old client has to keep working.
 */

/** Body field carrying the client's key. Absent means "no deduplication". */
export const CLIENT_REQUEST_ID_FIELD = "client_request_id";

/** Keys are opaque to us; this only bounds what we will store. */
export const MAX_CLIENT_REQUEST_ID_LENGTH = 200;

/**
 * The key from a request body, or null if it carries none.
 *
 * A malformed key is treated as absent rather than rejected: it can only cost
 * the request its deduplication, and failing an otherwise valid task over
 * it would be the worse trade.
 */
export function readClientRequestId(body: Record<string, unknown>): string | null {
  const raw = body[CLIENT_REQUEST_ID_FIELD];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_REQUEST_ID_LENGTH) return null;
  return trimmed;
}

/** The row a previous request with this key created, or null if it is unused. */
async function findPriorRowId(
  db: D1Database,
  userId: number,
  table: string,
  clientRequestId: string,
): Promise<number | null> {
  const prior = await db
    .prepare(
      "SELECT row_id FROM client_requests WHERE user_id = ? AND table_name = ? AND client_request_id = ?",
    )
    .bind(userId, table, clientRequestId)
    .first<{ row_id: number }>();
  return prior ? prior.row_id : null;
}

/** The statement that claims a key for a row. Fails if the key is already used. */
function claimStatement(
  db: D1Database,
  userId: number,
  table: string,
  clientRequestId: string,
  rowId: number | null,
): D1PreparedStatement {
  // `last_insert_rowid()` refers to the insert immediately before this statement
  // in the same batch — the whole reason the claim rides along in the batch
  // rather than following it. Passing an explicit id is for the callers that
  // already know one.
  return rowId === null
    ? db
        .prepare(
          "INSERT INTO client_requests (user_id, table_name, client_request_id, row_id) VALUES (?, ?, ?, last_insert_rowid())",
        )
        .bind(userId, table, clientRequestId)
    : db
        .prepare(
          "INSERT INTO client_requests (user_id, table_name, client_request_id, row_id) VALUES (?, ?, ?, ?)",
        )
        .bind(userId, table, clientRequestId, rowId);
}

export interface InsertOnceOptions {
  db: D1Database;
  userId: number;
  /** Table the key is scoped to — the same key from another table is unrelated. */
  table: string;
  /** The client's key, or null to insert without deduplication. */
  clientRequestId: string | null;
  /** The insert. Must create exactly one row in `table`. */
  insert: D1PreparedStatement;
}

export interface InsertOnceResult {
  /** id of the row this request is answered by — new, or the original one. */
  rowId: number;
  /** True when the key had already been used and no row was created. */
  deduplicated: boolean;
}

/**
 * Insert a row at most once per key.
 *
 * Atomic: the insert and the claim on the key are one batch, which D1 runs as a
 * single transaction. Either both land or neither does, so a key can never
 * outlive the row it points at (which would silently swallow a real entry) and
 * a row can never exist without its key (which would let a retry duplicate it).
 */
export async function insertOnce(options: InsertOnceOptions): Promise<InsertOnceResult> {
  const { db, userId, table, clientRequestId, insert } = options;

  if (clientRequestId === null) {
    const result = await insert.run();
    return { rowId: Number(result.meta.last_row_id), deduplicated: false };
  }

  const prior = await findPriorRowId(db, userId, table, clientRequestId);
  if (prior !== null) return { rowId: prior, deduplicated: true };

  try {
    const [inserted] = await db.batch([
      insert,
      claimStatement(db, userId, table, clientRequestId, null),
    ]);
    return { rowId: Number(inserted.meta.last_row_id), deduplicated: false };
  } catch (error) {
    // The lookup above is an optimisation, not the guard — two identical
    // requests in flight together both pass it, and the unique index rejects
    // the loser's batch. If the key is now claimed, that is exactly what
    // happened and the winner's row is the answer. Re-checking rather than
    // matching on the error text keeps this from depending on D1's wording.
    const winner = await findPriorRowId(db, userId, table, clientRequestId);
    if (winner !== null) return { rowId: winner, deduplicated: true };
    throw error;
  }
}

/**
 * Claim a key for a row that is already written.
 *
 * For creates that span more than one insert and so cannot use the batch above.
 * The claim is a separate statement, which leaves a window: fail between the
 * row and its claim and a retry creates a second row — no worse than having no
 * key at all, which is what every create did before.
 */
export async function claimClientRequestId(
  db: D1Database,
  userId: number,
  table: string,
  clientRequestId: string | null,
  rowId: number,
): Promise<void> {
  if (clientRequestId === null) return;
  try {
    await claimStatement(db, userId, table, clientRequestId, rowId).run();
  } catch {
    // Losing the race means another request claimed this key and its row is the
    // one being returned to whoever asked second. Nothing to undo here.
  }
}

/** Look up the row a key already produced, for the multi-statement creates. */
export async function findClaimedRowId(
  db: D1Database,
  userId: number,
  table: string,
  clientRequestId: string | null,
): Promise<number | null> {
  if (clientRequestId === null) return null;
  return findPriorRowId(db, userId, table, clientRequestId);
}

/**
 * Drop keys old enough that no client could still be retrying against them.
 *
 * Called from the daily cron. Without it the table grows forever for no gain —
 * a key is only ever consulted in the minutes after it was issued.
 */
export async function pruneClientRequests(db: D1Database, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare("DELETE FROM client_requests WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
