// ---- source lines 1-56 (daemon-header.ts) ----
/**
 * The single owner daemon: the only process that mutates durable state or talks to the Host.
 *
 * Why this file exists: the design puts one owner between N thin MCP gateways and the Host so
 * that (a) ownership is unambiguous, (b) mutations for the same session are serialized while
 * different sessions run concurrently, and (c) durable intent always precedes the network
 * write. The daemon therefore owns four responsibilities and delegates the rest:
 *
 *   - mutation scheduling: per-session FIFO, cross-session concurrent;
 *   - the durable-intent protocol: commit `dispatching` BEFORE the send, ack AFTER a valid
 *     response, and `uncertain` whenever the outcome cannot be proven;
 *   - event ingest with a bound-generation cursor, gap detection and explicit completeness;
 *   - approval/question authority: decisions require the operator token, never a model tool.
 *
 * It deliberately does NOT retry non-idempotent mutations, does not treat a missing history
 * entry as proof of non-execution, and does not report a turn as terminated without an
 * authoritative terminal event for that turn.
 */

import { randomUUID } from 'node:crypto';
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.ts';
import { assertIdKind, createDigest, isIdempotencyKey, mintId, payloadDigest } from './ids.ts';
import { Store } from './store.ts';
import type {
  CursorRow,
  EventCoverage,
  EventRow,
  InteractionDecision,
  InteractionRow,
  OperationRow,
  RecordedInteraction,
  ReservedOperation,
  ResponseDedupeRow,
  SessionRow,
  TaskRow,
  TurnRow,
} from './store.ts';
import { OwnerLock } from './owner-lock.ts';
import { DshHostAdapter } from './adapter.ts';
import { startIpcServer, ensureAuthorityToken, readAuthorityToken } from './ipc.ts';
import type { IpcServer } from './ipc.ts';

/**
 * What one adapter call returns, as this file reads it.
 *
 * `errors.ts` attaches the status-specific fields at runtime (`Object.assign(this, fields)` in
 * the `Result` constructor: `value` on ok, `error` on refused, `reason` on uncertain), so the
 * class type alone does not carry them. `value` is the Host's own JSON value, i.e. exactly as
 * untyped as a `JSON.parse` result, which is why it is `unknown` here: a reader must narrow it
 * (see `#okValue`/`#okObject` below) instead of the type system asserting a shape the Host never
 * promised. This is a real constraint rather than a formality — the Host's payloads are the one
 * surface in this project we do not control.
 */
interface AdapterCallResult {
  readonly status: 'ok' | 'refused' | 'uncertain';
  readonly value?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: object };
  readonly reason?: string | null;
}

/** Default tunable limits (initial values from the design; all overridable). */
export const DEFAULT_LIMITS = Object.freeze({
  compactResultBytes: 64 * 1024,
  eventPageMax: 200,
  eventPageMaxBytes: 256 * 1024,
  frameMaxBytes: 1024 * 1024,
  eventBufferMaxBytes: 32 * 1024 * 1024,
  logMaxBytes: 100 * 1024 * 1024,
  waitDefaultMs: 30_000,
  waitMaxMs: 120_000,
});

/** Connection state, deliberately separate from turn execution state. */
export const CONNECTION_STATES = Object.freeze(['disconnected', 'connecting', 'reconciling', 'ready']);

