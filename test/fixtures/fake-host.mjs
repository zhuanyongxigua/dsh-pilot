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
  #held = new Set();
  #respondBodyBytes = 0;
  /** @type {{status: number, body: string}|null} */
  #respondRaw = null;
  #delayed = new Map();
  /** @type {Map<string, Promise<void>>} responses applied but held */
  #barriers = new Map();
  /** @type {Map<string, () => void>} the release for each held response */
  #barrierReleases = new Map();
  /** @type {Set<string>} methods whose barrier has been reached at least once */
  #barriersReached = new Set();
  #rejections = new Map();
  #results = new Map();
  #faults = { malformedFrames: 0, oversizeFrames: 0, duplicateEvery: 0, reorderWindow: 0 };
  #events = [];
  #seq = 0;
  #received = [];
  #sessions = new Map();
  /** sessionId -> pending inbox occurrences, in the Host's own FIFO order. */
  #queues = new Map();
  /**
   * Sessions whose `session/queue` broadcasts are being held back.
   *
   * Why this exists: the snapshot rides the WebSocket while the mutation's reply rides HTTP, so on
   * the real Host the frame can still be in flight when the next request arrives. A test cannot
   * reproduce that race honestly with sleeps (section 8 forbids sleep-based synchronization), so
   * delivery is controlled explicitly: the fixture applies the mutation to its own queue either
   * way, and only the BROADCAST is held. That models delivery, never semantics.
   */
  #queueSnapshotsHeld = new Set();
  /** sessionId -> the queue mutations the fixture actually applied, for assertions. */
  #queueMutations = [];
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

  // ---- the pending inbox --------------------------------------------------------------
  //
  // The real Host holds queued occurrences that are NOT durable: they are not model-visible and
  // are not written to the session log until the Agent claims one. The only signal about them is
  // the complete `session/queue` snapshot the Host re-sends after every enqueue, mutation, claim
  // or discard, and the only mutation of a single occurrence is `session.updateQueue` addressed
  // by its `MessageId`. This fixture mirrors exactly that: no durable event, one snapshot per
  // change, one id-addressed mutation.

  /** The fixture's current pending inbox for one session, as a test-side oracle (not a wire shape). */
  queueItems(hostSessionId) {
    return this.#queueItems(hostSessionId).map((item) => ({ ...item }));
  }

  /** Every queue mutation the fixture applied, in order, for assertions. */
  get queueMutations() { return this.#queueMutations.map((row) => ({ ...row })); }

  /**
   * Enqueue one occurrence, the way the real Host does: the item id is minted by the Host, the
   * FIFO placement is resolved by the Agent, and the WHOLE snapshot is re-broadcast.
   * @param {string} hostSessionId
   * @param {{text?: string, placement?: 'queued'|'steering'|'context', id?: string}} [options]
   */
  enqueue(hostSessionId, { text = 'fixture queued message', placement = 'queued', id = `msg_${randomUUID()}` } = {}) {
    if (!this.#sessions.has(hostSessionId)) throw new Error(`unknown fixture session ${hostSessionId}`);
    // An explicit id is allowed so a test can put an occurrence back under the id it already had. That
    // is not a convenience: the case it exists for is the Host re-reporting the SAME occurrence in a
    // later snapshot — after a removal whose effect it has not reflected yet — and a test cannot model
    // that with a fresh id, because a fresh id is a different occurrence that nothing has touched.
    const item = { id, placement, message: { role: 'user', content: [{ type: 'text', text }] } };
    this.#queueItems(hostSessionId).push(item);
    this.emitQueueSnapshot(hostSessionId);
    return { ...item };
  }

  /**
   * Broadcast a session's complete pending-inbox snapshot, as the real Host does after every
   * change. Held back for a session whose delivery a test has deliberately paused.
   * @param {string} hostSessionId
   */
  emitQueueSnapshot(hostSessionId) {
    const items = this.#queueItems(hostSessionId).map((item) => ({ ...item }));
    if (!this.#queueSnapshotsHeld.has(hostSessionId)) {
      this.#broadcast({ type: 'session/queue', sessionId: hostSessionId, items });
    }
    return items.length;
  }

  /**
   * Pause `session/queue` DELIVERY for one session: the fixture keeps applying changes to its own
   * queue, it just does not tell anyone yet.
   * @param {string} hostSessionId
   */
  holdQueueSnapshots(hostSessionId) { this.#queueSnapshotsHeld.add(hostSessionId); }

  /**
   * Resume delivery and send the current snapshot, one per held session (or one named session).
   * @param {string} [hostSessionId]
   */
  releaseQueueSnapshots(hostSessionId) {
    const sessions = hostSessionId === undefined
      ? [...this.#queueSnapshotsHeld]
      : [hostSessionId];
    for (const id of sessions) {
      this.#queueSnapshotsHeld.delete(id);
      this.emitQueueSnapshot(id);
    }
  }

  /** @param {string} hostSessionId */
  #queueItems(hostSessionId) {
    let items = this.#queues.get(hostSessionId);
    if (!items) {
      items = [];
      this.#queues.set(hostSessionId, items);
    }
    return items;
  }

  /** Requests that actually carried a business effect, i.e. were not refused client-side. */
  get mutationCount() {
    return this.#received.filter((row) => row.method !== 'host.describe').length;
  }

  /** Make the next N responses for a method disappear after being applied. */
  dropResponseFor(method) { this.#dropped.add(method); }
  stopDropping(method) { this.#dropped.delete(method); }
  /**
   * Accept and APPLY the request, then never write a reply — the socket stays open and silent.
   * This is the fault a client with no deadline cannot survive: not a refusal, not a drop, but a peer
   * that simply never finishes answering. The Host has already taken the answer, so the client's
   * outcome is unproven, which is exactly why "no reply" must not be read as "not sent".
   * @param {string} method
   */
  holdResponseFor(method) { this.#held.add(method); }
  /** @param {string} method */
  releaseHeldResponses(method) { this.#held.delete(method); }
  /**
   * Answer with `bytes` bytes of body instead of a receipt. A body bound can only be shown to work by
   * a peer that exceeds it, and a receipt that never ends is the one shape the parser cannot classify.
   * @param {number} bytes
   */
  respondBodyBytes(bytes) { this.#respondBodyBytes = bytes; }
  /**
   * Answer with an exact status and a literal body. `respondBodyBytes` covers "too big to read" and
   * this covers "readable but not a receipt", which is a different thing to classify: the peer did
   * answer, so the outcome is unproven rather than a refusal.
   * @param {number} status @param {string} body
   */
  respondWithRaw(status, body) { this.#respondRaw = { status, body }; }
  /** @param {string} method @param {number} ms */
  delayFor(method, ms) { this.#delayed.set(method, ms); }

  /**
   * Hold the response to `method` AFTER applying it, until `releaseBarrier(method)`.
   * @param {string} method
   */
  barrierFor(method) {
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolvePromise) => { release = () => resolvePromise(undefined); });
    this.#barriers.set(method, held);
    this.#barrierReleases.set(method, release);
  }

  /** Has a request currently been applied and its response held? The test's own timing oracle. */
  barrierReached(method) { return this.#barriersReached.has(method); }

  /** Let held responses through, and stop holding. @param {string} method */
  releaseBarrier(method) {
    const release = this.#barrierReleases.get(method);
    if (release) release();
    this.#barriers.delete(method);
    this.#barrierReleases.delete(method);
  }
  /**
   * Script a refusal for one method. `details` is part of the real Host's error envelope
   * (`{code, message, details}`), and the details bag is a first-class leak surface for the
   * bridge's sanitiser, so the fixture's type states it rather than hiding it.
   * @param {string} method @param {{code: string, message?: string, details?: object}} error
   */
  rejectWith(method, error) { this.#rejections.set(method, error); }
  /** Lift a rejection, so a later attempt at the same method can succeed. @param {string} method */
  stopRejecting(method) { this.#rejections.delete(method); }
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
    // Recorded into the session's history as well as broadcast, because the real Host serves
    // `session.history` from the same log it streams. A fixture that only broadcasts makes history a
    // mirror of the live stream, which is precisely the state in which a broken history refetch
    // cannot be distinguished from a working one — the daemon recovers the event live and the test
    // passes without the refetch ever doing anything. Existing cases are unaffected: they assert on
    // what the daemon STORED, and nothing reads the fixture's history length.
    if (session) session.events.push(envelope.event);
    this.#broadcast(envelope);
    return envelope.event;
  }

  /**
   * Record an event in a session's history WITHOUT broadcasting it.
   *
   * This models the one case history exists for: something the Host did while our downlink was down.
   * The event is in the Host's log, so `session.history` serves it, and it was never on the wire, so
   * the ONLY way the bridge can learn it is by refetching. That is what makes an assertion about the
   * refetch non-decorative. Broadcasting it instead — the obvious thing to write — lets the live
   * socket deliver it and the test then proves nothing about history at all.
   * @param {string} hostSessionId
   * @param {object} event the event body, without `seq`
   * @returns {object} the recorded event, with its `seq`
   */
  recordSessionEvent(hostSessionId, event) {
    const session = this.#sessions.get(hostSessionId);
    if (!session) throw new Error(`unknown fixture session ${hostSessionId}`);
    session.eventSeq = (session.eventSeq ?? 0) + 1;
    const recorded = { seq: session.eventSeq, ...event };
    session.events.push(recorded);
    return recorded;
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
        // The forced reason lets a test drive the OTHER values of the Host's closed refusal set —
        // `bad-response` above all, which the bridge must not report as `not-pending` — and a reason
        // outside the set entirely, which the bridge must report as unrecognised rather than assume.
        // Held only for the next receipt, so one case cannot leak into another.
        const forced = this.#forcedRespondReason;
        this.#forcedRespondReason = null;
        const outcome = forced ?? (pending ? 'accepted' : 'not-pending');
        this.#respondReceipts.push({ rpcId, outcome, result: parsed?.result ?? null });
        if (pending) this.#pendingApprovals.delete(rpcId);
        // The delay sits HERE, after the answer has been APPLIED and recorded, and before the reply is
        // written. That ordering is the whole point of the feature: it reproduces the window a real
        // crash opens — the Host holds the answer, the client has not yet learned its outcome — and
        // only in that window can a test observe whether the bridge treats a delivery it never got a
        // receipt for as "not sent" (which would invite a duplicate) or as unproven (which is the
        // truth). A delay placed before this point would instead delay the answer's application and
        // measure nothing.
        const respondDelay = this.#delayed.get('respond');
        if (respondDelay) await new Promise((resolvePromise) => setTimeout(resolvePromise, respondDelay));
        // `dropResponseFor('respond')` means the answer was APPLIED — the lines above already ran —
        // and the receipt is lost with the socket. That is the lost-receipt case FR-APPR-1's second
        // half is about, and it is injectable here rather than only on the `/api/<method>` path: this
        // branch used to return before the fault-injection block below, so the requirement could not
        // be exercised at all and a test had to document that as an evidenced limitation.
        if (this.#dropped.has('respond')) {
          req.socket.destroy();
          return;
        }
        // A silent peer: headers are not even written. The request was accepted and applied above, and
        // no reply ever comes. Kept open deliberately — `res.end()` would be a short body rather than a
        // hang, and the deadline is what this case is about.
        if (this.#held.has('respond')) return;
        if (this.#respondRaw) {
          const raw = this.#respondRaw;
          this.#respondRaw = null;
          res.writeHead(raw.status, { 'content-type': 'application/json' });
          res.end(raw.body);
          return;
        }
        if (this.#respondBodyBytes > 0) {
          const size = this.#respondBodyBytes;
          res.writeHead(200, { 'content-type': 'application/json' });
          // Streamed in chunks rather than one big buffer, so the fixture does not have to hold the
          // oversized body in memory to prove the client refuses to.
          const chunk = 'x'.repeat(64 * 1024);
          let written = 0;
          while (written < size) {
            res.write(chunk.slice(0, Math.min(chunk.length, size - written)));
            written += chunk.length;
          }
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(outcome === 'accepted' ? { accepted: true } : { accepted: false, reason: outcome }));
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
      // A BARRIER, not a delay. The reply above has already been computed, which means the mutation was
      // APPLIED, and the response is then held until the test releases it. That gives a deterministic
      // window in which the Host has definitely applied the method and the caller has definitely not
      // learned the outcome — the window a real SIGKILL opens — without any test guessing at a sleep
      // duration. `delayFor` cannot serve here: it runs before `#replyFor`, so it delays the mutation
      // itself and the Host would not yet have applied anything when the process is killed.
      const barrier = this.#barriers.get(method);
      if (barrier) {
        this.#barriersReached.add(method);
        await barrier;
      }
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
      case 'session.updateQueue': {
        const session = [...this.#sessions.values()].find((s) => s.sessionId === payload.sessionId);
        if (!session) {
          return { type: 'server-response', rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: {} } } };
        }
        const items = this.#queueItems(session.sessionId);
        const index = items.findIndex((item) => item.id === payload.itemId);
        // The contract's own refusal for an occurrence that is not pending any more: already
        // claimed, already removed, or never this session's. It is a DEFINITE refusal, which is
        // why it must never be reported as a removal and never as an unknown outcome.
        if (index < 0) {
          return {
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: {
                code: 'queue-item-not-found',
                message: `no pending queue item ${String(payload.itemId)} in this session`,
                details: { itemId: payload.itemId },
              },
            },
          };
        }
        const action = payload.action ?? {};
        if (action.kind === 'remove') {
          items.splice(index, 1);
        } else if (action.kind === 'steer') {
          // Steering is only meaningful for an occurrence the Agent still holds as queued work.
          if (items[index].placement === 'context') {
            return {
              type: 'server-response',
              rpcId,
              result: {
                ok: false,
                error: { code: 'steer-unavailable', message: 'a context occurrence cannot be steered', details: { itemId: payload.itemId } },
              },
            };
          }
          items[index].placement = 'steering';
        } else if (action.kind === 'edit') {
          items[index].message = { role: 'user', content: action.content ?? [] };
        } else {
          return {
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'bad-request', message: `fixture does not implement queue action ${String(action.kind)}`, details: {} } },
          };
        }
        this.#queueMutations.push({ sessionId: session.sessionId, itemId: payload.itemId, action });
        // Every mutation re-sends the COMPLETE snapshot: that is the only signal a caller has.
        this.emitQueueSnapshot(session.sessionId);
        return { type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } };
      }
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
  /** @type {string|null} one-shot override for the next `/api/respond` reason */
  #forcedRespondReason = null;
  /** @type {string[]} approvals this Host applied, so a test can prove recovery applied none */
  #appliedApprovals = [];

  /** Mark an approval rpc id as pending so /api/respond accepts it exactly once. */
  markApprovalPending(rpcId) { this.#pendingApprovals.add(rpcId); }

  /**
   * Force the reason on the NEXT `/api/respond` receipt, whatever the request's pending state is.
   * @param {string|null} reason a reason from the Host's closed set, or any other string
   */
  forceRespondReason(reason) { this.#forcedRespondReason = reason; }

  /** The approval decisions the Host actually APPLIED, for a "did recovery approve anything?" oracle. */
  get appliedApprovals() { return [...this.#appliedApprovals]; }

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
