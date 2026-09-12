/**
 * A fake DSH Host: real HTTP, real WebSocket, real receipt semantics.
 *
 * Why this file exists: the bridge's most delicate behaviour (envelope echo verification,
 * error-code mapping, gap detection, dropped acks, receipt semantics) can only be tested
 * against something that speaks the same wire protocol over real sockets. A mock object that
 * bypasses HTTP would leave the carrier untested; and this fixture is deliberately NOT the
 * official Host — it proves things about OUR client, never about the DSH product. Suites that
 * need the product use test/isolated-host instead.
 *
 * Fault injection is first-class, because those are the cases that must not lie:
 *   - dropResponseFor(method): the request is accepted and applied, the reply never arrives
 *     (the exact situation that must become `uncertain`, never a retry);
 *   - duplicateEvent / reorderEvents / malformedFrames / oversizeFrames: event-stream hazards;
 *   - rejectWith(code): a deterministic host refusal;
 *   - delayFor(method, ms): slow responses.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { acceptWebSocket } from '../../dist/lib/ws-client.js';

/** One fake host instance, listening on an ephemeral port. */
export class FakeHost {
  #server;
  #port = 0;
  #sockets = new Set();
  #muxSockets = []; 
  #hostSockets = [];
  #dropped = new Set();
  #delayed = new Map();
  #rejections = new Map();
  #results = new Map();
  #faults = { malformedFrames: 0, oversizeFrames: 0, duplicateEvery: 0, reorderWindow: 0 };
  #events = [];
  #seq = 0;
  #received = [];
  #sessions = new Map();
  #respondReceipts = [];
  #nextRpcId = null;
  /** ws -> raw TCP socket, so dropping a downlink is a real disconnect at both ends. */
  #downlinkSockets = new Map();

  /** @type {{hostDescribe?: object}} */
  describeOverride = {};

  /** When true, a prompt produces a complete turn (start + terminal end) deterministically. */
  autoTurn = true;

  /**
   * Control the per-session turn number used by the terminal event, so a stale or foreign
   * turn end can be injected deliberately.
   */
  forceTurnNumber(hostSessionId, turn) {
    const session = this.#sessions.get(hostSessionId);
    if (!session) throw new Error(`unknown fixture session ${hostSessionId}`);
    session.turnCounter = turn;
    return session;
  }

  async start() {
    this.#server = createServer((req, res) => this.#handleHttp(req, res));
    this.#server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.#port = this.#server.address().port;
    return this;
  }

