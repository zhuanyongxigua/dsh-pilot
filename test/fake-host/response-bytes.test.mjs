/**
 * The unary response cap, in the unit it claims: RECEIVED BYTES — and the lifecycle around it.
 *
 * Why this file exists: `MAX_RESPONSE_BYTES` was compared against `text.length` AFTER
 * `res.setEncoding('utf8')`, which counts UTF-16 code units rather than bytes. A body of 3-byte
 * characters could therefore be three times the promised cap before anything refused it, and a 4-byte
 * emoji four times: the number in the error message described a quantity the code never measured. Both
 * unary paths share one reader now, and the cases below hold it to the claim using bodies whose
 * character count is comfortably UNDER the cap while their byte count is over it. Under the old
 * comparison every one of them was accepted.
 *
 * The cap is configured small here (4 KiB) instead of exercised at the shipped 8 MiB. That is not a
 * weaker test — the claim is a comparison, and the comparison is the same at 4 KiB while being cheap
 * enough to run with several shapes of body — and the shipped default and its whole path are asserted
 * separately in `test/fake-host/response-default-cap.test.mjs`, so the two numbers cannot be confused.
 *
 * Two oracles are used, and both are end-to-end rather than internal:
 *
 *   - the classification the caller receives for a request whose response could not be read, which is
 *     `uncertain` and never "provably not sent", because bytes were already on the wire;
 *   - `session.hostSessionId`, which comes from the Host's `session.create` VALUE. A raw body carries a
 *     multi-byte session id the test chose, decoded through the reader under test and read back over
 *     IPC, so a per-chunk decode that mangles a split sequence shows up as a replacement character in
 *     an id that came out of the Host's mouth.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

const CAP = 4096;

/** The sentinel the fixture replaces with the request's own rpcId, which the adapter checks. */
const RPC = '__RPCID__';

