/**
 * Seeded property / model layer.
 *
 * Why these tests exist: hand-written cases only cover the interleavings someone thought of.
 * Here a seeded generator produces event sequences — duplicates, reorderings, holes, foreign
 * sessions — and an INDEPENDENT reference model, written from the semantics rather than from
 * the implementation, predicts what a correct reader must conclude. The store's answer is then
 * compared against the model's.
 *
 * The seed is printed on every run (not only on failure) and can be replayed with
 * DSH_PILOT_SEED; a failure that cannot be replayed is not diagnosed.
 *
 * Independence note: the model deliberately does NOT reuse any code from lib/. It shares only
 * the arithmetic of "what sequences did we see", which is exactly the thing under test.
 */

import { join } from 'node:path';
import { assert, must, scratchDir } from '../helpers.mjs';

/** Deterministic PRNG (mulberry32): same seed, same sequence, on every platform. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The reference model: fold a generated arrival sequence into the conclusions a correct
 * reader is entitled to. Written from the rules, not from the implementation.
 *
 * The rule, stated so it can be argued with: a sequence is MISSING iff it lies between the
 * LOWEST sequence we have ever seen for this session and the highest, and is absent. Below the
 * lowest seen sequence nothing can be concluded — a reader that attached late legitimately
 * only ever receives a later window — so that region is not a gap. This is the only rule that
 * is a pure function of the received set, and therefore the only one that stays true under
 * replay and reordering.
 * @param {{sessionId: string, seq: number}[]} arrivals
 * @param {string} target
 */
function referenceFold(arrivals, target) {
  const seen = new Set();
  for (const arrival of arrivals) {
    if (arrival.sessionId === target) seen.add(arrival.seq);
  }
  const ordered = [...seen].sort((a, b) => a - b);
  if (!ordered.length) {
    return {
      storedSeqs: [], count: 0, contiguousThrough: 0, highWater: 0,
      hasGap: false, gapFrom: null, gapTo: null,
    };
  }
  const lowest = ordered[0];
  const highest = ordered[ordered.length - 1];
  let contiguous = lowest;
  for (const seq of ordered) {
    if (seq === contiguous + 1 || seq === lowest) contiguous = seq > lowest ? seq : lowest;
  }
  const missing = [];
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i] > ordered[i - 1] + 1) missing.push({ from: ordered[i - 1] + 1, to: ordered[i] - 1 });
  }
  return {
    storedSeqs: ordered,
    count: ordered.length,
    contiguousThrough: contiguous,
    highWater: highest,
    hasGap: missing.length > 0,
    gapFrom: missing.length ? missing[0].from : null,
    gapTo: missing.length ? missing[missing.length - 1].to : null,
  };
}

