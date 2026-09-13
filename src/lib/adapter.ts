/**
 * Typed adapter for the DSH Host `/api` surface.
 *
 * Why this file exists: the Host's wire contract is the one thing this project does not own,
 * and it has already drifted between published versions (methods appeared and disappeared
 * between resolved trees). So the adapter is deliberately dumb and explicitly negotiated:
 * it carries envelopes, verifies the rpcId echo, maps the closed error-code set, and reports
 * capability presence instead of assuming a method exists.
 *
 * Wire facts implemented here (measured against the installed package and a running host):
 *   POST /api/<method>  body {type:'client-request', rpcId, method, payload}
 *                       reply {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 *   POST /api/respond   body {type:'client-response', rpcId, result:{ok:true,value}}
 *                       reply is a CARRIER RECEIPT: {accepted:true} | {accepted:false,reason}
 *   GET  /api/events.mux   WebSocket-only (plain GET answers 426)
 *   GET  /api/events.host  WebSocket-only
 *
 * Outcome classification, which the rest of the system depends on:
 *   ok        -> a valid response with ok:true
 *   refused   -> a valid response with ok:false (a definite business refusal), or a
 *                deterministic client-side rejection before any byte was written
 *   uncertain -> the request may have been applied: a timeout or transport failure AFTER the
 *                bytes were handed to the socket. Never auto-retried.
 */

import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BridgeError, ERROR_CODES, refused, ok, uncertain, type Result } from './errors.ts';
import { connectWebSocket, type WebSocketConnection } from './ws-client.ts';

/**
 * The most response body this client will hold, for both unary paths.
 *
 * One constant rather than a number per call site: `call()` had this bound and `respond()` did not,
 * and two owners for one quantity is how a bound stops being a bound — the stricter one gets edited
 * and the other keeps a value nobody reads. A Host that streams more than this is refused as a
 * protocol error while the body is still being read, so the limit is about what this process holds
 * and not about what the peer sends.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Method map at the pin. Presence here is what capability negotiation starts from. */
export const PINNED_METHODS = Object.freeze([
  'session.list', 'session.search', 'session.create', 'session.history', 'session.models',
  'session.selectModel', 'session.rename', 'session.fork', 'session.prompt', 'session.attachment',
  'session.updateQueue', 'session.cancel',
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'host.describe', 'host.pickDirectory', 'host.listDirectory', 'host.createDirectory', 'host.openPath',
  'workspace.list', 'workspace.create', 'workspace.rename', 'workspace.delete',
  'workspace.insertBefore', 'workspace.insertSessionBefore', 'workspace.archiveSession',
  'skill.list',
  'agentPreset.list', 'agentPreset.select', 'agentPreset.read', 'agentPreset.copy',
  'agentPreset.openDocument', 'agentPreset.remove',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'llm.providers', 'llm.models', 'llm.discoverModels',
]);

/** Closed error-code set from the pinned contract; an unknown code is reported, not defaulted. */
export const PINNED_ERROR_CODES = Object.freeze([
  'bad-request', 'cancelled', 'session-not-found', 'model-unavailable', 'session-conflict',
  'invalid-time-zone', 'workspace-attach-failed', 'workspace-not-found', 'workspace-invalid-path',
  'workspace-name-conflict', 'workspace-move-invalid', 'directory-unreadable', 'directory-exists',
  'directory-create-failed', 'directory-picker-unavailable', 'agent-preset-read-only',
  'agent-preset-locked', 'agent-preset-conflict', 'agent-preset-not-found', 'agent-preset-invalid',
  'agent-busy', 'attachment-error', 'queue-item-not-found', 'steer-unavailable', 'command-error',
  'unknown-command', 'settings-rejected', 'settings-conflict', 'credential-rejected',
  'model-discovery-failed', 'title-invalid', 'fork-unavailable', 'subagent-parent-unavailable',
  'subagent-not-found', 'subagent-catalog-diagnostic', 'subagent-not-resumable',
  'subagent-unauthorized', 'subagent-delivery-unavailable', 'internal',
]);

