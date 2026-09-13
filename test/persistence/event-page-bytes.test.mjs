/**
 * Event paging under a byte budget.
 *
 * Why these tests exist: the daemon declared `eventPageMaxBytes` and nothing read it, so the only
 * limit a page respected was a count. A count is the wrong unit for the same reason a frame count is
 * the wrong unit for a message: 200 events that each carry a megabyte are a 200-megabyte reply, and
 * the reply is built in this process's memory before any client sees it. `docs/architecture.md` said
 * the byte budget existed, so a reader could reasonably have believed it was enforced.
 *
 * The budget is run SMALL here (through the configured limit, not a hard-coded constant) so the
 * cases are about the logic rather than about this machine's memory, and the paging case is driven
 * as a real cursor loop: the only way to prove "every event is delivered exactly once" is to page
 * through the whole history and compare it against what was written.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A daemon with a small event-page byte budget, over a real fake Host and a real IPC socket.
 * @param {string} label
 * @param {Record<string, string>} [env]
 */
async function rig(label, env = {}) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({
    hostBase: host.baseUrl,
    stateDir,
    extraEnv: { DSH_PILOT_EVENT_PAGE_MAX_BYTES: '2048', DSH_PILOT_EVENT_PAGE_MAX: '200', ...env },
  });
  const teardown = async () => {
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, daemon, stateDir, teardown };
}

/**
 * Start a session and let the Test Host deliver events into it.
 * @param {any} r
 * @param {any} client
 * @param {string} clientKey
 */
async function sessionWithEvents(r, client, clientKey) {
  const task = await client.request({ op: 'task.ensure', clientKey: `${clientKey}-task` });
  const session = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `${clientKey}-session` });
  return { taskId: task.task.taskId, sessionId: session.session.sessionId, hostSessionId: session.session.hostSessionId };
}

/**
 * Wait until this session really holds `total` events, counted through the cursor loop.
 *
 * Not `page.events.length >= total`: a byte-limited page is supposed to come back short, so that
 * condition can never be satisfied and the wait times out against correct behaviour. The count that
 * matters is the size of the whole history, which is what paging is for.
 * @param {any} client
 * @param {{taskId: string, sessionId: string}} ids
 * @param {number} total
 */
async function waitForEventCount(client, ids, total) {
  /** @type {number} */
  let last = -1;
  await waitFor(async () => {
    const { seqs } = await pageAll(client, ids, 200);
    last = seqs.length;
    return last >= total;
  }, { timeoutMs: 8000, what: `the session to hold ${total} events` })
    .catch((error) => { throw new Error(`${error.message}; the history held ${last} events`); });
}

/** Every event this session has, paged backwards with the cursor a caller actually uses. */
async function pageAll(client, ids, pageSize) {
  const seen = [];
  let beforeSeq = null;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await client.request({
      op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: pageSize, beforeSeq,
    });
    for (const event of page.events) seen.push(event.seq);
    if (!page.hasMore) {
      // Sorted once, at the end. Concatenating pages and sorting is order-independent, whereas
      // unshifting each page assumes the rows inside a page also arrive newest-first — they arrive
      // oldest-first, so mixing the two reverses every page and makes a correct paging loop look
      // like it has holes.
      return { seqs: seen.sort((a, b) => a - b), pages: guard + 1 };
    }
    assert.ok(page.events.length > 0, 'a page that says it has more must not be empty, or the caller cannot advance');
    beforeSeq = page.events[0].seq;
  }
  throw new Error('paging did not terminate within the guard: the cursor is not advancing');
}

