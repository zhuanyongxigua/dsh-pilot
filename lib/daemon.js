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
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.js';
import { assertIdKind, createDigest, isIdempotencyKey, mintId, payloadDigest } from './ids.js';
import { Store } from './store.js';
import { OwnerLock } from './owner-lock.js';
import { DshHostAdapter } from './adapter.js';
import { startIpcServer, ensureAuthorityToken, readAuthorityToken } from './ipc.js';

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

export class Daemon {
  #stateDir;
  #store;
  #lock;
  #adapter;
  #ipc = null;
  #limits;
  #connection = 'disconnected';
  #sessions = new Map(); // sessionId -> queue tail promise
  #eventAbort = null;
  #eventStats = {
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
  #queue = new Map(); // sessionId -> local queue of pending prompts (daemon-owned)
  #dispatchHolds = new Map(); // sessionId -> boolean (hold next dispatch while cancelling)
  #localQueueMax = 64;
  #stopped = false;
  /** Result of the restart sweep, reported through health so a crash is inspectable. */
  #recovery = { sweptOperations: 0, uncertainOperationIds: [], at: null };

  /**
   * @param {object} options
   * @param {string} options.stateDir
   * @param {string} options.hostBase
   * @param {string} [options.hostScope] stable identifier of the controlled Host namespace
   * @param {object} [options.limits]
   */
  constructor({ stateDir, hostBase, hostScope = 'default', limits = {} }) {
    this.#stateDir = stateDir;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#lock = new OwnerLock({ lockPath: `${stateDir}/owner.lock.sqlite` });
    this.#store = new Store({ stateDir });
    this.#adapter = new DshHostAdapter({ baseUrl: hostBase, timeoutMs: 15_000 });
    this.hostBase = hostBase;
    this.hostScope = hostScope;
  }