// ---- source lines 58-307 (daemon-frag-a.ts) ----
export class Daemon {
  #stateDir: string;
  #store: Store;
  #lock: OwnerLock;
  #adapter: DshHostAdapter;
  #ipc: IpcServer | null = null;
  /**
   * The tunable limits, read as a `number` per key rather than as `typeof DEFAULT_LIMITS`: `Object.freeze`
   * gives the untouched defaults *literal* types (`eventPageMax: 200`, `waitDefaultMs: 30000`), and every
   * one of them is overridable from configuration, so the literal view would reject exactly the overrides
   * this field exists to hold.
   */
  #limits: { [K in keyof typeof DEFAULT_LIMITS]: number };
  #connection: 'disconnected' | 'connecting' | 'reconciling' | 'ready' = 'disconnected';
  #sessions = new Map<string, Promise<unknown>>(); // sessionId -> queue tail promise
  #eventAbort: AbortController | null = null;
  #eventStats: {
    frames: number;
    stored: number;
    duplicates: number;
    gaps: number;
    malformed: number;
    oversize: number;
    reconnects: number;
    historyTruncations: number;
  } = {
    frames: 0,
    stored: 0,
    duplicates: 0,
    gaps: 0,
    malformed: 0,
    oversize: 0,
    reconnects: 0,
    /** History pages the host truncated, i.e. asked-for coverage it did not deliver. */
    historyTruncations: 0,
  };
  /**
   * The element is the shape the only reader of this map projects; the daemon never appends to the
   * queue, so the original left its element type unstated.
   */
  #queue = new Map<string, Array<{ operationId: string; state: string }>>(); // sessionId -> local queue of pending prompts (daemon-owned)
  #dispatchHolds = new Map<string, boolean>(); // sessionId -> boolean (hold next dispatch while cancelling)
  #localQueueMax = 64;
  #stopped = false;
  /**
   * Result of the restart sweep, reported through health so a crash is inspectable.
   */
  #recovery: { sweptOperations: number; uncertainOperationIds: string[]; at: number | null } = { sweptOperations: 0, uncertainOperationIds: [], at: null };

  /**
   * The daemon's own identity: the controlled Host's base URL and the stable scope of its
   * namespace. Declared because the original assigned them as public fields, and `health`
   * reports both to an operator.
   */
  hostBase: string;
  hostScope: string;

  constructor({ stateDir, hostBase, hostScope = 'default', limits = {} }: {
    readonly stateDir: string;
    readonly hostBase: string;
    /** stable identifier of the controlled Host namespace */
    readonly hostScope?: string;
    /**
     * Overrides for the tunable limits, spread over the frozen defaults, so a partial bag is
     * exactly what this accepts (which is what `config.limits` is). Numbers per key, not
     * `Partial<typeof DEFAULT_LIMITS>`: see `#limits` above.
     */
    readonly limits?: Partial<{ [K in keyof typeof DEFAULT_LIMITS]: number }>;
  }) {
    this.#stateDir = stateDir;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#lock = new OwnerLock({ lockPath: `${stateDir}/owner.lock.sqlite` });
    this.#store = new Store({ stateDir });
    this.#adapter = new DshHostAdapter({ baseUrl: hostBase, timeoutMs: 15_000 });
    this.hostBase = hostBase;
    this.hostScope = hostScope;
  }

  get store(): Store { return this.#store; }
  get limits() { return { ...this.#limits }; }
  get connection(): 'disconnected' | 'connecting' | 'reconciling' | 'ready' { return this.#connection; }
  get eventStats() { return { ...this.#eventStats }; }
  get adapter(): DshHostAdapter { return this.#adapter; }
  get ipcPath(): string | null { return this.#ipc?.path ?? null; }

  /**
   * Start the daemon: ownership first, then recovery, then the IPC endpoint.
   *
   * Ordering matters and is asserted by a test: the owner lock is taken BEFORE an orphan IPC
   * socket is reclaimed, because reclaiming an endpoint you do not own would let a second
   * process answer calls meant for the owner.
   */
  async start(): Promise<{
    stateDir: string;
    socketPath: string;
    generation: number;
    recovery: { interrupted: number; uncertainOperations: string[] };
    authorityTokenPath: string;
    authorityTokenCreated: boolean;
  }> {
    this.#lock.acquire();
    this.#lock.writeMarker();

    const integrity = this.#store.integrityCheck();
    if (!integrity.ok) {
      throw new BridgeError(ERROR_CODES.STORAGE_CORRUPT, 'state database failed its integrity check', {
        detail: integrity.detail.slice(0, 200),
      });
    }

    const recovery = this.recover();
    this.#recovery = {
      // Named for what a caller can act on: these operations are "possibly sent".
      sweptOperations: recovery.interrupted,
      uncertainOperationIds: recovery.uncertainOperations,
      at: Date.now(),
    };

    const token = ensureAuthorityToken(this.#stateDir);
    this.#ipc = await startIpcServer({
      stateDir: this.#stateDir,
      handle: (request) => this.handleIpc(request),
    });

    this.#store.audit({ kind: 'daemon-started', actor: 'daemon', detail: { hostBase: this.hostBase } });
    return {
      stateDir: this.#stateDir,
      socketPath: this.#ipc.path,
      generation: this.#store.generation,
      recovery,
      authorityTokenPath: token.path,
      authorityTokenCreated: token.created,
    };
  }

  /**
   * Restart recovery: interrupted dispatches become uncertain (possibly sent), never retried.
   */
  recover(): { interrupted: number; uncertainOperations: string[] } {
    const interrupted = this.#store.sweepInterruptedDispatches('crash-during-dispatch');
    return {
      interrupted: interrupted.length,
      uncertainOperations: interrupted.map((row) => row.operation_id),
    };
  }

  /** Stop the daemon cleanly: close ingest, close IPC, release ownership. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#eventAbort?.abort();
    if (this.#ipc) await this.#ipc.close();
    try { this.#store.checkpoint(); } catch { /* checkpoint is best effort at shutdown */ }
    this.#store.close();
    this.#lock.release();
  }

  // ---- IPC surface ------------------------------------------------------------------

  /**
   * A sound narrowing of parsed JSON, and not a cast: every property of a non-null object reads as
   * `unknown`, which is exactly what this record type claims, so viewing one that way adds no
   * assertion the value cannot support.
   */
  #isParsedObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Handle one gateway request. Authorization for state-changing decisions is enforced here,
   * so no MCP tool can reach it.
   */
  async handleIpc(request: unknown): Promise<unknown> {
    // The frame is parsed JSON, so nothing about its shape is known at this point. `op` was read by
    // destructuring `request ?? {}` in the original; this reads the same field off the same object,
    // and a frame that is not an object becomes `{}`, which yields the same `undefined` that
    // destructuring a primitive did. The bag is what the op handlers receive, too.
    const fields: Record<string, unknown> = this.#isParsedObject(request) ? request : {};
    const op = fields.op;
    switch (op) {
      case 'health': return this.health();
      case 'task.ensure': return this.taskEnsure(fields);
      case 'session.start': return this.sessionStart(fields);
      case 'session.prompt': return this.sessionPrompt(fields);
      case 'session.state': return this.sessionState(fields);
      case 'session.events': return this.sessionEvents(fields);
      case 'session.wait': return this.sessionWait(fields);
      case 'interaction.list': return this.interactionList(fields);
      case 'interaction.decide': return this.interactionDecide(fields);
      case 'session.cancel': return this.sessionCancel(fields);
      case 'queue.clear': return this.queueClear(fields);
      case 'ops.get': return this.opGet(fields);
      case 'stream.subscribe': return this.streamSubscribe(fields);
      default:
        throw new BridgeError(ERROR_CODES.UNSUPPORTED, `unsupported ipc op: ${String(op)}`, { op });
    }
  }

  health() {
    return {
      status: 'ok',
      pid: process.pid,
      hostBase: this.hostBase,
      hostScope: this.hostScope,
      connection: this.#connection,
      storeGeneration: this.#store.generation,
      /** What restart recovery found and resolved, so an operator can see it after a crash. */
      recovery: this.#recovery,
      stats: this.#store.stats(),
      // Operations are the only place an in-flight request is observable from outside; a test
      // needs this to know that a request has actually been handed to the wire before it kills
      // the process, otherwise "uncertain after crash" proves nothing.
      operations: this.#store.operationCounts(),
      eventStats: this.eventStats,
      adapterStats: this.#adapter.stats,
      capabilities: this.#adapter.capabilities(),
      limits: this.limits,
    };
  }

  /**
   * The request is the IPC peer's parsed JSON, so it is read as a field bag and each field keeps
   * the `unknown` type it arrives with; the task id is narrowed by `assertIdKind` below, which is
   * the only narrowing the original performed. (`label` was destructured there and never read:
   * the stored label is derived from the client key.)
   */
  taskEnsure({ taskId = null, label = null, clientKey }: Record<string, unknown>): {
    task: ReturnType<typeof shapeTask>;
    created: boolean;
  } {
    const key = clientKey ?? 'default';
    const existing = this.#store.get<TaskRow>(`select * from tasks where label = ?`, `task:${key}`);
    if (existing) return { task: shapeTask(existing), created: false };
    // `assertIdKind` is the narrowing: it throws unless the value is a well-formed task id and
    // returns that same id, so the checked value is what goes to the store.
    const newTaskId = assertIdKind(taskId ?? mintId('task'), 'task');
    const task = this.#store.createTask({
      taskId: newTaskId,
      label: `task:${key}`,
      hostBase: this.hostBase,
      hostScope: this.hostScope,
    });
    // `createTask` reads back the row it has just written; a null row made the original's
    // `shapeTask` fail on its own property read, and a missing row still fails here, with the same
    // `TypeError` and the same field.
    this.#requireRow(task, 'task_id');
    return { task: shapeTask(task), created: true };
  }

  /**
   * The original dereferenced a store row directly, so a row that was absent made the property read
   * throw a `TypeError`; a row genuinely can be absent, which is why the store types it `| null`.
   * Asserting presence here keeps exactly that outcome — same error, same message — instead of
   * inventing a bridge error code or continuing with `undefined`.
   */
  #requireRow<T>(row: T | null, field: string): asserts row is T {
    if (row === null) throw new TypeError(`Cannot read properties of null (reading '${field}')`);
  }

  /**
   * Start a session, or adopt the one already recorded for this idempotency key. Session
   * creation is the ONE place the design allows an automatic retry, and only with a
   * preallocated sessionId and an identical cwd.
   *
   * The request is the IPC peer's parsed JSON: `taskId`, `cwd`, `clientKey` and `agentPreset` are
   * read as fields of unknown type, because the original validated none of them. (`clientTimeZone`
   * is documented for this call but was never read, here or below.)
   */
  async sessionStart({ taskId, cwd = null, clientKey, agentPreset = null }: Record<string, unknown>) {
    const task = this.#requireTask(taskId);
    const keyCheck = isIdempotencyKey(`session-start:${clientKey}`);
    if (!keyCheck.ok) throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'invalid client key', { reason: keyCheck.reason });

    // The intent's identity is (client key, cwd, preset) — NOT the preallocated host id,
    // which is minted once and then reused from the stored request. Including it would make
    // every retry look like a different payload and break key-based idempotency.
    const intent = { cwd, agentPreset };
    const { operation, created } = this.#store.reserveOperation({
      taskId: task.task_id,
      kind: 'session.create',
      idempotencyKey: `session-start:${clientKey}`,
      payload: intent,
    });
    this.#requireRow(operation, 'operation_id');

    const storedRequest = this.#store.latestOutboxPayload(operation.operation_id);
    // The stored request is the bridge's own JSON, but a value that is not a string cannot be a
    // host session id, so a non-string falls back exactly as a missing one did.
    const storedSessionId: unknown = storedRequest?.sessionId;
    const hostSessionId = typeof storedSessionId === 'string' ? storedSessionId : `session-${randomUUID()}`;
    const requestBody = storedRequest ?? { sessionId: hostSessionId, ...(cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) };

    if (!created) {
      // The preallocated host id lives in the stored request, so an operation whose response
      // we never saw can still be resolved: session.create is idempotent for that id.
      const existing = this.#store.findSessionByHostId(hostSessionId);
      if (existing) {
        return { session: shapeSession(existing), operation: shapeOperation(this.#store.getOperation(operation.operation_id)), reused: true };
      }
      const current = this.#store.getOperation(operation.operation_id);
      this.#requireRow(current, 'state');
      if (current.state === 'succeeded' || current.state === 'refused') {
        return { session: null, operation: shapeOperation(current), reused: true, result: { status: current.state === 'succeeded' ? 'ok' : 'refused' } };
      }
      // pending / dispatching / uncertain: fall through and reuse the SAME stored request,
      // which the contract makes idempotent for a preallocated sessionId with the same cwd.
    }

    const result = await this.#dispatch({
      operation: this.#store.getOperation(operation.operation_id),
      method: 'session.create',
      payload: requestBody,
      retryable: true,
      allowedStates: ['pending', 'uncertain'],
    });
    if (result.status !== 'ok') {
      return { session: null, operation: shapeOperation(this.#store.getOperation(operation.operation_id)), result };
    }
    // `result.value` is the adapter's own ok envelope (`{value, rpcId}`) and the Host's
    // `session.create` value is one level inside it, so the envelope is narrowed before the read
    // rather than asserted. An ok result always carries that envelope object, and a Host value that
    // is not an object is handed on as `undefined` — which reads exactly like the absent field the
    // original's `result.value.value` produced — so the preallocated host id stays the fallback.
    // The Host value itself is handed on as `unknown`: the original never inspected it either.
    const envelope: unknown = result.value;
    const hostValue: unknown = this.#isParsedObject(envelope) ? envelope.value : undefined;
    return this.#recordSessionFromCreate(task.task_id, hostValue, hostSessionId, cwd, operation.operation_id);
  }

// ---- source lines 316-753 (daemon-frag-b.ts) ----
  /**
   * @param value session.create response value
   */
  #recordSessionFromCreate(
    taskId: string,
    value: unknown,
    fallbackHostId: string,
    cwd: unknown,
    operationId: string,
  ) {
    // `value?.sessionId ?? fallbackHostId`, with the optional read and the nullish check preserved:
    // an absent value, an absent field and a `null`/`undefined` field all fall back to the
    // preallocated host id, which is the idempotent-retry path. `#str` keeps only a string, which is
    // what a Host session id is by contract: a value that is not one cannot name a session, so it
    // takes the same fallback the absent cases take.
    const hostSessionId = this.#isPropertyBag(value)
      ? (this.#str(value, 'sessionId') ?? fallbackHostId)
      : fallbackHostId;
    // `cwd` arrives in the same untyped frame as the ids and the column is text: a value that is
    // not a string cannot be a working directory, so it is recorded as absent instead of being
    // coerced into one.
    const cwdValue: string | null = typeof cwd === 'string' ? cwd : null;
    const sessionId = mintId('session');
    const session = this.#store.recordSession({ sessionId, taskId, hostSessionId, cwd: cwdValue });
    this.#store.audit({ taskId, kind: 'session-created', actor: 'daemon', detail: { hostSessionId } });
    return {
      // `shapeSession` reads `row.session_id` unconditionally, so a null row fails exactly as it
      // did in the original: a TypeError from the property read, not a new error.
      session: shapeSession(this.#presentRow(session, 'session_id')),
      operation: shapeOperation(this.#store.getOperation(operationId)),
      result: { status: 'ok' },
    };
  }

  // Every op below takes the gateway's request as what it actually is: an untyped JSON bag.
  // `mcp-tools.ts` builds `Record<string, unknown>` requests (after checking each field against the
  // tool schema) and `ipc.ts` documents the handler as the only place that decides what a
  // well-formed request is, so each field is narrowed where it is used rather than at the boundary.

  #serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#sessions.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive without leaking a rejected tail into the next caller.
    this.#sessions.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  sessionState({ taskId, sessionId }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    // `session.session_id` is the id `#requireSession` just matched by primary key, i.e. the same
    // string: the queue, the dispatch holds and the operation rows are all keyed by it.
    const localId = session.session_id;
    const cursor = this.#store.readCursor({ taskId: session.task_id, sessionId: localId });
    const openTurn = this.#store.currentOpenTurn(localId);
    const operations = this.#store.listOperations(session.task_id)
      .filter((row) => row.session_id === localId);
    const interactions = this.#store.listInteractions(session.task_id);
    const held = this.#dispatchHolds.get(localId) === true;
    return {
      session: shapeSession(session),
      connection: this.#connection,
      execution: {
        state: openTurn ? 'running' : 'idle',
        currentTurnId: openTurn?.turn_id ?? null,
        // A terminal reason is only ever recorded from an authoritative terminal event.
        lastTerminalReason: lastTerminalReason(this.#store, localId),
      },
      cursor: cursor.status === 'expired'
        ? { status: 'CURSOR_EXPIRED', detail: 'cursor was bound to a different store generation' }
        : (cursor.cursor
          ? {
            status: 'ok',
            lastSeq: Number(cursor.cursor.last_seq),
            completedThrough: Number(cursor.cursor.completed_through ?? cursor.cursor.last_seq),
            highWater: Number(cursor.cursor.high_water),
            completeness: cursor.cursor.completeness,
            gapFrom: cursor.cursor.gap_from,
            gapTo: cursor.cursor.gap_to,
          }
          : { status: 'ok', lastSeq: -1, completedThrough: -1, highWater: -1, completeness: 'unknown' }),
      queue: {
        local: (this.#queue.get(localId) ?? []).map((item) => ({ operationId: item.operationId, state: item.state })),
        localScope: 'daemon',
        dispatchHeld: held,
      },
      operations: operations.slice(-20).map(shapeOperation),
      interactions: interactions.filter((row) => row.session_id === localId).map(shapeInteraction),
      events: this.#store.countEvents(session.task_id, localId),
    };
  }

  /**
   * Incremental event paging with explicit completeness.
   */
  sessionEvents({ taskId, sessionId, beforeSeq = null, limit = 50 }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, this.#limits.eventPageMax));
    const rows = beforeSeq === null
      ? this.#store.pageEvents({ taskId: session.task_id, sessionId: session.session_id, limit: bounded })
      : this.#store.pageEvents({ taskId: session.task_id, sessionId: session.session_id, beforeSeq: Number(beforeSeq), limit: bounded });
    const cursor = this.#store.getCursor(session.task_id, session.session_id);
    return {
      // The reply carries the ids `#requireSession` just matched, i.e. the same strings that
      // arrived; the pages above are keyed by the stored session, not by the frame's copy of it.
      sessionId: session.session_id,
      taskId: session.task_id,
      events: rows.map((row) => ({
        seq: Number(row.seq),
        kind: row.kind,
        // The owning session travels with every event: a caller must never have to infer
        // which session an event belongs to, and a test can check for cross-session leakage.
        sessionId: row.session_id,
        at: Number(row.stored_at),
        payload: safeJson(row.payload_json),
      })),
      hasMore: rows.length === bounded,
      cursorStatus: cursor ? 'ok' : 'unknown',
      completeness: cursor?.completeness ?? 'unknown',
      completedThrough: cursor ? Number(cursor.completed_through ?? cursor.last_seq) : null,
      highWater: cursor ? Number(cursor.high_water) : null,
      // `cursor?.gap_from != null` is the original's loose comparison: a null or undefined
      // `gap_from` yields null, any number (including 0) yields the gap range.
      gap: cursor?.gap_from != null ? { from: Number(cursor.gap_from), to: Number(cursor.gap_to) } : null,
    };
  }

  /**
   * Bounded, event-driven wait. Register-then-recheck: the state is read once after
   * registration, so a change landing between the two cannot be missed.
   */
  async sessionWait({ taskId, sessionId, timeoutMs = null, sinceSeq = null }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    const bounded = Math.max(50, Math.min(Number(timeoutMs) || this.#limits.waitDefaultMs, this.#limits.waitMaxMs));
    const deadline = Date.now() + bounded;
    const startCount = this.#store.countEvents(session.task_id, session.session_id);
    // Recheck after registering the wait condition: read once, then poll a monotonic counter.
    for (;;) {
      const openTurn = this.#store.currentOpenTurn(session.session_id);
      const count = this.#store.countEvents(session.task_id, session.session_id);
      const cursor = this.#store.getCursor(session.task_id, session.session_id);
      if (!openTurn) {
        return {
          reason: this.#store.listTurns(session.session_id).length === 0 ? 'no-turn-observed' : 'turn-ended',
          terminalReason: lastTerminalReason(this.#store, session.session_id),
          events: count - startCount,
          connection: this.#connection,
          completeness: cursor?.completeness ?? 'unknown',
        };
      }
      if (Date.now() >= deadline) {
        return {
          reason: 'timeout',
          turnId: openTurn.turn_id,
          events: count - startCount,
          connection: this.#connection,
          completeness: cursor?.completeness ?? 'unknown',
          note: 'turn still open at the deadline; execution state is unaffected by this wait ending',
        };
      }
      if (this.#connection !== 'ready') {
        return {
          reason: 'disconnected',
          turnId: openTurn.turn_id,
          connection: this.#connection,
          note: 'connection loss does not prove the turn stopped',
        };
      }
      await delay(25);
    }
  }

  /**
   * Cancel the active turn. Turn cancellation and queue clearing are separate operations and
   * are reported separately; a cancel ack never proves a subprocess stopped.
   */
  async sessionCancel({ taskId, sessionId, clientKey }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    // The intent payload keeps the frame's own session id verbatim (its digest is the idempotency
    // identity); the row reference is the id `#requireSession` matched.
    const { operation, created } = this.#store.reserveOperation({
      taskId: session.task_id, kind: 'session.cancel', idempotencyKey: `cancel:${clientKey}`,
      payload: { sessionId }, sessionId: session.session_id,
    });
    // One read of the reserved row's id; both branches below address that same operation.
    const operationId = this.#presentRow(operation, 'operation_id').operation_id;
    if (!created) {
      return { operation: shapeOperation(this.#store.getOperation(operationId)), reused: true };
    }
    return this.#serialize(session.session_id, async () => {
      // Freeze the next local dispatch while the target turn is checked.
      this.#dispatchHolds.set(session.session_id, true);
      try {
        const openTurn = this.#store.currentOpenTurn(session.session_id);
        const result = await this.#dispatch({
          operation: this.#store.getOperation(operationId),
          method: 'session.cancel',
          payload: { sessionId: session.host_session_id },
          allowedStates: ['pending'],
        });
        return {
          operation: shapeOperation(this.#store.getOperation(operationId)),
          target: openTurn ? { turnId: openTurn.turn_id, scope: 'local-open-turn' } : { turnId: null, scope: 'no-open-turn' },
          result: { status: result.status, ...(result.error ? { error: result.error } : {}) },
          processEvidence: {
            observed: false,
            reason: 'the Host exposes no receipt for tool subprocess termination; only a turn-level ack is available',
          },
          note: result.status === 'uncertain'
            ? 'cancel outcome unproven: the turn may or may not have stopped'
            : 'cancel acknowledged for the turn only; queued work and subprocesses are unaffected by this ack',
        };
      } finally {
        this.#dispatchHolds.set(session.session_id, false);
      }
    });
  }

  /**
   * Clear the daemon's local queue. The remote queue is a different scope and is reported
   * separately: session-level cancellation cannot safely target an old turn when external
   * writers may have advanced the session.
   */
  queueClear({ taskId, sessionId }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    const removed = this.#queue.get(session.session_id) ?? [];
    this.#queue.set(session.session_id, []);
    return {
      localRemoved: removed.length,
      localScope: 'daemon',
      remoteScope: {
        cleared: false,
        reason: 'remote queue clearing requires a queue item id observed from the Host queue snapshot',
      },
    };
  }

  interactionList({ taskId, state = null }: Record<string, unknown>) {
    const task = this.#requireTask(taskId);
    // `task.task_id` is the id that lookup just matched, i.e. the same string. The store's filter
    // is a string by contract and anything else cannot name a stored state, so a non-string is
    // filtered as absent — reachable only from a hand-built frame, since the tool schema checks it.
    const stateFilter: string | null = typeof state === 'string' ? state : null;
    return { interactions: this.#store.listInteractions(task.task_id, stateFilter).map(shapeInteraction) };
  }

  /**
   * Decide an approval/question. Requires the operator authority token; a model-accessible
   * tool cannot reach this. The decision is a compare-and-set: a duplicate identical decision
   * is idempotent, a conflicting or stale one is rejected.
   */
  interactionDecide({ taskId, interactionId, decision, authorityToken, reason = null }: Record<string, unknown>) {
    // The frame's task id as a stored id can be: `mintId` only ever mints strings, so a non-string
    // can never equal one, which is the branch the comparison below takes for it either way.
    const taskIdValue: string | null = typeof taskId === 'string' ? taskId : null;
    const expected = readAuthorityToken(this.#stateDir);
    if (!expected) {
      throw new BridgeError(ERROR_CODES.APPROVAL_UNAUTHORIZED, 'no authority token exists in this state directory', {});
    }
    // `typeof authorityToken !== 'string'` is the original's own first condition, not an addition.
    if (typeof authorityToken !== 'string' || createDigest(authorityToken) !== createDigest(expected)) {
      this.#store.audit({ taskId: taskIdValue, kind: 'approval-unauthorized', actor: 'unknown', detail: { interactionId } });
      throw new BridgeError(ERROR_CODES.APPROVAL_UNAUTHORIZED, 'authority token rejected', { interactionId });
    }
    // A non-string interaction id cannot be a stored primary key, so it finds no row and takes the
    // original's not-found branch; the detail keeps the value exactly as it arrived.
    const interaction = typeof interactionId === 'string' ? this.#store.getInteraction(interactionId) : null;
    if (!interaction) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'interaction not found', { interactionId });
    if (interaction.task_id !== taskIdValue) {
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'interaction belongs to another task', { interactionId });
    }
    // Truthiness, not a null check: an `expires_at` of 0 is treated as "no expiry" here exactly as
    // it was in the original. The staleness arithmetic itself is unchanged.
    if (interaction.expires_at && Date.now() > Number(interaction.expires_at)) {
      return this.#decideAndReport(interaction, 'expired', 'expired-before-decision');
    }
    // `typeof decision !== 'string'` short-circuits into the same rejection the original's
    // `includes` test produced for it, and narrows the value the CAS below is given.
    if (typeof decision !== 'string' || !['allowed-once', 'rejected'].includes(decision)) {
      throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'decision must be allowed-once or rejected', { decision });
    }
    // The delivery row is keyed by the interaction's own task, which the check above has just shown
    // to be the frame's task id.
    const previousDelivery = this.#store.getResponseDelivery(interaction.task_id, interaction.host_rpc_id);
    if (previousDelivery && previousDelivery.outcome === 'not-pending') {
      return {
        interaction: shapeInteraction(interaction),
        delivered: false,
        receipt: 'not-pending',
        note: 'the host has no pending request for this rpc id; the interaction was already resolved, expired or replayed',
      };
    }
    const reasonValue: string | null = typeof reason === 'string' ? reason : null;
    const cas = this.#store.decideInteraction({
      interactionId: interaction.interaction_id, decision, reason: reasonValue,
    });
    if (!cas.applied) {
      // `cas.interaction` is declared nullable but is the row the CAS just read; the original read
      // its fields directly, so the failure mode is a TypeError and stays one.
      const current = this.#presentRow(cas.interaction, 'decision');
      if (current.decision === decision) {
        return { interaction: shapeInteraction(current), delivered: false, receipt: 'duplicate', note: 'identical decision already applied' };
      }
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'interaction already decided with a different decision', {
        interactionId, previous: current.state,
      });
    }
    // Delivery is asynchronous and its receipt is reported honestly, never as the outcome.
    // `shapeInteraction` tolerates a null row, so the applied path keeps the original's tolerance.
    return {
      interaction: shapeInteraction(cas.interaction),
      decision,
      delivery: 'pending-async',
      note: 'the host receipt arrives asynchronously and may be not-pending; the resolved frame is the outcome',
    };
  }

  #decideAndReport(interaction: InteractionRow, state: string, reason: string) {
    this.#store.decideInteraction({ interactionId: interaction.interaction_id, decision: state, reason });
    return {
      interaction: shapeInteraction(this.#store.getInteraction(interaction.interaction_id)),
      delivered: false,
      receipt: state,
      note: reason,
    };
  }

  opGet({ operationId }: Record<string, unknown>) {
    // A non-string cannot be an operation primary key, so it finds no row and takes the original's
    // not-found branch; the detail keeps the value exactly as it arrived.
    const operation = typeof operationId === 'string' ? this.#store.getOperation(operationId) : null;
    if (!operation) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'operation not found', { operationId });
    return { operation: shapeOperation(operation) };
  }

  /**
   * Register a bounded watch on one session's event stream. Returned immediately: a gateway
   * streams by polling pages with the returned cursor rather than holding an IPC socket open.
   */
  streamSubscribe({ taskId, sessionId }: Record<string, unknown>) {
    this.#requireSession(taskId, sessionId);
    return {
      subscriptionId: mintId('event'),
      mode: 'poll-pages',
      note: 'the daemon keeps the live subscription; callers page with session.events',
    };
  }

  // ---- private narrowing helpers (added by the TypeScript port; no counterpart in the JS) ----

  /**
   * The shape test for an untyped JSON value: non-null and `typeof 'object'`. Arrays are included
   * because JavaScript property access treats them as objects, so this is the honest equivalent of
   * the direct property read the original performed (`value?.sessionId`, `details?.hostCode`).
   * A value parsed out of JSON is never a function, so the `typeof` test loses nothing.
   */
  #isPropertyBag(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * One unconditional property read off an untyped value, with JavaScript's own semantics: a
   * missing field is `undefined`, and `null`/`undefined` throw a TypeError (V8's own message shape)
   * rather than silently becoming a default. This is `result.value.value` in `#dispatch`: a read of
   * the Host's value that must not be quietly re-interpreted as a second unwrap.
   */
  #fieldOf(value: unknown, field: string): unknown {
    if (value === null || value === undefined) {
      throw new TypeError(`Cannot read properties of ${String(value)} (reading '${field}')`);
    }
    return this.#isPropertyBag(value) ? value[field] : undefined;
  }

  /**
   * Narrow a store read that the calling path has already proven present.
   *
   * Several rows here are read out of the store and dereferenced immediately (`fresh.state`,
   * `current.state`, `cas.interaction.decision`, the row handed to `shapeSession`), and every one of
   * them is the row this code reserved or wrote one statement earlier, so the null branch is
   * unreachable. It is not turned into a new error: the original read the field off the row and a
   * null row produced a TypeError from that read, which is what this produces too.
   */
  #presentRow<T>(row: T | null, field: string): T {
    if (row === null) {
      throw new TypeError(`Cannot read properties of null (reading '${field}')`);
    }
    return row;
  }

  #requireTask(taskId: unknown): TaskRow {
    // The frame is parsed JSON: an id that is not a string cannot name a task this daemon recorded
    // (every id it mints is a string), so it takes the not-found path rather than being coerced.
    const task = typeof taskId === 'string' ? this.#store.getTask(taskId) : null;
    if (!task) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'task not found', { taskId });
    if (task.host_base !== this.hostBase) {
      throw new BridgeError(ERROR_CODES.CONFLICT, 'task belongs to a different host', { taskId });
    }
    return task;
  }

  #requireSession(taskId: unknown, sessionId: unknown): SessionRow {
    const task = this.#requireTask(taskId);
    // Same narrowing, same reason: a non-string session id cannot be a stored primary key.
    const session = typeof sessionId === 'string' ? this.#store.getSession(sessionId) : null;
    if (!session || session.task_id !== task.task_id) {
      throw new BridgeError(ERROR_CODES.NOT_FOUND, 'session not found in this task', { sessionId });
    }
    return session;
  }

