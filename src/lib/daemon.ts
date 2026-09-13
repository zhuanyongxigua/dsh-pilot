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
 *
 * Provenance, recorded because a reader is entitled to know how this file was written: the
 * TypeScript migration built this file by assembling it from temporary per-section fragments. Those
 * fragments lived in the repository-ignored `.local/` directory and are NOT part of the delivered
 * source, on purpose — this file is now the single source of truth and is meant to be edited
 * directly with an ordinary editor. Nothing regenerates it. If you are looking for the generator
 * the older section markers named, it was scaffolding and it is gone; a comment referring to it
 * would be a lie, which is why it is not there.
 */

import { randomUUID } from 'node:crypto';
import { BridgeError, ERROR_CODES, toBridgeError, type Result } from './errors.ts';
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
import { DshHostAdapter, boundText } from './adapter.ts';
import { redactInbound } from './redact.ts';
import { startIpcServer, ensureAuthorityToken, readAuthorityToken, MAX_IPC_REPLY_BYTES } from './ipc.ts';
import { resolveWorkspace, verifyWorkspace, workspaceChanged, workspaceUnsafe, type WorkspaceFs } from './workspace.ts';
import { realpathSync, statSync } from 'node:fs';
import type { IpcServer } from './ipc.ts';

/**
 * The filesystem operations the workspace boundary uses.
 *
 * Injected rather than imported inside `workspace.ts`, so the module that DECIDES is separated from the
 * module that touches the disk, and so this file is the only place in the daemon that follows a path.
 */
const WORKSPACE_FS: WorkspaceFs = {
  realpath: (path: string): string => realpathSync(path),
  isDirectory: (path: string): boolean => statSync(path).isDirectory(),
};

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
  /**
   * One assembled downlink message. A message is one frame or every frame up to its FIN, so this is
   * the bound `frameMaxBytes` cannot express: a fragmented message is assembled from frames that are
   * each individually legal.
   */
  eventMessageMaxBytes: 4 * 1024 * 1024,
  frameMaxBytes: 1024 * 1024,
  eventBufferMaxBytes: 32 * 1024 * 1024,
  logMaxBytes: 100 * 1024 * 1024,
  /**
   * The unary deadline the adapter applies, including to `/api/respond`. It sits here as well as in
   * `config.ts` because this object is the daemon's fallback when it is constructed directly (as the
   * unit tests do), and every other overridable bound is in both places for the same reason.
   */
  hostTimeoutMs: 15_000,
  hostResponseMaxBytes: 8 * 1024 * 1024,
  ipcReplyMaxBytes: MAX_IPC_REPLY_BYTES,
  waitDefaultMs: 30_000,
  waitMaxMs: 120_000,
});