/** What {@link DshHostAdapter} counts about its own behaviour. Counters only, never payload text. */
export interface AdapterStats {
  readonly unary: number;
  readonly refused: number;
  readonly uncertain: number;
  readonly protocolErrors: number;
  readonly oversize: number;
}

/**
 * The same five counters as the mutable state the getter above hands out a copy of. `readonly`
 * describes what a caller receives, not the field the increments are applied to.
 */
type MutableStats = { -readonly [K in keyof AdapterStats]: AdapterStats[K] };

/**
 * Negotiated capability set. Only presence is claimed: a method is `declared` when the pin knows
 * it, `probed` once the host has actually answered for it, and otherwise `unverified`.
 */
export interface AdapterCapabilities {
  readonly declared: readonly string[];
  readonly probed: readonly string[];
  readonly unverified: readonly string[];
}

/** Constructor options for {@link DshHostAdapter}. */
export interface DshHostAdapterOptions {
  /** like `http://127.0.0.1:3080` */
  readonly baseUrl: string;
  /** Host header authority (`null` = the URL authority) */
  readonly hostHeader?: string | null;
  /** unary deadline for bounded calls */
  readonly timeoutMs?: number;
}

/** Per-call options for {@link DshHostAdapter.call}. */
export interface AdapterCallOptions {
  /** abort the request when this signal fires */
  readonly signal?: AbortSignal;
  /** true for user-paced calls (no adapter deadline) */
  readonly callerPaced?: boolean;
}

/** Options for the two downlink openers. */
export interface DownlinkOptions {
  readonly signal?: AbortSignal;
  readonly maxFrameBytes?: number;
  /** Cap on one assembled message; see `connectWebSocket`, whose per-frame bound is not enough. */
  readonly maxMessageBytes?: number;
  /** Cap on parsed-but-unconsumed frames, i.e. the memory a slow reader may cause to be held. */
  readonly maxQueueBytes?: number;
}

/**
 * What one unary attempt settled as before any interpretation: a protocol-level refusal decided
 * while reading the body, or an HTTP reply still to be parsed.
 */
type UnaryOutcome =
  | { readonly kind: 'protocol'; readonly error: BridgeError }
  | { readonly kind: 'http'; readonly status: number | undefined; readonly text: string };

/**
 * The host's error member inside a `result:{ok:false}` envelope. Every field is optional because
 * it is a peer-supplied payload: `code` is defaulted to `internal` and `message` is bounded
 * before either reaches our own error surface.
 */
export interface HostErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
}

/**
 * The host's reply envelope, as far as this adapter reads it. Declared once here and cast at the
 * one `JSON.parse` boundary below; every member the adapter trusts (`type`, `rpcId`, `result.ok`)
 * is still checked at runtime exactly as the untyped original checked it.
 */
export interface ServerResponseEnvelope {
  readonly type?: string;
  readonly rpcId?: string;
  readonly result?: {
    readonly ok?: boolean;
    readonly value?: unknown;
    readonly error?: HostErrorEnvelope;
  };
}

/**
 * The action `session.updateQueue` applies to ONE pending inbox occurrence.
 *
 * Pinned to the Host's own union rather than accepted as an opaque `object`: the action is a
 * closed three-arm union on the wire (`edit` carrying replacement content, `remove`, `steer`),
 * and an open `object` here would let a caller send an arm the Host has no branch for while the
 * type checker stayed silent. Written out rather than imported, because this project takes no
 * dependency on the Host's packages (see AGENTS.md section 4).
 */
