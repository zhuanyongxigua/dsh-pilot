/**
 * Durable state: SQLite (WAL, synchronous=FULL, foreign keys, uniqueness) plus the
 * single-owner kernel lock.
 *
 * Why this file exists: the design's spine is "durable before accepted". Every mutating
 * intent and its outbox row are committed BEFORE the network write, and the ack is recorded
 * after a valid response. A crash from `dispatching` onward therefore means "possibly sent",
 * which is why `uncertain` is a persisted, first-class state rather than an error string.
 *
 * Invariants enforced here (each has a test in test/unit/store.test.mjs):
 *   - one row per (task, idempotencyKey); the same key with a different payload digest is a
 *     conflict, never a silent second operation.
 *   - transactions never span a network call; callers must commit, then send.
 *   - corrupt / ENOSPC / unwritable state is reported with evidence preserved; the DB and
 *     WAL are never deleted and success is never reported.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.ts';
import { createDigest, mintId } from './ids.ts';

/** On-disk state schema version. An unknown *future* version is refused, not guessed. */
export const STATE_SCHEMA_VERSION = 1;

/** Operation lifecycle. `uncertain` is terminal-but-unresolved, by design. */
export const OP_STATES = Object.freeze([
  'pending',      // intent + outbox row durable, nothing sent yet
  'dispatching',  // committed immediately before the network write
  'sent',         // response received and parsed
  'uncertain',    // sent with unproven outcome, or never proven not sent
  'succeeded',
  'failed',
  'refused',      // host answered ok:false (a definite business refusal)
] as const);

/** The states an operation row may hold. The DDL check constraint lists the same set. */
export type OperationState = (typeof OP_STATES)[number];

/** Interaction lifecycle (approvals and questions). */
export const INTERACTION_STATES = Object.freeze([
  'pending',
  'answered',
  'rejected',
  'expired',
  'revoked',
  'superseded',
  'uncertain',
] as const);

/**
 * The lifecycle above is the intended set of interaction states. The column is NOT typed with
 * it: `decideInteraction` writes the caller's decision string into `state`, and the daemon
 * decides with `allowed-once` / `rejected` / `expired`, so a narrower type here would be a
 * claim the store cannot keep.
 */
export type InteractionState = (typeof INTERACTION_STATES)[number];

/**
 * The states this bridge writes when an operator answers an interaction. Used by
 * `markAnswerNotPending` to refuse a receipt re-classification on a row that carries no answer, and
 * to keep the compare-and-set's own list and this one visibly the same set.
 */
export const ANSWER_STATES: readonly string[] = Object.freeze(['allowed-once', 'rejected', 'expired']);

/**
 * Where an answered interaction lands when the Host's carrier receipt says the request was no longer
 * pending. Distinct from every other state on purpose: it records that we answered AND that the
 * answer had nothing to apply to, which no other single state says.
 */
export const ANSWER_NOT_PENDING = 'answer-not-pending';

/** The states an outbox row may hold. The DDL check constraint lists the same set. */
export type OutboxState = 'pending' | 'dispatching' | 'acknowledged' | 'uncertain';

/** The states a turn row may hold. The DDL check constraint lists the same set. */
export type TurnState = 'open' | 'completed' | 'failed' | 'cancelled' | 'uncertain';

const DDL = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists tasks (
  task_id     text primary key,
  label       text,
  host_base   text not null,
  host_scope  text not null,
  created_at  integer not null,
  updated_at  integer not null
);

create table if not exists sessions (
  session_id        text primary key,
  task_id           text not null references tasks(task_id) on delete cascade,
  host_session_id   text not null,
  cwd               text,
  created_at        integer not null,
  updated_at        integer not null,
  unique (task_id, host_session_id)
);

create table if not exists turns (
  turn_id     text primary key,
  session_id  text not null references sessions(session_id) on delete cascade,
  host_turn   integer,
  state       text not null default 'open',
  opened_at   integer not null,
  ended_at    integer,
  reason      text,
  check (state in ('open','completed','failed','cancelled','uncertain'))
);

create table if not exists operations (
  operation_id     text primary key,
  task_id          text not null references tasks(task_id) on delete cascade,
  session_id       text references sessions(session_id) on delete set null,
  turn_id          text references turns(turn_id) on delete set null,
  kind             text not null,
  state            text not null,
  idempotency_key  text not null,
  payload_digest   text not null,
  request_id       text,
  request_json     text,
  response_json    text,
  error_code       text,
  error_message    text,
  uncertain_reason text,
  evidence         text,
  created_at       integer not null,
  updated_at       integer not null,
  unique (task_id, idempotency_key),
  check (state in ('pending','dispatching','sent','uncertain','succeeded','failed','refused'))
);

create table if not exists outbox (
  operation_id  text primary key references operations(operation_id) on delete cascade,
  request_id    text not null,
  method        text not null,
  endpoint      text not null,
  payload_json  text not null,
  state         text not null,
  attempts      integer not null default 0,
  created_at    integer not null,
  check (state in ('pending','dispatching','acknowledged','uncertain'))
);

create table if not exists interactions (
  interaction_id  text primary key,
  task_id         text not null references tasks(task_id) on delete cascade,
  session_id      text not null references sessions(session_id) on delete cascade,
  turn_id         text references turns(turn_id) on delete set null,
  kind            text not null,
  host_rpc_id     text not null unique,
  native_id       text,
  payload_digest  text not null,
  payload_json    text not null,
  state           text not null,
  decision        text,
  reason          text,
  generation      integer not null,
  store_generation integer not null,
  created_at      integer not null,
  expires_at      integer,
  decided_at      integer,
  check (kind in ('approval','question'))
);

create table if not exists events (
  task_id     text not null references tasks(task_id) on delete cascade,
  session_id  text not null references sessions(session_id) on delete cascade,
  seq         integer not null,
  kind        text not null,
  payload_json text not null,
  stored_at   integer not null,
  primary key (task_id, session_id, seq)
);

create table if not exists cursors (
  task_id       text not null references tasks(task_id) on delete cascade,
  session_id    text not null references sessions(session_id) on delete cascade,
  store_generation integer not null,
  scope         text not null,
  last_seq      integer not null,
  completed_through integer not null default 0,
  high_water    integer not null,
  completeness  text not null,
  gap_from      integer,
  gap_to        integer,
  updated_at    integer not null,
  primary key (task_id, session_id, scope)
);

-- What the bridge has done about each Host queue item it was asked to remove.
--
-- Why this is durable rather than in-memory: session.updateQueue has no host-side idempotency key
-- beyond rpcId, so the only thing standing between a retry and a second destructive request is what
-- the bridge remembers about the FIRST attempt. A 'removed' row means the Host confirmed the
-- removal; an 'uncertain' row means bytes reached the socket and the outcome was never proven. Both
-- must survive a restart, because the process that would otherwise remember is exactly the process
-- that may have died mid-request. Neither is ever re-sent blindly. (No backticks in this comment:
-- it lives inside the schema template literal, where one would end the string.)
create table if not exists queue_removals (
  task_id      text not null references tasks(task_id) on delete cascade,
  session_id   text not null references sessions(session_id) on delete cascade,
  item_id      text not null,
  state        text not null,
  operation_id text,
  updated_at   integer not null,
  primary key (task_id, session_id, item_id),
  check (state in ('removed','uncertain','not-pending'))
);