// ---- source lines 333-431 (daemon-frag-e.ts) ----
  /**
   * Send one operation's request after committing `dispatching`, then record the outcome.
   * Never retries unless the caller passes `retryable` AND the contract makes it idempotent.
   *
   * The input arrives as a field bag because that is what `handleIpc` holds: an IPC frame is the
   * peer's already-parsed JSON, so every field is `unknown` until it is narrowed here. `operation`
   * may legitimately be absent (the caller passes the nullable result of `#store.getOperation`),
   * which is why the null arm below is a real branch rather than an assertion.
   */
  async #dispatch({ operation, method, payload, allowedStates, retryable }: {
    operation: OperationRow | null;
    method: string;
    payload: object;
    allowedStates: readonly string[];
    /**
     * Part of the caller's declared contract and deliberately unread: the original never branched
     * on it either. It is named here so the shape is honest about what callers pass rather than
     * pretending the field does not exist.
     */
    retryable?: boolean;
  }): Promise<AdapterCallResult> {
    const fresh = this.#store.getOperation(
      this.#presentRow(operation, 'operation_id').operation_id,
    );
    // The row is read back from the id just reserved, so the null arm is unreachable; the read is
    // preserved rather than asserted, and a null row fails exactly as it did before.
    const freshRow: OperationRow = this.#presentRow(fresh, 'state');
    if (!allowedStates.includes(freshRow.state)) {
      return {
        status: 'refused',
        error: new BridgeError(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `operation is ${freshRow.state} and a dispatch is not allowed from that state`,
          { operationId: freshRow.operation_id, state: freshRow.state },
        ).toJSON(),
      };
    }
    if (freshRow.state === 'pending') {
      this.#store.markDispatching({
        operationId: freshRow.operation_id,
        method,
        endpoint: `/api/${method}`,
        payload,
      });
    }
    const result: AdapterCallResult = await this.#adapter.call(method, payload);
    if (result.status === 'ok') {
      // The `value` read is preserved verbatim from the original: `AdapterCallResult.value` is the
      // adapter's ok envelope (`{value, rpcId}`), so this reads one level inside it. Narrowing the
      // envelope rather than casting it keeps a non-object value reading as the absent field the
      // original produced, instead of putting an `any` back into the durable write.
      this.#store.markAcknowledged({
        operationId: freshRow.operation_id,
        ok: true,
        value: this.#isPropertyBag(result.value) ? result.value['value'] : undefined,
      });
    } else if (result.status === 'refused') {
      // Preserve the host's own business code (for example `session-conflict`): the generic
      // HOST_REFUSED code would erase which refusal actually happened. A `hostCode` that is not a
      // string falls through to `error.code`, exactly as an absent one did.
      const hostCode: unknown = this.#isPropertyBag(result.error?.details)
        ? result.error?.details['hostCode']
        : undefined;
      this.#store.markAcknowledged({
        operationId: freshRow.operation_id,
        ok: false,
        error: {
          code: typeof hostCode === 'string' ? hostCode : result.error?.code,
          message: result.error?.message,
        },
      });
    } else {
      // Possibly sent and unproven: stays uncertain. No automatic retry.
      this.#store.markUncertain({
        operationId: freshRow.operation_id,
        reason: result.reason ?? 'unproven-outcome',
        evidence: { method, at: Date.now() },
      });
    }
    return result;
  }

  /**
   * Send a prompt into a session, durably. Serialized per session; concurrent across sessions.
   *
   * The request is the IPC peer's parsed JSON, so each field is narrowed where it is used:
   * `taskId`/`sessionId` by `#requireSession` (a non-string finds no session and takes the original
   * NOT_FOUND path), `clientKey` by the idempotency check below, and `text` by the length test the
   * original already performed.
   */
  async sessionPrompt({ taskId, sessionId, text, mode = 'queue', clientKey, clientTimeZone = null }: Record<string, unknown>): Promise<
    | { operation: ReturnType<typeof shapeOperation>; reused: boolean; note?: string }
    | {
      operation: ReturnType<typeof shapeOperation>;
      result: { status: string; error?: { readonly code?: string; readonly message?: string; readonly details?: object } };
    }
  > {
    const session = this.#requireSession(taskId, sessionId);
    // The session row carries the same two ids as the strings the store read back, and every use
    // below is the store's own key again (the operation row, the serialization chain). Binding them
    // from the row rather than the raw frame cannot select a different branch: a frame carrying a
    // non-string already threw NOT_FOUND inside `#requireSession`.
    const taskKey: string = session.task_id;
    const sessionKey: string = session.session_id;
    if (typeof text !== 'string' || text.length === 0) {
      throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'prompt text must be a non-empty string', {});
    }
    if (text.length > 64 * 1024) {
      throw new BridgeError(ERROR_CODES.OVERSIZE, 'prompt text exceeds 64KiB', { length: text.length });
    }
    const keyCheck = isIdempotencyKey(`prompt:${clientKey}`);
    if (!keyCheck.ok) throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'invalid client key', { reason: keyCheck.reason });

    const payload = { sessionId, mode, text };
    const { operation, created } = this.#store.reserveOperation({
      taskId: taskKey, kind: 'session.prompt', idempotencyKey: `prompt:${clientKey}`,
      payload, sessionId: sessionKey,
    });
    // The row was just reserved on this id, so the null arm is unreachable; the read is kept
    // because the original read the field off the row, and a null row fails the same way here.
    const reservedId: string = this.#presentRow(operation, 'operation_id').operation_id;
    if (!created) {
      const current = this.#presentRow(this.#store.getOperation(reservedId), 'state');
      if (current.state === 'succeeded' || current.state === 'refused') {
        return { operation: shapeOperation(current), reused: true };
      }
      // An existing uncertain intent is NOT re-sent: report it and let a human/caller decide.
      if (current.state === 'uncertain') {
        return { operation: shapeOperation(current), reused: true, note: 'previously-sent-outcome-unknown' };
      }
      // pending or dispatching from a concurrent call with the same key: report, do not double-send.
      return { operation: shapeOperation(current), reused: true, note: 'in-flight' };
    }

    return this.#serialize(sessionKey, async () => {
      const result = await this.#dispatch({
        operation: this.#store.getOperation(reservedId),
        method: 'session.prompt',
        payload: {
          sessionId: session.host_session_id,
          mode,
          content: [{ type: 'text', text }],
          ...(clientTimeZone ? { clientTimeZone } : {}),
        },
        allowedStates: ['pending'],
      });
      // Note: no turn record is opened here. Whether a turn is running is a claim that must
      // come from the Host's own turn/start event; inferring it from an accepted prompt would
      // manufacture execution state that no observation supports.
      return {
        operation: shapeOperation(this.#store.getOperation(reservedId)),
        result: { status: result.status, ...(result.error ? { error: result.error } : {}) },
      };
    });
  }