export default {
  'generated event streams: stored sequences and gap conclusions match an independent model': async (context) => {
    const seed = Number(process.env.DSH_PILOT_SEED ?? 20260912);
    const rounds = Number(process.env.DSH_PILOT_PROPERTY_ROUNDS ?? 40);
    process.stdout.write(`       [seeded property] seed=${seed} rounds=${rounds} (replay with DSH_PILOT_SEED=${seed})\n`);
    const { FakeHost } = await import('../fixtures/fake-host.mjs');
    const { startDaemon, ipcClient, waitFor } = await import('../helpers.mjs');
    const { randomUUID } = await import('node:crypto');

    const random = rng(seed);
    const failures = [];

    for (let round = 0; round < rounds; round += 1) {
      const host = await new FakeHost().start();
      host.autoTurn = false;
      const scratch = scratchDir(`prop-${round}`);
      const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch.dir, 'state') });
      const ipc = await ipcClient(daemon.socketPath);
      try {
        const task = await ipc.request({ op: 'task.ensure', clientKey: `prop-${round}-${seed}` });
        // Two sessions so cross-session bleed would show up as a wrong answer, not a crash.
        const sessions = [];
        for (let i = 0; i < 2; i += 1) {
          const started = await ipc.request({
            op: 'session.start', taskId: task.task.taskId, clientKey: `prop-${round}-s${i}-${seed}`,
          });
          assert.ok(started.session, `session ${i} failed in round ${round}: ${JSON.stringify(started)}`);
          sessions.push(started.session);
        }
        await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready', { timeoutMs: 5000, what: 'mux ready' });

        // Generate a per-session arrival plan: native sequences with holes, repeats and
        // out-of-order delivery, interleaved across the two sessions.
        const plan = [];
        for (const [index, session] of sessions.entries()) {
          const total = 3 + Math.floor(random() * 5);
          const seqs = [];
          for (let s = 1; s <= total; s += 1) if (random() > 0.25) seqs.push(s);
          if (seqs.length === 0) seqs.push(1);
          for (const seq of seqs) {
            plan.push({ sessionIndex: index, sessionId: session.hostSessionId, seq });
            if (random() > 0.65) plan.push({ sessionIndex: index, sessionId: session.hostSessionId, seq });
          }
        }
        // Shuffle deterministically.
        for (let i = plan.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [plan[i], plan[j]] = [plan[j], plan[i]];
        }

        const emitted = [];
        for (const item of plan) {
          // Explicit seq keeps the emitted stream identical to the plan even when frames are
          // duplicated or reordered.
          host.emitSessionEvent(item.sessionId, {
            type: 'user/message', seq: item.seq, text: `r${round}-${randomUUID().slice(0, 6)}`,
          });
          emitted.push({ sessionId: item.sessionId, seq: item.seq });
        }
        const expectedByHostId = new Map();
        for (const session of sessions) expectedByHostId.set(session.hostSessionId, referenceFold(emitted, session.hostSessionId));

        // Wait until EVERY session holds its own planned count. Comparing after only one
        // session has settled would report a genuine mid-stream state as a mismatch.
        await waitFor(async () => {
          for (const session of sessions) {
            const model = expectedByHostId.get(session.hostSessionId);
            const page = await ipc.request({
              op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200,
            });
            if (page.events.length !== model.count) return false;
          }
          return true;
        }, { timeoutMs: 15000, what: `store to reach the model's event counts (round ${round})` });

        for (const session of sessions) {
          const model = expectedByHostId.get(session.hostSessionId);
          const page = await ipc.request({
            op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200,
          });
          const storedSeqs = page.events.map((event) => event.seq).sort((a, b) => a - b);
          const detail = `round=${round} seed=${seed} session=${session.hostSessionId} plan=${JSON.stringify(plan)}`;
          try {
            assert.deepEqual(storedSeqs, model.storedSeqs, `stored sequences diverged from the model. ${detail}`);
            // Deduplication is by native sequence: a repeat is never stored twice.
            assert.equal(new Set(storedSeqs).size, storedSeqs.length, `duplicate sequence stored. ${detail}`);
            // Cross-session bleed: every stored event must belong to this session.
            for (const event of page.events) {
              assert.equal(event.sessionId, session.sessionId, `event leaked from another session. ${detail}`);
            }
            // Gap conclusions must match the model exactly.
            assert.equal(page.completeness, model.hasGap ? 'incomplete' : 'complete',
              `completeness disagreed with the model (hasGap=${model.hasGap}). ${detail}`);
            if (model.hasGap) {
              assert.ok(page.gap, `the model says a hole exists but no gap was reported. ${detail}`);
            }
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
      } finally {
        ipc.close();
        await daemon.stop();
        await host.stop();
        scratch.cleanup();
      }
    }
    assert.deepEqual(failures, [], `property failures (seed ${seed}):\n${failures.join('\n')}`);
  },

  'idempotency keys under repeated submission produce exactly one durable operation': async () => {
    const seed = Number(process.env.DSH_PILOT_SEED ?? 20260912);
    const random = rng(seed + 7);
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('prop-idem');
    const store = new Store({ stateDir: join(scratch.dir, 'state') });
    try {
      const taskId = 'task_44444444-4444-4444-4444-444444444444';
      store.createTask({ taskId, hostBase: 'http://h', hostScope: 'h' });
      const keys = ['k-one', 'k-two', 'k-three'];
      const created = new Map();
      for (let i = 0; i < 200; i += 1) {
        const key = keys[Math.floor(random() * keys.length)];
        const payload = { text: `payload-for-${key}` };
        const result = store.reserveOperation({ taskId, kind: 'session.prompt', idempotencyKey: key, payload });
        if (result.created) created.set(key, created.get(key) ?? 0);
        created.set(key, created.get(key) ?? 0);
        // The same key with the same payload always resolves to the same operation row. The row
        // is typed nullable because "no row" is an honest store outcome, but this property is a
        // statement ABOUT the row, so the row must be present for every one of the 200 rounds.
        const row = must(result.operation, `the operation row resolved for key ${key} on round ${i}`);
        assert.equal(row.idempotency_key, key);
      }
      const rows = store.get('select count(*) as c from operations');
      assert.equal(rows.c, keys.length, 'exactly one durable operation per idempotency key');
    } finally {
      store.close();
      scratch.cleanup();
    }
  },

  'cursor conclusions are stable no matter how many times the same stream is replayed': async () => {
    const seed = Number(process.env.DSH_PILOT_SEED ?? 20260912);
    const random = rng(seed + 11);
    const { FakeHost } = await import('../fixtures/fake-host.mjs');
    const { startDaemon, ipcClient, waitFor } = await import('../helpers.mjs');
    const host = await new FakeHost().start();
    host.autoTurn = false;
    const scratch = scratchDir('prop-replay');
    const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch.dir, 'state') });
    const ipc = await ipcClient(daemon.socketPath);
    try {
      const task = await ipc.request({ op: 'task.ensure', clientKey: `replay-${seed}` });
      const session = (await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `replay-s-${seed}` })).session;
      assert.ok(session);
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready', { timeoutMs: 5000, what: 'mux ready' });
      const seqs = [1, 2, 3, 4, 5].filter(() => random() > 0.2);
      if (!seqs.length) seqs.push(1);
      // Emit each planned sequence several times in a shuffled order. The event carries an
      // EXPLICIT seq, because the dedupe key is the sequence: relying on the fixture to number
      // the frames would generate fresh numbers and never exercise dedupe at all.
      const emissions = [];
      for (const seq of seqs) for (let i = 0; i < 1 + Math.floor(random() * 3); i += 1) emissions.push(seq);
      for (let i = emissions.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [emissions[i], emissions[j]] = [emissions[j], emissions[i]];
      }
      for (const seq of emissions) {
        host.emitSessionEvent(session.hostSessionId, { type: 'user/message', seq, text: `x${seq}` });
      }
      const model = referenceFold(emissions.map((seq) => ({ sessionId: session.hostSessionId, seq })), session.hostSessionId);
      await waitFor(async () => {
        const page = await ipc.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200 });
        return page.events.length === model.count;
      }, { timeoutMs: 10000, what: 'store to settle on the model count' });
      // Every planned sequence must be stored exactly once even though most were emitted more
      // than once: this is the assertion that makes native-sequence dedupe load-bearing.
      const first = await ipc.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200 });
      assert.deepEqual(first.events.map((e) => e.seq), model.storedSeqs,
        `duplicate emissions must collapse to one row each (seed ${seed})`);
      // Replaying the identical stream again must not change any conclusion.
      const before = await ipc.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200 });
      const statsBefore = (await ipc.request({ op: 'health' })).eventStats.duplicates;
      for (const seq of emissions) {
        host.emitSessionEvent(session.hostSessionId, { type: 'user/message', seq, text: `x${seq}` });
      }
      await waitFor(async () => (await ipc.request({ op: 'health' })).eventStats.duplicates >= statsBefore + emissions.length,
        { timeoutMs: 5000, what: 'every replayed frame to be recognised as a duplicate' });
      const after = await ipc.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.sessionId, limit: 200 });
      assert.equal(after.events.length, before.events.length, 'a replayed stream must not add events');
      assert.equal(after.completeness, before.completeness, 'a replayed stream must not change completeness');
      assert.deepEqual(
        after.events.map((e) => e.seq),
        model.storedSeqs,
        `final sequences must equal the model (seed ${seed})`,
      );
      // The daemon must recognise the replay itself, not merely be saved by the store's primary
      // key: a writer that cannot tell a redelivery from a new event cannot report stream health.
      const statsAfter = (await ipc.request({ op: 'health' })).eventStats.duplicates;
      assert.ok(statsAfter - statsBefore >= emissions.length,
        `each of the ${emissions.length} replayed frames must be counted as a duplicate, saw ${statsAfter - statsBefore}`);
    } finally {
      ipc.close();
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },
};