  get baseUrl() { return `http://127.0.0.1:${this.#port}`; }
  get received() { return [...this.#received]; }
  get respondReceipts() { return [...this.#respondReceipts]; }

  /** @param {string} method */
  requestsFor(method) {
    return this.#received.filter((row) => row.method === method);
  }

  /** Requests that actually carried a business effect, i.e. were not refused client-side. */
  get mutationCount() {
    return this.#received.filter((row) => row.method !== 'host.describe').length;
  }

  /** Make the next N responses for a method disappear after being applied. */
  dropResponseFor(method) { this.#dropped.add(method); }
  stopDropping(method) { this.#dropped.delete(method); }
  /** @param {string} method @param {number} ms */
  delayFor(method, ms) { this.#delayed.set(method, ms); }
  /** @param {string} method @param {{code: string, message?: string}} error */
  rejectWith(method, error) { this.#rejections.set(method, error); }
  /** @param {string} method @param {object} value */
  respondWith(method, value) { this.#results.set(method, value); }
  /** @param {object} faults */
  injectFaults(faults) { this.#faults = { ...this.#faults, ...faults }; }

  /**
   * Create a session the way the real host does: an id the caller preallocated, or a fresh one.
   * @param {string} [sessionId]
   */
  createSession(sessionId) {
    const id = sessionId ?? `session-${randomUUID()}`;
    const createdAt = Date.now();
    this.#sessions.set(id, { sessionId: id, createdAt, running: false, cwd: null, events: [] });
    return { sessionId: id, createdAt };
  }

  /** @param {string} sessionId */
  session(sessionId) { return this.#sessions.get(sessionId) ?? null; }

  /**
   * Emit one session event onto the mux downlink.
   *
   * The native sequence is PER SESSION, matching the real Host: a mux that carries many
   * sessions interleaves their independent counters. A global counter here would be a
   * fixture lie that makes correct gap detection look like a bug.
   */
  emitSessionEvent(hostSessionId, event) {
    const session = this.#sessions.get(hostSessionId);
    if (session) session.eventSeq = (session.eventSeq ?? 0) + 1;
    this.#seq += 1;
    const envelope = {
      type: 'session/event',
      sessionId: hostSessionId,
      event: { seq: session ? session.eventSeq : this.#seq, ...event },
    };
    this.#broadcast(envelope);
    return envelope.event;
  }

  /** Emit raw text onto the mux downlink (used to send hazards such as broken JSON). */
  emitRawMux(text) { this.#broadcastRaw(text); }

  /**
   * Advance ONE session's native sequence counter without emitting anything, so the next
   * event for that session lands with a hole in front of it. This is the only honest way to
   * test gap detection: two consecutive emits can never produce a gap.
   * @param {string} hostSessionId
   * @param {number} by
   */
  skipSequences(hostSessionId, by = 1) {
    const session = this.#sessions.get(hostSessionId);
    if (!session) throw new Error(`unknown fixture session ${hostSessionId}`);
    session.eventSeq = (session.eventSeq ?? 0) + Math.max(0, Math.floor(by));
  }

  /** Emit an approval request frame with a stable rpc id (as the real host does on replay). */
  emitApprovalRequested(hostSessionId, { approvalId = `appr_${randomUUID()}`, toolName = 'bash', rpcId = randomUUID() } = {}) {
    this.#broadcast({
      type: 'approval/requested',
      sessionId: hostSessionId,
      approvalId,
      toolName,
      reason: 'fixture approval',
    }, rpcId);
    return { approvalId, rpcId };
  }

  /** Emit a turn/start that carries the host's own turn number, as the real host does. */
  emitTurnStart(hostSessionId, turn = null) {
    const session = this.#sessions.get(hostSessionId);
    if (!session) throw new Error(`unknown fixture session ${hostSessionId}`);
    session.turnCounter = (session.turnCounter ?? 0) + 1;
    const number = turn ?? session.turnCounter;
    return this.emitSessionEvent(hostSessionId, { type: 'turn/start', turn: number });
  }

  /** @param {string} hostSessionId @param {number} turn */
  emitTurnEnd(hostSessionId, turn, outcome = 'completed') {
    return this.emitSessionEvent(hostSessionId, { type: 'turn/end', turn, outcome });
  }

  /** Close every open downlink (simulates the host going away). */
  dropDownlinks() {
    // The underlying TCP socket is destroyed too: a client that never reads again would
    // otherwise never notice, because nothing is written to it.
    for (const [ws, socket] of this.#downlinkSockets) {
      try { socket.destroy(); } catch { /* already closed */ }
      try { ws.close(); } catch { /* already closed */ }
    }
    this.#downlinkSockets.clear();
    this.#muxSockets = [];
    this.#hostSockets = [];
  }

  async stop() {
    for (const socket of this.#sockets) {
      try { socket.destroy(); } catch { /* best effort */ }
    }
    await new Promise((resolve) => this.#server.close(resolve));
  }

  // ---- internals --------------------------------------------------------------------

  /** @param {object} envelope @param {string} [rpcId] */
  #broadcast(envelope, rpcId = randomUUID()) {
    const payload = JSON.stringify({ type: 'server-request', rpcId, method: 'mux', payload: envelope });
    this.#broadcastRaw(payload);
  }

  /** @param {string} text */
  #broadcastRaw(text) {
    const targets = [...this.#muxSockets];
    const frames = [text];
    if (this.#faults.duplicateEvery > 0 && this.#seq % this.#faults.duplicateEvery === 0) frames.push(text);
    if (this.#faults.malformedFrames > 0) {
      this.#faults.malformedFrames -= 1;
      frames.push('{"type":"server-request","rpcId":');
    }
    if (this.#faults.oversizeFrames > 0) {
      this.#faults.oversizeFrames -= 1;
      const big = JSON.stringify({ type: 'server-request', rpcId: 'big', method: 'mux', payload: { type: 'session/event', sessionId: 'x', event: { seq: 999999, pad: 'y'.repeat(2 * 1024 * 1024) } } });
      frames.push(big);
    }
    for (const socket of targets) {
      for (const frame of frames) {
        try { socket.send(frame); } catch { /* dropped socket: the client sees a disconnect */ }
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  #handleHttp(req, res) {
    // `req.url` is always set on a real HTTP request; the fallback only satisfies its declared type.
    const url = new URL(req.url ?? '', 'http://localhost');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/api/respond') {
        let parsed = null;
        try { parsed = JSON.parse(bodyText); } catch { /* malformed */ }
        const rpcId = parsed?.rpcId;
        const pending = this.#pendingApprovals?.has(rpcId) ?? false;
        const outcome = pending ? 'accepted' : 'not-pending';
        this.#respondReceipts.push({ rpcId, outcome, result: parsed?.result ?? null });
        if (pending) this.#pendingApprovals.delete(rpcId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(outcome === 'accepted' ? { accepted: true } : { accepted: false, reason: 'not-pending' }));
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (url.pathname === '/api/events.mux' || url.pathname === '/api/events.host') {
        // Measured behaviour of the real host: a plain GET is refused with 426.
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('upgrade required');
        return;
      }
      const method = url.pathname.slice('/api/'.length);
      let envelope = null;
      try { envelope = JSON.parse(bodyText); } catch { /* malformed */ }
      const rpcId = envelope?.rpcId ?? randomUUID();
      this.#received.push({ method, payload: envelope?.payload ?? null, rpcId, at: Date.now() });

      const delay = this.#delayed.get(method);
      if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));

      const reply = this.#replyFor(method, envelope?.payload ?? {}, rpcId);
      if (this.#dropped.has(method)) {
        // Applied, but the caller never learns: the response is discarded and the socket closed.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  }

  /**
   * @param {string} method
   * @param {object} payload
   * @param {string} rpcId
   */
  #replyFor(method, payload, rpcId) {
    const rejection = this.#rejections.get(method);
    if (rejection) {
      return {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: rejection.code, message: rejection.message ?? 'fixture refusal', details: {} } },
      };
    }
    const override = this.#results.get(method);
    if (override !== undefined) {
      return { type: 'server-response', rpcId, result: { ok: true, value: override } };
    }
    switch (method) {
      case 'host.describe':
        return {
          type: 'server-response',
          rpcId,
          result: {
            ok: true,
            value: {
              version: '0.0.1',
              cwd: '/fixture',
              provider: 'fixture-provider',
              model: 'fixture-model',
              attachedSessions: this.#sessions.size,
              home: '/fixture',
              canOpenPath: false,
              ...this.describeOverride,
            },
          },
        };
      case 'session.list':
        return {
          type: 'server-response',
          rpcId,
          result: {
            ok: true,
            value: {
              items: [...this.#sessions.values()].map((s) => ({
                sessionId: s.sessionId, updatedAt: s.createdAt, running: s.running, blank: false, cwd: s.cwd,
              })),
            },
          },
        };
      case 'session.create': {
        const requested = payload.sessionId;
        if (requested && this.#sessions.has(requested)) {
          const existing = this.#sessions.get(requested);
          if (payload.cwd && existing.cwd && payload.cwd !== existing.cwd) {
            return {
              type: 'server-response',
              rpcId,
              result: { ok: false, error: { code: 'session-conflict', message: 'cwd differs', details: { sessionId: requested } } },
            };
          }
          return { type: 'server-response', rpcId, result: { ok: true, value: { sessionId: requested } } };
        }
        const created = this.createSession(requested);
        this.#sessions.get(created.sessionId).cwd = payload.cwd ?? null;
        return { type: 'server-response', rpcId, result: { ok: true, value: { sessionId: created.sessionId } } };
      }
      case 'session.history': {
        const session = [...this.#sessions.values()].find((s) => s.sessionId === payload.sessionId);
        const events = session ? session.events : [];
        const beforeSeq = payload.beforeSeq;
        const filtered = beforeSeq === undefined || beforeSeq === null
          ? events
          : events.filter((e) => Number(e.seq) < Number(beforeSeq));
        const max = payload.maxMessages ?? 100;
        const page = filtered.slice(-max);
        return {
          type: 'server-response',
          rpcId,
          result: { ok: true, value: { events: page.map((event) => ({ event })), hasMore: filtered.length > page.length } },
        };
      }
      case 'session.prompt': {
        const session = [...this.#sessions.values()].find((s) => s.sessionId === payload.sessionId);
        if (!session) {
          return { type: 'server-response', rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: {} } } };
        }
        session.running = true;
        const event = { seq: ++this.#seq, type: 'user/message', text: extractText(payload.content) };
        session.events.push(event);
        this.#broadcast({ type: 'session/event', sessionId: session.sessionId, event });
        if (this.autoTurn) {
          // A well-behaved turn: start then terminal end, with the turn number the daemon
          // binds to. Scripted so the event-order tests can stay deterministic.
          session.turnCounter = (session.turnCounter ?? 0) + 1;
          const turn = session.turnCounter;
          const start = { seq: ++this.#seq, type: 'turn/start', turn };
          const end = { seq: ++this.#seq, type: 'turn/end', turn, outcome: 'completed' };
          session.events.push(start, end);
          this.#broadcast({ type: 'session/event', sessionId: session.sessionId, event: start });
          this.#broadcast({ type: 'session/event', sessionId: session.sessionId, event: end });
          session.running = false;
        }
        return { type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } };
      }
      case 'session.cancel': {
        const session = [...this.#sessions.values()].find((s) => s.sessionId === payload.sessionId);
        if (!session) {
          return { type: 'server-response', rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: {} } } };
        }
        session.cancels = (session.cancels ?? 0) + 1;
        if (this.autoTurn && session.turnCounter) {
          const end = { seq: ++this.#seq, type: 'turn/end', turn: session.turnCounter, outcome: 'cancelled' };
          session.events.push(end);
          this.#broadcast({ type: 'session/event', sessionId: session.sessionId, event: end });
          session.running = false;
        }
        return { type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } };
      }
      case 'session.updateQueue':
      case 'session.rename':
      case 'session.selectModel':
        return { type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } };
      default:
        return {
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'bad-request', message: `fixture does not implement ${method}`, details: {} } },
        };
    }
  }

  /** Approvals awaiting an answer, keyed by rpc id. */
  #pendingApprovals = new Set();

  /** Mark an approval rpc id as pending so /api/respond accepts it exactly once. */
  markApprovalPending(rpcId) { this.#pendingApprovals.add(rpcId); }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  #handleUpgrade(req, socket, head) {
    // A socket destroyed mid-read raises ECONNRESET; on a fixture downlink that is an
    // expected end of life, so it must not take the test process down.
    socket.on('error', () => { try { socket.destroy(); } catch { /* already gone */ } });
    // As in `#handleHttp`: an upgrade request always carries a url; this is only its declared type.
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname === '/api/events.mux') {
      const ws = acceptWebSocket(req, socket, () => {
        // Client messages on the downlink are a protocol violation in the real host.
        try { socket.destroy(); } catch { /* already gone */ }
      });
      this.#muxSockets.push(ws);
      this.#downlinkSockets.set(ws, socket);
      ws.onClose(() => {
        this.#muxSockets = this.#muxSockets.filter((x) => x !== ws);
        this.#downlinkSockets.delete(ws);
      });
      return;
    }
    if (url.pathname === '/api/events.host') {
      const ws = acceptWebSocket(req, socket);
      this.#hostSockets.push(ws);
      this.#downlinkSockets.set(ws, socket);
      ws.onClose(() => {
        this.#hostSockets = this.#hostSockets.filter((x) => x !== ws);
        this.#downlinkSockets.delete(ws);
      });
      return;
    }
    socket.destroy();
  }
}

/** @param {unknown} content */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('');
}
