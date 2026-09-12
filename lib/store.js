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
import { DatabaseSync } from 'node:sqlite';
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.js';
import { createDigest, mintId } from './ids.js';

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
]);

/** Interaction lifecycle (approvals and questions). */
export const INTERACTION_STATES = Object.freeze([
  'pending',
  'answered',
  'rejected',
  'expired',
  'revoked',
  'superseded',
  'uncertain',
]);

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

/**
 * Map a thrown SQLite error onto the taxonomy, preserving evidence.
 * @param {unknown} error thrown by node:sqlite
 * @param {string} context what was being attempted
 * @returns {BridgeError}
 */
export function mapSqliteError(error, context) {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  let code = ERROR_CODES.STORAGE_UNAVAILABLE;
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
  #db;
  #stateDir;
  #generation;

  /**
   * @param {object} options
   * @param {string} options.stateDir directory holding the DB, WAL and lock file
   */
  constructor({ stateDir }) {
    this.#stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const dbPath = join(stateDir, 'state.sqlite');
    let db;
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

  get stateDir() { return this.#stateDir; }
  get generation() { return this.#generation; }

  /** @returns {number} durable store generation, used to bind cursors. */
  #readGeneration() {
    const row = this.#db.prepare('select value from meta where key = ?').get('generation');
    if (row) return Number(row.value);
    const generation = 1;
    this.#db.prepare('insert into meta(key, value) values (?, ?)').run('generation', String(generation));
    this.#db.prepare('insert into meta(key, value) values (?, ?)').run('schema_version', String(STATE_SCHEMA_VERSION));
    return generation;
  }

  /**
   * Refuse a state file written by a newer bridge.
   * @param {DatabaseSync} db
   */
  #checkSchemaVersion(db) {
    const row = db.prepare('select value from meta where key = ?').get('schema_version');
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
   * @template T
   * @param {() => T} fn work to perform inside the transaction
   * @returns {T}
   */
  write(fn) {
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
   * @template T
   * @param {string} sql
   * @returns {T}
   */
  get(sql, ...params) {
    try {
      return /** @type {T} */ (this.#db.prepare(sql).get(...params));
    } catch (error) {
      throw mapSqliteError(error, 'query');
    }
  }

  /**
   * @param {string} sql
   * @returns {unknown[]}
   */
  all(sql, ...params) {
    try {
      return this.#db.prepare(sql).all(...params);
    } catch (error) {
      throw mapSqliteError(error, 'query');
    }
  }

  /**
   * @param {string} sql
   * @returns {void}
   */
  run(sql, ...params) {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (error) {
      throw mapSqliteError(error, 'mutate');
    }
  }

  /** Checkpoint the WAL; bounded and explicit. */
  checkpoint() {
    try {
      this.#db.exec('pragma wal_checkpoint(TRUNCATE)');
    } catch (error) {
      throw mapSqliteError(error, 'checkpoint');
    }
  }

  /** Close the store. Never deletes anything: evidence is preserved for triage. */
  close() {
    try {
      this.#db.close();
    } catch {
      // A close failure must not mask the original error path.
    }
  }

  /**
   * Integrity check used at startup: a corrupt DB must fail loudly.
   * @returns {{ok: boolean, detail: string}}
   */
  integrityCheck() {
    try {
      const rows = this.#db.prepare('pragma integrity_check').all();
      const detail = rows.map((r) => Object.values(r)[0]).join('; ');
      return { ok: detail === 'ok', detail };
    } catch (error) {
      return { ok: false, detail: toBridgeError(error).message };
    }
  }

  // ---- tasks ------------------------------------------------------------------------

  /** @param {{taskId: string, label?: string, hostBase: string, hostScope: string}} input */
  createTask({ taskId, label = null, hostBase, hostScope }) {
    const now = Date.now();
    this.write(() => {
      this.run(
        'insert into tasks(task_id, label, host_base, host_scope, created_at, updated_at) values (?,?,?,?,?,?)',
        taskId, label, hostBase, hostScope, now, now,
      );
    });
    return this.getTask(taskId);
  }

  /** @param {string} taskId */
  getTask(taskId) {
    return this.get('select * from tasks where task_id = ?', taskId) ?? null;
  }

  /** @param {{taskId: string, reason: string, actor: string}} input */
  audit({ taskId = null, kind, actor, detail = {} }) {
    this.write(() => {
      this.run(
        'insert into audit(audit_id, task_id, at, kind, actor, detail_json) values (?,?,?,?,?,?)',
        mintId('event'), taskId, Date.now(), kind, actor, JSON.stringify(detail),
      );
    });
  }

  /** @param {string} taskId @param {number} [limit] */
  auditTrail(taskId, limit = 100) {
    return this.all(
      'select * from audit where task_id = ? order by at asc, audit_id asc limit ?',
      taskId, limit,
    );
  }

  // ---- sessions ---------------------------------------------------------------------

  /** @param {{sessionId: string, taskId: string, hostSessionId: string, cwd: string|null}} input */
  recordSession({ sessionId, taskId, hostSessionId, cwd = null }) {
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

  /** @param {string} sessionId */
  getSession(sessionId) {
    return this.get('select * from sessions where session_id = ?', sessionId) ?? null;
  }

  /** @param {string} taskId */
  listSessions(taskId) {
    return this.all('select * from sessions where task_id = ? order by created_at asc', taskId);
  }

  /** @param {string} hostSessionId */
  findSessionByHostId(hostSessionId) {
    return this.get('select * from sessions where host_session_id = ?', hostSessionId) ?? null;
  }

  // ---- operations -------------------------------------------------------------------

  /**
   * Reserve an operation idempotently: the same key and payload returns the SAME operation,
   * and the same key with a different payload is a conflict. This is the caller-facing
   * idempotency contract and it is enforced by a unique constraint, not by a lookup race.
   * @param {{taskId: string, kind: string, idempotencyKey: string, payload: unknown,
   *          sessionId?: string|null, turnId?: string|null}} input
   * @returns {{operation: object, created: boolean}}
   */
  reserveOperation({ taskId, kind, idempotencyKey, payload, sessionId = null, turnId = null }) {
    const digest = createDigest(JSON.stringify(payload ?? null));
    const existing = this.get(
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
      const raced = this.get(
        'select * from operations where task_id = ? and idempotency_key = ?',
        taskId, idempotencyKey,
      );
      if (raced && raced.payload_digest === digest) return { operation: raced, created: false };
      throw error;
    }
    return { operation: this.getOperation(operationId), created: true };
  }

  /** @param {string} operationId */
  getOperation(operationId) {
    return this.get('select * from operations where operation_id = ?', operationId) ?? null;
  }

  /** @param {string} taskId @param {number} [limit] */
  listOperations(taskId, limit = 200) {
    return this.all(
      'select * from operations where task_id = ? order by created_at asc limit ?',
      taskId, limit,
    );
  }

  /**
   * Persist the outbox row and move the operation to `dispatching` in ONE transaction,
   * committed before the caller performs the network write. This ordering is the whole
   * point: after this returns, a crash means "possibly sent".
   * @param {{operationId: string, method: string, endpoint: string, payload: unknown}} input
   */
  /**
   * The most recent request body handed to the wire for an operation, if any. This is what a
   * retry must resend verbatim: re-deriving a preallocated sessionId would ask the host to
   * create a DIFFERENT session while claiming to be the same operation.
   * @param {string} operationId
   * @returns {object|null}
   */
  latestOutboxPayload(operationId) {
    const row = this.get(
      'select payload_json from outbox where operation_id = ? order by created_at desc limit 1',
      operationId,
    );
    if (!row?.payload_json) return null;
    try {
      const parsed = JSON.parse(row.payload_json);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  markDispatching({ operationId, method, endpoint, payload }) {
    const now = Date.now();
    return this.write(() => {
      const op = this.get('select * from operations where operation_id = ?', operationId);
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
   * @param {{operationId: string, ok: boolean, value?: unknown, error?: object}} input
   */
  markAcknowledged({ operationId, ok, value = null, error = null }) {
    const now = Date.now();
    return this.write(() => {
      const op = this.get('select * from operations where operation_id = ?', operationId);
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
   * @param {{operationId: string, reason: string, evidence?: object}} input
   */
  markUncertain({ operationId, reason, evidence = {} }) {
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
   * @param {{operationId: string, resolution: 'succeeded'|'failed', evidence: object}} input
   */
  resolveUncertain({ operationId, resolution, evidence }) {
    const now = Date.now();
    return this.write(() => {
      const op = this.get('select * from operations where operation_id = ?', operationId);
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
   * @param {string} reason
   * @returns {object[]} the operations moved to uncertain
   */
  sweepInterruptedDispatches(reason) {
    const rows = this.all("select * from operations where state = 'dispatching'");
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
   * @param {{taskId: string, sessionId: string, seq: number, kind: string, payload: object}} input
   * @returns {boolean} true when the row was newly inserted
   */
  /**
   * Append one native event. Returns false when the sequence is already stored.
   *
   * Dedupe lives HERE, on the primary key, not only in the caller: the store is the last line
   * of defence, so a redelivered frame can never produce a second row even if a caller forgets
   * to check. (Callers still check first, to avoid taking a write transaction for a known
   * duplicate.)
   * @returns {boolean} true when a new row was written
   */
  appendEvent({ taskId, sessionId, seq, kind, payload }) {
    return this.write(() => {
      const before = this.get(
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
   * @param {{taskId: string, sessionId: string, beforeSeq?: number, maxMessages?: number}} input
   */
  pageEvents({ taskId, sessionId, beforeSeq = null, limit = 200 }) {
    const rows = beforeSeq === null
      ? this.all(
        `select * from events where task_id = ? and session_id = ?
         order by seq desc limit ?`, taskId, sessionId, limit)
      : this.all(
        `select * from events where task_id = ? and session_id = ? and seq < ?
         order by seq desc limit ?`, taskId, sessionId, beforeSeq, limit);
    return rows.reverse();
  }

  /** Operation counts by state — the observable signal that a request is in flight. */
  operationCounts() {
    const rows = this.all('select state, count(*) as n from operations group by state');
    /** @type {Record<string, number>} */
    const counts = {};
    for (const row of rows) counts[row.state] = Number(row.n);
    return counts;
  }

  /** @param {string} taskId @param {string} sessionId */
  countEvents(taskId, sessionId) {
    const row = this.get(
      'select count(*) as n from events where task_id = ? and session_id = ?', taskId, sessionId,
    );
    return Number(row?.n ?? 0);
  }

  /** @param {string} taskId @param {string} sessionId @param {number} seq */
  hasEvent(taskId, sessionId, seq) {
    const row = this.get(
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
   * @param {string} taskId @param {string} sessionId
   * @returns {{count: number, first: number|null, highest: number, contiguousThrough: number, missing: {from: number, to: number}[]}}
   */
  eventCoverage(taskId, sessionId) {
    const rows = this.all(
      'select seq from events where task_id = ? and session_id = ? order by seq',
      taskId, sessionId,
    ).map((row) => Number(row.seq));
    if (!rows.length) {
      return { count: 0, first: null, highest: 0, contiguousThrough: 0, missing: [] };
    }
    const missing = [];
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
   * @param {string} taskId @param {string} sessionId
   * @returns {{from: number|null, through: number, count: number}}
   */
  contiguousEventRange(taskId, sessionId) {
    const coverage = this.eventCoverage(taskId, sessionId);
    return { from: coverage.first, through: coverage.contiguousThrough, count: coverage.count };
  }

  /**
   * Record a cursor bound to the store generation, scope and page high-water. A cursor whose
   * generation no longer matches is expired, not silently treated as "latest".
   * @param {{taskId: string, sessionId: string, scope: string, lastSeq: number,
   *          highWater: number, completeness: string, gapFrom?: number|null, gapTo?: number|null}} input
   */
  putCursor({ taskId, sessionId, scope = 'mux', lastSeq, highWater, completeness, gapFrom = null, gapTo = null, completedThrough = null }) {
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

  /** @param {string} taskId @param {string} sessionId @param {string} scope */
  getCursor(taskId, sessionId, scope = 'mux') {
    return this.get(
      'select * from cursors where task_id = ? and session_id = ? and scope = ?',
      taskId, sessionId, scope,
    ) ?? null;
  }

  /**
   * @param {{taskId: string, sessionId: string, scope?: string}} input
   * @returns {{status: 'ok'|'expired', cursor?: object}}
   */
  readCursor({ taskId, sessionId, scope = 'mux' }) {
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
   * @param {{taskId: string, sessionId: string, turnId?: string|null, kind: 'approval'|'question',
   *          hostRpcId: string, nativeId?: string|null, payload: object, expiresAt?: number|null}} input
   * @returns {{interaction: object, created: boolean}}
   */
  recordInteraction({ taskId, sessionId, turnId = null, kind, hostRpcId, nativeId = null, payload, expiresAt = null }) {
    const existing = this.get('select * from interactions where host_rpc_id = ?', hostRpcId);
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

  /** @param {string} interactionId */
  getInteraction(interactionId) {
    return this.get('select * from interactions where interaction_id = ?', interactionId) ?? null;
  }

  /** @param {string} hostRpcId */
  getInteractionByRpcId(hostRpcId) {
    return this.get('select * from interactions where host_rpc_id = ?', hostRpcId) ?? null;
  }

  /** @param {string} taskId @param {string} [state] */
  listInteractions(taskId, state = null) {
    return state
      ? this.all('select * from interactions where task_id = ? and state = ? order by created_at asc', taskId, state)
      : this.all('select * from interactions where task_id = ? order by created_at asc', taskId);
  }

  /**
   * Compare-and-set one decision. Duplicate identical decisions are idempotent; a different
   * decision on an already-decided interaction is rejected by the caller after this returns
   * the current row, so the CAS is the single point of truth.
   * @param {{interactionId: string, decision: string, reason?: string}} input
   * @returns {{applied: boolean, interaction: object, previous: string|null}}
   */
  decideInteraction({ interactionId, decision, reason = null }) {
    const now = Date.now();
    return this.write(() => {
      const current = this.get('select * from interactions where interaction_id = ?', interactionId);
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
   * @param {{taskId: string, hostRpcId: string, answerDigest: string, outcome: string}} input
   */
  recordResponseDelivery({ taskId, hostRpcId, answerDigest, outcome }) {
    this.write(() => {
      this.run(
        `insert into response_dedupe(task_id, host_rpc_id, answer_digest, outcome, created_at)
         values (?,?,?,?,?)
         on conflict(task_id, host_rpc_id) do update set answer_digest = excluded.answer_digest,
           outcome = excluded.outcome, created_at = excluded.created_at`,
        taskId, hostRpcId, answerDigest, outcome, Date.now(),
      );
    });
    return this.get('select * from response_dedupe where task_id = ? and host_rpc_id = ?', taskId, hostRpcId);
  }

  /** @param {string} taskId @param {string} hostRpcId */
  getResponseDelivery(taskId, hostRpcId) {
    return this.get('select * from response_dedupe where task_id = ? and host_rpc_id = ?', taskId, hostRpcId) ?? null;
  }

  // ---- turns ------------------------------------------------------------------------

  /** @param {{turnId: string, sessionId: string, hostTurn?: number|null}} input */
  openTurn({ turnId, sessionId, hostTurn = null }) {
    this.write(() => {
      this.run(
        `insert into turns(turn_id, session_id, host_turn, state, opened_at) values (?,?,?,'open',?)`,
        turnId, sessionId, hostTurn, Date.now(),
      );
    });
    return this.getTurn(turnId);
  }

  /** @param {string} turnId */
  getTurn(turnId) {
    return this.get('select * from turns where turn_id = ?', turnId) ?? null;
  }

  /** @param {string} sessionId @param {string} [state] */
  listTurns(sessionId, state = null) {
    return state
      ? this.all('select * from turns where session_id = ? and state = ? order by opened_at asc', sessionId, state)
      : this.all('select * from turns where session_id = ? order by opened_at asc', sessionId);
  }

  /** @param {string} sessionId @returns {object|null} */
  currentOpenTurn(sessionId) {
    return this.get(
      "select * from turns where session_id = ? and state = 'open' order by opened_at desc limit 1", sessionId,
    ) ?? null;
  }

  /**
   * Close a turn only on an authoritative terminal event for that exact turn.
   * @param {{turnId: string, state: 'completed'|'failed'|'cancelled'|'uncertain', reason?: string}} input
   */
  closeTurn({ turnId, state, reason = null }) {
    this.write(() => {
      const turn = this.get('select * from turns where turn_id = ?', turnId);
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
  stats() {
    const ops = this.all('select state, count(*) as n from operations group by state');
    const interactions = this.all('select state, count(*) as n from interactions group by state');
    return {
      generation: this.#generation,
      schemaVersion: STATE_SCHEMA_VERSION,
      operations: Object.fromEntries(ops.map((r) => [r.state, Number(r.n)])),
      interactions: Object.fromEntries(interactions.map((r) => [r.state, Number(r.n)])),
      stateDirSizeBytes: safeDirSize(this.#stateDir),
    };
  }
}

/**
 * @param {string} dir
 * @returns {number} total bytes of the state directory, 0 when unreadable
 */
function safeDirSize(dir) {
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