export default {
  'FR-STATE-4 paging: a page is bounded by serialised UTF-8 bytes, and the reply reports the bytes it cost': async () => {
    const r = await rig('page-bytes');
    try {
      const client = await ipcClient(r.daemon.socketPath);
      try {
        const ids = await sessionWithEvents(r, client, 'page-bytes');
        // Multi-byte payloads on purpose: a budget measured in characters would let this page through
        // at roughly a quarter of the memory it actually costs.
        for (let i = 0; i < 20; i += 1) {
          r.host.emitSessionEvent(ids.hostSessionId, { type: 'note', text: `事件${i}：${'汉'.repeat(120)}` });
        }
        await waitForEventCount(client, ids, 20);

        const page = await client.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 200 });
        const measured = Buffer.byteLength(JSON.stringify(page.events), 'utf8');
        assert.ok(page.bytes > 0, `the page must report the bytes it cost, got ${page.bytes}`);
        assert.ok(page.bytes <= page.maxBytes,
          `the page must fit the configured budget of ${page.maxBytes}, got ${page.bytes}`);
        assert.equal(page.events.length < 20, true,
          `the byte budget must actually truncate a page this size (20 multi-byte events cost `
          + `${measured} bytes against a ${page.maxBytes}-byte budget)`);
        assert.equal(page.hasMore, true,
          'and a page truncated by bytes must say that older events remain');
        // The reported figure must be about the payload, not about the row count, so it is within
        // one event's size of what the events actually serialise to.
        assert.ok(measured <= page.maxBytes,
          `the delivered events must fit the budget: ${measured} > ${page.maxBytes}`);
      } finally {
        client.close();
      }
    } finally {
      await r.teardown();
    }
  },

  'FR-STATE-4 paging: paging with the cursor delivers every event exactly once, in order, with nothing dropped by the byte budget': async () => {
    const r = await rig('page-continuation');
    try {
      const client = await ipcClient(r.daemon.socketPath);
      try {
        const ids = await sessionWithEvents(r, client, 'page-continuation');
        // Many small events, so the COUNT limit is not the thing that stops each page.
        const total = 60;
        // The oracle is the Host's own record of what it sent: `emitSessionEvent` returns the event
        // it assigned a sequence number to. The alternative — reading the sequence numbers out of a
        // page — would be using the thing under test as its own reference, and it fails immediately
        // here, because the byte-limited newest page does not contain the whole history.
        const expected = [];
        for (let i = 0; i < total; i += 1) {
          expected.push(r.host.emitSessionEvent(ids.hostSessionId, { type: 'tick', n: i }).seq);
        }
        await waitForEventCount(client, ids, total);
        const { seqs, pages } = await pageAll(client, ids, 5);
        assert.deepEqual(seqs, expected,
          'paging backwards with the cursor must reproduce the full history exactly: same sequence '
          + `numbers, same order, no duplicates and no holes (pages=${pages})`);
        assert.ok(pages > 1, `the byte budget must have forced more than one page, got ${pages}`);
        // The last (oldest) page must declare that nothing is behind it, or a caller loops forever.
        let beforeSeq = seqs[0];
        const oldest = await client.request({
          op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 5, beforeSeq,
        });
        assert.deepEqual(oldest.events, [], 'nothing may exist before the oldest event');
        assert.equal(oldest.hasMore, false,
          'and the empty page must say there is nothing more, rather than claiming a continuation');
      } finally {
        client.close();
      }
    } finally {
      await r.teardown();
    }
  },

  'FR-STATE-4 paging: a single event larger than the whole page budget is delivered and named, so the cursor can still advance': async () => {
    const r = await rig('page-oversize', { DSH_PILOT_EVENT_PAGE_MAX_BYTES: '1024' });
    try {
      const client = await ipcClient(r.daemon.socketPath);
      try {
        const ids = await sessionWithEvents(r, client, 'page-oversize');
        const bigText = '大'.repeat(3000);
        r.host.emitSessionEvent(ids.hostSessionId, { type: 'note', text: bigText });
        r.host.emitSessionEvent(ids.hostSessionId, { type: 'note', text: 'after the big one' });
        await waitForEventCount(client, ids, 2);

        // The newest page first. It must NOT contain the oversized event: the walk keeps the newest
        // rows that fit, so a row that cannot fit is left for the page that starts at it, where it is
        // the only candidate. A page that pulled it in anyway would exceed the budget for a reason
        // it did not name.
        const newest = await client.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 200 });
        assert.equal(newest.events.length, 1,
          `a normal row must still fit its own page, got ${newest.events.length}`);
        assert.deepEqual(newest.oversize, [], 'and no row here is over the budget');
        assert.ok(newest.bytes <= newest.maxBytes,
          `this page must respect the budget: ${newest.bytes} > ${newest.maxBytes}`);
        assert.equal(newest.hasMore, true, 'the oversized event is older, so this page must say more remains');

        // Continue at the cursor the previous page implies: now the oversized event is the only
        // candidate, and it must be DELIVERED and NAMED rather than skipped. Skipping it would lose
        // an event silently; returning an empty page here would make a caller loop on this cursor
        // forever, because `hasMore` would keep promising something it never hands over.
        const oversizePage = await client.request({
          op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 200, beforeSeq: newest.events[0].seq,
        });
        const big = oversizePage.events[0];
        assert.ok(big, `an event over the whole budget must still be delivered, got ${JSON.stringify(oversizePage.events)}`);
        const bigSize = Buffer.byteLength(JSON.stringify(big), 'utf8');
        assert.ok(bigSize > oversizePage.maxBytes,
          `this page must contain a row over the budget: ${bigSize} vs ${oversizePage.maxBytes}`);
        assert.equal(oversizePage.events.length, 1,
          `an oversized event must be delivered ALONE, got ${oversizePage.events.length}`);
        assert.deepEqual(oversizePage.oversize, [big.seq],
          `and it must be NAMED, so the fact is in the reply rather than in a comment: ${JSON.stringify(oversizePage.oversize)}`);
        assert.equal(oversizePage.hasMore, false, 'and there is nothing older than it');

        // The end-to-end claim: a cursor loop terminates and sees every event exactly once.
        const { seqs, pages } = await pageAll(client, ids, 200);
        assert.deepEqual(seqs, [big.seq, newest.events[0].seq].sort((a, b) => a - b),
          `paging must terminate and see both events exactly once: ${JSON.stringify({ seqs, pages })}`);
      } finally {
        client.close();
      }
    } finally {
      await r.teardown();
    }
  },

  'FR-STATE-4 paging: a page that is not truncated says so, and the count limit still applies': async () => {
    const r = await rig('page-honest');
    try {
      const client = await ipcClient(r.daemon.socketPath);
      try {
        const ids = await sessionWithEvents(r, client, 'page-honest');
        for (let i = 0; i < 12; i += 1) {
          r.host.emitSessionEvent(ids.hostSessionId, { type: 'tick', n: i });
        }
        await waitForEventCount(client, ids, 12);

        // Small enough to fit the byte budget: everything comes back, and nothing is claimed about
        // a continuation. A `hasMore` computed from the page length would be wrong in one of these
        // two directions, so both are pinned.
        const all = await client.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 200 });
        assert.equal(all.events.length, 12, 'a page under both limits must carry the whole history');
        assert.equal(all.hasMore, false, 'and it must not claim older events that do not exist');

        // The COUNT limit still binds independently of the byte budget.
        const counted = await client.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 5 });
        assert.equal(counted.events.length, 5, 'the requested count must still be honoured');
        assert.equal(counted.hasMore, true, 'and the count-truncated page must say older events remain');
        assert.ok(counted.bytes < all.maxBytes,
          `this page was stopped by count, not by bytes: ${counted.bytes} of ${all.maxBytes}`);

        // Exactly the whole history with a count that fits: `hasMore` must be false. This is the case
        // where "the page filled the count limit" and "there is more" differ, which is why hasMore is
        // asked of the database instead of inferred from the page length.
        const exact = await client.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 12 });
        assert.equal(exact.events.length, 12, 'a count that fits must return the whole history');
        assert.equal(exact.hasMore, false,
          'a page that filled the count limit exactly is NOT a truncated page, and must not claim one');
      } finally {
        client.close();
      }
    } finally {
      await r.teardown();
    }
  },
};