// ---- source lines 0-0 (daemon-frag-helpers.ts) ----
  /**
   * Read one string field out of a parsed frame, or `null` if it is absent or not a string.
   *
   * Why this exists: the daemon's public methods receive the IPC peer's already-parsed JSON, so a
   * field arrives as `unknown`. The original JavaScript read such a field and passed it straight to a
   * string-typed collaborator (a store key, a column, a queue key). Narrowing at the read keeps that
   * honest without a cast, and a non-string takes the same "not found" path the original took when
   * the lookup missed — it never reaches a collaborator as a non-string.
   */
  #str(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];
    return typeof value === 'string' ? value : null;
  }

  /**
   * True when a parsed value is a JSON object usable as a field bag.
   *
   * Why this exists: every frame and every Host reply value crosses in as `unknown`, and reading a
   * field off it requires saying what "an object" means. `typeof === 'object'` with a null check is
   * the whole test the untyped original relied on — JSON has no functions, so there is nothing else
   * to exclude.
   */
  #isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Read a frame's `sessionId`, or `null` when there is no session to look up.
   *
   * Why this is not a plain narrowing: what the original did with a non-string member was
   * node:sqlite's decision, not the daemon's, and that decision was **measured** rather than guessed.
   * Only an absent or boolean member is a parameter the store refuses — those threw and reached the
   * ingest loop's catch, which counts them as malformed and reconnects, so they still throw here
   * rather than being quietly swallowed (a swallow would change the `malformed` counter). A `null`,
   * number or bigint binds happily and simply matches no row, and an object argument is read by
   * node:sqlite as a bag of *named* parameters: an empty one binds nothing and answers "no such
   * session", a non-empty one is refused like a boolean. Answering `null` for the binding-but-not-
   * matching cases is therefore faithful, and the measured differential (84/84 frame-pairs agreeing
   * with the JavaScript original) is what makes that a fact rather than a reading.
   */
  #frameSessionId(frame: Record<string, unknown>): string | null {
    const value = frame['sessionId'];
    if (typeof value === 'string') {
      // An empty string reached the store in the original and simply matched no row.
      return value === '' ? null : value;
    }
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return null;
    // An object argument is read by node:sqlite as a bag of NAMED parameters: an empty one binds
    // nothing and still answers "no such session", a non-empty one is refused like a boolean.
    if (Array.isArray(value) && value.length === 0) return null;
    if (typeof value === 'object' && Object.keys(value).length === 0) return null;
    throw new TypeError('Provided value cannot be bound to SQLite parameter 1.');
  }