create table if not exists response_dedupe (
  task_id    text not null,
  host_rpc_id text not null,
  answer_digest text not null,
  outcome    text not null,
  created_at integer not null,
  primary key (task_id, host_rpc_id)
);

create table if not exists audit (
  audit_id    text primary key,
  task_id     text,
  at          integer not null,
  kind        text not null,
  actor       text not null,
  detail_json text
);

create index if not exists events_by_session on events(session_id, seq);
create index if not exists ops_by_state on operations(state);
create index if not exists interactions_by_state on interactions(state);
`;

// ---- row shapes -------------------------------------------------------------------------
//
// node:sqlite types every result as `Record<string, SQLOutputValue>`, which erases the
// columns entirely. Each distinct query shape is named once here, and the result is cast once
// where it crosses the driver boundary — so a mistyped column is a compile error instead of an
// `undefined` at runtime.

/** `select value from meta where key = ?`. */
export interface MetaValueRow {
  readonly value: string;
}

/** One row of `tasks`. */
export interface TaskRow {
  readonly task_id: string;
  readonly label: string | null;
  readonly host_base: string;
  readonly host_scope: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One row of `sessions`. */
export interface SessionRow {
  readonly session_id: string;
  readonly task_id: string;
  readonly host_session_id: string;
  readonly cwd: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One row of `turns`. */
export interface TurnRow {
  readonly turn_id: string;
  readonly session_id: string;
  readonly host_turn: number | null;
  readonly state: TurnState;
  readonly opened_at: number;
  readonly ended_at: number | null;
  readonly reason: string | null;
}

/** One row of `operations`. */
export interface OperationRow {
  readonly operation_id: string;
  readonly task_id: string;
  readonly session_id: string | null;
  readonly turn_id: string | null;
  readonly kind: string;
  readonly state: OperationState;
  readonly idempotency_key: string;
  readonly payload_digest: string;
  readonly request_id: string | null;
  readonly request_json: string | null;
  readonly response_json: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly uncertain_reason: string | null;
  readonly evidence: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One row of `outbox`. */
export interface OutboxRow {
  readonly operation_id: string;
  readonly request_id: string;
  readonly method: string;
  readonly endpoint: string;
  readonly payload_json: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly created_at: number;
}

/** `select payload_json from outbox where operation_id = ?`. */
export interface OutboxPayloadRow {
  readonly payload_json: string;
}

/** One row of `interactions`. */
export interface InteractionRow {
  readonly interaction_id: string;
  readonly task_id: string;
  readonly session_id: string;
  readonly turn_id: string | null;
  readonly kind: 'approval' | 'question';
  readonly host_rpc_id: string;
  readonly native_id: string | null;
  readonly payload_digest: string;
  readonly payload_json: string;
  readonly state: string;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly generation: number;
  readonly store_generation: number;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly decided_at: number | null;
}

/** One row of `events`. */
export interface EventRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload_json: string;
  readonly stored_at: number;
}

/** `select 1 as present from events where ...`. */
export interface EventPresenceRow {
  readonly present: number;
}

/** `select seq from events where ... order by seq`. */
export interface EventSeqRow {
  readonly seq: number;
}

/** `select count(*) as n from events where ...`. */
export interface CountRow {
  readonly n: number;
}

/** `select state, count(*) as n from <table> group by state`. */
export interface StateCountRow {
  readonly state: string;
  readonly n: number;
}

/** One row of `cursors`. */
export interface CursorRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly store_generation: number;
  readonly scope: string;
  readonly last_seq: number;
  readonly completed_through: number;
  readonly high_water: number;
  readonly completeness: string;
  readonly gap_from: number | null;
  readonly gap_to: number | null;
  readonly updated_at: number;
}

/** One row of `response_dedupe`. */
export interface ResponseDedupeRow {
  readonly task_id: string;
  readonly host_rpc_id: string;
  readonly answer_digest: string;
  readonly outcome: string;
  readonly created_at: number;
}

/**
 * The closed set of states a recorded queue removal can be in.
 *
 * All three mean "do not send another request for this item", and they are kept distinct because
 * they are different facts: `removed` was confirmed by the Host, `uncertain` reached the socket and
 * was never proven, and `not-pending` is the Host's own definite answer that the item was not in its
 * queue — so no removal happened and none is needed. Collapsing `not-pending` into `removed` would
 * report a removal that never occurred; collapsing it into `uncertain` would leave a settled item
 * unresolved forever.
 */
export const QUEUE_REMOVAL_STATES = Object.freeze(['removed', 'uncertain', 'not-pending']);

/** One row of `queue_removals`: what the bridge knows about one Host queue item's removal. */
export interface QueueRemovalRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly item_id: string;
  /** `removed` when the Host confirmed it, `uncertain` when the outcome was never proven. */
  readonly state: string;
  readonly operation_id: string | null;
  readonly updated_at: number;
}

/** One row of `audit`. */
export interface AuditRow {
  readonly audit_id: string;
  readonly task_id: string | null;
  readonly at: number;
  readonly kind: string;
  readonly actor: string;
  readonly detail_json: string | null;
}

/** Result of `pragma integrity_check`. */
export interface IntegrityReport {
  readonly ok: boolean;
  readonly detail: string;
}

/** One contiguous hole in the stored sequence set. */
export interface MissingRange {
  readonly from: number;
  readonly to: number;
}

/** What the store actually holds for one session's event stream. */
export interface EventCoverage {
  readonly count: number;
  readonly first: number | null;
  readonly highest: number;
  readonly contiguousThrough: number;
  readonly missing: readonly MissingRange[];
}

/** The provable contiguous run of one session's event stream. */
export interface ContiguousEventRange {
  readonly from: number | null;
  readonly through: number;
  readonly count: number;
}

/** A cursor read, bound to the store generation it was written under. */
export type CursorRead =
  | { readonly status: 'ok'; readonly cursor: CursorRow | null }
  | { readonly status: 'expired'; readonly cursor: CursorRow };

/** Result of reserving an operation idempotently. */
export interface ReservedOperation {
  readonly operation: OperationRow | null;
  readonly created: boolean;
}

/** Result of recording an interaction. */
export interface RecordedInteraction {
  readonly interaction: InteractionRow | null;
  readonly created: boolean;
}

/** Result of one compare-and-set on an interaction. */
export interface InteractionDecision {
  readonly applied: boolean;
  readonly interaction: InteractionRow | null;
  readonly previous: string | null;
}

/** Diagnostics snapshot: counts only, no payload text. */
export interface StoreStats {
  readonly generation: number;
  readonly schemaVersion: number;
  readonly operations: Record<string, number>;
  readonly interactions: Record<string, number>;
  readonly stateDirSizeBytes: number;
}

/** Constructor options: the directory holding the DB, WAL and lock file. */
export interface StoreOptions {
  readonly stateDir: string;
}

/** The host's error envelope, as much of it as the store records. */
export interface HostErrorLike {
  readonly code?: string | number | null;
  readonly message?: string | null;
}

/** Input of `createTask`. */
export interface CreateTaskInput {
  readonly taskId: string;
  readonly label?: string | null;
  readonly hostBase: string;
  readonly hostScope: string;
}

/** Input of `audit`. */
export interface AuditInput {
  readonly taskId?: string | null;
  readonly kind: string;
  readonly actor: string;
  readonly detail?: Record<string, unknown>;
}

/** Input of `recordSession`. */
export interface RecordSessionInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly hostSessionId: string;
  readonly cwd?: string | null;
}

/** Input of `reserveOperation`. */
export interface ReserveOperationInput {
  readonly taskId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
}

/** Input of `markDispatching`. */
export interface MarkDispatchingInput {
  readonly operationId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly payload: unknown;
}

/** Input of `markAcknowledged`. */
export interface MarkAcknowledgedInput {
  readonly operationId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: HostErrorLike | null;
}

/** Input of `markUncertain`. */
export interface MarkUncertainInput {
  readonly operationId: string;
  readonly reason: string;
  readonly evidence?: Record<string, unknown>;
}

/** Input of `resolveUncertain`. */
export interface ResolveUncertainInput {
  readonly operationId: string;
  readonly resolution: 'succeeded' | 'failed';
  readonly evidence: Record<string, unknown>;
}

/** Input of `appendEvent`. */
export interface AppendEventInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: object;
}

/** Input of `pageEvents`. */
export interface PageEventsInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly beforeSeq?: number | null;
  readonly limit?: number;
}

/** Input of `putCursor`. */
export interface PutCursorInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly scope?: string;
  readonly lastSeq: number;
  readonly highWater: number;
  readonly completeness: string;
  readonly gapFrom?: number | null;
  readonly gapTo?: number | null;
  readonly completedThrough?: number | null;
}

/** Input of `readCursor`. */
export interface ReadCursorInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly scope?: string;
}

/** Input of `recordInteraction`. */
export interface RecordInteractionInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly turnId?: string | null;
  readonly kind: 'approval' | 'question';
  readonly hostRpcId: string;
  readonly nativeId?: string | null;
  readonly payload: object;
  readonly expiresAt?: number | null;
}

/** Input of `decideInteraction`. */
export interface DecideInteractionInput {
  readonly interactionId: string;
  readonly decision: string;
  readonly reason?: string | null;
}

/** Input of `recordResponseDelivery`. */
/**
 * The closed set of states a recorded answer delivery can be in.
 *
 * `dispatching` is the one that makes a crash recoverable, and it is written BEFORE the POST: it
 * means bytes may have reached the Host and no answer was observed. Its absence is equally
 * meaningful — a decision with NO delivery row had no delivery attempted, which is a different fact
 * from "we sent it and do not know the outcome". Collapsing those two is how a crash between the
 * decision and the send gets reported as an unprovable outcome, or worse, as delivered.
 */
export const RESPONSE_DELIVERY_STATES = Object.freeze([
  'dispatching', 'accepted', 'not-pending', 'bad-response', 'refused', 'uncertain', 'unclassified', 'unrecognised',
]);

export interface RecordResponseDeliveryInput {
  readonly taskId: string;
  readonly hostRpcId: string;
  readonly answerDigest: string;
  readonly outcome: string;
}

/** Input of `openTurn`. */
export interface OpenTurnInput {
  readonly turnId: string;
  readonly sessionId: string;
  readonly hostTurn?: number | null;
}

/** Input of `closeTurn`. */
export interface CloseTurnInput {
  readonly turnId: string;
  readonly state: 'completed' | 'failed' | 'cancelled' | 'uncertain';
  readonly reason?: string | null;
}

/**
 * Map a thrown SQLite error onto the taxonomy, preserving evidence.
 * @param error thrown by node:sqlite
 * @param context what was being attempted
 * @returns a BridgeError carrying the mapped code
 */
export function mapSqliteError(error: unknown, context: string): BridgeError {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  /** one of ERROR_CODES; starts at the least specific storage code */
  let code: string = ERROR_CODES.STORAGE_UNAVAILABLE;
  if (lower.includes('disk i/o') || lower.includes('full') || lower.includes('enospc')) {
    code = ERROR_CODES.STORAGE_FULL;
  } else if (lower.includes('malformed') || lower.includes('corrupt') || lower.includes('not a database')) {
    code = ERROR_CODES.STORAGE_CORRUPT;
  } else if (lower.includes('busy') || lower.includes('locked')) {
    code = ERROR_CODES.BUSY;
  } else if (lower.includes('readonly') || lower.includes('permission') || lower.includes('unable to open')) {
    code = ERROR_CODES.STORAGE_UNAVAILABLE;
  }
  return new BridgeError(code, `${context}: ${raw}`, { context });
}

/** Result of one read-write transaction attempt. */
const MAX_BUSY_RETRY = 5;

/** Durable store. One instance per daemon process; never shared across processes. */
export class Store {
  #db: DatabaseSync;
  #stateDir: string;
  #generation: number;

  /**
   * @param options
   * @param options.stateDir directory holding the DB, WAL and lock file
   */
  constructor({ stateDir }: StoreOptions) {
    this.#stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const dbPath = join(stateDir, 'state.sqlite');
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { timeout: 0 });
      db.exec('pragma journal_mode=WAL');
      db.exec('pragma synchronous=FULL');
      db.exec('pragma foreign_keys=ON');
      db.exec('pragma busy_timeout=0');
      // Refuse a *newer* schema rather than misreading it. Written after DDL for a fresh DB.
      db.exec(DDL);
      this.#checkSchemaVersion(db);
    } catch (error) {
      // A typed refusal from our own validation (for example a newer schema) must survive
      // as-is; only raw driver errors are mapped.
      if (error instanceof BridgeError) throw error;
      throw mapSqliteError(error, 'opening state');
    }
    this.#db = db;
    this.#generation = this.#readGeneration();
  }

  get stateDir(): string { return this.#stateDir; }
  get generation(): number { return this.#generation; }

  /** @returns durable store generation, used to bind cursors. */
  #readGeneration(): number {
    // One cast for this `meta` read: node:sqlite hands back a loose column bag.
    const row = this.#db.prepare('select value from meta where key = ?').get('generation') as MetaValueRow | undefined;
    if (row) return Number(row.value);
    const generation = 1;
    this.#db.prepare('insert into meta(key, value) values (?, ?)').run('generation', String(generation));
    this.#db.prepare('insert into meta(key, value) values (?, ?)').run('schema_version', String(STATE_SCHEMA_VERSION));
    return generation;
  }

  /**
   * Refuse a state file written by a newer bridge.
   * @param db
   */
  #checkSchemaVersion(db: DatabaseSync): void {
    // The same cast for the same query shape, on the connection being opened.
    const row = db.prepare('select value from meta where key = ?').get('schema_version') as MetaValueRow | undefined;
    if (!row) return;
    const found = Number(row.value);
    if (!Number.isFinite(found)) {
      throw new BridgeError(ERROR_CODES.STORAGE_CORRUPT, 'state schema_version is not a number', { found: row.value });
    }
    if (found > STATE_SCHEMA_VERSION) {
      throw new BridgeError(
        ERROR_CODES.STATE_VERSION_UNSUPPORTED,
        `state was written by a newer bridge (schema ${found} > ${STATE_SCHEMA_VERSION})`,
        { found, supported: STATE_SCHEMA_VERSION },
      );
    }
  }

  /**
   * Run a write inside a transaction with bounded busy retry. Never wraps a network call:
   * callers commit, then send.
   * @param fn work to perform inside the transaction
   * @returns the value the work returned
   */
  write<T>(fn: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.#db.exec('begin immediate');
        try {
          const value = fn();
          this.#db.exec('commit');
          return value;
        } catch (error) {
          try { this.#db.exec('rollback'); } catch { /* rollback of a failed begin is a no-op */ }
          throw error;
        }
      } catch (error) {
        const mapped = error instanceof BridgeError ? error : mapSqliteError(error, 'write');
        if (mapped.code === ERROR_CODES.BUSY && attempt < MAX_BUSY_RETRY) {
          const deadline = Date.now() + (attempt + 1) * 5;
          while (Date.now() < deadline) { /* bounded spin: no unbounded sleep, no fake progress */ }
          continue;
        }
        throw mapped;
      }
    }
  }

  /**
   * Read one row, with the row shape named by the caller.
   * @param sql statement to run
   * @param params values bound to its `?` placeholders
   * @returns the first row, or undefined when the statement matched nothing
   */
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    try {
      // The cast every `get` caller relies on: node:sqlite types the row as a loose column
      // bag, and the caller names the shape it selected for (see the row shapes above).
      return this.#db.prepare(sql).get(...params) as unknown as T | undefined;
    } catch (error) {
      throw mapSqliteError(error, 'query');
    }
  }

  /**
   * Read every matching row, with the row shape named by the caller.
   * @param sql statement to run
   * @param params values bound to its `?` placeholders
   * @returns one entry per row
   */
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    try {
      // The same cast for `.all`: one named row shape per query; see the row shapes above.
      return this.#db.prepare(sql).all(...params) as unknown as T[];
    } catch (error) {
      throw mapSqliteError(error, 'query');
    }
  }

  /**
   * @param sql statement to run
   * @param params values bound to its `?` placeholders
   * @returns nothing
   */
  run(sql: string, ...params: SQLInputValue[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (error) {
      throw mapSqliteError(error, 'mutate');
    }
  }

  /** Checkpoint the WAL; bounded and explicit. */
  checkpoint(): void {
    try {
      this.#db.exec('pragma wal_checkpoint(TRUNCATE)');
    } catch (error) {
      throw mapSqliteError(error, 'checkpoint');
    }
  }

  /** Close the store. Never deletes anything: evidence is preserved for triage. */
  close(): void {
    try {
      this.#db.close();
    } catch {
      // A close failure must not mask the original error path.
    }
  }

  /**
   * Integrity check used at startup: a corrupt DB must fail loudly.
   * @returns whether the DB is intact, with the pragma's own detail text
   */
  integrityCheck(): IntegrityReport {
    try {
      const rows = this.#db.prepare('pragma integrity_check').all();
      const detail = rows.map((r) => Object.values(r)[0]).join('; ');
      return { ok: detail === 'ok', detail };
    } catch (error) {
      return { ok: false, detail: toBridgeError(error).message };
    }
  }

  // ---- tasks ------------------------------------------------------------------------

  /** @param input the task to record */
  createTask({ taskId, label = null, hostBase, hostScope }: CreateTaskInput): TaskRow | null {
    const now = Date.now();
    this.write(() => {
      this.run(
        'insert into tasks(task_id, label, host_base, host_scope, created_at, updated_at) values (?,?,?,?,?,?)',
        taskId, label, hostBase, hostScope, now, now,
      );
    });
    return this.getTask(taskId);
  }

  /** @param taskId */
  getTask(taskId: string): TaskRow | null {
    return this.get<TaskRow>('select * from tasks where task_id = ?', taskId) ?? null;
  }

  /** @param input the audited action */
  audit({ taskId = null, kind, actor, detail = {} }: AuditInput): void {
    this.write(() => {
      this.run(
        'insert into audit(audit_id, task_id, at, kind, actor, detail_json) values (?,?,?,?,?,?)',
        mintId('event'), taskId, Date.now(), kind, actor, JSON.stringify(detail),
      );
    });
  }

  /** @param taskId @param limit */
  auditTrail(taskId: string, limit = 100): AuditRow[] {
    return this.all<AuditRow>(
      'select * from audit where task_id = ? order by at asc, audit_id asc limit ?',
      taskId, limit,
    );
  }

  // ---- sessions ---------------------------------------------------------------------

  /** @param input the session to record */
  recordSession({ sessionId, taskId, hostSessionId, cwd = null }: RecordSessionInput): SessionRow | null {
    const now = Date.now();
    this.write(() => {
      this.run(
        `insert into sessions(session_id, task_id, host_session_id, cwd, created_at, updated_at)
         values (?,?,?,?,?,?)
         on conflict(task_id, host_session_id) do update set updated_at = excluded.updated_at`,
        sessionId, taskId, hostSessionId, cwd, now, now,
      );
    });
    return this.getSession(sessionId);
  }

  /** @param sessionId */
  getSession(sessionId: string): SessionRow | null {
    return this.get<SessionRow>('select * from sessions where session_id = ?', sessionId) ?? null;
  }

  /** @param taskId */
  listSessions(taskId: string): SessionRow[] {
    return this.all<SessionRow>('select * from sessions where task_id = ? order by created_at asc', taskId);
  }

  /** @param hostSessionId */
  findSessionByHostId(hostSessionId: string): SessionRow | null {
    return this.get<SessionRow>('select * from sessions where host_session_id = ?', hostSessionId) ?? null;
  }

  // ---- operations -------------------------------------------------------------------

  /**
   * Reserve an operation idempotently: the same key and payload returns the SAME operation,
   * and the same key with a different payload is a conflict. This is the caller-facing
   * idempotency contract and it is enforced by a unique constraint, not by a lookup race.
   * @param input the operation to reserve
   * @returns the operation row and whether this call created it
   */
  reserveOperation({ taskId, kind, idempotencyKey, payload, sessionId = null, turnId = null }: ReserveOperationInput): ReservedOperation {
    const digest = createDigest(JSON.stringify(payload ?? null));
    const existing = this.get<OperationRow>(
      'select * from operations where task_id = ? and idempotency_key = ?',
      taskId, idempotencyKey,
    );
    if (existing) {
      if (existing.payload_digest !== digest) {
        throw new BridgeError(
          ERROR_CODES.CONFLICT,
          'idempotency key reused with a different payload',
          { idempotencyKey, operationId: existing.operation_id },
        );
      }
      return { operation: existing, created: false };
    }
    const operationId = mintId('operation');
    const requestId = mintId('operation');
    const now = Date.now();
    try {
      this.write(() => {
        this.run(
          `insert into operations(operation_id, task_id, session_id, turn_id, kind, state,
             idempotency_key, payload_digest, request_id, request_json, created_at, updated_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?)`,
          operationId, taskId, sessionId, turnId, kind, 'pending',
          idempotencyKey, digest, requestId, JSON.stringify(payload ?? null), now, now,
        );
      });
    } catch (error) {
      // Unique-constraint race: another process reserved the key between read and write.
      const raced = this.get<OperationRow>(
        'select * from operations where task_id = ? and idempotency_key = ?',
        taskId, idempotencyKey,
      );
      if (raced && raced.payload_digest === digest) return { operation: raced, created: false };
      throw error;
    }
    return { operation: this.getOperation(operationId), created: true };
  }

  /** @param operationId */
  getOperation(operationId: string): OperationRow | null {
    return this.get<OperationRow>('select * from operations where operation_id = ?', operationId) ?? null;
  }

  /** @param taskId @param limit */
  listOperations(taskId: string, limit = 200): OperationRow[] {
    return this.all<OperationRow>(
      'select * from operations where task_id = ? order by created_at asc limit ?',
      taskId, limit,
    );
  }

  /**
   * Persist the outbox row and move the operation to `dispatching` in ONE transaction,
   * committed before the caller performs the network write. This ordering is the whole
   * point: after this returns, a crash means "possibly sent".
   * @param input the operation and the request about to go on the wire
   */
  /**
   * The most recent request body handed to the wire for an operation, if any. This is what a
   * retry must resend verbatim: re-deriving a preallocated sessionId would ask the host to
   * create a DIFFERENT session while claiming to be the same operation.
   * @param operationId
   * @returns the stored request body, or null when none is recorded or it is not an object
   */
  latestOutboxPayload(operationId: string): Record<string, unknown> | null {
    const row = this.get<OutboxPayloadRow>(
      'select payload_json from outbox where operation_id = ? order by created_at desc limit 1',
      operationId,
    );
    if (!row?.payload_json) return null;
    try {
      // JSON.parse is an untyped boundary; the store itself wrote this column as a JSON object.
      const parsed = JSON.parse(row.payload_json) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  markDispatching({ operationId, method, endpoint, payload }: MarkDispatchingInput): OperationRow | null {
    const now = Date.now();
    return this.write(() => {
      const op = this.get<OperationRow>('select * from operations where operation_id = ?', operationId);
      if (!op) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'operation not found', { operationId });
      if (op.state !== 'pending') {
        throw new BridgeError(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `cannot start dispatch from state ${op.state}`,
          { operationId, state: op.state },
        );
      }
      this.run(
        `insert into outbox(operation_id, request_id, method, endpoint, payload_json, state, attempts, created_at)
         values (?,?,?,?,?,'dispatching',1,?)
         on conflict(operation_id) do update set
           state = 'dispatching',
           attempts = outbox.attempts + 1,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`,
        operationId, op.request_id, method, endpoint, JSON.stringify(payload ?? null), now,
      );
      this.run(
        "update operations set state = 'dispatching', updated_at = ? where operation_id = ?",
        now, operationId,
      );
      return this.getOperation(operationId);
    });
  }

  /**
   * Record a valid host response. `ok:false` is a definite refusal; `ok:true` a success.
   * @param input the acknowledged operation and the host's answer
   */
  markAcknowledged({ operationId, ok, value = null, error = null }: MarkAcknowledgedInput): OperationRow | null {
    const now = Date.now();
    return this.write(() => {
      const op = this.get<OperationRow>('select * from operations where operation_id = ?', operationId);
      if (!op) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'operation not found', { operationId });
      if (op.state !== 'dispatching' && op.state !== 'sent') {
        throw new BridgeError(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `cannot acknowledge from state ${op.state}`,
          { operationId, state: op.state },
        );
      }
      this.run(
        `update operations set state = ?, response_json = ?, error_code = ?, error_message = ?, updated_at = ?
         where operation_id = ?`,
        ok ? 'succeeded' : 'refused',
        JSON.stringify(value ?? null),
        ok ? null : (error?.code ?? null),
        ok ? null : (error?.message ?? null),
        now, operationId,
      );
      this.run("update outbox set state = 'acknowledged' where operation_id = ?", operationId);
      return this.getOperation(operationId);
    });
  }

  /**
   * Mark an operation uncertain. Called when the outcome cannot be proven: a lost carrier
   * after a send, or a crash that left the row in `dispatching`. It stays uncertain
   * indefinitely unless strong evidence resolves it — absence of proof is not proof.
   * @param input the operation, the reason, and any evidence
   */
  markUncertain({ operationId, reason, evidence = {} }: MarkUncertainInput): OperationRow | null {
    const now = Date.now();
    return this.write(() => {
      this.run(
        `update operations set state = 'uncertain', uncertain_reason = ?, evidence = ?, updated_at = ?
         where operation_id = ?`,
        reason, JSON.stringify(evidence), now, operationId,
      );
      this.run("update outbox set state = 'uncertain' where operation_id = ?", operationId);
      return this.getOperation(operationId);
    });
  }

  /**
   * Resolve an uncertain operation from independent evidence (for example authoritative
   * history). Only called with evidence; never called to "tidy up".
   * @param input the operation, the resolution, and the evidence for it
   */
  resolveUncertain({ operationId, resolution, evidence }: ResolveUncertainInput): OperationRow | null {
    const now = Date.now();
    return this.write(() => {
      const op = this.get<OperationRow>('select * from operations where operation_id = ?', operationId);
      if (!op) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'operation not found', { operationId });
      if (op.state !== 'uncertain') {
        throw new BridgeError(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `cannot resolve from state ${op.state}`,
          { operationId, state: op.state },
        );
      }
      this.run(
        'update operations set state = ?, evidence = ?, updated_at = ? where operation_id = ?',
        resolution, JSON.stringify(evidence), now, operationId,
      );
      return this.getOperation(operationId);
    });
  }

  /**
   * Operations that were mid-dispatch when the process died: they are "possibly sent" and
   * must be surfaced as uncertain, never silently retried.
   * @param reason
   * @returns the operations moved to uncertain
   */
  sweepInterruptedDispatches(reason: string): OperationRow[] {
    const rows = this.all<OperationRow>("select * from operations where state = 'dispatching'");
    for (const row of rows) {
      this.markUncertain({
        operationId: row.operation_id,
        reason,
        evidence: { sweptAt: Date.now(), outboxState: 'dispatching' },
      });
    }
    return rows;
  }

  // ---- events and cursors -----------------------------------------------------------

  /**
   * Append an event once. Re-delivery of an identical native event is a no-op: dedupe is by
   * native sequence identity, never by hashing repeated identical text.
   * @param input the event to append
   * @returns true when the row was newly inserted
   */
  /**
   * Append one native event. Returns false when the sequence is already stored.
   *
   * Dedupe lives HERE, on the primary key, not only in the caller: the store is the last line
   * of defence, so a redelivered frame can never produce a second row even if a caller forgets
   * to check. (Callers still check first, to avoid taking a write transaction for a known
   * duplicate.)
   * @returns true when a new row was written
   */
  appendEvent({ taskId, sessionId, seq, kind, payload }: AppendEventInput): boolean {
    return this.write(() => {
      const before = this.get<EventPresenceRow>(
        'select 1 as present from events where task_id = ? and session_id = ? and seq = ?',
        taskId, sessionId, seq,
      );
      if (before) return false;
      this.run(
        'insert into events(task_id, session_id, seq, kind, payload_json, stored_at) values (?,?,?,?,?,?)',
        taskId, sessionId, seq, kind, JSON.stringify(payload), Date.now(),
      );
      return true;
    });
  }

  /**
   * @param input the page request
   * @returns the page in ascending sequence order
   */
  pageEvents({ taskId, sessionId, beforeSeq = null, limit = 200 }: PageEventsInput): EventRow[] {
    const rows = beforeSeq === null
      ? this.all<EventRow>(
        `select * from events where task_id = ? and session_id = ?
         order by seq desc limit ?`, taskId, sessionId, limit)
      : this.all<EventRow>(
        `select * from events where task_id = ? and session_id = ? and seq < ?
         order by seq desc limit ?`, taskId, sessionId, beforeSeq, limit);
    return rows.reverse();
  }

  /** Operation counts by state — the observable signal that a request is in flight. */
  operationCounts(): Record<string, number> {
    const rows = this.all<StateCountRow>('select state, count(*) as n from operations group by state');
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = Number(row.n);
    return counts;
  }

  /** @param taskId @param sessionId */
  countEvents(taskId: string, sessionId: string): number {
    const row = this.get<CountRow>(
      'select count(*) as n from events where task_id = ? and session_id = ?', taskId, sessionId,
    );
    return Number(row?.n ?? 0);
  }

  /** @param taskId @param sessionId @param seq */
  hasEvent(taskId: string, sessionId: string, seq: number): boolean {
    const row = this.get<EventPresenceRow>(
      'select 1 as present from events where task_id = ? and session_id = ? and seq = ?',
      taskId, sessionId, seq,
    );
    return Boolean(row);
  }

  /**
   * Describe the stored event coverage for one session as a closed set of conclusions.
   *
   * `missing` lists the sequence ranges between the first and highest stored sequence that
   * are absent. Ranges BELOW the first stored sequence are deliberately not reported: a client
   * that attached to an existing session legitimately receives only a later window, and
   * calling that a hole would report a gap no observation supports.
   * @param taskId @param sessionId
   */
  eventCoverage(taskId: string, sessionId: string): EventCoverage {
    const rows = this.all<EventSeqRow>(
      'select seq from events where task_id = ? and session_id = ? order by seq',
      taskId, sessionId,
    ).map((row) => Number(row.seq));
    if (!rows.length) {
      return { count: 0, first: null, highest: 0, contiguousThrough: 0, missing: [] };
    }
    const missing: MissingRange[] = [];
    let contiguousThrough = rows[0];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i] > rows[i - 1] + 1) missing.push({ from: rows[i - 1] + 1, to: rows[i] - 1 });
      if (rows[i] === contiguousThrough + 1) contiguousThrough = rows[i];
    }
    return {
      count: rows.length,
      first: rows[0],
      highest: rows[rows.length - 1],
      contiguousThrough,
      missing,
    };
  }

  /**
   * Highest sequence N such that every sequence from the first stored one through N is
   * present. Derived from the stored rows rather than inferred from arrival order: an
   * out-of-order arrival must never let the store claim a contiguous run it does not hold.
   * @param taskId @param sessionId
   */
  contiguousEventRange(taskId: string, sessionId: string): ContiguousEventRange {
    const coverage = this.eventCoverage(taskId, sessionId);
    return { from: coverage.first, through: coverage.contiguousThrough, count: coverage.count };
  }

  /**
   * Record a cursor bound to the store generation, scope and page high-water. A cursor whose
   * generation no longer matches is expired, not silently treated as "latest".
   * @param input the cursor to record
   */
  putCursor({ taskId, sessionId, scope = 'mux', lastSeq, highWater, completeness, gapFrom = null, gapTo = null, completedThrough = null }: PutCursorInput): CursorRow | null {
    this.write(() => {
      this.run(
        `insert into cursors(task_id, session_id, store_generation, scope, last_seq, completed_through, high_water,
           completeness, gap_from, gap_to, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?)
         on conflict(task_id, session_id, scope) do update set
           store_generation = excluded.store_generation,
           last_seq = max(cursors.last_seq, excluded.last_seq),
           completed_through = max(cursors.completed_through, excluded.completed_through),
           high_water = max(cursors.high_water, excluded.high_water),
           completeness = excluded.completeness,
           gap_from = coalesce(excluded.gap_from, cursors.gap_from),
           gap_to = excluded.gap_to,
           updated_at = excluded.updated_at`,
        taskId, sessionId, this.#generation, scope, lastSeq, completedThrough ?? lastSeq, highWater,
        completeness, gapFrom, gapTo, Date.now(),
      );
    });
    return this.getCursor(taskId, sessionId, scope);
  }

  /** @param taskId @param sessionId @param scope */
  getCursor(taskId: string, sessionId: string, scope = 'mux'): CursorRow | null {
    return this.get<CursorRow>(
      'select * from cursors where task_id = ? and session_id = ? and scope = ?',
      taskId, sessionId, scope,
    ) ?? null;
  }

  /**
   * @param input the cursor to read
   * @returns the cursor, or an expired marker when it was bound to another store generation
   */
  readCursor({ taskId, sessionId, scope = 'mux' }: ReadCursorInput): CursorRead {
    const cursor = this.getCursor(taskId, sessionId, scope);
    if (!cursor) return { status: 'ok', cursor: null };
    if (Number(cursor.store_generation) !== this.#generation) {
      return { status: 'expired', cursor };
    }
    return { status: 'ok', cursor };
  }

  // ---- interactions -----------------------------------------------------------------

  /**
   * Record an approval/question exactly once per host rpc id. Replay of the same pending
   * request restores display state only and never re-arms a decision.
   * @param input the interaction to record
   * @returns the interaction row and whether this call created it
   */
  recordInteraction({ taskId, sessionId, turnId = null, kind, hostRpcId, nativeId = null, payload, expiresAt = null }: RecordInteractionInput): RecordedInteraction {
    const existing = this.get<InteractionRow>('select * from interactions where host_rpc_id = ?', hostRpcId);
    if (existing) return { interaction: existing, created: false };
    const interactionId = mintId('interaction');
    const digest = createDigest(JSON.stringify(payload));
    this.write(() => {
      this.run(
        `insert into interactions(interaction_id, task_id, session_id, turn_id, kind, host_rpc_id,
           native_id, payload_digest, payload_json, state, generation, store_generation, created_at, expires_at)
         values (?,?,?,?,?,?,?,?,?,'pending',1,?,?,?)`,
        interactionId, taskId, sessionId, turnId, kind, hostRpcId,
        nativeId, digest, JSON.stringify(payload), this.#generation, Date.now(), expiresAt,
      );
    });
    return { interaction: this.getInteraction(interactionId), created: true };
  }

  /** @param interactionId */
  getInteraction(interactionId: string): InteractionRow | null {
    return this.get<InteractionRow>('select * from interactions where interaction_id = ?', interactionId) ?? null;
  }

  /** @param hostRpcId */
  getInteractionByRpcId(hostRpcId: string): InteractionRow | null {
    return this.get<InteractionRow>('select * from interactions where host_rpc_id = ?', hostRpcId) ?? null;
  }

  /** @param taskId @param state */
  listInteractions(taskId: string, state: string | null = null): InteractionRow[] {
    return state
      ? this.all<InteractionRow>('select * from interactions where task_id = ? and state = ? order by created_at asc', taskId, state)
      : this.all<InteractionRow>('select * from interactions where task_id = ? order by created_at asc', taskId);
  }

  /**
   * Compare-and-set one decision. Duplicate identical decisions are idempotent; a different
   * decision on an already-decided interaction is rejected by the caller after this returns
   * the current row, so the CAS is the single point of truth.
   * @param input the decision to apply
   * @returns whether it applied, the current row, and the state it was in before
   */
  decideInteraction({ interactionId, decision, reason = null }: DecideInteractionInput): InteractionDecision {
    const now = Date.now();
    return this.write(() => {
      const current = this.get<InteractionRow>('select * from interactions where interaction_id = ?', interactionId);
      if (!current) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'interaction not found', { interactionId });
      if (current.state !== 'pending') {
        return { applied: false, interaction: current, previous: current.state };
      }
      this.run(
        `update interactions set state = ?, decision = ?, reason = ?, decided_at = ?, generation = generation + 1
         where interaction_id = ? and state = 'pending'`,
        decision, decision, reason, now, interactionId,
      );
      return { applied: true, interaction: this.getInteraction(interactionId), previous: 'pending' };
    });
  }

  /**
   * Record an answer delivery attempt result keyed by host rpc id, so a replayed answer is
   * detectable even after the interaction row moved on.
   * @param input the delivery attempt
   * @returns the stored dedupe row
   */
  /**
   * Record what happened to one answer delivery, overwriting any earlier value.
   *
   * The caller's FIRST write for an rpc id must be `dispatching`, made durable before the request is
   * written, and the later write must be the observed outcome. Two writes rather than one is the
   * whole point: a process that dies in between leaves `dispatching` behind, and that row is the only
   * evidence that bytes may have been sent. Without it a crash is indistinguishable from a decision
   * that was never delivered — and "never delivered" invites a retry that a `dispatching` row
   * correctly forbids.
   * @param input the rpc id, the answer digest, and the state just reached
   */
  recordResponseDelivery({ taskId, hostRpcId, answerDigest, outcome }: RecordResponseDeliveryInput): ResponseDedupeRow | undefined {
    this.write(() => {
      this.run(
        `insert into response_dedupe(task_id, host_rpc_id, answer_digest, outcome, created_at)
         values (?,?,?,?,?)
         on conflict(task_id, host_rpc_id) do update set answer_digest = excluded.answer_digest,
           outcome = excluded.outcome, created_at = excluded.created_at`,
        taskId, hostRpcId, answerDigest, outcome, Date.now(),
      );
    });
    return this.get<ResponseDedupeRow>('select * from response_dedupe where task_id = ? and host_rpc_id = ?', taskId, hostRpcId);
  }

  /**
   * Removal attempts that are durable but have NO settled row in the removal ledger.
   *
   * This is the crash-recoverable index the once-only guarantee depends on. `recordQueueRemoval` is
   * written after the Host answers, so a process killed between the Host applying a `remove` and that
   * write leaves the ledger EMPTY for an item the Host may already have removed — and an empty ledger
   * is what says "safe to send again". The operation row does not have that gap: `#dispatch` persists
   * the intent as `pending` and then as `dispatching` BEFORE any byte is written, so every removal
   * attempt that could possibly have reached the Host is on disk with its item id in `request_json`.
   *
   * The join is therefore the recovery source of truth, and the `not exists` clause keeps it bounded:
   * once an attempt's item has a ledger row of any state, that item is no longer a candidate, because
   * the settled row is the better evidence.
   *
   * Only `remove` actions are returned. An `edit` or `steer` shares the method but is not a removal,
   * and treating one as a removal attempt would invent a block that the Host was never asked about.
   * @returns the durable removal attempts with no settled ledger row, oldest first
   */
  listUnsettledRemovalAttempts(): OperationRow[] {
    return this.all<OperationRow>(
      `select o.* from operations o
        where o.kind = 'session.updateQueue'
          and o.session_id is not null
          and json_valid(o.request_json)
          and json_extract(o.request_json, '$.action.kind') = 'remove'
          and json_extract(o.request_json, '$.itemId') is not null
          and not exists (
            select 1 from queue_removals q
             where q.task_id = o.task_id
               and q.session_id = o.session_id
               and q.item_id = json_extract(o.request_json, '$.itemId')
          )
        order by o.created_at asc, o.operation_id asc`,
    );
  }

  /**
   * Did a delivery for this rpc id leave the `dispatching` state, and what is it now?
   *
   * Returns the row, so a caller can tell all three cases apart: `null` means no delivery was ever
   * attempted (the decision is durable and NOT sent), `dispatching` means bytes may have reached the
   * Host and the outcome was never observed, and any terminal state means the question is answered.
   * The distinction is what AGENTS.md section 6 requires a caller be able to make.
   * @param taskId @param hostRpcId
   */
  getResponseDeliveryState(taskId: string, hostRpcId: string): ResponseDedupeRow | null {
    return this.getResponseDelivery(taskId, hostRpcId) ?? null;
  }

  /**
   * Record what the bridge knows about one Host queue item's removal, overwriting any earlier state.
   *
   * Overwriting is deliberate: the ONLY transition that may replace a value is a later, better
   * observation — `uncertain` becoming `removed` once the Host's own queue snapshot no longer lists
   * the item. A caller that wants to avoid re-sending must therefore read this first and treat BOTH
   * states as settled. See `getQueueRemoval`.
   * @param input the item, its session, and the state just observed
   */
  recordQueueRemoval({ taskId, sessionId, itemId, state, operationId = null }: {
    taskId: string; sessionId: string; itemId: string; state: string; operationId?: string | null;
  }): QueueRemovalRow | null {
    this.write(() => {
      this.run(
        `insert into queue_removals(task_id, session_id, item_id, state, operation_id, updated_at)
         values (?,?,?,?,?,?)
         on conflict(task_id, session_id, item_id) do update set state = excluded.state,
           operation_id = excluded.operation_id, updated_at = excluded.updated_at`,
        taskId, sessionId, itemId, state, operationId, Date.now(),
      );
    });
    return this.getQueueRemoval(taskId, sessionId, itemId);
  }

  /**
   * What is already known about this item's removal, or null when nothing is.
   *
   * The caller's rule, stated here because it is the whole point of the table: a non-null row means a
   * request for this item has ALREADY been sent, so sending another would be a second destructive
   * request for the same occurrence. `null` is the only value that may be sent.
   * @param taskId @param sessionId @param itemId
   */
  getQueueRemoval(taskId: string, sessionId: string, itemId: string): QueueRemovalRow | null {
    // `get` answers `undefined` for no row and the row interfaces are nullable, so the two
    // spellings of "nothing" are reconciled here rather than at every call site.
    return this.get<QueueRemovalRow>(
      'select * from queue_removals where task_id = ? and session_id = ? and item_id = ?',
      taskId, sessionId, itemId,
    ) ?? null;
  }

  /** Every recorded removal for one session, oldest first. @param taskId @param sessionId */
  listQueueRemovals(taskId: string, sessionId: string): QueueRemovalRow[] {
    return this.all<QueueRemovalRow>(
      'select * from queue_removals where task_id = ? and session_id = ? order by updated_at asc',
      taskId, sessionId,
    );
  }

  /** @param taskId @param hostRpcId */
  getResponseDelivery(taskId: string, hostRpcId: string): ResponseDedupeRow | null {
    return this.get<ResponseDedupeRow>('select * from response_dedupe where task_id = ? and host_rpc_id = ?', taskId, hostRpcId) ?? null;
  }

  /**
   * Re-classify an interaction after the HOST's carrier receipt arrives, when that receipt says the
   * request was no longer pending.
   *
   * Why this needs its own transition rather than a second `decideInteraction` call: that call is a
   * compare-and-set that only moves a row out of `pending`, and the answer we just sent has already
   * taken the row out of `pending`. So the second call is *refused by design* — measured, not
   * assumed: it returns `applied: false, previous: 'allowed-once'`, and the row would silently keep
   * the operator's decision. That guard is correct and must not be weakened, because it is what
   * stops a replay from overwriting a settled interaction.
   *
   * So the receipt gets its own transition, permitted only from the states this bridge writes as an
   * answer, and it lands on a state that says both things that are true: the operator answered, AND
   * the Host had nothing pending to apply the answer to. Either half alone would be a lie —
   * `allowed-once` would claim the answer was used, and a bare `resolved-by-host` would hide that a
   * decision was made and went nowhere.
   * @param input the interaction and the receipt reason
   * @returns the row as it now stands, or undefined when the row was not in an answerable state
   */
  markAnswerNotPending({ interactionId, reason = null }: {
    readonly interactionId: string; readonly reason?: string | null;
  }): InteractionRow | null {
    return this.write(() => {
      const current = this.get<InteractionRow>('select * from interactions where interaction_id = ?', interactionId);
      if (!current) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'interaction not found', { interactionId });
      // Only the states this bridge writes as an answer may move here. A row still `pending` means no
      // answer was ever recorded, which is a different situation and is deliberately left alone.
      if (!ANSWER_STATES.includes(current.state)) return null;
      this.run(
        `update interactions set state = ?, reason = ?, generation = generation + 1
         where interaction_id = ? and state = ?`,
        ANSWER_NOT_PENDING, reason, interactionId, current.state,
      );
      return this.getInteraction(interactionId);
    });
  }

  // ---- turns ------------------------------------------------------------------------

  /** @param input the turn to open */
  openTurn({ turnId, sessionId, hostTurn = null }: OpenTurnInput): TurnRow | null {
    this.write(() => {
      this.run(
        `insert into turns(turn_id, session_id, host_turn, state, opened_at) values (?,?,?,'open',?)`,
        turnId, sessionId, hostTurn, Date.now(),
      );
    });
    return this.getTurn(turnId);
  }

  /** @param turnId */
  getTurn(turnId: string): TurnRow | null {
    return this.get<TurnRow>('select * from turns where turn_id = ?', turnId) ?? null;
  }

  /** @param sessionId @param state */
  listTurns(sessionId: string, state: string | null = null): TurnRow[] {
    return state
      ? this.all<TurnRow>('select * from turns where session_id = ? and state = ? order by opened_at asc', sessionId, state)
      : this.all<TurnRow>('select * from turns where session_id = ? order by opened_at asc', sessionId);
  }

  /** @param sessionId @returns the open turn, or null when the session is idle */
  currentOpenTurn(sessionId: string): TurnRow | null {
    return this.get<TurnRow>(
      "select * from turns where session_id = ? and state = 'open' order by opened_at desc limit 1", sessionId,
    ) ?? null;
  }

  /**
   * Close a turn only on an authoritative terminal event for that exact turn.
   * @param input the turn to close and the terminal state it reached
   */
  closeTurn({ turnId, state, reason = null }: CloseTurnInput): TurnRow | null {
    this.write(() => {
      const turn = this.get<TurnRow>('select * from turns where turn_id = ?', turnId);
      if (!turn) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'turn not found', { turnId });
      if (turn.state !== 'open') return;
      this.run(
        'update turns set state = ?, reason = ?, ended_at = ? where turn_id = ? and state = \'open\'',
        state, reason, Date.now(), turnId,
      );
    });
    return this.getTurn(turnId);
  }

  /** Diagnostics snapshot, safe to expose: counts only, no payload text. */
  stats(): StoreStats {
    const ops = this.all<StateCountRow>('select state, count(*) as n from operations group by state');
    const interactions = this.all<StateCountRow>('select state, count(*) as n from interactions group by state');
    return {
      generation: this.#generation,
      schemaVersion: STATE_SCHEMA_VERSION,
      operations: Object.fromEntries(ops.map((r): [string, number] => [r.state, Number(r.n)])),
      interactions: Object.fromEntries(interactions.map((r): [string, number] => [r.state, Number(r.n)])),
      stateDirSizeBytes: safeDirSize(this.#stateDir),
    };
  }
}

/**
 * @param dir
 * @returns total bytes of the state directory, 0 when unreadable
 */
function safeDirSize(dir: string): number {
  try {
    const dbPath = join(dir, 'state.sqlite');
    let total = 0;
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      const path = join(dir, name);
      if (existsSync(path)) total += statSync(path).size;
    }
    return total || (existsSync(dbPath) ? statSync(dbPath).size : 0);
  } catch {
    return 0;
  }
}
