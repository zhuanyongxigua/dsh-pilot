/**
 * The oversize-event policy against the IPC reply bound — two limits that can disagree.
 *
 * Why this file exists: the daemon has a page budget it applies by walking a window newest-first, and it
 * deliberately keeps a single event that exceeds that budget rather than returning an empty page, because
 * an empty page with `hasMore` true would make a caller ask for the same cursor for ever. That exemption
 * is about the PAGE budget. The IPC socket has a second, harder limit — the size of a frame it will carry
 * at all — and the exemption was being read as covering that one too, so an event large enough to exceed
 * the socket bound produced a reply the server side refused to write. The caller saw a typed oversize
 * error with no way to tell WHICH event was undeliverable and therefore no way to make progress past it.
 *
 * The policy is now explicit and asserted here from both sides:
 *
 *   - when the bound allows it, one oversized event IS delivered, alone, and named in `oversize`;
 *   - when it does not, the refusal names that event's seq and both bounds, so a caller can advance past
 *     it deliberately;
 *   - and advancing past it really does make progress, which is the part that makes the refusal useful
 *     rather than merely honest.
 *
 * Both cases are the SAME event of the SAME size, moved across a configured bound. That is what makes
 * this a test of the bound rather than a test of large payloads.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/** The configured page budget, small so the case is about the comparison rather than about memory. */
const PAGE_MAX = 1024;
/** The configured IPC reply bound: below one big event, and comfortably above the small ones. */
const REPLY_MAX = 8192;
/** 3000 three-byte characters: about 9 KB of payload, so above {@link REPLY_MAX} and above the page. */
const BIG_CHARACTERS = 3000;

/**
 * A daemon over a real fake Host, with both bounds set through the configuration.
 * @param {string} label @param {Record<string, string>} env
 */
async function rig(label, env) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`page-ipc-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({
    hostBase: host.baseUrl,
    stateDir,
    extraEnv: {
      DSH_PILOT_EVENT_PAGE_MAX_BYTES: String(PAGE_MAX),
      DSH_PILOT_IPC_REPLY_MAX_BYTES: String(REPLY_MAX),
      ...env,
    },
  });
  const client = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await client.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  const task = await client.request({ op: 'task.ensure', clientKey: `t-${label}` });
  const started = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `s-${label}` });
  assert.equal(started.operation.state, 'succeeded', 'the rig session must start');
  return {
    host,
    client,
    taskId: task.task.taskId,
    sessionId: started.session.sessionId,
    hostSessionId: started.session.hostSessionId,
    page: (beforeSeq = null) => client.request({
      op: 'session.events', taskId: task.task.taskId, sessionId: started.session.sessionId,
      limit: 50, beforeSeq,
    }),
    teardown: async () => {
      try { client.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/** Wait until the session holds `total` events, read through the paging loop a caller uses. @param {any} r */
async function waitForEvents(r, total) {
  let last = 0;
  await waitFor(async () => {
    const page = await r.page();
    last = page.events.length;
    return last >= total;
  }, { timeoutMs: 8000, what: `the session to hold ${total} events` })
    .catch((error) => { throw new Error(`${error.message}; the newest page carried ${last}`); });
}

/**
 * Three small events, then one large one — in that order, because the large event must be the NEWEST
 * row for this file to test what it says it tests.
 *
 * `#fitEventPage` walks the window newest-first and keeps a row that busts the budget only while the
 * page is still EMPTY, so a lone oversized event is exempted exactly when it is the first row the walk
 * sees. Any other order produces a page that simply stops before the large row, which is correct
 * behaviour and not the case under test.
 *
 * The wait before the large event is emitted is what makes the wait bounded and honest: while only the
 * small events exist the page SUCCEEDS, so this waits on an observable that is readable in both cases
 * rather than on a page that one case is supposed to refuse.
 * @param {any} r
 */
async function seed(r) {
  const small = [];
  for (let i = 0; i < 3; i += 1) small.push(r.host.emitSessionEvent(r.hostSessionId, { type: 'tick', n: i }).seq);
  await waitForEvents(r, 3);
  const big = r.host.emitSessionEvent(r.hostSessionId, { type: 'note', text: '大'.repeat(BIG_CHARACTERS) }).seq;
  return { small, big };
}

/**
 * Wait until the newest page is refused, and return the refusal. The refusal IS the evidence that the
 * large event has been ingested, so a bounded wait on it is a wait on the ingestion rather than a sleep.
 * @param {any} r @param {number} big
 */