// ---- source lines 733-1020 (daemon-frag-f.ts) ----
  /**
   * Start the mux ingest loop. Frames become durable events keyed by their native sequence,
   * and a gap in that sequence is recorded as explicit incompleteness rather than hidden.
   * @returns resolves once the loop is running (or the attempt failed)
   */
  async startEventIngest(): Promise<void> {
    if (this.#eventAbort) return;
    this.#eventAbort = new AbortController();
    const signal = this.#eventAbort.signal;
    const loop = async () => {
      let backoffMs = 50;
      while (!signal.aborted) {
        this.#connection = this.#eventStats.frames === 0 ? 'connecting' : 'reconciling';
        try {
          const ws = await this.#adapter.openMux({ signal, maxFrameBytes: this.#limits.frameMaxBytes });
          this.#connection = 'ready';
          backoffMs = 50;
          for await (const text of ws.frames) {
            this.#ingestFrame(text);
          }
          this.#connection = 'disconnected';
        } catch (error) {
          this.#connection = 'disconnected';
          const code = toBridgeError(error).code;
          if (code === ERROR_CODES.OVERSIZE) this.#eventStats.oversize += 1;
          else this.#eventStats.malformed += 1;
        }
        if (signal.aborted) break;
        this.#eventStats.reconnects += 1;
        // Reconnect means reopen AND refetch history, because the mux `since` hook is
        // unimplemented in v1: reopening alone cannot prove continuity.
        await this.refetchHistoryForKnownSessions();
        await delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 1_000);
      }
    };
    // Run detached: the daemon must serve IPC while the downlink is down.
    loop().catch(() => { /* the loop reports its own state through #connection */ });
  }

  /**
   * Parse one mux frame and persist it when it carries a session event.
   * @param text raw frame
   */
  #ingestFrame(text: string): void {
    this.#eventStats.frames += 1;
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      this.#eventStats.malformed += 1;
      return;
    }
    // `envelope?.payload ?? envelope`: a mux frame wraps a session event in a `payload` envelope,
    // while some frames carry their fields at the top level. `??` (not `||`) is the original's, so a
    // present-but-falsy `payload` still wins. Every read below is a property read on the result, so
    // a non-object envelope reads as `{}` — which is what an optional read off it produced.
    const envelopeFields: Record<string, unknown> = this.#isPropertyBag(envelope) ? envelope : {};
    const payload: unknown = envelopeFields['payload'] ?? envelope;
    const frame: Record<string, unknown> = this.#isPropertyBag(payload) ? payload : {};
    // Answerable frames carry the Host's own rpcId; it must be preserved verbatim so a
    // decision can echo exactly the id the Host is waiting on (and a replayed frame is
    // recognisable as the same interaction rather than a new one).
    const hostRpcId = String(envelopeFields['rpcId'] ?? '');
    if (frame['type'] === 'approval/requested' || frame['type'] === 'question/requested') {
      // A non-string id cannot go into the TEXT column, and the `??` chain is preserved exactly:
      // only a nullish `approvalId` falls through to the question id, which is what the original did.
      const rawNativeId: unknown = frame['approvalId'] ?? frame['questionId'] ?? null;
      const nativeId: string | null = typeof rawNativeId === 'string' ? rawNativeId : null;
      const hostSessionId = this.#frameSessionId(frame);
      const session = hostSessionId === null ? null : this.#store.findSessionByHostId(hostSessionId);
      if (!session) return; // never adopt a session we do not own
      const kind = typeof frame['type'] === 'string' && frame['type'].startsWith('approval') ? 'approval' : 'question';
      this.#store.recordInteraction({
        taskId: session.task_id,
        sessionId: session.session_id,
        turnId: this.#store.currentOpenTurn(session.session_id)?.turn_id ?? null,
        kind,
        hostRpcId,
        nativeId,
        // Store only the shape we act on: no unbounded host payload is copied into state.
        payload: {
          toolName: typeof frame['toolName'] === 'string' ? frame['toolName'].slice(0, 200) : null,
          reason: typeof frame['reason'] === 'string' ? frame['reason'].slice(0, 500) : null,
          nativeId,
        },
        expiresAt: Number.isFinite(Number(frame['expiresAt'])) ? Number(frame['expiresAt']) : null,
      });
      return;
    }
    if (frame['type'] === 'approval/resolved' || frame['type'] === 'question/resolved') {
      // The resolved frame is the authoritative outcome; the delivery receipt only said
      // whether the Host still had the request pending.
      const interaction = this.#store.getInteractionByRpcId(hostRpcId);
      if (interaction && interaction.state === 'pending') {
        const outcome = String(frame['outcome'] ?? frame['result'] ?? 'resolved');
        const decision = outcome.includes('reject') ? 'rejected'
          : outcome.includes('cancel') ? 'revoked'
            : outcome.includes('expire') ? 'expired'
              : 'answered';
        this.#store.decideInteraction({ interactionId: interaction.interaction_id, decision, reason: 'host-resolved-frame' });
      }
      return;
    }
    if (frame['type'] !== 'session/event') return;
    const hostSessionId = this.#frameSessionId(frame);
    const session = hostSessionId === null ? null : this.#store.findSessionByHostId(hostSessionId);
    if (!session) return; // not one of our sessions: never adopt it
    const eventFields: Record<string, unknown> = this.#isPropertyBag(frame['event']) ? frame['event'] : {};
    const seq = Number(eventFields['seq'] ?? eventFields['sequence']);
    if (!Number.isFinite(seq)) {
      this.#eventStats.malformed += 1;
      return;
    }
    // Dedupe against what is actually stored, not against the cursor: the cursor tracks the
    // contiguous run (which can end before the highest stored sequence), so using it here
    // would re-store events already held, or drop genuinely new ones.
    if (this.#store.hasEvent(session.task_id, session.session_id, seq)) {
      this.#eventStats.duplicates += 1;
      return;
    }
    const before = this.#store.eventCoverage(session.task_id, session.session_id);
    const inserted = this.#store.appendEvent({
      taskId: session.task_id,
      sessionId: session.session_id,
      seq,
      kind: String(eventFields['type'] ?? 'unknown'),
      payload: { nativeType: eventFields['type'] ?? null, raw: frame['event'] ?? null },
    });
    if (inserted) this.#eventStats.stored += 1;
    else this.#eventStats.duplicates += 1;
    const after = this.#recomputeCursor(session.task_id, session.session_id);
    // Count a gap once, when it FIRST appears for this session, rather than on every frame
    // that is observed while the hole is still open.
    if (inserted && after && after.completeness === 'incomplete' && before.missing.length === 0) {
      this.#eventStats.gaps += 1;
    }
    this.#applyEventToState(session.session_id, frame['event']);
  }

  /**
   * Fold an event into daemon state. A turn is closed only by a terminal event that names
   * that turn; an `idle`-looking or stale message never terminates a new turn.
   * @param sessionId
   * @param event
   */
  #applyEventToState(sessionId: string, event: unknown): void {
    const fields: Record<string, unknown> = this.#isPropertyBag(event) ? event : {};
    const type = fields['type'];
    if (type === 'turn/start') {
      const open = this.#store.currentOpenTurn(sessionId);
      if (!open) {
        // Store the host's turn number as a real number or null — never as NaN, which would
        // fail every later comparison and leave the turn unclosable.
        const hostTurn = Number(fields['turn']);
        this.#store.openTurn({
          turnId: mintId('turn'),
          sessionId,
          hostTurn: Number.isFinite(hostTurn) ? hostTurn : null,
        });
      }
      return;
    }
    if (type === 'turn/end') {
      const open = this.#store.currentOpenTurn(sessionId);
      if (!open) return;
      const endSeq = Number(fields['seq']);
      const openHostTurn = open.host_turn;
      const endTurn = Number(fields['turn']);
      // Authoritative binding. A terminal event closes a turn only when it NAMES that turn:
      //  - if the open turn carries no host turn number, a numbered terminal event belongs to
      //    some other turn and must be ignored;
      //  - if it names a different number, it is stale or foreign and must be ignored too.
      // Guessing here is how a stray "idle" or a replayed end silently reports a live turn as
      // finished, so the unknown case is refused rather than adopted.
      if (Number.isFinite(endTurn)) {
        if (!Number.isFinite(openHostTurn) || endTurn !== openHostTurn) return;
      } else if (Number.isFinite(openHostTurn)) {
        // An unnumbered terminal event is only usable while the open turn is itself
        // unnumbered, where it is the sole candidate. Once the open turn IS bound to a host
        // turn number, an event that names nothing cannot be shown to be about it.
        return;
      }
      if (!Number.isFinite(endSeq)) return;
      const outcome = String(fields['outcome'] ?? fields['reason'] ?? 'completed');
      const state = outcome.includes('cancel') ? 'cancelled'
        : outcome.includes('fail') || outcome.includes('error') ? 'failed'
          : 'completed';
      this.#store.closeTurn({ turnId: open.turn_id, state, reason: `authoritative turn/end at seq ${endSeq}` });
    }
  }

  /**
   * Recompute a session's cursor from what the store actually holds.
   *
   * The rule, stated so it can be checked: a sequence is `missing` iff it lies between the
   * first stored sequence and the highest stored sequence and is not present. Holes below the
   * first stored sequence are unreachable — a session's stream legitimately starts at 1 while
   * a client that attached late may only ever receive a later window — so they are not gaps.
   * Completeness is therefore a pure function of the stored set, which is what makes it
   * idempotent under replay and immune to arrival order.
   * @param taskId @param sessionId
   */
  #recomputeCursor(taskId: string, sessionId: string): CursorRow | null {
    const coverage = this.#store.eventCoverage(taskId, sessionId);
    if (coverage.first === null) return null;
    const hasGap = coverage.missing.length > 0;
    return this.#store.putCursor({
      taskId,
      sessionId,
      // last_seq is the end of the contiguous run that can be proven from the stored rows.
      lastSeq: coverage.contiguousThrough,
      completedThrough: coverage.contiguousThrough,
      // high_water is the highest sequence ever stored, gap or not.
      highWater: coverage.highest,
      completeness: hasGap ? 'incomplete' : 'complete',
      gapFrom: hasGap ? coverage.missing[0].from : null,
      gapTo: hasGap ? coverage.missing[coverage.missing.length - 1].to : null,
    });
  }

  /**
   * Refetch history for known sessions after a reconnect, to reconcile anything missed while
   * the downlink was down. Only sequences absent from the store are appended.
   * @returns the number of sessions swept and the number of events appended
   */
  async refetchHistoryForKnownSessions(): Promise<{ sessions: number; appended: number }> {
    const tasks = this.#store.all<{ task_id: string }>('select distinct task_id from sessions');
    let sessions = 0;
    let appended = 0;
    for (const { task_id: taskId } of tasks) {
      for (const session of this.#store.listSessions(taskId)) {
        sessions += 1;
        // Refetch the WHOLE history page rather than "after last_seq": after a gap the
        // missing sequences are BELOW last_seq, and asking only for newer ones would make
        // the hole permanent while looking successful.
        const result = await this.#adapter.history({
          sessionId: session.host_session_id,
          maxMessages: this.#limits.eventPageMax,
        });
        if (result.status !== 'ok') continue;
        // `result.value` is the adapter's ok envelope, so the Host's own page is one level in.
        // Narrowing rather than casting keeps a non-object envelope reading as the absent field
        // the original produced.
        const page: unknown = this.#isPropertyBag(result.value) ? result.value['value'] : undefined;
        const events: readonly unknown[] = this.#isPropertyBag(page) && Array.isArray(page['events'])
          ? page['events']
          : [];
        const hasMore = this.#isPropertyBag(page) && page['hasMore'] === true;
        const observed: number[] = [];
        for (const entry of events) {
          const entryFields: Record<string, unknown> = this.#isPropertyBag(entry) ? entry : {};
          const event = entryFields['event'];
          const eventFields: Record<string, unknown> = this.#isPropertyBag(event) ? event : {};
          const seq = Number(eventFields['seq']);
          if (!Number.isFinite(seq)) continue;
          observed.push(seq);
          const inserted = this.#store.appendEvent({
            taskId, sessionId: session.session_id, seq,
            kind: String(eventFields['type'] ?? 'unknown'),
            payload: { nativeType: eventFields['type'] ?? null, raw: event ?? null, source: 'history-refetch' },
          });
          if (inserted) {
            appended += 1;
            this.#applyEventToState(session.session_id, event);
          }
        }
        if (!observed.length) continue;
        // Completeness is a pure function of the stored rows, so recomputing is enough — and
        // it is the honest answer: a hole the refetch filled disappears, and a hole it did
        // not fill stays reported.
        this.#recomputeCursor(taskId, session.session_id);
        // A page the host truncated proves only that it returned less than we asked for. The
        // store keeps whatever it holds and any hole inside it stays 'incomplete'; the
        // truncation is counted so the reason is inspectable rather than invisible.
        if (hasMore) this.#eventStats.historyTruncations += 1;
      }
    }
    return { sessions, appended };
  }
}