export type QueueAction =
  | { readonly kind: 'edit'; readonly content: readonly object[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' };

/**
 * The carrier receipt `/api/respond` answers with: the answer was taken, or why it was not.
 *
 * The Host's contract for `reason` is a CLOSED set — `not-pending` when it holds no request for that
 * rpc id, and `bad-response` when the answer itself was malformed — and the values are named here so
 * that the mapping below can be checked against them instead of against a recollection.
 */
export interface RespondReceipt {
  readonly accepted?: boolean;
  readonly reason?: unknown;
}

/** The closed set of reasons the Host's own contract names for a refused carrier receipt. */
export const RESPOND_REFUSAL_REASONS = Object.freeze(['not-pending', 'bad-response']);

/** The answer to deliver: the server-request's rpc id and the payload to answer with. */
export interface RespondInput {
  /** the server-request's rpc id, echoed verbatim */
  readonly rpcId: string;
  /** the answer payload */
  readonly value: object;
}

/**
 * The Host carrier.
 */
export class DshHostAdapter {
  #baseUrl: string;
  #hostHeader: string;
  #timeoutMs: number;
  /**
   * Methods the host has actually answered for; `null` until the first confirmed response.
   */
  #capabilities: Set<string> | null = null;
  #observedErrorCodes = new Set<string>();
  #stats: MutableStats = { unary: 0, refused: 0, uncertain: 0, protocolErrors: 0, oversize: 0 };

  /**
   * @param options
   * @param options.baseUrl e.g. http://127.0.0.1:3080
   * @param options.hostHeader Host header authority (`null` = the URL authority)
   * @param options.timeoutMs unary deadline for bounded calls
   */
  constructor({ baseUrl, hostHeader = null, timeoutMs = 15_000 }: DshHostAdapterOptions) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#hostHeader = hostHeader ?? new URL(this.#baseUrl).host;
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl(): string { return this.#baseUrl; }
  get hostHeader(): string { return this.#hostHeader; }
  get stats(): AdapterStats { return { ...this.#stats }; }
  get observedErrorCodes(): string[] { return [...this.#observedErrorCodes].sort(); }

  /**
   * Negotiated capability set. Only presence is claimed: a method is `declared` when the pin
   * knows it, and `probed` once the host has actually answered for it. A method that is
   * declared but not probed is reported as `unverified`, never as working.
   * @returns the three sets, in that order of strength
   */
  capabilities(): AdapterCapabilities {
    const probed = [...(this.#capabilities ?? [])].sort();
    return {
      declared: [...PINNED_METHODS],
      probed,
      unverified: PINNED_METHODS.filter((m) => !probed.includes(m)),
    };
  }

  /** @param method a method the host has answered for */
  #noteCapability(method: string): void {
    if (!this.#capabilities) this.#capabilities = new Set();
    this.#capabilities.add(method);
  }

  /**
   * Send one unary request.
   *
   * `payload` is typed `object`, not `Record<string, unknown>`, because it is opaque here — it is
   * only serialised into the envelope — and the daemon layer hands over its own named payload
   * shapes, which are not assignable to an index signature.
   * @param method wire method name, e.g. `session.create`
   * @param payload business payload
   * @param options abort signal, and whether the CALLER owns the deadline
   * @returns the classified outcome
   */
  async call(method: string, payload: object = {}, { signal, callerPaced = false }: AdapterCallOptions = {}): Promise<Result> {
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
    const url = new URL(`${this.#baseUrl}/api/${method}`);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return refused(new BridgeError(ERROR_CODES.BAD_REQUEST, 'call aborted before send', { method }));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const deadline = callerPaced ? null : setTimeout(() => controller.abort(), this.#timeoutMs);
    if (deadline) deadline.unref?.();

    let settled: UnaryOutcome;
    let bytesWritten = false;
    try {
      settled = await new Promise<UnaryOutcome>((resolve, reject) => {
        const req = httpRequest({
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            host: this.#hostHeader,
            // One request per connection: a reused socket would let a dropped response or a
            // peer-side close affect an unrelated later request.
            connection: 'close',
          },
          agent: false,
          signal: controller.signal,
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            // `setEncoding('utf8')` above makes every chunk a decoded string, which is why the
            // listener is annotated as a string: Node's own `data` signature says Buffer
            // regardless of the encoding.
            text += chunk;
            if (text.length > MAX_RESPONSE_BYTES) {
              // Named and numbered: the constant exists so there is one owner for the quantity, and a
              // message that only named the constant would make the reader open this file to learn a
              // number that used to be in the message itself.
              resolve({ kind: 'protocol', error: new BridgeError(ERROR_CODES.OVERSIZE, `response body exceeds ${MAX_RESPONSE_BYTES} bytes`, { method, maxResponseBytes: MAX_RESPONSE_BYTES }) });
              req.destroy();
            }
          });
          res.on('end', () => {
            resolve({ kind: 'http', status: res.statusCode, text });
          });
        });
        req.on('socket', (socket) => {
          socket.once('connect', () => { bytesWritten = true; });
        });
        req.on('error', reject);
        req.end(body);
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const uncertainNow = bytesWritten;
      this.#stats.unary += 1;
      if (uncertainNow) {
        this.#stats.uncertain += 1;
        return uncertain('transport-after-send', {
          method,
          rpcId,
          reason: aborted ? 'timeout-after-send' : 'transport-error-after-send',
          message: boundText(error instanceof Error ? error.message : String(error)),
        });
      }
      this.#stats.refused += 1;
      return refused(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `host unreachable before send: ${boundText(error instanceof Error ? error.message : String(error))}`, { method }));
    } finally {
      if (deadline) clearTimeout(deadline);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    this.#stats.unary += 1;

    if (settled.kind === 'protocol') {
      // The oversize guard trips while READING a response body, so the Host answered: post-send.
      this.#stats.protocolErrors += 1;
      return this.#refuseOrUncertain(bytesWritten, 'oversize-response-after-send', settled.error, method, rpcId);
    }
    if (settled.status !== 200) {
      // An HTTP failure is a RESPONSE, so the Host received the request. Reporting this as `refused`
      // would assert "not applied" for a request the Host demonstrably processed far enough to answer.
      return this.#refuseOrUncertain(bytesWritten, 'http-error-after-send', new BridgeError(
        ERROR_CODES.HOST_REFUSED,
        `host answered HTTP ${settled.status} for ${method}`,
        { method, status: settled.status },
      ), method, rpcId);
    }

    let envelope: ServerResponseEnvelope;
    try {
      // The only untyped boundary in this method: the body is JSON written by the peer, and the
      // three checks below are the ones the original performed on the parsed value.
      envelope = JSON.parse(settled.text) as ServerResponseEnvelope;
    } catch {
      this.#stats.protocolErrors += 1;
      return this.#refuseOrUncertain(bytesWritten, 'unreadable-response-after-send',
        new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response body is not json', { method }), method, rpcId);
    }
    if (envelope?.type !== 'server-response') {
      this.#stats.protocolErrors += 1;
      return this.#refuseOrUncertain(bytesWritten, 'unreadable-response-after-send',
        new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response is not a server-response envelope', { method }), method, rpcId);
    }
    if (envelope.rpcId !== rpcId) {
      // A mismatched echo means the answer belongs to another call: never accept it.
      this.#stats.protocolErrors += 1;
      return this.#refuseOrUncertain(bytesWritten, 'mismatched-envelope-after-send',
        new BridgeError(ERROR_CODES.ENVELOPE_MISMATCH, 'response rpcId does not echo the request', { method }), method, rpcId);
    }
    const result = envelope.result;
    if (result?.ok === true) {
      this.#noteCapability(method);
      return ok({ value: result.value ?? null, rpcId });
    }
    if (result?.ok === false) {
      const code = result.error?.code ?? 'internal';
      this.#observedErrorCodes.add(code);
      if (!PINNED_ERROR_CODES.includes(code)) {
        // An unknown code is a capability signal: report it, do not silently map it to success.
        this.#stats.protocolErrors += 1;
      }
      this.#stats.refused += 1;
      return refused(new BridgeError(ERROR_CODES.HOST_REFUSED, boundText(result.error?.message ?? 'host refused'), {
        method,
        hostCode: code,
        known: PINNED_ERROR_CODES.includes(code),
        details: sanitizeDetails(result.error?.details),
      }));
    }
    this.#stats.protocolErrors += 1;
    return this.#refuseOrUncertain(bytesWritten, 'unreadable-response-after-send',
      new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response result is neither ok nor error', { method }), method, rpcId);
  }


  /**
   * Classify a failure that happened after the request bytes were handed to the socket.
   *
   * Why this exists: the module's own contract distinguishes `refused` ("not applied") from
   * `uncertain` ("may have been applied, outcome unknown"), and the single deciding question is
   * whether the bytes left this process. `transport` failures already asked it via `bytesWritten`;
   * the RESPONSE-side failures did not, and reported `refused` for failures that demonstrably
   * happened after the Host had received the request — a non-200 status, a body that is not JSON,
   * a wrong envelope, a mismatched rpcId, or a body that is neither ok nor error.
   *
   * That direction is the dangerous one. For a non-idempotent mutation such as `session.prompt` or
   * `session.cancel`, `refused` is the bridge saying "this was not applied" on the strength of an
   * unreadable reply — and the durable record then says the same. The Host may have run the turn.
   * An unprovable outcome must surface as UNCERTAIN, which is exactly what the design requires and
   * what the caller can reconcile; a confident "no" is a claim we cannot support.
   *
   * Note the asymmetry, which is deliberate: when nothing was written there is no ambiguity and the
   * result stays `refused`, because "we never sent it" IS provable.
   */
  #refuseOrUncertain(bytesWritten: boolean, reason: string, error: BridgeError, method: string, rpcId: string) {
    if (!bytesWritten) {
      this.#stats.refused += 1;
      return refused(error);
    }
    this.#stats.uncertain += 1;
    return uncertain(reason, {
      method,
      rpcId,
      reason,
      message: `${error.code}: ${error.message}`,
    });
  }

  /**
   * Deliver a client-response (approval or question answer) and report the CARRIER RECEIPT.
   * The receipt is not the outcome: `{accepted:false, reason:'not-pending'}` means the host
   * has no pending request for that rpc id (already resolved, expired or replayed), which the
   * caller must surface as such rather than as "answered".
   * @param input the server-request's rpc id and the answer payload
   * @returns the classified outcome
   */
  async respond({ rpcId, value }: RespondInput): Promise<Result> {
    const body = JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } });
    const url = new URL(`${this.#baseUrl}/api/respond`);
    let bytesWritten = false;
    let oversize = false;
    /**
     * This path had no deadline and no body bound, and both absences are the same defect: a Host that
     * accepts the request and then answers slowly, endlessly, or never would hold this call — and the
     * memory of its body — for as long as it liked. The deadline is the adapter's existing unary one
     * rather than a new constant, and the body bound is the shared `MAX_RESPONSE_BYTES`, so there is
     * one owner per quantity instead of a second, quieter limit that disagrees.
     */
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    deadline.unref?.();
    try {
      const settled = await new Promise<{ readonly status: number | undefined; readonly text: string }>((resolve, reject) => {
        const req = httpRequest({
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            host: this.#hostHeader,
            connection: 'close',
          },
          agent: false,
          signal: controller.signal,
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.length > MAX_RESPONSE_BYTES) {
              // Refused while reading, not after: the point of the bound is the memory this process
              // holds, so it is enforced on the way in. The receipt is unreadable either way, so this
              // is an unproven outcome and the caller must not treat it as "not sent".
              // Flagged before the promise settles: the reader below tests this flag, and leaving the
              // order the other way round would make correctness depend on microtask ordering.
              oversize = true;
              resolve({ status: undefined, text: '' });
              req.destroy();
            }
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('socket', (socket) => socket.once('connect', () => { bytesWritten = true; }));
        req.on('error', reject);
        req.end(body);
      });
      if (oversize) {
        this.#stats.protocolErrors += 1;
        return uncertain('respond-receipt-oversize', {
          rpcId,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          note: 'the answer may have been applied; the receipt could not be read, so the outcome is unproven',
        });
      }
      if (settled.status !== 200) {
        return refused(new BridgeError(ERROR_CODES.HOST_REFUSED, `respond answered HTTP ${settled.status}`, { status: settled.status }));
      }
      let receipt: RespondReceipt;
      try {
        // The same single untyped boundary as above: a receipt written by the peer.
        receipt = JSON.parse(settled.text) as RespondReceipt;
      } catch {
        // An unreadable receipt is an UNPROVEN outcome, not a refusal — the same rule the oversize
        // branch above follows, and the rule the whole post-send classification rests on: bytes
        // reached the socket, so "provably not applied" is not available. This used to be a
        // `HOST_PROTOCOL` refusal, which the caller reports as "the host did not accept the answer" —
        // telling an operator that an answer the Host may well have applied never arrived. The
        // malformed-answer case is different and stays a refusal: there the Host SAID it rejected the
        // answer (`{accepted:false, reason:'bad-response'}`), which is a readable receipt.
        return uncertain('respond-receipt-unreadable', {
          rpcId,
          bytes: settled.text.length,
          note: 'the host answered but its receipt could not be parsed, so the outcome is unproven',
        });
      }
      if (receipt?.accepted === true) return ok({ receipt: 'accepted' });
      // `accepted: false` carries WHY, and the why is not one thing. Collapsing every refusal into
      // `not-pending` told the caller "the host has no pending request for this rpc id" for a
      // `bad-response` too — which is the opposite fact: the Host DID have the request and rejected
      // the ANSWER as malformed, i.e. this bridge sent something wrong. Reporting that as "nothing was
      // pending" hides a defect in the very code path being reported on, so the reasons are mapped
      // explicitly and an unrecognised one is named as unrecognised rather than defaulted.
      const reason = typeof receipt?.reason === 'string' ? receipt.reason : 'unknown';
      if (reason === 'not-pending' || reason === 'bad-response') {
        return ok({ receipt: reason, reason });
      }
      return ok({ receipt: 'unclassified', reason });
    } catch (error) {
      // A timeout and a dropped connection are the SAME question here, and the question is whether the
      // answer could have reached the Host. Once bytes have been written it could, so the outcome is
      // unproven — never "not sent", which would invite a caller to deliver the answer a second time.
      if (bytesWritten) {
        return uncertain('respond-transport-after-send', {
          rpcId,
          reason: timedOut ? 'timeout-after-send' : 'transport-error-after-send',
          message: boundText(error instanceof Error ? error.message : String(error)),
        });
      }
      return refused(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `respond failed before send: ${boundText(error instanceof Error ? error.message : String(error))}`, {}));
    } finally {
      // The timer is cleared on EVERY path, not only the failing one: a live timer holds the event
      // loop open and, in a long-lived daemon, one leaked per approval would be a slow leak of them.
      clearTimeout(deadline);
    }
  }

  // ---- convenience wrappers (thin; each returns a Result) ---------------------------

  /** @returns the host's own description */
  describe(): Promise<Result> { return this.call('host.describe', {}); }

  /** @param payload paging cursor, when resuming a listing */
  listSessions(payload: { readonly cursor?: string } = {}): Promise<Result> { return this.call('session.list', payload); }

  /**
   * @param payload the session to create
   */
  createSession(payload: {
    readonly cwd?: string;
    readonly sessionId?: string;
    readonly agentPreset?: string;
    readonly workspaceId?: string;
  }): Promise<Result> { return this.call('session.create', payload); }

  /**
   * @param payload the session and the page bound
   */
  history(payload: {
    readonly sessionId: string;
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
  }): Promise<Result> { return this.call('session.history', payload); }

  /**
   * @param payload the prompt and how it enters the session
   */
  prompt(payload: {
    readonly sessionId: string;
    readonly mode: 'queue' | 'steer';
    readonly content: object[];
    readonly clientTimeZone?: string;
  }): Promise<Result> { return this.call('session.prompt', payload); }

  /**
   * @param payload the queued item and the action to apply to it. `sessionId` and `itemId` are the
   *   Host's own ids: `itemId` is a `MessageId` observed from a `session/queue` frame, which is the
   *   only place a usable one comes from — queued work is not durable until the Agent claims it, so
   *   there is no other id to address it by.
   */
  updateQueue(payload: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly action: QueueAction;
  }): Promise<Result> { return this.call('session.updateQueue', payload); }

  /** @param payload the session whose active turn is cancelled */
  cancel(payload: { readonly sessionId: string }): Promise<Result> { return this.call('session.cancel', payload); }

  /** @param payload the session whose model list is read */
  models(payload: { readonly sessionId: string }): Promise<Result> { return this.call('session.models', payload); }

  /**
   * Open the all-session mux downlink as a real WebSocket.
   * @param options abort signal and frame bound
   * @returns the frame stream, the writers, and the handshake result
   */
  openMux({ signal, maxFrameBytes = 1024 * 1024, maxMessageBytes, maxQueueBytes }: DownlinkOptions = {}): Promise<WebSocketConnection> {
    const wsUrl = this.#baseUrl.replace(/^http/, 'ws') + '/api/events.mux';
    return connectWebSocket({ url: wsUrl, signal, maxFrameBytes, maxMessageBytes, maxQueueBytes });
  }

  /**
   * Open the host-level downlink.
   * @param options abort signal and frame bound
   * @returns the frame stream, the writers, and the handshake result
   */
  openHostStream({ signal, maxFrameBytes = 1024 * 1024, maxMessageBytes, maxQueueBytes }: DownlinkOptions = {}): Promise<WebSocketConnection> {
    const wsUrl = this.#baseUrl.replace(/^http/, 'ws') + '/api/events.host';
    return connectWebSocket({ url: wsUrl, signal, maxFrameBytes, maxMessageBytes, maxQueueBytes });
  }
}

/**
 * Credential shapes as they appear in TEXT a peer hands us: a provider token, an authorization
 * header, a `key=value` assignment, or a bare JWT. Deliberately shape-based and deliberately
 * narrow: this redacts material that is recognisably a credential and leaves ordinary diagnostic
 * prose intact, because an error that has been scrubbed into uselessness is a second bug.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // Provider-style tokens, including the sentinel shape the security suite plants. The longest
  // forms are tried first so `sk-ant-...` is consumed as a whole rather than leaving its tail.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:gh[pousr]|glpat|xox[baprs])-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  // A `key=value` or `"key": "value"` pair whose NAME says it is a credential.
  /((?:api[-_]?key|auth[-_]?token|access[-_]?token|client[-_]?secret|password|passwd|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi,
  // A bare JWT: three base64url segments, the first of which decodes to a JSON header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** What replaces redacted material. Named so a reader of a log can tell a redaction from a blank. */
const REDACTION = '[redacted:credential]';

/**
 * Remove credential-shaped material from peer-supplied text.
 *
 * Why this exists: the Host, and anything behind it, authors text that this bridge copies into its
 * own error surface and its own outbox. That text can quote a provider token — a failed
 * authorization is exactly the situation in which a token gets echoed — so the copy is a leak that
 * this project would be performing itself, not one it merely failed to prevent. FR-SEC-3 says a
 * secret never appears in state, logs or errors, so the copy is redacted at the boundary.
 * @param text the peer's text
 * @returns the text with credential-shaped runs replaced
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, REDACTION);
  return out;
}

/**
 * Bound, clean and REDACT a peer-supplied string before it enters our own error surface.
 * @param value the peer's value, of any type
 * @param max the longest string to keep
 * @returns the cleaned, bounded, redacted string
 */
export function boundText(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : String(value);
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  // Redact BEFORE truncating, and the order is load-bearing: truncating first can cut a credential
  // in half, and half a credential is still a leak of the half that survived.
  const redacted = redactCredentials(cleaned);
  return redacted.length > max ? `${redacted.slice(0, max)}…[truncated ${redacted.length - max} chars]` : redacted;
}

/**
 * Keep only bounded, non-secret detail fields from a host error payload. Unknown shapes are
 * summarised rather than copied, so a host detail can never smuggle a large or secret blob
 * into a log or a tool result. Strings are bounded for the same reason: the size of a peer's
 * error must not become the size of ours.
 * @param details the host's detail bag, of any shape
 * @returns a bounded, string-keyed bag
 */
export function sanitizeDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') out[key] = boundText(value, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length} items]`;
    else out[key] = '[object]';
  }
  return out;
}