/**
 * A fake Host and a real daemon whose adapter refuses any response body above {@link CAP} bytes.
 * @param {string} label
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`resp-bytes-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({
    hostBase: host.baseUrl,
    stateDir,
    extraEnv: { DSH_PILOT_HOST_RESPONSE_MAX_BYTES: String(CAP) },
  });
  // ONE connection for the whole rig, through the shared helper, so the reply frames are read by the
  // oracle the rest of the suite uses. Keeping it open is deliberate: the recovery case is about
  // whether a refused response leaves the connection usable.
  const client = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await client.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  const task = await client.request({ op: 'task.ensure', clientKey: `t-${label}` });
  // A real session first, so `session.prompt` has something to prompt. It is created through the plain
  // path, BEFORE any raw answer is queued, so the fixture's own reply is what makes it.
  const seeded = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `seed-${label}`, cwd: '/tmp' });
  assert.equal(seeded.operation.state, 'succeeded', `the rig's own session must start: ${JSON.stringify(seeded.operation)}`);
  let prompts = 0;
  return {
    host,
    client,
    taskId: task.task.taskId,
    sessionId: seeded.session.sessionId,
    /** One `session.prompt`, which reaches the Host on the unary path the cap lives on. */
    prompt: async (text = 'x') => {
      prompts += 1;
      return client.request({
        op: 'session.prompt', taskId: task.task.taskId, sessionId: seeded.session.sessionId,
        clientKey: `p-${label}-${prompts}`, text,
      });
    },
    /** One `session.start`, whose reply carries the Host `session.create` value's sessionId. */
    start: async (key) => client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: key, cwd: '/tmp' }),
    teardown: async () => {
      try { client.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/**
 * A `session.prompt` envelope padded with 3-byte characters.
 * @param {number} characters
 */
function multiByteEnvelope(characters) {
  return JSON.stringify({
    type: 'server-response',
    rpcId: RPC,
    result: { ok: true, value: { padding: '中'.repeat(characters) } },
  });
}

/**
 * The body as it will appear on the wire.
 *
 * The fixture substitutes the request's own rpcId for {@link RPC}, so the bytes that count against the
 * cap include a real 36-character uuid rather than the 9-character sentinel. Sizes are asserted against
 * THIS string: measuring the template would be off by 27 bytes and could straddle the cap by accident.
 * @param {string} body
 */
function wire(body) {
  return body.replace(RPC, 'x'.repeat(36));
}

/**
 * The outcome a caller sees for a prompt whose response could not be read.
 *
 * `session.prompt` replies `{operation, result:{status}}` — it does not carry the adapter's error, so
 * the HONEST durable answer to "why" is the operation's own `uncertainReason`, which is what this reads
 * rather than inventing a field that is not on the wire. The reason names the carrier problem, and the
 * closed set of values is what makes it checkable: `oversize-response-after-send` is only produced when
 * the byte cap was the cause, and `timeout-after-send` only when the deadline was.
 * @param {unknown} reply
 */
function outcomeOf(reply) {
  return /** @type {{operation?: {state?: string, uncertainReason?: string|null}, result?: {status?: string, error?: {code?: string}}}} */ (reply);
}

export default {
  'the response cap counts BYTES: a body small in characters and over the cap in bytes is refused': async () => {
    const r = await rig('cap-bytes');
    try {
      const body = multiByteEnvelope(2000);
      assert.ok(wire(body).length < CAP,
        `the body must be UNDER the cap in characters for this case to mean anything, got ${wire(body).length}`);
      assert.ok(Buffer.byteLength(wire(body), 'utf8') > CAP,
        `and OVER it in bytes, got ${Buffer.byteLength(wire(body), 'utf8')} against a ${CAP} cap`);
      r.host.answerRawFor('session.prompt', { body });
      const shaped = outcomeOf(await r.prompt());
      // NOT "refused". The prompt was written to the socket before the response arrived, so the request
      // may have been applied: an unreadable response is an unproven outcome, and reporting it as "not
      // reached" is the misreading this whole surface is built to prevent.
      assert.equal(shaped.operation?.state, 'uncertain',
        `an unreadable response after a send must be uncertain, got ${shaped.operation?.state}`);
      // And the reason is specifically the byte cap. A body that was under the cap would have produced
      // `ok`, and a peer that was merely slow would have produced a timeout reason, so this separates
      // the byte measurement from every other way this call could have failed.
      assert.equal(shaped.operation?.uncertainReason, 'oversize-response-after-send',
        `the reason must name the response cap, got ${shaped.operation?.uncertainReason}`);
      assert.equal(shaped.result?.status, 'uncertain', 'and the reply must not claim a status it does not have');
    } finally {
      await r.teardown();
    }
  },

  'a multi-byte body split across chunk boundaries mid-character is decoded correctly, read back out of a Host value': async () => {
    const r = await rig('cap-split');
    try {
      // A multi-byte Host session id, chosen by this test. `session.start` reads the Host
      // `session.create` value's `sessionId`, so the string that comes back over IPC is the one the
      // reader decoded from the raw body.
      const chosen = `session-中😀é-${'漢'.repeat(8)}`;
      const body = JSON.stringify({ type: 'server-response', rpcId: RPC, result: { ok: true, value: { sessionId: chosen } } });
      assert.ok(Buffer.byteLength(body, 'utf8') > 60,
        `the body must be long enough for a 1-byte split to be meaningful, got ${Buffer.byteLength(body, 'utf8')} bytes`);
      // ONE BYTE PER CHUNK. Every multi-byte character is therefore split across chunk boundaries by
      // construction rather than by luck. A per-chunk `chunk.toString('utf8')` — which is what the IPC
      // client does, and what this reader would do if it decoded per chunk — turns each split character
      // into replacement characters, so this is the case that fails when the body is not decoded once.
      r.host.answerRawFor('session.create', { body, splitEvery: 1 });
      const started = /** @type {{session?: {hostSessionId?: string}}} */ (await r.start('split-session'));
      assert.equal(started.session?.hostSessionId, chosen,
        'the Host session id must decode identically however the peer chunked the body');
      assert.ok(!String(started.session?.hostSessionId).includes('\uFFFD'),
        'and no replacement character may appear, which is what a split sequence becomes when decoded per chunk');
    } finally {
      await r.teardown();
    }
  },

  'the same kind of multi-byte body is accepted when it fits the cap, so the cap is a comparison and not a prohibition': async () => {
    const r = await rig('cap-fits');
    try {
      // The counterpart of the first case: a reader that refused every multi-byte body would pass that
      // one, so this proves the cap is a comparison and not a refusal of non-ASCII.
      const chosen = `session-${'中'.repeat(40)}`;
      const body = JSON.stringify({ type: 'server-response', rpcId: RPC, result: { ok: true, value: { sessionId: chosen } } });
      assert.ok(Buffer.byteLength(wire(body), 'utf8') < CAP,
        `this body must fit in ${CAP} bytes, got ${Buffer.byteLength(wire(body), 'utf8')}`);
      r.host.answerRawFor('session.create', { body });
      const started = /** @type {{session?: {hostSessionId?: string}}} */ (await r.start('fits-session'));
      assert.equal(started.session?.hostSessionId, chosen, 'a body inside the cap must be read exactly as sent');
    } finally {
      await r.teardown();
    }
  },

  'a response that stops early settles on the truncation instead of hanging until the deadline': async () => {
    const r = await rig('cap-truncated');
    try {
      const body = multiByteEnvelope(60);
      // The full length is declared, a third of it is sent, and only THEN is the socket destroyed.
      // MEASURED on a peer of this exact shape: the RESPONSE emits `error` (message `aborted`) and then
      // `close`, and the REQUEST emits nothing at all. The reader used to listen for failure on the
      // request alone, so nothing settled the call and it hung until its deadline; this case fails
      // (HUNG, not merely a wrong answer) with both response exits removed, and passes with either one of
      // them present — so what it evidences is that the response lifecycle is now an exit, not that one
      // particular handler is the one that fires.
      // `truncateDelayMs` is what makes this a truncated BODY rather than a dead connection, and the
      // distinction is measured rather than assumed: destroying the socket in the same tick as the
      // partial write means the client never parses a response at all and sees `socket hang up` on the
      // REQUEST, which the reader already handled. Waiting first means the client reads the headers and
      // part of the body and then loses the connection — response events `aborted`/`error`/`close`, and
      // nothing on the request. Only the second shape tests the response lifecycle.
      r.host.answerRawFor('session.prompt', { body, truncateTo: 100, truncateDelayMs: 60 });
      const started = Date.now();
      const shaped = outcomeOf(await r.prompt());
      const elapsed = Date.now() - started;
      // The rig's deadline is the adapter default of 15 s. A truncation that waited for it would be the
      // defect; the bound below is generous for a loaded machine and still separates "settled on the
      // truncation" from "waited out the timeout".
      assert.ok(elapsed < 8000, `a truncated body must settle promptly, not at the deadline; took ${elapsed}ms`);
      assert.equal(shaped.operation?.state, 'uncertain',
        `a truncated response after a send is unproven, got ${shaped.operation?.state}`);
      // THE DISCRIMINATING ASSERTION. A reader with no exit for a truncated body waited out the deadline
      // and then reported `timeout-after-send`; a reader that noticed the truncation reports it as a
      // transport error. The elapsed-time bound above says WHEN it settled, and this says WHY — together
      // they distinguish "saw the truncation" from "gave up after fifteen seconds", which the timing
      // alone could not.
      assert.equal(shaped.operation?.uncertainReason, 'transport-error-after-send',
        `the reason must be the carrier failure rather than the deadline, got ${shaped.operation?.uncertainReason}`);
    } finally {
      await r.teardown();
    }
  },

  'a refused oversized response leaves the client healthy for the next call': async () => {
    const r = await rig('cap-recovery');
    try {
      r.host.answerRawFor('session.prompt', { body: multiByteEnvelope(2000) });
      const refused = outcomeOf(await r.prompt());
      assert.equal(refused.operation?.uncertainReason, 'oversize-response-after-send',
        'the first call must be the one that trips the cap');
      // The request was destroyed mid-body, so that connection is gone. The next call must still work:
      // the cap is per response, and a refusal must not leave a half-read connection or a wedged client.
      const started = /** @type {{session?: {hostSessionId?: string}}} */ (await r.start('after-refusal'));
      assert.match(String(started.session?.hostSessionId), /^session-/,
        'the next call must succeed normally and carry the Host session id');
      // Exactly one MORE than the rig's own seed created: the recovery is a second request, not a cache.
      assert.equal(r.host.requestsFor('session.create').length, 2,
        'the successful call must have been a real request, so the seed plus this one is two');
    } finally {
      await r.teardown();
    }
  },
};