// ---- source lines 1014-1100 (daemon-frag-h.ts) ----
/**
 * Wait, without holding the process open.
 *
 * `unref` is why this is not a bare `setTimeout`: the ingest loop's backoff must not keep the
 * event loop alive on its own, or a daemon that has been asked to stop would linger until the
 * last backoff elapsed.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Parse stored JSON, answering `null` for anything unparseable.
 *
 * The return is `unknown` rather than `any`: the value came out of a TEXT column this process wrote
 * but no longer controls, so a caller must narrow it, which is exactly what the shapers' consumers
 * do.
 */
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param store
 * @param sessionId
 * @returns reason of the latest closed turn, if any
 */
function lastTerminalReason(store: Store, sessionId: string): string | null {
  const turns: TurnRow[] = store.listTurns(sessionId);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].state !== 'open') return turns[i].reason ?? turns[i].state;
  }
  return null;
}

/** The task shape handed to an MCP client; not exported because only this module builds it. */
interface ShapedTask {
  taskId: string;
  label: string | null;
  hostBase: string;
  hostScope: string;
  createdAt: number;
}

/**
 * @param row a `tasks` row. The row is read unconditionally, so a null row fails as a `TypeError`
 * on the property read — which is what the original did, rather than a new error code.
 */
function shapeTask(row: TaskRow): ShapedTask {
  return {
    taskId: row.task_id,
    label: row.label,
    hostBase: row.host_base,
    hostScope: row.host_scope,
    createdAt: Number(row.created_at),
  };
}

