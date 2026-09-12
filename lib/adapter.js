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
import { BridgeError, ERROR_CODES, refused, ok, uncertain } from './errors.js';
import { connectWebSocket } from './ws-client.js';

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

/**
 * The Host carrier.
 */
export class DshHostAdapter {
  #baseUrl;
  #hostHeader;
  #timeoutMs;
  #capabilities = null;
  #observedErrorCodes = new Set();
  #stats = { unary: 0, refused: 0, uncertain: 0, protocolErrors: 0, oversize: 0 };

  /**
   * @param {object} options
   * @param {string} options.baseUrl e.g. http://127.0.0.1:3080
   * @param {string} [options.hostHeader] Host header authority (defaults to the URL authority)
   * @param {number} [options.timeoutMs] unary deadline for bounded calls
   */
  constructor({ baseUrl, hostHeader = null, timeoutMs = 15_000 }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#hostHeader = hostHeader ?? new URL(this.#baseUrl).host;
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() { return this.#baseUrl; }
  get hostHeader() { return this.#hostHeader; }
  get stats() { return { ...this.#stats }; }
  get observedErrorCodes() { return [...this.#observedErrorCodes].sort(); }

  /**
   * Negotiated capability set. Only presence is claimed: a method is `declared` when the pin
   * knows it, and `probed` once the host has actually answered for it. A method that is
   * declared but not probed is reported as `unverified`, never as working.
   * @returns {{declared: string[], probed: string[], unverified: string[]}}
   */
  capabilities() {
    const probed = [...(this.#capabilities ?? [])].sort();
    return {
      declared: [...PINNED_METHODS],
      probed,
      unverified: PINNED_METHODS.filter((m) => !probed.includes(m)),
    };
  }

  /** @param {string} method */
  #noteCapability(method) {
    if (!this.#capabilities) this.#capabilities = new Set();
    this.#capabilities.add(method);
  }

  /**
   * Send one unary request.
   * @param {string} method wire method name, e.g. `session.create`
   * @param {object} payload business payload
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.callerPaced] true for user-paced calls (no adapter deadline)
   * @returns {Promise<import('./errors.js').Result>}
   */
  async call(method, payload = {}, { signal, callerPaced = false } = {}) {
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

    let settled;
    let bytesWritten = false;
    try {
      settled = await new Promise((resolve, reject) => {
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
          res.on('data', (chunk) => {
            text += chunk;
            if (text.length > 8 * 1024 * 1024) {
              resolve({ kind: 'protocol', error: new BridgeError(ERROR_CODES.OVERSIZE, 'response body exceeds 8MiB', { method }) });
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
      return refused(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `host unreachable before send: ${boundText(error.message)}`, { method }));
    } finally {
      if (deadline) clearTimeout(deadline);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    this.#stats.unary += 1;

    if (settled.kind === 'protocol') {
      this.#stats.protocolErrors += 1;
      return refused(settled.error);
    }
    if (settled.status !== 200) {
      this.#stats.refused += 1;
      return refused(new BridgeError(
        ERROR_CODES.HOST_REFUSED,
        `host answered HTTP ${settled.status} for ${method}`,
        { method, status: settled.status },
      ));
    }

    let envelope;
    try {
      envelope = JSON.parse(settled.text);
    } catch {
      this.#stats.protocolErrors += 1;
      return refused(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response body is not json', { method }));
    }
    if (envelope?.type !== 'server-response') {
      this.#stats.protocolErrors += 1;
      return refused(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response is not a server-response envelope', { method }));
    }
    if (envelope.rpcId !== rpcId) {
      // A mismatched echo means the answer belongs to another call: never accept it.
      this.#stats.protocolErrors += 1;
      return refused(new BridgeError(ERROR_CODES.ENVELOPE_MISMATCH, 'response rpcId does not echo the request', {
        method,
      }));
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
    return refused(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'response result is neither ok nor error', { method }));
  }

  /**
   * Deliver a client-response (approval or question answer) and report the CARRIER RECEIPT.
   * The receipt is not the outcome: `{accepted:false, reason:'not-pending'}` means the host
   * has no pending request for that rpc id (already resolved, expired or replayed), which the
   * caller must surface as such rather than as "answered".
   * @param {object} options
   * @param {string} options.rpcId the server-request's rpc id, echoed verbatim
   * @param {object} options.value the answer payload
   * @returns {Promise<import('./errors.js').Result>}
   */
  async respond({ rpcId, value }) {
    const body = JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } });
    const url = new URL(`${this.#baseUrl}/api/respond`);
    let bytesWritten = false;
    try {
      const settled = await new Promise((resolve, reject) => {
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
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('socket', (socket) => socket.once('connect', () => { bytesWritten = true; }));
        req.on('error', reject);
        req.end(body);
      });
      if (settled.status !== 200) {
        return refused(new BridgeError(ERROR_CODES.HOST_REFUSED, `respond answered HTTP ${settled.status}`, { status: settled.status }));
      }
      let receipt;
      try {
        receipt = JSON.parse(settled.text);
      } catch {
        return refused(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'respond receipt is not json', {}));
      }
      if (receipt?.accepted === true) return ok({ receipt: 'accepted' });
      return ok({ receipt: 'not-pending', reason: receipt?.reason ?? 'unknown' });
    } catch (error) {
      if (bytesWritten) {
        return uncertain('respond-transport-after-send', {
          rpcId,
          message: boundText(error instanceof Error ? error.message : String(error)),
        });
      }
      return refused(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `respond failed before send: ${boundText(error.message)}`, {}));
    }
  }

  // ---- convenience wrappers (thin; each returns a Result) ---------------------------

  /** @returns {Promise<import('./errors.js').Result>} */
  describe() { return this.call('host.describe', {}); }

  /** @param {{cursor?: string}} [payload] */
  listSessions(payload = {}) { return this.call('session.list', payload); }

  /**
   * @param {{cwd?: string, sessionId?: string, agentPreset?: string, workspaceId?: string}} payload
   */
  createSession(payload) { return this.call('session.create', payload); }

  /**
   * @param {{sessionId: string, beforeSeq?: number, maxMessages?: number}} payload
   */
  history(payload) { return this.call('session.history', payload); }

  /**
   * @param {{sessionId: string, mode: 'queue'|'steer', content: object[], clientTimeZone?: string}} payload
   */
  prompt(payload) { return this.call('session.prompt', payload); }

  /**
   * @param {{sessionId: string, itemId: string, action: object}} payload
   */
  updateQueue(payload) { return this.call('session.updateQueue', payload); }

  /** @param {{sessionId: string}} payload */
  cancel(payload) { return this.call('session.cancel', payload); }

  /** @param {{sessionId: string}} payload */
  models(payload) { return this.call('session.models', payload); }

  /**
   * Open the all-session mux downlink as a real WebSocket.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.maxFrameBytes]
   * @returns {Promise<{frames: AsyncIterable<string>, close: () => void, closed: Promise<void>}>}
   */
  openMux({ signal, maxFrameBytes = 1024 * 1024 } = {}) {
    const wsUrl = this.#baseUrl.replace(/^http/, 'ws') + '/api/events.mux';
    return connectWebSocket({ url: wsUrl, signal, maxFrameBytes });
  }

  /**
   * Open the host-level downlink.
   * @param {object} [options]
   */
  openHostStream({ signal, maxFrameBytes = 1024 * 1024 } = {}) {
    const wsUrl = this.#baseUrl.replace(/^http/, 'ws') + '/api/events.host';
    return connectWebSocket({ url: wsUrl, signal, maxFrameBytes });
  }
}

/**
 * Bound and clean a peer-supplied string before it enters our own error surface.
 * @param {unknown} value
 * @param {number} [max]
 */
export function boundText(value, max = 400) {
  const text = typeof value === 'string' ? value : String(value);
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…[truncated ${cleaned.length - max} chars]` : cleaned;
}

/**
 * Keep only bounded, non-secret detail fields from a host error payload. Unknown shapes are
 * summarised rather than copied, so a host detail can never smuggle a large or secret blob
 * into a log or a tool result. Strings are bounded for the same reason: the size of a peer's
 * error must not become the size of ours.
 * @param {unknown} details
 * @returns {object}
 */
export function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') out[key] = boundText(value, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length} items]`;
    else out[key] = '[object]';
  }
  return out;
}