  get store() { return this.#store; }
  get limits() { return { ...this.#limits }; }
  get connection() { return this.#connection; }
  get eventStats() { return { ...this.#eventStats }; }
  get adapter() { return this.#adapter; }
  get ipcPath() { return this.#ipc?.path ?? null; }

  /**
   * Start the daemon: ownership first, then recovery, then the IPC endpoint.
   *
   * Ordering matters and is asserted by a test: the owner lock is taken BEFORE an orphan IPC
   * socket is reclaimed, because reclaiming an endpoint you do not own would let a second
   * process answer calls meant for the owner.
   * @returns {Promise<{stateDir: string, socketPath: string, generation: number, recovery: object}>}
   */
  async start() {
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
   * @returns {{interrupted: number, uncertainOperations: string[]}}
   */
  recover() {
    const interrupted = this.#store.sweepInterruptedDispatches('crash-during-dispatch');
    return {
      interrupted: interrupted.length,
      uncertainOperations: interrupted.map((row) => row.operation_id),
    };
  }

  /** Stop the daemon cleanly: close ingest, close IPC, release ownership. */
  async stop() {
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
   * Handle one gateway request. Authorization for state-changing decisions is enforced here,
   * so no MCP tool can reach it.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async handleIpc(request) {
    const { op } = request ?? {};
    switch (op) {
      case 'health': return this.health();
      case 'task.ensure': return this.taskEnsure(request);
      case 'session.start': return this.sessionStart(request);
      case 'session.prompt': return this.sessionPrompt(request);
      case 'session.state': return this.sessionState(request);
      case 'session.events': return this.sessionEvents(request);
      case 'session.wait': return this.sessionWait(request);
      case 'interaction.list': return this.interactionList(request);
      case 'interaction.decide': return this.interactionDecide(request);
      case 'session.cancel': return this.sessionCancel(request);
      case 'queue.clear': return this.queueClear(request);
      case 'ops.get': return this.opGet(request);
      case 'stream.subscribe': return this.streamSubscribe(request);
      default:
        throw new BridgeError(ERROR_CODES.UNSUPPORTED, `unsupported ipc op: ${String(op)}`, { op });
    }
  }

  /** @returns {object} */
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
   * @param {{taskId?: string, label?: string, clientKey: string}} request
   * @returns {object}
   */
  taskEnsure({ taskId = null, label = null, clientKey }) {
    const key = clientKey ?? 'default';
    const existing = this.#store.get(`select * from tasks where label = ?`, `task:${key}`);
    if (existing) return { task: shapeTask(existing), created: false };
    const newTaskId = taskId ?? mintId('task');
    assertIdKind(newTaskId, 'task');
    const task = this.#store.createTask({
      taskId: newTaskId,
      label: `task:${key}`,
      hostBase: this.hostBase,
      hostScope: this.hostScope,
    });
    return { task: shapeTask(task), created: true };
  }

  /**
   * Start a session, or adopt the one already recorded for this idempotency key. Session
   * creation is the ONE place the design allows an automatic retry, and only with a
   * preallocated sessionId and an identical cwd.
   * @param {{taskId: string, cwd?: string, clientKey: string, clientTimeZone?: string}} request
   */
  async sessionStart({ taskId, cwd = null, clientKey, agentPreset = null }) {
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

    const storedRequest = this.#store.latestOutboxPayload(operation.operation_id);
    const hostSessionId = storedRequest?.sessionId ?? `session-${randomUUID()}`;
    const requestBody = storedRequest ?? { sessionId: hostSessionId, ...(cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) };

    if (!created) {
      // The preallocated host id lives in the stored request, so an operation whose response
      // we never saw can still be resolved: session.create is idempotent for that id.
      const existing = this.#store.findSessionByHostId(hostSessionId);
      if (existing) {
        return { session: shapeSession(existing), operation: shapeOperation(this.#store.getOperation(operation.operation_id)), reused: true };
      }
      const current = this.#store.getOperation(operation.operation_id);
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
    return this.#recordSessionFromCreate(task.task_id, result.value.value, hostSessionId, cwd, operation.operation_id);
  }

  /**
   * @param {string} taskId
   * @param {object} value session.create response value
   * @param {string} fallbackHostId
   * @param {string|null} cwd
   * @param {string} operationId
   */
  #recordSessionFromCreate(taskId, value, fallbackHostId, cwd, operationId) {
    const hostSessionId = value?.sessionId ?? fallbackHostId;
    const sessionId = mintId('session');
    const session = this.#store.recordSession({ sessionId, taskId, hostSessionId, cwd });
    this.#store.audit({ taskId, kind: 'session-created', actor: 'daemon', detail: { hostSessionId } });
    return {
      session: shapeSession(session),
      operation: shapeOperation(this.#store.getOperation(operationId)),
      result: { status: 'ok' },
    };
  }

  /**
   * Send a prompt into a session, durably. Serialized per session; concurrent across sessions.
   * @param {{taskId: string, sessionId: string, text: string, mode?: 'queue'|'steer',
   *          clientKey: string, clientTimeZone?: string}} request
   */
  async sessionPrompt({ taskId, sessionId, text, mode = 'queue', clientKey, clientTimeZone = null }) {
    const session = this.#requireSession(taskId, sessionId);
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
      taskId, kind: 'session.prompt', idempotencyKey: `prompt:${clientKey}`,
      payload, sessionId,
    });
    if (!created) {
      const current = this.#store.getOperation(operation.operation_id);
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

    return this.#serialize(sessionId, async () => {
      const result = await this.#dispatch({
        operation: this.#store.getOperation(operation.operation_id),
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
        operation: shapeOperation(this.#store.getOperation(operation.operation_id)),
        result: { status: result.status, ...(result.error ? { error: result.error } : {}) },
      };
    });
  }

  /**
   * Send one operation's request after committing `dispatching`, then record the outcome.
   * Never retries unless the caller passes `retryable` AND the contract makes it idempotent.
   * @param {{operation: object, method: string, payload: object, allowedStates: string[], retryable?: boolean}} input
   */
  async #dispatch({ operation, method, payload, allowedStates }) {
    const fresh = this.#store.getOperation(operation.operation_id);
    if (!allowedStates.includes(fresh.state)) {
      return {
        status: 'refused',
        error: new BridgeError(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `operation is ${fresh.state} and a dispatch is not allowed from that state`,
          { operationId: fresh.operation_id, state: fresh.state },
        ).toJSON(),
      };
    }
    if (fresh.state === 'pending') {
      this.#store.markDispatching({
        operationId: fresh.operation_id,
        method,
        endpoint: `/api/${method}`,
        payload,
      });
    }
    const result = await this.#adapter.call(method, payload);
    if (result.status === 'ok') {
      this.#store.markAcknowledged({ operationId: fresh.operation_id, ok: true, value: result.value.value });
    } else if (result.status === 'refused') {
      this.#store.markAcknowledged({
        operationId: fresh.operation_id,
        ok: false,
        // Preserve the host's own business code (for example `session-conflict`): the
        // generic HOST_REFUSED code would erase which refusal actually happened.
        error: { code: result.error?.details?.hostCode ?? result.error?.code, message: result.error?.message },
      });
    } else {
      // Possibly sent and unproven: stays uncertain. No automatic retry.
      this.#store.markUncertain({
        operationId: fresh.operation_id,
        reason: result.reason ?? 'unproven-outcome',
        evidence: { method, at: Date.now() },
      });
    }
    return result;
  }

  /**
   * @param {string} sessionId
   * @param {() => Promise<T>} fn
   * @template T
   * @returns {Promise<T>}
   */
  #serialize(sessionId, fn) {
    const previous = this.#sessions.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive without leaking a rejected tail into the next caller.
    this.#sessions.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * @param {{taskId: string, sessionId: string}} request
   */
  sessionState({ taskId, sessionId }) {
    const session = this.#requireSession(taskId, sessionId);
    const cursor = this.#store.readCursor({ taskId, sessionId });
    const openTurn = this.#store.currentOpenTurn(sessionId);
    const operations = this.#store.listOperations(taskId).filter((row) => row.session_id === sessionId);
    const interactions = this.#store.listInteractions(taskId);
    const held = this.#dispatchHolds.get(sessionId) === true;
    return {
      session: shapeSession(session),
      connection: this.#connection,
      execution: {
        state: openTurn ? 'running' : 'idle',
        currentTurnId: openTurn?.turn_id ?? null,
        // A terminal reason is only ever recorded from an authoritative terminal event.
        lastTerminalReason: lastTerminalReason(this.#store, sessionId),
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
        local: (this.#queue.get(sessionId) ?? []).map((item) => ({ operationId: item.operationId, state: item.state })),
        localScope: 'daemon',
        dispatchHeld: held,
      },
      operations: operations.slice(-20).map(shapeOperation),
      interactions: interactions.filter((row) => row.session_id === sessionId).map(shapeInteraction),
      events: this.#store.countEvents(taskId, sessionId),
    };
  }

  /**
   * Incremental event paging with explicit completeness.
   * @param {{taskId: string, sessionId: string, beforeSeq?: number, limit?: number}} request
   */
  sessionEvents({ taskId, sessionId, beforeSeq = null, limit = 50 }) {
    this.#requireSession(taskId, sessionId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, this.#limits.eventPageMax));
    const rows = beforeSeq === null
      ? this.#store.pageEvents({ taskId, sessionId, limit: bounded })
      : this.#store.pageEvents({ taskId, sessionId, beforeSeq: Number(beforeSeq), limit: bounded });
    const cursor = this.#store.getCursor(taskId, sessionId);
    return {
      sessionId,
      taskId,
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
      gap: cursor?.gap_from != null ? { from: Number(cursor.gap_from), to: Number(cursor.gap_to) } : null,
    };
  }

  /**
   * Bounded, event-driven wait. Register-then-recheck: the state is read once after
   * registration, so a change landing between the two cannot be missed.
   * @param {{taskId: string, sessionId: string, timeoutMs?: number, sinceSeq?: number}} request
   */
  async sessionWait({ taskId, sessionId, timeoutMs = null, sinceSeq = null }) {
    this.#requireSession(taskId, sessionId);
    const bounded = Math.max(50, Math.min(Number(timeoutMs) || this.#limits.waitDefaultMs, this.#limits.waitMaxMs));
    const deadline = Date.now() + bounded;
    const startCount = this.#store.countEvents(taskId, sessionId);
    // Recheck after registering the wait condition: read once, then poll a monotonic counter.
    for (;;) {
      const openTurn = this.#store.currentOpenTurn(sessionId);
      const count = this.#store.countEvents(taskId, sessionId);
      const cursor = this.#store.getCursor(taskId, sessionId);
      if (!openTurn) {
        return {
          reason: this.#store.listTurns(sessionId).length === 0 ? 'no-turn-observed' : 'turn-ended',
          terminalReason: lastTerminalReason(this.#store, sessionId),
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
   * @param {{taskId: string, sessionId: string, clientKey: string}} request
   */
  async sessionCancel({ taskId, sessionId, clientKey }) {
    const session = this.#requireSession(taskId, sessionId);
    const { operation, created } = this.#store.reserveOperation({
      taskId, kind: 'session.cancel', idempotencyKey: `cancel:${clientKey}`,
      payload: { sessionId }, sessionId,
    });
    if (!created) {
      return { operation: shapeOperation(this.#store.getOperation(operation.operation_id)), reused: true };
    }
    return this.#serialize(sessionId, async () => {
      // Freeze the next local dispatch while the target turn is checked.
      this.#dispatchHolds.set(sessionId, true);
      try {
        const openTurn = this.#store.currentOpenTurn(sessionId);
        const result = await this.#dispatch({
          operation: this.#store.getOperation(operation.operation_id),
          method: 'session.cancel',
          payload: { sessionId: session.host_session_id },
          allowedStates: ['pending'],
        });
        return {
          operation: shapeOperation(this.#store.getOperation(operation.operation_id)),
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
        this.#dispatchHolds.set(sessionId, false);
      }
    });
  }

  /**
   * Clear the daemon's local queue. The remote queue is a different scope and is reported
   * separately: session-level cancellation cannot safely target an old turn when external
   * writers may have advanced the session.
   * @param {{taskId: string, sessionId: string}} request
   */
  queueClear({ taskId, sessionId }) {
    this.#requireSession(taskId, sessionId);
    const removed = this.#queue.get(sessionId) ?? [];
    this.#queue.set(sessionId, []);
    return {
      localRemoved: removed.length,
      localScope: 'daemon',
      remoteScope: {
        cleared: false,
        reason: 'remote queue clearing requires a queue item id observed from the Host queue snapshot',
      },
    };
  }

  /**
   * @param {{taskId: string, sessionId?: string, state?: string}} request
   */
  interactionList({ taskId, state = null }) {
    this.#requireTask(taskId);
    return { interactions: this.#store.listInteractions(taskId, state).map(shapeInteraction) };
  }

  /**
   * Decide an approval/question. Requires the operator authority token; a model-accessible
   * tool cannot reach this. The decision is a compare-and-set: a duplicate identical decision
   * is idempotent, a conflicting or stale one is rejected.
   * @param {{taskId: string, interactionId: string, decision: string, authorityToken: string}} request
   */
  interactionDecide({ taskId, interactionId, decision, authorityToken, reason = null }) {
    const expected = readAuthorityToken(this.#stateDir);
    if (!expected) {
      throw new BridgeError(ERROR_CODES.APPROVAL_UNAUTHORIZED, 'no authority token exists in this state directory', {});
    }
    if (typeof authorityToken !== 'string' || createDigest(authorityToken) !== createDigest(expected)) {
      this.#store.audit({ taskId, kind: 'approval-unauthorized', actor: 'unknown', detail: { interactionId } });
      throw new BridgeError(ERROR_CODES.APPROVAL_UNAUTHORIZED, 'authority token rejected', { interactionId });
    }
    const interaction = this.#store.getInteraction(interactionId);
    if (!interaction) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'interaction not found', { interactionId });
    if (interaction.task_id !== taskId) {
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'interaction belongs to another task', { interactionId });
    }
    if (interaction.expires_at && Date.now() > Number(interaction.expires_at)) {
      return this.#decideAndReport(interaction, 'expired', 'expired-before-decision');
    }
    if (!['allowed-once', 'rejected'].includes(decision)) {
      throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'decision must be allowed-once or rejected', { decision });
    }
    const previousDelivery = this.#store.getResponseDelivery(taskId, interaction.host_rpc_id);
    if (previousDelivery && previousDelivery.outcome === 'not-pending') {
      return {
        interaction: shapeInteraction(interaction),
        delivered: false,
        receipt: 'not-pending',
        note: 'the host has no pending request for this rpc id; the interaction was already resolved, expired or replayed',
      };
    }
    const cas = this.#store.decideInteraction({ interactionId, decision, reason });
    if (!cas.applied) {
      if (cas.interaction.decision === decision) {
        return { interaction: shapeInteraction(cas.interaction), delivered: false, receipt: 'duplicate', note: 'identical decision already applied' };
      }
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'interaction already decided with a different decision', {
        interactionId, previous: cas.interaction.state,
      });
    }
    // Delivery is asynchronous and its receipt is reported honestly, never as the outcome.
    return {
      interaction: shapeInteraction(cas.interaction),
      decision,
      delivery: 'pending-async',
      note: 'the host receipt arrives asynchronously and may be not-pending; the resolved frame is the outcome',
    };
  }

  /**
   * @param {object} interaction
   * @param {string} state
   * @param {string} reason
   */
  #decideAndReport(interaction, state, reason) {
    this.#store.decideInteraction({ interactionId: interaction.interaction_id, decision: state, reason });
    return {
      interaction: shapeInteraction(this.#store.getInteraction(interaction.interaction_id)),
      delivered: false,
      receipt: state,
      note: reason,
    };
  }

  /** @param {{operationId: string}} request */
  opGet({ operationId }) {
    const operation = this.#store.getOperation(operationId);
    if (!operation) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'operation not found', { operationId });
    return { operation: shapeOperation(operation) };
  }

  /**
   * Register a bounded watch on one session's event stream. Returned immediately: a gateway
   * streams by polling pages with the returned cursor rather than holding an IPC socket open.
   * @param {{taskId: string, sessionId: string}} request
   */
  streamSubscribe({ taskId, sessionId }) {
    this.#requireSession(taskId, sessionId);
    return {
      subscriptionId: mintId('event'),
      mode: 'poll-pages',
      note: 'the daemon keeps the live subscription; callers page with session.events',
    };
  }

  /**
   * @param {string} taskId
   */
  #requireTask(taskId) {
    const task = this.#store.getTask(taskId);
    if (!task) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'task not found', { taskId });
    if (task.host_base !== this.hostBase) {
      throw new BridgeError(ERROR_CODES.CONFLICT, 'task belongs to a different host', { taskId });
    }
    return task;
  }

  /**
   * @param {string} taskId
   * @param {string} sessionId
   */
  #requireSession(taskId, sessionId) {
    this.#requireTask(taskId);
    const session = this.#store.getSession(sessionId);
    if (!session || session.task_id !== taskId) {
      throw new BridgeError(ERROR_CODES.NOT_FOUND, 'session not found in this task', { sessionId });
    }
    return session;
  }

  // ---- event ingest -----------------------------------------------------------------

  /**
   * Start the mux ingest loop. Frames become durable events keyed by their native sequence,
   * and a gap in that sequence is recorded as explicit incompleteness rather than hidden.
   * @returns {Promise<void>} resolves once the loop is running (or the attempt failed)
   */
  async startEventIngest() {
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
   * @param {string} text raw frame
   */
  #ingestFrame(text) {
    this.#eventStats.frames += 1;
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      this.#eventStats.malformed += 1;
      return;
    }
    const frame = envelope?.payload ?? envelope;
    // Answerable frames carry the Host's own rpcId; it must be preserved verbatim so a
    // decision can echo exactly the id the Host is waiting on (and a replayed frame is
    // recognisable as the same interaction rather than a new one).
    const hostRpcId = String(envelope?.rpcId ?? '');
    if (frame?.type === 'approval/requested' || frame?.type === 'question/requested') {
      const session = this.#store.findSessionByHostId(frame.sessionId);
      if (!session) return; // never adopt a session we do not own
      const kind = frame.type.startsWith('approval') ? 'approval' : 'question';
      this.#store.recordInteraction({
        taskId: session.task_id,
        sessionId: session.session_id,
        turnId: this.#store.currentOpenTurn(session.session_id)?.turn_id ?? null,
        kind,
        hostRpcId,
        nativeId: frame.approvalId ?? frame.questionId ?? null,
        // Store only the shape we act on: no unbounded host payload is copied into state.
        payload: {
          toolName: typeof frame.toolName === 'string' ? frame.toolName.slice(0, 200) : null,
          reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 500) : null,
          nativeId: frame.approvalId ?? frame.questionId ?? null,
        },
        expiresAt: Number.isFinite(Number(frame.expiresAt)) ? Number(frame.expiresAt) : null,
      });
      return;
    }
    if (frame?.type === 'approval/resolved' || frame?.type === 'question/resolved') {
      // The resolved frame is the authoritative outcome; the delivery receipt only said
      // whether the Host still had the request pending.
      const interaction = this.#store.getInteractionByRpcId(hostRpcId);
      if (interaction && interaction.state === 'pending') {
        const outcome = String(frame.outcome ?? frame.result ?? 'resolved');
        const decision = outcome.includes('reject') ? 'rejected'
          : outcome.includes('cancel') ? 'revoked'
            : outcome.includes('expire') ? 'expired'
              : 'answered';
        this.#store.decideInteraction({ interactionId: interaction.interaction_id, decision, reason: 'host-resolved-frame' });
      }
      return;
    }
    if (frame?.type !== 'session/event') return;
    const hostSessionId = frame.sessionId;
    const session = this.#store.findSessionByHostId(hostSessionId);
    if (!session) return; // not one of our sessions: never adopt it
    const seq = Number(frame.event?.seq ?? frame.event?.sequence);
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
      kind: String(frame.event?.type ?? 'unknown'),
      payload: { nativeType: frame.event?.type ?? null, raw: frame.event ?? null },
    });
    if (inserted) this.#eventStats.stored += 1;
    else this.#eventStats.duplicates += 1;
    const after = this.#recomputeCursor(session.task_id, session.session_id);
    // Count a gap once, when it FIRST appears for this session, rather than on every frame
    // that is observed while the hole is still open.
    if (inserted && after && after.completeness === 'incomplete' && before.missing.length === 0) {
      this.#eventStats.gaps += 1;
    }
    this.#applyEventToState(session.session_id, frame.event);
  }

  /**
   * Fold an event into daemon state. A turn is closed only by a terminal event that names
   * that turn; an `idle`-looking or stale message never terminates a new turn.
   * @param {string} sessionId
   * @param {object|null} event
   */
  #applyEventToState(sessionId, event) {
    const type = event?.type;
    if (type === 'turn/start') {
      const open = this.#store.currentOpenTurn(sessionId);
      if (!open) {
        // Store the host's turn number as a real number or null — never as NaN, which would
        // fail every later comparison and leave the turn unclosable.
        const hostTurn = Number(event?.turn);
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
      const endSeq = Number(event?.seq);
      const openHostTurn = open.host_turn;
      const endTurn = Number(event?.turn);
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
      const outcome = String(event?.outcome ?? event?.reason ?? 'completed');
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
   * @param {string} taskId @param {string} sessionId
   */
  #recomputeCursor(taskId, sessionId) {
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
   * @returns {Promise<{sessions: number, appended: number}>}
   */
  async refetchHistoryForKnownSessions() {
    const tasks = this.#store.all('select distinct task_id from sessions');
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
        const events = result.value.value?.events ?? [];
        const hasMore = result.value.value?.hasMore === true;
        const observed = [];
        for (const entry of events) {
          const seq = Number(entry?.event?.seq);
          if (!Number.isFinite(seq)) continue;
          observed.push(seq);
          const inserted = this.#store.appendEvent({
            taskId, sessionId: session.session_id, seq,
            kind: String(entry.event?.type ?? 'unknown'),
            payload: { nativeType: entry.event?.type ?? null, raw: entry.event ?? null, source: 'history-refetch' },
          });
          if (inserted) {
            appended += 1;
            this.#applyEventToState(session.session_id, entry.event);
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

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** @param {string} text @returns {any} */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {Store} store
 * @param {string} sessionId
 * @returns {string|null} reason of the latest closed turn, if any
 */
function lastTerminalReason(store, sessionId) {
  const turns = store.listTurns(sessionId);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].state !== 'open') return turns[i].reason ?? turns[i].state;
  }
  return null;
}

/** @param {object} row */
function shapeTask(row) {
  return {
    taskId: row.task_id,
    label: row.label,
    hostBase: row.host_base,
    hostScope: row.host_scope,
    createdAt: Number(row.created_at),
  };
}

/** @param {object} row */
function shapeSession(row) {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    hostSessionId: row.host_session_id,
    cwd: row.cwd,
    createdAt: Number(row.created_at),
  };
}

/** @param {object} row */
export function shapeOperation(row) {
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

/** @param {object} row */
export function shapeInteraction(row) {
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