/** The session shape handed to an MCP client; not exported for the same reason as `ShapedTask`. */
interface ShapedSession {
  sessionId: string;
  taskId: string;
  hostSessionId: string;
  cwd: string | null;
  createdAt: number;
}

/**
 * @param row a `sessions` row. Read unconditionally, so a null row fails as a `TypeError`, as above.
 */
function shapeSession(row: SessionRow): ShapedSession {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    hostSessionId: row.host_session_id,
    cwd: row.cwd,
    createdAt: Number(row.created_at),
  };
}

/** The operation shape handed to an MCP client. */
export interface ShapedOperation {
  operationId: string;
  taskId: string;
  sessionId: string | null;
  kind: string;
  state: string;
  idempotencyKey: string;
  requestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  uncertainReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * @param row an `operations` row, or nothing when the id is unknown.
 * @returns the shaped row, or `null` for both a null and an absent row — the original refused both.
 */
export function shapeOperation(row: OperationRow | null | undefined): ShapedOperation | null {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    uncertainReason: row.uncertain_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** The interaction shape handed to an MCP client. */
export interface ShapedInteraction {
  interactionId: string;
  taskId: string;
  sessionId: string;
  kind: string;
  state: string;
  nativeId: string | null;
  payloadDigest: string;
  payload: unknown;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * @param row an `interactions` row, or nothing when the rpc id is unknown.
 * @returns the shaped row, or `null` for both a null and an absent row.
 */
export function shapeInteraction(row: InteractionRow | null | undefined): ShapedInteraction | null {
  if (!row) return null;
  return {
    interactionId: row.interaction_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    nativeId: row.native_id,
    payloadDigest: row.payload_digest,
    payload: safeJson(row.payload_json),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
  };
}