async function waitForRefusal(r, big) {
  /** @type {any} */
  let error = null;
  /** @type {any} */
  let seen = null;
  await waitFor(async () => {
    const outcome = await r.page().then((page) => ({ page }), (thrown) => ({ error: thrown }));
    seen = outcome;
    error = outcome.error ?? null;
    return error !== null;
  }, { timeoutMs: 8000, what: 'the page holding one oversized event to be refused' });
  if (error === null) {
    throw new Error(`the page was delivered instead of refused, with seqs `
      + `${JSON.stringify(seen?.page?.events?.map((/** @type {any} */ event) => event.seq))} for a big event at ${big}`);
  }
  return error;
}

export default {
  'an event larger than the IPC reply bound is refused with its seq named, and paging past that seq makes progress': async () => {
    const r = await rig('refused', {});
    try {
      const { small, big } = await seed(r);
      // The newest event is the big one, so the page is a single row — the shape the oversize exemption
      // produces — and that row cannot cross the socket bound.
      const error = await waitForRefusal(r, big);
      assert.equal(error.code, 'RESULT_TOO_LARGE',
        `the undeliverable page must be a typed refusal, got ${error.code}: ${String(error.message)}`);
      // The seq is the whole point: without it a caller knows a page failed and not which event to skip.
      assert.equal(error.details?.seq, big,
        `the refusal must name the event that cannot be delivered, got ${error.details?.seq} for ${big}`);
      assert.equal(error.details?.maxReplyBytes, REPLY_MAX, 'and the socket bound it crossed');
      assert.equal(error.details?.pageMaxBytes, PAGE_MAX, 'and the page budget, which is a different limit');
      assert.ok(Number(error.details?.bytes) > REPLY_MAX,
        `and the size that crossed it, got ${error.details?.bytes}`);

      // PROGRESS. A refusal that leaves the caller stuck is a worse outcome than a slow one: the same
      // request with the cursor moved past the undeliverable event must return the older events.
      const older = await r.page(big);
      assert.deepEqual(older.events.map((event) => event.seq), small,
        'paging past the named seq must return every older event, in write order');
      assert.equal(older.hasMore, false, 'and there is nothing older than the oldest event it returned');
      assert.equal(older.bytes <= PAGE_MAX, true, 'and the page that succeeded is inside the page budget');
    } finally {
      await r.teardown();
    }
  },

  'the same event is delivered alone when the configured bound allows it, so the refusal is about the bound': async () => {
    // The positive control. Identical page budget, identical event, only the socket bound differs. Without
    // this case the refusal above would be indistinguishable from "the daemon cannot deliver large events
    // at all", which is not the claim the code makes.
    const r = await rig('delivered', { DSH_PILOT_IPC_REPLY_MAX_BYTES: String(16 * 1024 * 1024) });
    try {
      const { big } = await seed(r);
      // Waits for the large event to be the newest row, read through the page itself: with the bound
      // raised, the page that case 1 refuses is exactly the page this case must receive.
      /** @type {any} */
      let page = null;
      await waitFor(async () => {
        page = await r.page();
        return page.events.length > 0 && page.events[0].seq === big;
      }, { timeoutMs: 8000, what: 'the page to be led by the large event' });
      assert.equal(page.events.length, 1,
        `one event over the page budget must be delivered ALONE rather than dropped, got ${page.events.length}`);
      assert.equal(page.events[0]?.seq, big, 'and it must be the large one');
      // Named as oversize, which is how a caller tells "this page was byte-limited and one row was
      // exempted" from "this page was simply short".
      assert.deepEqual(page.oversize, [big], 'and the page must name the row the budget could not cover');
      // Whole, not truncated to fit a budget. Asserted against the serialised payload rather than a
      // named field, because the shape of a forwarded event's payload is the Host's business and this
      // claim is about every byte of it arriving.
      const payloadJson = JSON.stringify(page.events[0]?.payload ?? null);
      assert.ok(payloadJson.includes('大'.repeat(BIG_CHARACTERS)),
        `the payload must arrive whole; it serialised to ${payloadJson.length} characters`);
      // BYTES, which is the unit that matters here and the unit this whole file is about: 3000
      // three-byte characters are 9000 characters in a string and 9000 bytes on the wire, and only the
      // second of those is what the page budget and the socket bound were measured in.
      assert.ok(Buffer.byteLength(payloadJson, 'utf8') >= BIG_CHARACTERS * 3,
        `and it must still be as large as what the Host sent, got ${Buffer.byteLength(payloadJson, 'utf8')} bytes`);
      assert.ok(Number(page.bytes) > PAGE_MAX,
        `the reported cost must be the real one, above the page budget, got ${page.bytes}`);
      // `maxBytes` reports the PAGE budget, which this page exceeded by design: a caller reading only
      // `bytes <= maxBytes` would conclude the page was bounded, so the reply also carries `oversize`.
      assert.equal(page.maxBytes, PAGE_MAX, 'and the page budget is reported as configured');
    } finally {
      await r.teardown();
    }
  },
};