/** Connection state, deliberately separate from turn execution state. */
export const CONNECTION_STATES = Object.freeze(['disconnected', 'connecting', 'reconciling', 'ready']);

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
   * The daemon's own pending-prompt queue, which holds NOTHING and is reported as such.
   *
   * The map is kept rather than deleted because the reply still carries a `local` array and the two
   * cancellation scopes are a requirement (FR-CANCEL-1): what a caller must be able to see is that the
   * daemon-local scope is EMPTY, which is a different statement from it being absent. It is genuinely
   * empty — nothing in this bridge appends to it, because a prompt is dispatched to the Host whose inbox
   * is the only queue that holds work — and the note on the reply says so, so an operator does not read
   * an empty array as "nothing queued right now".
   *
   * The `#localQueueMax` field that stood next to it is GONE: a limit that is never compared to anything
   * bounds nothing, and a reader who found it would reasonably conclude that local queueing is a
   * capability of this daemon. It is not one, and the honest way to say so is to not have the number.
   */
  #queue = new Map<string, Array<{ operationId: string; state: string }>>(); // sessionId -> daemon-local queue, always empty (see above)
  /**
   * The Host's pending inbox per session, as last OBSERVED from an authoritative `session/queue`
   * frame. Deliberately a clearly-named NEIGHBOUR of `#queue` rather than a second use of it:
   * `#queue` is the daemon's own pending-prompt queue (the `localScope: 'daemon'` scope this
   * bridge owns), while this is the Host's queue — and FR-CANCEL-1 exists precisely because those
   * two scopes are separate operations with separate effects. Sharing one map would erase the
   * distinction the report is required to preserve.
   *
   * NOT persisted, on purpose, and that is a measurement rather than a shortcut: the Host
   * documents pending inbox work as transient (a queued message is not model-visible and is not
   * durable until the Agent claims it), which is why it has no `session/event` and why the Host
   * re-sends the COMPLETE snapshot after every enqueue, mutation, claim or discard. A reloaded
   * durable copy would therefore assert a pending inbox the Host may already have claimed. After
   * a reconnect the snapshot arrives again on its own; until it does, the honest state is
   * "nothing observed", which is what an absent key means here.
   *
   * An item is held only as far as a caller can act on it: its `id` (the only id
   * `session.updateQueue` accepts) and the Host-resolved `placement`.
   */
  #observedQueue = new Map<string, Array<{ itemId: string; placement: string }>>(); // sessionId -> last observed Host inbox snapshot
  #dispatchHolds = new Map<string, boolean>(); // sessionId -> boolean (hold next dispatch while cancelling)
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
    this.#adapter = new DshHostAdapter({
      baseUrl: hostBase,
      timeoutMs: this.#limits.hostTimeoutMs,
      maxResponseBytes: this.#limits.hostResponseMaxBytes,
    });
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
      maxReplyBytes: this.#limits.ipcReplyMaxBytes,
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
   * Restart recovery: interrupted dispatches become uncertain (possibly sent), never retried — and
   * every removal attempt that could have reached the Host is settled in the removal ledger first.
   *
   * The ledger reconciliation runs AFTER the sweep on purpose: the sweep turns an interrupted
   * `dispatching` operation into `uncertain`, which is exactly the fact this reconciler needs to
   * classify, so running it first would read the pre-sweep state and have to duplicate that logic.
   * @returns what was interrupted, and what the ledger reconciliation settled
   */
  recover(): {
    interrupted: number;
    uncertainOperations: string[];
    removalAttempts: { settled: number; blocked: number; confirmed: number; retryable: number; items: string[] };
  } {
    const interrupted = this.#store.sweepInterruptedDispatches('crash-during-dispatch');
    const removals = this.#reconcileRemovalAttempts();
    return {
      interrupted: interrupted.length,
      uncertainOperations: interrupted.map((row) => row.operation_id),
      removalAttempts: removals,
    };
  }

  /**
   * Settle every durable removal attempt that never got a ledger row.
   *
   * Why this exists: the once-only guarantee is enforced by the removal ledger, but the ledger is
   * written AFTER the Host answers. A process killed in between — the Host has applied the `remove`,
   * the ledger says nothing — leaves the item looking untouched, and the next `queueClear` would send
   * a second destructive request for it. The attempt itself is not lost: `#dispatch` persisted the
   * operation before writing any byte. So the classification is read off the operation, which is the
   * durable record of how far the attempt actually got:
   *
   * | operation state | what it proves | ledger result |
   * | --- | --- | --- |
   * | `pending` | no byte was written — `#dispatch` writes `dispatching` before sending | nothing: provably NOT sent, so a retry stays safe |
   * | `refused` | the Host refused before applying anything | nothing: provably not applied, so a retry stays safe |
   * | `uncertain`, `dispatching` | bytes may have reached the Host and the outcome was never observed | `uncertain`, which blocks a blind re-send |
   * | `succeeded` with `{accepted:true}` | the Host's own confirmation was persisted | `removed` |
   * | `succeeded` without it | an `ok` envelope that was not a removal confirmation | `uncertain` |
   *
   * The distinction that matters is the one the review named: an attempt that provably never left the
   * process must stay RETRYABLE, so this never writes a blanket block. Only an attempt that may have
   * been applied is recorded, and `#dispatch`'s ordering is what makes "never left the process" a
   * fact rather than a guess.
   * @returns counts per classification, with the item ids that were blocked
   */
  #reconcileRemovalAttempts(): { settled: number; blocked: number; confirmed: number; retryable: number; items: string[] } {
    const attempts = this.#store.listUnsettledRemovalAttempts();
    const blocked: string[] = [];
    let confirmed = 0;
    let retryable = 0;
    for (const attempt of attempts) {
      const sessionId = attempt.session_id ?? null;
      // Both the request and the response are nullable columns, so the null is handled rather than
      // asserted away: the query already requires a valid `request_json`, and a row that somehow
      // lacks one is skipped below rather than parsed as `null`.
      const payload: unknown = attempt.request_json === null ? null : safeJson(attempt.request_json);
      const itemId = this.#isPropertyBag(payload) && typeof payload['itemId'] === 'string' ? payload['itemId'] : null;
      if (sessionId === null || itemId === null) continue;
      if (attempt.state === 'pending' || attempt.state === 'refused') {
        // Provably never applied. Nothing is written, deliberately: a ledger row here would lock an
        // item that the Host was never asked about out of a legitimate retry.
        retryable += 1;
        continue;
      }
      let state: 'removed' | 'uncertain' = 'uncertain';
      if (attempt.state === 'succeeded') {
        const response: unknown = attempt.response_json === null ? null : safeJson(attempt.response_json);
        // The same confirmation test `queueClear` applies on the live path, read from the persisted
        // response instead of from a live result: the Host's contract for this method is
        // `{accepted: true}`, and anything else is not a confirmation.
        state = this.#isPropertyBag(response) && response['accepted'] === true ? 'removed' : 'uncertain';
      }
      if (state === 'removed') confirmed += 1;
      else blocked.push(itemId);
      this.#store.recordQueueRemoval({
        taskId: attempt.task_id,
        sessionId,
        itemId,
        state,
        operationId: attempt.operation_id,
      });
    }
    return { settled: attempts.length, blocked: blocked.length, confirmed, retryable, items: blocked };
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
    // The caller's label, checked rather than dropped. It was accepted from the MCP tool's own schema
    // ("Optional human label", at most 120 characters) and then ignored, so a client that set one got a
    // task named `task:default` back — an argument that appears in the tool's schema and does nothing is
    // the "silently ignored" failure this bridge is not supposed to have.
    //
    // A value that cannot be a label is refused rather than coerced or truncated: this frame is parsed
    // JSON, and silently cutting a long label or stringifying a number would be inventing an answer the
    // caller did not give.
    if (label !== null && typeof label !== 'string') {
      throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'label must be a string', { kind: typeof label });
    }
    if (typeof label === 'string' && label.length > MAX_TASK_LABEL) {
      throw new BridgeError(ERROR_CODES.BAD_REQUEST, `label must be at most ${MAX_TASK_LABEL} characters`, { length: label.length });
    }
    const displayLabel: string | null = typeof label === 'string' && label.trim() !== '' ? label : null;
    const existing = this.#store.get<TaskRow>(`select * from tasks where label = ?`, `task:${key}`);
    // Found by the INTERNAL key, not by the label: the client key is what makes this call idempotent, and
    // matching on the caller's label would have made two calls with the same key and different labels
    // create two tasks. The stored label is not updated on the second call, which is stated rather than
    // implied: `task.ensure` is an idempotent ensure, and a rename would be a different operation.
    if (existing) return { task: shapeTask(existing), created: false };
    // `assertIdKind` is the narrowing: it throws unless the value is a well-formed task id and
    // returns that same id, so the checked value is what goes to the store.
    const newTaskId = assertIdKind(taskId ?? mintId('task'), 'task');
    const task = this.#store.createTask({
      taskId: newTaskId,
      label: `task:${key}`,
      displayLabel,
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
    // The same typed failure `#presentRow` gives, for the same reason and through the same code path: a
    // TypeError used to reach the caller as the daemon's error text, which names an internal property read
    // rather than the fact that a row this operation requires is missing.
    this.#presentRow(row, field);
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

    // The workspace boundary, before anything is reserved or sent.
    //
    // `cwd` is the one caller-supplied value this bridge hands to a component that runs tools inside it,
    // and a path is not a directory: it can be a symlink now and a different symlink later. What gets
    // recorded — and what the Host is told — is the directory the path RESOLVES to, so the session's
    // workspace is a directory rather than whatever a name points at by the time work is dispatched.
    // A path that is not absolute, does not exist, or is not a directory is refused here with a typed
    // error, and nothing reaches the Host: there is no partway state to reconcile.
    const requestedCwd: string | null = typeof cwd === 'string' && cwd !== '' ? cwd : null;
    let resolvedCwd: string | null = null;
    if (requestedCwd !== null) {
      const resolved = resolveWorkspace(requestedCwd, WORKSPACE_FS);
      if ('refusal' in resolved) throw workspaceUnsafe(requestedCwd, resolved.refusal);
      resolvedCwd = resolved.resolved;
    }

    // The intent's identity is (client key, cwd, preset) — NOT the preallocated host id,
    // which is minted once and then reused from the stored request. Including it would make
    // every retry look like a different payload and break key-based idempotency.
    //
    // The RESOLVED path is what the identity carries, and that is a deliberate choice with a consequence
    // worth stating: a retry that passes the same name resolves to the same directory and finds the same
    // operation, while a retry whose name now resolves somewhere else is refused by the workspace check
    // above rather than quietly creating a second session in a directory the first caller never chose.
    const intent = { cwd: resolvedCwd, agentPreset };
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
    const requestBody = storedRequest ?? { sessionId: hostSessionId, ...(resolvedCwd ? { cwd: resolvedCwd } : {}), ...(agentPreset ? { agentPreset } : {}) };

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
      allowedStates: ['pending', 'uncertain'],
    });
    if (result.status !== 'ok') {
      return { session: null, operation: shapeOperation(this.#store.getOperation(operation.operation_id)), result };
    }
    // `result.value` IS the Host's value. `call()` returns `ok({ value: result.value, rpcId })` and
    // `AdapterCallResult` promotes those fields to the top level, so the Host's `session.create` value
    // sits exactly here. This used to read one level further in (`result.value['value']`), which is a
    // key that never exists — the same over-deep read that was already corrected in `#dispatch` and in
    // the event page, and the reason those two sites carry the same note.
    //
    // It was MEASURED, and the consequence is not cosmetic: with the read one level too deep, a Host
    // that answers `{sessionId: "session-abc"}` had its id thrown away and the reply's `hostSessionId`
    // was always the UUID this bridge minted for the request. Every downstream use of a Host session id
    // — the `sessionId` in a `/api/respond` answer, for one — then named a session the Host had never
    // heard of, and nothing here could tell, because a locally minted id looks exactly like a Host's.
    const hostValue: unknown = result.value;
    // The RESOLVED workspace is recorded, not the name the caller used, and this is load-bearing rather
    // than tidy: the re-verification before dispatch compares the recorded path against what it resolves to
    // NOW, so a record holding a symlinked name would fail that comparison on every later call (on macOS a
    // temp path under /var resolves through /private/var, which is how this was caught). The record has to
    // hold the directory itself for the comparison to mean anything.
    return this.#recordSessionFromCreate(task.task_id, hostValue, hostSessionId, resolvedCwd, operation.operation_id);
  }

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
        // The same fact in machine-readable form. FR-EXEC-3 needs a caller to tell a completed turn
        // from a failed or cancelled one; the reason string above now says so in words, and this says
        // it in the store's own closed set (`store.TURN_STATES`) so nothing has to parse a sentence.
        lastTerminalState: lastTerminalState(this.#store, localId),
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
        // The other scope, reported here so a caller can SEE the item ids a removal may name: those
        // ids exist only in the Host's snapshot, and a caller that cannot observe them could not
        // ask for their removal at all.
        remote: (this.#observedQueue.get(localId) ?? []).map((item) => ({ itemId: item.itemId, placement: item.placement })),
        remoteScope: 'host',
        /**
         * False when no `session/queue` frame has been observed for this session yet. Kept
         * distinct from `remote.length === 0` because the two mean different things: an absent
         * snapshot is not evidence that the Host's inbox is empty.
         */
        remoteObserved: this.#observedQueue.has(localId),
        /**
         * What this bridge has already done about Host queue items, durably. Reported because it is
         * the answer to the only question a caller has before asking for a removal: has one been
         * sent for this item already, and was the outcome ever proven? `removed` is settled;
         * `uncertain` is unresolved and will not be retried on this bridge's own initiative. An item
         * absent from this list has never had a removal sent.
         */
        removalLedger: this.#store.listQueueRemovals(session.task_id, localId)
          .map((row) => ({ itemId: row.item_id, state: row.state })),
        dispatchHeld: held,
      },
      operations: operations.slice(-20).map(shapeOperation),
      interactions: interactions.filter((row) => row.session_id === localId)
        .map((row) => shapeInteraction(row, this.#store.getResponseDelivery(row.task_id, row.host_rpc_id))),
      events: this.#store.countEvents(session.task_id, localId),
    };
  }

  /**
   * Incremental event paging with explicit completeness.
   */
  sessionEvents({ taskId, sessionId, beforeSeq = null, limit = 50 }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, this.#limits.eventPageMax));
    const window = beforeSeq === null
      ? this.#store.pageEvents({ taskId: session.task_id, sessionId: session.session_id, limit: bounded })
      : this.#store.pageEvents({ taskId: session.task_id, sessionId: session.session_id, beforeSeq: Number(beforeSeq), limit: bounded });
    // Two limits, one page: `bounded` events, and `eventPageMaxBytes` of serialised JSON. The byte
    // limit is applied by walking the window from its NEWEST row backwards, because the window is
    // the `limit` most recent events — trimming the oldest rows inside it would drop events the
    // caller would then never receive, since the next page asks for `seq <` the first row returned.
    // Keeping the newest rows that fit leaves a contiguous run, so paging backwards sees every
    // event exactly once.
    const { rows, bytes, oversize } = this.#fitEventPage(window);
    // The oversize-event policy meets the socket's hard limit HERE, and it is stated rather than left to
    // whichever of the two bounds happens to fire first.
    //
    // `#fitEventPage` deliberately keeps a single event that exceeds the page budget, because silently
    // dropping the only event in a page would lose it: the caller would ask again with the same cursor
    // forever. That exemption is a policy about the PAGE budget, and it must not be read as an exemption
    // from the IPC reply bound, which is the size of a frame this socket can carry at all. When one
    // event's own JSON crosses that bound the page is undeliverable, and the honest outcomes are a typed
    // refusal or a silent truncation. It is a typed refusal, and it names the seq, so the caller can
    // advance past that one event deliberately instead of being unable to make progress.
    if (rows.length === 1 && bytes > this.#limits.ipcReplyMaxBytes) {
      throw new BridgeError(ERROR_CODES.RESULT_TOO_LARGE, 'one event is too large to deliver over ipc', {
        seq: Number(rows[0].seq),
        bytes,
        maxReplyBytes: this.#limits.ipcReplyMaxBytes,
        pageMaxBytes: this.#limits.eventPageMaxBytes,
      });
    }
    const cursor = this.#store.getCursor(session.task_id, session.session_id);
    const firstSeq = rows.length ? Number(rows[0].seq) : null;
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
      // What the page cost, and how it was bounded, so a caller can tell a byte-limited page from a
      // short one and can see which rows were exempted from the limit.
      bytes,
      maxBytes: this.#limits.eventPageMaxBytes,
      oversize,
      // Asked of the database rather than inferred from the page length: a page limited by bytes can
      // be short while older events remain, and a page that filled the count limit may be the whole
      // history. `hasMore` means "there is an event older than the oldest one returned".
      hasMore: firstSeq === null
        ? false
        : this.#store.hasEventsBefore(session.task_id, session.session_id, firstSeq),
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
   * Fit a page of event rows inside `eventPageMaxBytes`, newest-first, without losing an event.
   *
   * The walk is deliberately newest-to-oldest: the reversed slice is returned oldest-first, so the
   * caller's cursor (`beforeSeq` = the oldest row returned) stays a contiguous boundary and every
   * event is delivered exactly once across a paging loop. Trimming the other end would leave a hole
   * that no later page could ask for.
   *
   * A single event larger than the whole budget is delivered anyway, and named in `oversize`. The
   * alternatives are both worse: skipping it loses an event silently, and returning an empty page
   * for that cursor makes the caller loop forever on the same `beforeSeq`. Delivering it keeps the
   * cursor moving and puts the fact in the reply instead of in a comment.
   * @param window the page window from the store, oldest row first
   */
  #fitEventPage(window: { seq: bigint | number; kind: string; session_id: string; stored_at: bigint | number; payload_json: string }[]): {
    rows: typeof window;
    bytes: number;
    oversize: number[];
  } {
    const budget = this.#limits.eventPageMaxBytes;
    /** @type {typeof window} */
    const kept: typeof window = [];
    let bytes = 0;
    /** @type {number[]} */
    const oversize: number[] = [];
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const row = window[i];
      // The serialised size the caller actually receives, measured on the JSON this method is about
      // to build, so the budget is about the reply rather than about the stored bytes. A multi-byte
      // payload must count as its bytes, not as its characters.
      const size = Buffer.byteLength(JSON.stringify({
        seq: Number(row.seq),
        kind: row.kind,
        sessionId: row.session_id,
        at: Number(row.stored_at),
        payload: safeJson(row.payload_json),
      }), 'utf8');
      if (kept.length > 0 && bytes + size > budget) break;
      if (kept.length === 0 && size > budget) oversize.push(Number(row.seq));
      kept.push(row);
      bytes += size;
    }
    kept.reverse();
    return { rows: kept, bytes, oversize };
  }

  /**
   * Bounded, event-driven wait. Register-then-recheck: the state is read once after
   * registration, so a change landing between the two cannot be missed.
   */
  // `sinceSeq` used to be destructured here and never read: nothing in this bridge sends it, nothing
  // documents it, and a field that is accepted and ignored is a capability a caller can believe in. The
  // wait is driven by the session's event count and the open turn, which is what its reply describes.
  async sessionWait({ taskId, sessionId, timeoutMs = null }: Record<string, unknown>) {
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
          // `turn-ended` alone does not say whether the turn completed, failed or was cancelled;
          // this does. The wait's own closed-set `reason` is unchanged, because it answers a
          // different question (why did the wait return?) than the terminal state does.
          terminalState: lastTerminalState(this.#store, session.session_id),
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
   * Clear the daemon's local queue, and remove named items from the HOST's queue. The remote queue
   * is a different scope and is reported separately: session-level cancellation cannot safely
   * target an old turn when external writers may have advanced the session.
   *
   * The two scopes are different operations with different effects, and they are reported
   * separately (FR-CANCEL-1): `localScope`/`localRemoved` describe the daemon's own pending-prompt
   * queue, while `remoteScope` describes the Host's inbox, which only `session.updateQueue` with
   * `action.kind: 'remove'` touches. Neither is `session.cancel`: stopping the active turn is a
   * different operation that deliberately leaves queued work in place, so this result also reports
   * the turn scope it did NOT affect.
   *
   * A remote removal is bound twice over, and the binding is the point:
   *   - to the CURRENT session — the Host is addressed with the session's own `host_session_id`,
   *     never with anything the caller supplied;
   *   - to an OBSERVED item id — an id is only sent when the last `session/queue` snapshot for
   *     THIS session contained it. An id that was never observed is refused here and never reaches
   *     the wire, because a guessed id is a request to remove an occurrence the daemon cannot show
   *     exists. That is also what keeps a removal from one session out of another's queue.
   *
   * `remoteScope.cleared` reflects what actually happened: it is true only when EVERY requested
   * item was confirmed removed by the Host. A lost receipt leaves that item in `uncertain` with
   * `status: 'uncertain'` and `cleared: false` — deliberately not the same report as a refusal,
   * because "the Host may or may not have removed it" is neither success nor failure.
   */
  async queueClear({ taskId, sessionId, itemIds }: Record<string, unknown>) {
    const session = this.#requireSession(taskId, sessionId);
    // Local scope first, and unchanged: the daemon's own prompt queue for this session, which nothing
    // appends to, so `localRemoved` is ALWAYS 0 — reported as measured, not as proof that any other queue
    // is empty. There is no local queueing in this bridge: a prompt goes to the Host, and the Host's inbox
    // is the only queue holding work. The reply keeps the field so a caller can see the scope is empty,
    // and the note below says why it is.
    const localItems = this.#queue.get(session.session_id) ?? [];
    this.#queue.set(session.session_id, []);
    const localRemoved = localItems.length;

    // Read here only for REPORTING. The decision that matters — is this item still observed, and is
    // it already settled? — is taken INSIDE the per-session serialization boundary below, so that the
    // decision and the effect it authorises are ordered by the same lock rather than by two different
    // ones. A pre-lock read is what let two concurrent callers both conclude the same item was
    // sendable; what actually stops the second send today is the durable ledger, and the in-lock
    // re-read is the structural fix that removes the class rather than that instance.
    const observedItems = this.#observedQueue.get(session.session_id) ?? [];
    const observed = observedItems.map((item) => ({ itemId: item.itemId, placement: item.placement }));
    const openTurn = this.#store.currentOpenTurn(session.session_id);

    // The caller's request, narrowed: only a non-empty string can name an observed item, and a
    // repeat inside one request is not a second removal.
    const requested: string[] = [];
    if (Array.isArray(itemIds)) {
      for (const candidate of itemIds) {
        if (typeof candidate === 'string' && candidate.length > 0 && !requested.includes(candidate)) {
          requested.push(candidate);
        }
      }
    }

    if (requested.length === 0) {
      // Nothing was named, so nothing was sent and nothing may be claimed. Offering to remove
      // "everything" here would be a destructive guess at the caller's intent from a daemon that
      // only ever saw a snapshot.
      return {
        localRemoved,
        localScope: 'daemon',
        remoteScope: {
          status: 'not-requested',
          cleared: false,
          requested: 0,
          removedCount: 0,
          removed: [],
          refused: [],
          uncertain: [],
          observed,
          reason: 'remote queue clearing requires a queue item id observed from the Host queue snapshot',
        },
        turnScope: {
          effect: 'none',
          observed: { state: openTurn ? 'running' : 'idle', currentTurnId: openTurn?.turn_id ?? null },
          note: 'a queue removal never stops the active turn; session.cancel is the separate operation that does',
        },
        note: 'nothing was removed: this bridge has no daemon-local prompt queue to clear, and no Host '
          + 'queue item was named, so nothing was observed for the Host queue scope',
      };
    }

    const refused: Array<{ itemId: string; code: string; state: string; sent: boolean; message: string }> = [];
    const removed: string[] = [];
    const uncertain: Array<{ itemId: string; reason: string; operationId: string }> = [];
    const operations: Array<ReturnType<typeof shapeOperation>> = [];

    // Serialized per session, exactly like `session.prompt` and `session.cancel`: two mutating
    // requests for one session must not interleave. Everything that DECIDES whether to send happens
    // inside, not before.
    await this.#serialize(session.session_id, async () => {
      // Re-read the snapshot under the lock. This is the binding check: an id is only ever sent when
      // the LAST `session/queue` snapshot for THIS session contains it, which is what refuses an
      // invented id and what keeps a removal for one session out of another's queue.
      const freshItems = this.#observedQueue.get(session.session_id) ?? [];
      const observedIds = new Set(freshItems.map((item) => item.itemId));
      const sendable: string[] = [];
      for (const itemId of requested) {
        if (!observedIds.has(itemId)) {
          refused.push({
            itemId, code: 'queue-item-not-found', state: 'refused', sent: false,
            message: 'item id is not in the last observed session/queue snapshot for this session, so no request was sent',
          });
          continue;
        }
        // The durable ledger, read under the same lock: a request for this item has already been
        // sent, so sending another would be a second destructive request for the SAME occurrence.
        // Both settled states block it, and for different reasons that the caller must be able to
        // tell apart — `removed` is done, `uncertain` is unresolved and must be reconciled against
        // the Host rather than retried. This is a local refusal, so it never reaches the wire, and
        // it does not lean on the Host to answer `queue-item-not-found` a second time.
        const ledger = this.#store.getQueueRemoval(session.task_id, session.session_id, itemId);
        if (ledger) {
          /** Every settled state blocks the send; each is reported for what it is. */
          const settled: Record<string, { code: string; message: string }> = {
            removed: {
              code: 'queue-item-already-removed',
              message: 'this session already had this item removed, confirmed by the host, so it was not sent again',
            },
            uncertain: {
              code: 'queue-item-removal-uncertain',
              message: 'a removal request for this item was already sent and its outcome was never proven; it is not '
                + 'retried automatically, because a retry would be a second destructive request for the same item',
            },
            'not-pending': {
              code: 'queue-item-not-pending',
              message: 'the host has already answered that this item is not pending in this session, so there is '
                + 'nothing to remove and no request was sent',
            },
          };
          const report = settled[ledger.state];
          refused.push({
            itemId,
            // An unrecognised state cannot happen — the table's own check constraint bounds it — but a
            // report is built for it anyway rather than crashing, because inventing a code is worse
            // than naming the gap.
            code: report?.code ?? 'queue-item-removal-state-unrecognised',
            state: ledger.state,
            sent: false,
            message: report?.message ?? `the ledger holds an unrecognised settled state: ${String(ledger.state)}`,
          });
          continue;
        }
        sendable.push(itemId);
      }

      for (const itemId of sendable) {
          // Durable intent BEFORE the send. `session.updateQueue` has no host-side idempotency key
          // beyond `rpcId`, so the key here identifies one ATTEMPT: `#dispatch` persists the intent
          // and records the outcome, and the binding check above — not this key — is what stops a
          // duplicate send. Keying it per item alone would instead swallow a legitimate second
          // attempt at an occurrence the observed snapshot still lists.
          const { operation } = this.#store.reserveOperation({
            taskId: session.task_id,
            kind: 'session.updateQueue',
            idempotencyKey: `queue-remove:${createDigest(itemId).slice(0, 32)}:${randomUUID()}`,
            payload: { sessionId: session.host_session_id, itemId, action: { kind: 'remove' } },
            sessionId: session.session_id,
          });
          const operationId = this.#presentRow(operation, 'operation_id').operation_id;
          const result = await this.#dispatch({
            operation: this.#store.getOperation(operationId),
            method: 'session.updateQueue',
            payload: { sessionId: session.host_session_id, itemId, action: { kind: 'remove' } },
            allowedStates: ['pending'],
          });
          operations.push(shapeOperation(this.#store.getOperation(operationId)));
          if (result.status === 'ok') {
            // The Host's own answer, not merely a reachable endpoint: the contract's response to
            // this method is `{accepted: true}`. An `ok` envelope that does not carry it is not a
            // confirmation, so it is reported as unknown rather than as a removal.
            //
            // `AdapterCallResult.value` IS the Host's value for this call: the adapter's ok
            // envelope assigns the Host's own `result.value` to `Result.value`, so this reads it
            // directly, one level, rather than reaching for a nested `value` member the envelope
            // does not carry (which would always read as absent).
            const answer: unknown = result.value;
            if (this.#isPropertyBag(answer) && answer['accepted'] === true) {
              // Confirmed by the Host's own answer, so it is durably settled as removed. A later
              // request for the same item is refused locally instead of being sent again.
              this.#store.recordQueueRemoval({
                taskId: session.task_id, sessionId: session.session_id, itemId, state: 'removed', operationId,
              });
              removed.push(itemId);
            } else {
              // Bytes reached the Host and the answer was not a confirmation. That is an unproven
              // outcome, and it is recorded as one: the item is blocked from re-sending until
              // something observes what actually happened.
              this.#store.recordQueueRemoval({
                taskId: session.task_id, sessionId: session.session_id, itemId, state: 'uncertain', operationId,
              });
              uncertain.push({ itemId, reason: 'host-answer-was-not-a-removal-confirmation', operationId });
            }
          } else if (result.status === 'uncertain') {
            // Sent, and unprovable: the Host may have applied the removal. Never counted as removed,
            // and never retried on our initiative — it is recorded so a restart cannot forget it.
            this.#store.recordQueueRemoval({
              taskId: session.task_id, sessionId: session.session_id, itemId, state: 'uncertain', operationId,
            });
            uncertain.push({ itemId, reason: result.reason ?? 'unproven-outcome', operationId });
          } else {
            // A definite business refusal, with the Host's own code preserved: `queue-item-not-found`
            // means the occurrence was not pending any more, which is a different fact from "we
            // never sent it" and must not be flattened into one.
            //
            // `sent` is read off the adapter's own construction rather than guessed: it attaches
            // `hostCode` only when the Host answered `ok:false`, and a refusal decided BEFORE any
            // byte was written (an unreachable host, an aborted call) carries no `hostCode`. So a
            // refusal with no `hostCode` is exactly "nothing was written", which the caller must be
            // able to tell apart from "the Host answered no" — and from "we do not know".
            const hostCode: unknown = this.#isPropertyBag(result.error?.details)
              ? result.error?.details['hostCode']
              : undefined;
            const sent = typeof hostCode === 'string';
            // The ledger is written only for a refusal that SETTLES the item, and left untouched for
            // one that does not. Two cases, and the difference is what makes a retry safe:
            //
            //   - `queue-item-not-found` is the Host's definite answer that the item is not in its
            //     queue. Nothing was removed and nothing needs to be, so the item is settled as
            //     `not-pending`. Recording it is what removes the last dependence on the HOST refusing
            //     a second, duplicate request: the duplicate is now refused here, before it is sent.
            //   - any other refusal decided before a byte was written (an unreachable host, an aborted
            //     call) is provably NOT applied, so nothing is recorded and the item stays sendable.
            //     Writing a row here would turn a network blip into a permanently blocked item.
            if (hostCode === 'queue-item-not-found') {
              this.#store.recordQueueRemoval({
                taskId: session.task_id, sessionId: session.session_id, itemId, state: 'not-pending', operationId,
              });
            }
            refused.push({
              itemId,
              code: sent ? hostCode : (result.error?.code ?? ERROR_CODES.HOST_REFUSED),
              state: 'refused',
              sent,
              message: result.error?.message ?? 'the host refused the queue removal',
            });
          }
        }
    });

    // Uncertainty dominates the summary: a removal whose outcome is unknown is never summarised as
    // a completed clear, and never as a failure either.
    const status: 'cleared' | 'partial' | 'refused' | 'uncertain' = uncertain.length > 0
      ? 'uncertain'
      : refused.length > 0
        ? (removed.length > 0 ? 'partial' : 'refused')
        : 'cleared';
    const reason = status === 'cleared'
      ? `the host accepted all ${removed.length} requested queue removal(s)`
      : status === 'partial'
        ? `removed ${removed.length} of ${requested.length} requested item(s); ${refused.length} refused, so the queue is not cleared`
        : status === 'refused'
          ? `nothing was removed: ${refused.length} request(s) refused, none reached a confirmed removal`
          : `outcome unknown for ${uncertain.length} item(s) (${removed.length} confirmed removed, ${refused.length} refused): the host may or may not have applied the unconfirmed removal(s), so the queue is not reported as cleared`;

    return {
      localRemoved,
      localScope: 'daemon',
      remoteScope: {
        status,
        cleared: status === 'cleared',
        requested: requested.length,
        // How many items were ACTUALLY removed, stated as a count as well as a list: the caller
        // asked "how much of this happened", and a list would make every reader count it.
        removedCount: removed.length,
        removed,
        refused,
        uncertain,
        observed,
        reason,
      },
      operations,
      turnScope: {
        effect: 'none',
        observed: { state: openTurn ? 'running' : 'idle', currentTurnId: openTurn?.turn_id ?? null },
        note: 'a queue removal never stops the active turn; session.cancel is the separate operation that does',
      },
      note: 'the Host queue scope and the daemon-local queue scope are reported separately and are separate operations from cancelling the active turn',
    };
  }

  interactionList({ taskId, state = null }: Record<string, unknown>) {
    const task = this.#requireTask(taskId);
    // `task.task_id` is the id that lookup just matched, i.e. the same string. The store's filter
    // is a string by contract and anything else cannot name a stored state, so a non-string is
    // filtered as absent — reachable only from a hand-built frame, since the tool schema checks it.
    const stateFilter: string | null = typeof state === 'string' ? state : null;
    return {
      interactions: this.#store.listInteractions(task.task_id, stateFilter)
        .map((row) => shapeInteraction(row, this.#store.getResponseDelivery(row.task_id, row.host_rpc_id))),
    };
  }

  /**
   * Decide an approval/question. Requires the operator authority token; a model-accessible
   * tool cannot reach this. The decision is a compare-and-set: a duplicate identical decision
   * is idempotent, a conflicting or stale one is rejected.
   */
  async interactionDecide({ taskId, interactionId, decision, authorityToken, reason = null, turnId = null }: Record<string, unknown>) {
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
      return await this.#decideAndReport(interaction, 'expired', 'expired-before-decision');
    }
    // FR-APPR-2: an answer is bound to the exact task + turn + rpcId it answers. The task and the
    // rpcId are bound above; this is the turn half, and it was missing entirely — an answer aimed at
    // a turn other than the one that opened the interaction was accepted. A caller that names a
    // turn must name the right one, and the refusal is typed rather than silent, because a silent
    // acceptance of a mis-aimed approval is the worst failure this surface can have.
    if (typeof turnId === 'string' && turnId !== interaction.turn_id) {
      this.#store.audit({
        taskId: taskIdValue, kind: 'approval-wrong-turn', actor: 'operator',
        detail: { interactionId, expectedTurnId: interaction.turn_id, suppliedTurnId: turnId },
      });
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'answer names a different turn than the interaction belongs to', {
        interactionId, expectedTurnId: interaction.turn_id, suppliedTurnId: turnId,
      });
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
        interaction: shapeInteraction(interaction, this.#store.getResponseDelivery(interaction.task_id, interaction.host_rpc_id)),
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
        // FR-APPR-1/2: a replayed decision is REFUSED with its own typed error, not reported as a
        // success carrying a 'duplicate' receipt. That shape made an operator's second, identical
        // click look like a first one that worked: a caller could not tell "your answer was applied"
        // from "nothing happened because you already answered", and could not tell either from a real
        // delivery. `ERROR_CODES.APPROVAL_REPLAYED` existed for this path and had no callers, which is
        // how the wrong shape survived.
        //
        // The detail reports how far the FIRST decision's DELIVERY got, because that is the
        // distinction an operator actually needs — and it is read off the recorded receipt rather than
        // inferred from the row's mere existence.
        //
        // This is where the previous form was wrong, and wrongly in the dangerous direction: it said
        // "the decision was already delivered to the Host" whenever a delivery row existed at all.
        // A row also exists for `dispatching` (bytes may have been written and nothing was observed),
        // for `uncertain` (the same, after a sweep), for `refused` (the Host was never reached) and
        // for `bad-response` (the Host HELD the request and rejected the answer). Telling an operator
        // "already delivered, re-deciding is a no-op" for any of those turns a possible duplicate into
        // a reassuring no-op, and for `refused` it also suppresses the retry that would actually fix
        // it. So the hint is now generated per member of the closed set, and it never converts an
        // unproven outcome into a delivered one.
        const deliveryState: string | null = previousDelivery?.outcome ?? null;
        throw new BridgeError(ERROR_CODES.APPROVAL_REPLAYED, 'this interaction was already decided with the same decision', {
          interactionId,
          decision,
          state: current.state,
          // `null` is meaningful rather than "unknown": the delivery row records what the Host
          // answered, so its absence means the answer was committed and never delivered.
          deliveredToHost: deliveryState,
          // `deliveredToHost` is kept for callers that already read it, and `deliveryState` names the
          // same value as what it is — a state, not a boolean. A caller can then branch on the closed
          // set instead of on null-ness.
          deliveryState,
          // An unlisted state falls back to the explicit unknown entry, not to the delivered wording:
          // the table is the decision, and a state nobody wrote a meaning for must not inherit the
          // most reassuring one.
          hint: APPROVAL_REPLAY_HINTS[deliveryState ?? 'never-attempted'] ?? APPROVAL_REPLAY_HINTS['unrecognised-state'],
        });
      }
      throw new BridgeError(ERROR_CODES.APPROVAL_STALE, 'interaction already decided with a different decision', {
        interactionId, previous: current.state,
      });
    }
    // Durable-before-send, in that order and for the reason AGENTS.md gives: the decision is now
    // committed, so a crash between here and the POST is recoverable by reconciliation rather than
    // lost. Only after that does the answer go on the wire.
    //
    // This is the delivery FR-APPR-2 and FR-APPR-3 are about, and until this commit it did not
    // happen at all: `interactionDecide` committed a local decision, returned a note promising an
    // asynchronous receipt, and never contacted the Host. `DshHostAdapter.respond` and
    // `Store.recordResponseDelivery` existed and had zero callers, so an operator's approval was
    // recorded as decided and silently never delivered. The receipt below is what the Host actually
    // answered, and it is recorded before it is returned so a replay is recognisable.
    // The session id in the answer is the HOST's, not ours. The Host compares the answer's sessionId
    // against the session it raised the request for, and our own `session_id` is a different
    // identifier that exists only inside this bridge — measured: the daemon's internal id is
    // `sess_…` while the Host's is `session-…`, so answering with the internal one would be an answer
    // about a session the Host has never heard of. This was caught only because a test asserted the
    // delivered payload's sessionId rather than merely that a delivery happened.
    const hostSessionId = this.#store.getSession(interaction.session_id)?.host_session_id ?? null;
    if (hostSessionId === null) {
      // The session row is gone (deleted task or a pruned state file). There is no answer to send,
      // and inventing one would be worse than refusing: report it, do not deliver.
      return {
        delivered: false,
        receipt: 'refused',
        note: 'the interaction\'s session is no longer present in local state, so no answer was sent',
      };
    }
    const answerValue = { sessionId: hostSessionId, approvalId: interaction.native_id, outcome: decision };
    // DURABLE BEFORE SEND, in this order and for the reason AGENTS.md section 6 gives. The decision
    // was committed above; this row commits THE INTENT TO DELIVER it, before a byte is written. A
    // process that dies between the send below and the outcome write leaves `dispatching` behind, and
    // that row is the only thing that can later distinguish "we may have answered the Host" from "we
    // never tried" — the two cases a crash between the decision and the send would otherwise collapse
    // into one. Without it, a crash after the POST looked exactly like a decision that was never
    // delivered, and "never delivered" is an invitation to deliver again.
    this.#store.recordResponseDelivery({
      taskId: interaction.task_id,
      hostRpcId: interaction.host_rpc_id,
      answerDigest: createDigest(String(interaction.native_id ?? interaction.host_rpc_id)),
      outcome: 'dispatching',
    });
    const delivered = await this.#adapter.respond({ rpcId: interaction.host_rpc_id, value: answerValue });
    const receipt = await this.#recordDelivery(interaction, delivered);
    return {
      interaction: shapeInteraction(
        this.#store.getInteraction(interaction.interaction_id),
        this.#store.getResponseDelivery(interaction.task_id, interaction.host_rpc_id),
      ),
      decision,
      delivered: receipt.delivered,
      receipt: receipt.receipt,
      note: receipt.note,
    };
  }

  /**
   * Turn a delivery result into a durable receipt and the honest words for it.
   *
   * The distinction this method exists to preserve is the one FR-APPR-3 is written about: the
   * carrier receipt is NOT the outcome. `{accepted:false, reason:'not-pending'}` means the Host has
   * no pending request for that rpc id — already resolved, expired or replayed — and a caller
   * reading "delivered" out of that would be told an approval was answered when it was not. So
   * `not-pending` marks the interaction host-resolved instead of answered, and an unreachable or
   * unproven transport is reported as uncertain rather than as either success or failure
   * (AGENTS.md 6: never map uncertainty onto success or failure).
   * @param interaction the interaction whose answer was just sent
   * @param delivered what the adapter observed
   * @returns the receipt words for the caller, after recording them
   */
  async #recordDelivery(interaction: InteractionRow, delivered: Result): Promise<{
    delivered: boolean; receipt: string; note: string;
  }> {
    const digest = createDigest(String(interaction.native_id ?? interaction.host_rpc_id));
    if (delivered.ok) {
      // `Result` carries its status-specific fields through an index signature whose values are
      // `unknown`, so the receipt is narrowed here rather than asserted: this is the boundary where
      // a peer-authored receipt becomes our own decision about what happened.
      // Where the receipt actually lives is not obvious, and reading the wrong slot is how a
      // `not-pending` comes back as `accepted` — the single most dangerous misreading on this
      // surface, because it tells an operator an answer was used when the Host never had the
      // request. MEASURED, not assumed: `DshHostAdapter.respond` returns
      // `Result`-as-toJSON-shaped `{status:'ok', receipt:'not-pending', reason:'not-pending'}`, so
      // the receipt sits at the TOP level, because this method calls `ok({...})` directly rather
      // than going through `#dispatch` (whose own `ok({value})` wrapper is what nests it a level
      // down for the mutation methods). All three shapes are accepted so that neither refactor of
      // the adapter nor a future `#dispatch`-shaped caller can silently turn this into a default.
      const atTop: unknown = delivered.receipt;
      const atValue: unknown = this.#isRecord(delivered.value) ? delivered.value['receipt'] : undefined;
      const atValueValue: unknown = this.#isRecord(delivered.value) && this.#isRecord(delivered.value['value'])
        ? delivered.value['value']['receipt'] : undefined;
      const receiptField: unknown = atTop ?? atValue ?? atValueValue;
      // A CLOSED set, and nothing is inferred from membership in it. The previous form read
      // `typeof receiptField === 'string' ? receiptField : 'accepted'` and then special-cased only
      // `not-pending`, so EVERY other string — `bad-response`, a future Host reason, a typo, any
      // arbitrary text at all — was recorded as an acceptance with `delivered: true`. On a safety
      // surface that is the worst possible default: a caller could not tell "the Host took the
      // answer" from "the Host's answer was a word this bridge had never seen". A receipt this bridge
      // does not recognise is now reported as unrecognised, and `accepted` must be said explicitly.
      const receiptName = typeof receiptField === 'string' ? receiptField : null;
      if (receiptName === null) {
        this.#store.recordResponseDelivery({
          taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'unclassified',
        });
        return {
          delivered: false,
          receipt: 'unclassified',
          note: 'the host answered, but its answer carried no receipt this bridge could classify',
        };
      }
      if (receiptName === 'bad-response') {
        // The Host HELD the request and rejected the answer as malformed, which is a defect in what
        // this bridge sent rather than a statement about the request. It is recorded as its own
        // outcome so it can never be read as "nothing was pending", and it is not a delivery.
        this.#store.recordResponseDelivery({
          taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'bad-response',
        });
        this.#store.markAnswerNotPending({
          interactionId: interaction.interaction_id, reason: 'host-receipt-bad-response',
        });
        return {
          delivered: false,
          receipt: 'bad-response',
          note: 'the host rejected the answer as malformed, so the request was NOT answered by this call',
        };
      }
      if (receiptName !== 'accepted' && receiptName !== 'not-pending') {
        // A recognised SHAPE carrying a word this bridge does not know. Reported as unknown rather
        // than assumed in either direction: it is neither a delivery nor a proven refusal, and the
        // interaction is left for reconciliation rather than being marked resolved.
        this.#store.recordResponseDelivery({
          taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'unrecognised',
        });
        return {
          delivered: false,
          receipt: 'unrecognised',
          note: `the host answered with a receipt this bridge does not recognise: ${receiptName}`,
        };
      }
      const observed = receiptName;
      if (observed === 'not-pending') {
        // The Host answered, and its answer is that this request is no longer pending. The
        // interaction is resolved BY THE HOST, so it is recorded that way and never as answered.
        this.#store.recordResponseDelivery({
          taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'not-pending',
        });
        // Its own transition, not a second `decideInteraction`: that compare-and-set only moves a row
        // out of `pending` and the answer we just sent already moved it, so the second call is
        // refused (measured) and the row would keep the operator's decision with no trace that the
        // Host had nothing pending. `markAnswerNotPending` records both halves instead.
        this.#store.markAnswerNotPending({
          interactionId: interaction.interaction_id, reason: 'host-receipt-not-pending',
        });
        return {
          delivered: false,
          receipt: 'not-pending',
          note: 'the host has no pending request for this rpc id; the interaction was already resolved, expired or replayed',
        };
      }
      this.#store.recordResponseDelivery({
        taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'accepted',
      });
      return {
        delivered: true,
        receipt: observed,
        note: 'the host accepted the answer; the resolved frame is the authoritative outcome',
      };
    }
    if (delivered.uncertain) {
      this.#store.recordResponseDelivery({
        taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'uncertain',
      });
      const why: unknown = delivered.reason;
      return {
        delivered: false,
        receipt: 'uncertain',
        note: `the answer may or may not have reached the host: ${String(why ?? 'unproven-outcome')}`,
      };
    }
    // A provable refusal means the Host never processed the answer. The decision stands as recorded
    // (it is an operator decision, not a transport event) and the carrier failure is reported as
    // itself, so the operator can retry deliberately rather than being told it worked.
    this.#store.recordResponseDelivery({
      taskId: interaction.task_id, hostRpcId: interaction.host_rpc_id, answerDigest: digest, outcome: 'refused',
    });
    const failure: unknown = delivered.error;
    const failureCode = failure instanceof BridgeError ? failure.code : 'unknown-refusal';
    return {
      delivered: false,
      receipt: 'refused',
      note: `the host did not accept the answer: ${failureCode}`,
    };
  }

  async #decideAndReport(interaction: InteractionRow, state: string, reason: string) {
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
      // A typed failure rather than the TypeError this used to throw in the name of ported fidelity.
      // The message `Cannot read properties of null (reading 'session_id')` reached the CALLER as the
      // daemon's error text — measured on the `session.create` conflict path, before that path was fixed
      // to resolve the row the conflict kept — and it tells an operator nothing they can act on: it reads
      // like a bug in the bridge with no state attached. A row that must exist and does not, immediately
      // after a write reported success, means the durable state and the operation disagree, which is what
      // this code says.
      //
      // No test forces this branch directly, and that is stated rather than implied: the flow that
      // produced it is gone, because `Store.recordSession` now returns the row the conflict kept instead
      // of the id it minted. Forcing it from here would mean corrupting a state file mid-operation, which
      // would test the fixture rather than this line. What IS tested is the removal of its only trigger.
      throw new BridgeError(ERROR_CODES.STORAGE_CORRUPT, `a row this operation requires is missing (${field})`, { field });
    }
    return row;
  }

  #requireTask(taskId: unknown): TaskRow {
    // The frame is parsed JSON: an id that is not a string cannot name a task this daemon recorded
    // (every id it mints is a string), so it takes the not-found path rather than being coerced.
    const task = typeof taskId === 'string' ? this.#store.getTask(taskId) : null;
    if (!task) throw new BridgeError(ERROR_CODES.NOT_FOUND, 'task not found', { taskId });
    if (task.host_base !== this.hostBase) {
      // The host origin is part of a task's identity, and the real Host usually comes back on a NEW
      // ephemeral port. Refusing is right — a session on another origin is another Host's session —
      // but the refusal must say what an operator can actually do about it, and must not read like a
      // corrupted state file when it is really a moved Host.
      throw new BridgeError(ERROR_CODES.CONFLICT, 'task belongs to a different host', {
        taskId,
        taskHostBase: task.host_base,
        daemonHostBase: this.hostBase,
        hint: 'the Host this task was attached to is at a different origin; point the daemon at that ' +
          'origin, or start a new task for the current one',
      });
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

  /**
   * Send one operation's request after committing `dispatching`, then record the outcome.
   *
   * There is no retry HERE, and no parameter that suggests one. A caller used to pass `retryable: true`
   * for `session.create`; the field was never read, so the signature advertised a control that did not
   * exist and the call site read as though a retry were configured. Retrying is decided by the caller from
   * the CONTRACT and the operation's durable state — `session.create` is retried because it accepts a
   * caller-preallocated id, and nothing else is retried at all — so the decision belongs where that
   * knowledge is, and the flag that only looked like it was made is gone.
   *
   * The input arrives as a field bag because that is what `handleIpc` holds: an IPC frame is the
   * peer's already-parsed JSON, so every field is `unknown` until it is narrowed here. `operation`
   * may legitimately be absent (the caller passes the nullable result of `#store.getOperation`),
   * which is why the null arm below is a real branch rather than an assertion.
   */
  async #dispatch({ operation, method, payload, allowedStates }: {
    operation: OperationRow | null;
    method: string;
    payload: object;
    allowedStates: readonly string[];
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
      // `result.value` IS the Host's value: `call()` returns `ok({ value: result.value, rpcId })`, so
      // the envelope's `value` field already holds what the Host sent. This used to read one level
      // further in (`result.value['value']`), which is a key that never exists — MEASURED against the
      // fixture, `call('session.create')` gives `r.value === {sessionId: '…'}` and
      // `r.value['value'] === undefined`. The effect was that every acknowledged operation durably
      // stored no value at all, so an ack could not be replayed after a crash, which is the whole
      // point of the record. The comment that justified the old read was simply wrong about the
      // adapter's shape, which is why the read is now taken verbatim and the shape is asserted by a
      // test rather than described by a comment.
      this.#store.markAcknowledged({
        operationId: freshRow.operation_id,
        ok: true,
        value: this.#isPropertyBag(result.value) || Array.isArray(result.value) ? result.value : undefined,
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

    // The workspace is re-verified before the work is dispatched, and before the intent is even reserved.
    //
    // Why here and not at create time only: a session can live for days, and the recorded directory can be
    // deleted, replaced by a file, or replaced by a SYMLINK to somewhere else in between. The Host would
    // then run the turn in a directory this bridge never recorded and the caller never chose — which is the
    // escape this check exists to stop. It runs before the intent is persisted so that a refusal leaves no
    // operation row and no possibility of a later replay sending the prompt anyway.
    //
    // The trade this makes, stated rather than implied: a retry carrying the same client key after the
    // workspace changed is refused instead of returning the earlier operation's recorded outcome. The
    // refusal is the more useful answer — the caller's intent was to run work in a directory that is gone.
    const recordedCwd: string | null = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : null;
    if (recordedCwd !== null) {
      const still = verifyWorkspace(recordedCwd, WORKSPACE_FS);
      if (!still.ok) throw workspaceChanged(recordedCwd, still.refusal);
    }

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
          const ws = await this.#adapter.openMux({
            signal,
            maxFrameBytes: this.#limits.frameMaxBytes,
            // Both remaining budgets are enforced by the connection itself, and both are the
            // configured ones rather than constants of its own: `eventMessageMaxBytes` bounds one
            // assembled message, and `eventBufferMaxBytes` is the memory this process will hold for
            // a reader that falls behind. One owner per quantity, so there is no second, quieter
            // limit that disagrees with the documented one.
            maxMessageBytes: this.#limits.eventMessageMaxBytes,
            maxQueueBytes: this.#limits.eventBufferMaxBytes,
          });
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
          // Bound AND redacted, not merely truncated: this is peer-authored text that the
          // bridge copies into its own durable interaction payload, so a credential quoted in
          // an approval reason would be a leak this project performs itself. 500 is the
          // pre-existing bound and is preserved.
          reason: typeof frame['reason'] === 'string' ? boundText(frame['reason'], 500) : null,
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
        // The Host's closed outcome set is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
        // (the installed Host's own declaration). 'answered' is reachable only from the ONE value
        // that actually means the answer was used, because the previous fall-through turned every
        // unrecognised outcome into a definite answer — an outcome nobody understands became
        // "answered by us", which is the failure AGENTS.md 6 names: an unknown outcome must surface
        // as unknown rather than be mapped to success.
        const decision = outcome === 'allowed-once' ? 'answered'
          : outcome === 'rejected' ? 'rejected'
            : outcome.includes('cancel') ? 'revoked'
              : outcome.includes('expire') ? 'expired'
                : outcome === 'unavailable' ? 'revoked'
                  : 'unresolved-by-host';
        this.#store.decideInteraction({
          interactionId: interaction.interaction_id,
          decision,
          reason: decision === 'unresolved-by-host' ? `host-resolved-with-unrecognised-outcome:${outcome}` : 'host-resolved-frame',
        });
      }
      return;
    }
    if (frame['type'] === 'session/queue') {
      // The Host's pending inbox, whole. Each frame is the COMPLETE transient state after an
      // enqueue, mutation, claim or discard, so it REPLACES the previous set rather than being
      // merged: replacement is what makes a removal observable as a disappearance, and what makes
      // a replayed frame idempotent. Nothing here is persisted (see `#observedQueue`).
      const hostSessionId = this.#frameSessionId(frame);
      const session = hostSessionId === null ? null : this.#store.findSessionByHostId(hostSessionId);
      if (!session) return; // not one of our sessions: never adopt it
      const rawItems: unknown = frame['items'];
      if (!Array.isArray(rawItems)) {
        // The contract declares `items` as an array. A frame that is not one cannot be read as "the
        // inbox is now empty" — that would be this scope's version of reporting a gap as complete —
        // so it is counted as malformed and the last observed snapshot is kept.
        this.#eventStats.malformed += 1;
        return;
      }
      const items: Array<{ itemId: string; placement: string }> = [];
      for (const entry of rawItems) {
        const entryFields: Record<string, unknown> = this.#isPropertyBag(entry) ? entry : {};
        const id = entryFields['id'];
        // An occurrence with no usable id cannot be named by a later removal, so it is not held:
        // keeping it would advertise an id no mutation could address.
        if (typeof id !== 'string' || id.length === 0) continue;
        const placement = entryFields['placement'];
        // The Host owns this vocabulary ('queued' | 'steering' | 'context'). An unrecognised value
        // is carried verbatim rather than mapped to a guess, so a newer Host cannot be silently
        // reinterpreted as one of the three this bridge happens to know.
        items.push({ itemId: id, placement: typeof placement === 'string' ? placement : 'unknown' });
      }
      this.#observedQueue.set(session.session_id, items);

      // Reconcile unproven removals against this snapshot, which is the only authority on what the
      // Host's queue actually holds. A fresh frame REPLACES the previous set, so an item that had an
      // unproven removal and is no longer listed is now observed to be gone: the uncertainty is
      // resolved by observation, and its ledger row moves to `removed`. Without this, an item whose
      // removal succeeded but whose answer was lost would stay blocked forever — the caller would be
      // told "unresolved" about an item that is provably not in the queue any more.
      //
      // The reverse is deliberately NOT done: a still-listed item stays `uncertain` rather than
      // being downgraded to "not applied". The frame says the item is queued now, which is consistent
      // with a removal that never happened AND with one that happened while another enqueue re-added
      // the same text under a new id; only a new id would be evidence either way, so the row is left
      // alone and the caller keeps being told the outcome is unproven.
      const listed = new Set(items.map((item) => item.itemId));
      for (const row of this.#store.listQueueRemovals(session.task_id, session.session_id)) {
        if (row.state !== 'uncertain' || listed.has(row.item_id)) continue;
        this.#store.recordQueueRemoval({
          taskId: session.task_id,
          sessionId: session.session_id,
          itemId: row.item_id,
          state: 'removed',
          operationId: row.operation_id,
        });
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
    // C-1: ONE inbound boundary, applied ONCE, and the resulting value is what BOTH consumers see —
    // the durable archive below and the state reduction at the end of this method. Two normalised
    // copies would be two payloads for one event, and the live reduction and a later replay would
    // then be able to disagree; redacting only the stored copy would leak; redacting only the live
    // copy would make replay diverge from what was actually reduced. `seq`, `type` and every id are
    // read from the RAW frame above and survive normalisation unchanged, which is what keeps this a
    // redaction boundary rather than a reshaping one.
    const normalisedEvent: unknown = redactInbound(frame['event'] ?? null);
    const before = this.#store.eventCoverage(session.task_id, session.session_id);
    const inserted = this.#store.appendEvent({
      taskId: session.task_id,
      sessionId: session.session_id,
      seq,
      kind: String(eventFields['type'] ?? 'unknown'),
      payload: { nativeType: eventFields['type'] ?? null, raw: normalisedEvent },
    });
    if (inserted) this.#eventStats.stored += 1;
    else this.#eventStats.duplicates += 1;
    const after = this.#recomputeCursor(session.task_id, session.session_id);
    // Count a gap once, when it FIRST appears for this session, rather than on every frame
    // that is observed while the hole is still open.
    if (inserted && after && after.completeness === 'incomplete' && before.missing.length === 0) {
      this.#eventStats.gaps += 1;
    }
    // The same value that was stored, so a replay of this row reduces to the same state.
    this.#applyEventToState(session.session_id, normalisedEvent);
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
      // The reason leads with the terminal STATE. FR-EXEC-3 requires the paths to be distinguishable
      // through the public surfaces, and both surfaces carry this one string: a caller could
      // previously read `authoritative turn/end at seq N` for a completed turn, a failed turn AND a
      // cancelled one, so "the turn ended" was all it learned. The evidence sentence is kept after
      // the state rather than replaced, because the reason must still name what it was derived from.
      this.#store.closeTurn({
        turnId: open.turn_id,
        state,
        reason: `${state}: authoritative turn/end at seq ${endSeq}`,
      });
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
        // `result.value` IS the Host's page (see the same correction in `#dispatch`). Reading
        // `result.value['value']` here was a key that never exists, so `page` was always `undefined`,
        // `events` was always empty and this whole refetch stored nothing — a silent no-op that
        // looked like working code and made the mux reconnect path decorative. The reconnect test
        // passed for the wrong reason: the daemon's backoff reconnects fast enough that the event
        // arrives live instead of needing history.
        const page: unknown = result.value;
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
          // The same single boundary as the live path, for the same reason: a row written by the
          // refetch must be indistinguishable from the same row written live, or a crash-replay of
          // the archive would reduce differently depending on which path happened to store it.
          const normalisedEvent: unknown = redactInbound(event ?? null);
          const inserted = this.#store.appendEvent({
            taskId, sessionId: session.session_id, seq,
            kind: String(eventFields['type'] ?? 'unknown'),
            payload: { nativeType: eventFields['type'] ?? null, raw: normalisedEvent, source: 'history-refetch' },
          });
          if (inserted) {
            appended += 1;
            this.#applyEventToState(session.session_id, normalisedEvent);
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

/**
 * The terminal STATE of the latest closed turn, from the store's own closed set, or null when no
 * turn has closed. Reads the same rows as `lastTerminalReason` above and walks them the same way, so
 * the two surfaces cannot disagree about which turn they are describing.
 * @param store
 * @param sessionId
 * @returns the state of the latest closed turn, if any
 */
function lastTerminalState(store: Store, sessionId: string): string | null {
  const turns: TurnRow[] = store.listTurns(sessionId);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].state !== 'open') return turns[i].state;
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
/** The longest label the `dsh_task_ensure` tool schema advertises. Longer labels are refused, not cut. */
const MAX_TASK_LABEL = 120;

function shapeTask(row: TaskRow): ShapedTask {
  return {
    taskId: row.task_id,
    // The caller's own label when it supplied one, and the internal key otherwise. A client shows this to
    // a human, and the internal key is not something a human asked for.
    label: row.display_label ?? row.label,
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
  /**
   * The turn this interaction belongs to, or null when the frame arrived outside a turn.
   *
   * Exposed because FR-APPR-2 requires an answer to be bound to an exact task + turn + rpcId, and
   * a binding a caller cannot observe is not a binding it can verify. The row always carried this
   * value; it was simply not handed out, which meant the wrong-turn case in the requirement could
   * not be exercised from the caller's side at all.
   */
  turnId: string | null;
  /** The Host's own rpc id for the answerable server-request the caller must echo. */
  hostRpcId: string;
  kind: string;
  state: string;
  nativeId: string | null;
  payloadDigest: string;
  payload: unknown;
  createdAt: number;
  expiresAt: number | null;
  /**
   * What happened to the ANSWER, as opposed to what was decided. `null` means the decision is
   * durable and no delivery was ever attempted; `dispatching` means bytes may have reached the Host
   * and no answer was observed; every other value is the recorded outcome. See `shapeInteraction`.
   */
  delivery: { state: string; at: number } | null;
}

/**
 * @param row an `interactions` row, or nothing when the rpc id is unknown.
 * @returns the shaped row, or `null` for both a null and an absent row.
 */
/**
 * What a replayed decision's delivery state MEANS, one entry per member of the closed set plus the
 * absence of a row. Written as a total table rather than a chain of conditionals so that adding a
 * delivery state without deciding what it means for an operator is a visible omission: the index is
 * typed as `Record<string, string>`, and an unlisted state falls back to the explicit entry for a
 * state this build does not know, never to the "delivered" wording.
 *
 * The one rule these all obey: never tell an operator the answer was delivered unless the Host said
 * so. `accepted` is the only state that may claim delivery, and `not-pending` is the opposite fact —
 * the Host had no request to apply it to.
 */
const APPROVAL_REPLAY_HINTS: Record<string, string> = {
  accepted: 'the decision was already delivered to the Host, which accepted it; re-deciding is a no-op and is refused',
  'not-pending': 'the answer was already sent and the Host answered that it holds no pending request for this '
    + 'rpc id, so the answer was NOT applied; re-deciding is refused, and the interaction is host-resolved',
  dispatching: 'an answer was already sent and the Host never answered it back, so it MAY have been applied; '
    + 're-deciding is refused rather than risk a second approval, and the outcome is unproven until it is reconciled',
  uncertain: 'an answer was already sent and its outcome was never proven, so it MAY have been applied; '
    + 're-deciding is refused rather than risk a second approval, and the outcome is unproven until it is reconciled',
  refused: 'the earlier answer never reached the Host, so it was NOT applied; the decision is durable and '
    + 'delivering it again is what is needed, not re-deciding it',
  'bad-response': 'the Host held the request and rejected the earlier answer as malformed, so it was NOT '
    + 'applied; delivering a corrected answer is what is needed, not re-deciding the interaction',
  unclassified: 'the Host answered the earlier attempt with a receipt this bridge could not classify, so '
    + 'whether it was applied is unknown; it is not reported as delivered',
  unrecognised: 'the Host answered the earlier attempt with a receipt this bridge does not recognise, so '
    + 'whether it was applied is unknown; it is not reported as delivered',
  'never-attempted': 'the decision is durable but no answer was ever delivered for it; delivering it is what '
    + 'is needed, not re-deciding the interaction',
  'unrecognised-state': 'the recorded delivery state is one this build does not know, so delivery is treated as '
    + 'unproven rather than assumed',
};

export function shapeInteraction(
  row: InteractionRow | null | undefined,
  delivery?: ResponseDedupeRow | null,
): ShapedInteraction | null {
  if (!row) return null;
  return {
    interactionId: row.interaction_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    hostRpcId: row.host_rpc_id,
    kind: row.kind,
    state: row.state,
    nativeId: row.native_id,
    payloadDigest: row.payload_digest,
    payload: safeJson(row.payload_json),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    /**
     * What happened to the ANSWER, which is a different question from what was decided.
     *
     * `null` means the decision is durable and no delivery was ever attempted; `dispatching` means
     * bytes may have reached the Host and no answer was observed; `accepted`/`not-pending`/
     * `bad-response`/`refused`/`uncertain`/... are the recorded outcomes. Without this a caller saw
     * `state: 'allowed-once'` and could not tell whether the Host had been told — which is exactly
     * the equation FR-APPR-3 forbids between "the decision is recorded" and "the answer was
     * delivered". Optional because only a caller holding a store connection can supply it.
     */
    delivery: delivery ? { state: delivery.outcome, at: Number(delivery.created_at) } : null,
  };
}
