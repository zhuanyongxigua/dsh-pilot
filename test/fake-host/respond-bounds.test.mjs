/**
 * The `/api/respond` transport bounds: a deadline and a receipt body cap.
 *
 * Why these tests exist: answering an approval is the one path where this bridge tells a Host to do
 * something consequential, and it was the one path with no deadline and no bound on the reply it
 * read. `call()` had both. So a Host that accepted the answer and then answered slowly, endlessly, or
 * never could hold that call — and the memory of its body — for as long as it liked, with the
 * approval sitting in `dispatching` while an operator waited.
 *
 * The claim under test is not "respond returns eventually". It is that the outcome is reported HONESTLY
 * when the transport fails after the answer may already have arrived: `uncertain`, never "not reached",
 * because the durable `dispatching` record already says the request was written. A caller told "not
 * reached" would deliver the answer again; a caller told "unproven" will not, and cannot be silently
 * auto-approved either, because nothing on this path decides anything by itself.
 *
 * The deadline is run small (`DSH_PILOT_HOST_TIMEOUT_MS`) through the configured limit, so no case
 * waits fifteen seconds for a bound it is trying to prove exists.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A daemon whose unary deadline is small, over a real fake Host and a real IPC socket.
 * @param {string} label
 * @param {Record<string, string>} [env]
 */
async function rig(label, env = {}) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`respond-bounds-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({
    hostBase: host.baseUrl,
    stateDir,
    extraEnv: { DSH_PILOT_HOST_TIMEOUT_MS: '900', ...env },
  });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the daemon mux downlink to reach ready' });
  const task = await ipc.request({ op: 'task.ensure', clientKey: `t-${label}` });
  const taskId = task.task.taskId;
  const started = await ipc.request({ op: 'session.start', taskId, clientKey: `s-${label}` });
  assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
  const hostSessionId = started.session.hostSessionId;
  const sessionId = started.session.sessionId;
  // The operator token comes from the daemon's private state directory through the same helper the
  // other approval suites use, rather than a token invented for this file.
  const { readAuthorityToken } = await import('../../dist/lib/ipc.js');
  const token = readAuthorityToken(stateDir);
  /** Raise a real approval request from the Host and wait until the bridge has recorded it. */
  const raiseApproval = async () => {
    const approval = host.emitApprovalRequested(hostSessionId);
    host.markApprovalPending(approval.rpcId);
    await waitFor(async () => {
      const list = await ipc.request({ op: 'interaction.list', taskId });
      return list.interactions.length >= 1;
    }, { timeoutMs: 5000, what: 'the approval to be recorded' });
    const list = await ipc.request({ op: 'interaction.list', taskId });
    return { approval, interactionId: list.interactions[list.interactions.length - 1].interactionId };
  };
  return {
    host, ipc, daemon, stateDir, taskId, sessionId, hostSessionId, token, raiseApproval,
    teardown: async () => {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/** The durable delivery state recorded for an interaction, read back through the API. */
async function deliveryOf(r, interactionId) {
  const list = await r.ipc.request({ op: 'interaction.list', taskId: r.taskId });
  return list.interactions.find((row) => row.interactionId === interactionId);
}

/** Answer one interaction, returning the reply or the typed refusal. */
async function decide(r, interactionId) {
  return r.ipc.request({
    op: 'interaction.decide', taskId: r.taskId, interactionId,
    decision: 'allowed-once', authorityToken: r.token,
  }).then((value) => /** @type {any} */ (value), (error) => ({ error: /** @type {any} */ (error) }));
}

export default {
  'FR-APPR-4 a silently held response ends as an unproven receipt after the deadline, and the answer is never sent twice': async () => {
    const r = await rig('silent');
    try {
      const { interactionId, approval } = await r.raiseApproval();
      // The Host takes the answer and then says nothing at all — no headers, no body, no close.
      r.host.holdResponseFor('respond');
      const startedAt = Date.now();
      const reply = await decide(r, interactionId);
      const elapsed = Date.now() - startedAt;

      assert.equal(reply.error, undefined,
        `the DECISION succeeds even when its delivery is unproven, got ${JSON.stringify(reply.error)}`);
      assert.equal(reply.receipt, 'uncertain',
        `a peer that never answers leaves the outcome unproven, never "not reached": `
        + `got ${JSON.stringify(reply.receipt)} (${reply.note})`);
      assert.equal(reply.delivered, false, 'an unproven delivery is not a delivery');
      assert.ok(elapsed < 8000,
        `the call must end on its configured deadline rather than hang; it took ${elapsed}ms`);
      // The Host DID receive it. That is the fact that makes "unproven" the right report: the answer
      // was written, so "not reached" would be a lie a caller might act on by sending it again.
      assert.equal(r.host.respondReceipts.length, 1,
        'the Host must have taken exactly one answer before going silent');
      assert.equal(r.host.respondReceipts[0].rpcId, approval.rpcId, 'and it must be this interaction\'s answer');
      const row = await deliveryOf(r, interactionId);
      assert.equal(row?.delivery?.state, 'uncertain',
        `the durable record must say unproven, got ${JSON.stringify(row?.delivery)}`);
      assert.notEqual(row?.delivery?.state, 'accepted', 'and never an acceptance it did not observe');

      // Nothing re-sends the answer on its own, now or after the peer recovers.
      r.host.releaseHeldResponses('respond');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(r.host.respondReceipts.length, 1,
        `nothing may re-deliver the answer without a caller asking, got ${r.host.respondReceipts.length}`);
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-4 an oversized receipt body is refused while it is read, and the daemon still answers everything else': async () => {
    const r = await rig('oversize');
    try {
      const { interactionId } = await r.raiseApproval();
      // 9 MiB of body against the client's 8 MiB cap. The fixture streams it in chunks, so the test
      // never holds an oversized body either.
      r.host.respondBodyBytes(9 * 1024 * 1024);
      const reply = await decide(r, interactionId);
      assert.equal(reply.error, undefined, `the decision must still be reported: ${JSON.stringify(reply.error)}`);
      assert.equal(reply.receipt, 'uncertain',
        `a receipt that cannot be read leaves the outcome unproven, got ${JSON.stringify(reply.receipt)}`);
      const row = await deliveryOf(r, interactionId);
      assert.equal(row?.delivery?.state, 'uncertain',
        'and the durable record must say so rather than "not reached"');

      // The bound is per request, not per process: the bridge must still work afterwards.
      r.host.respondBodyBytes(0);
      const health = await r.ipc.request({ op: 'health' });
      assert.equal(health.connection, 'ready', 'the daemon must still be attached to the Host');
      const state = await r.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId });
      const reportedId = state.sessionId ?? state.session?.sessionId;
      assert.equal(reportedId, r.sessionId, 'and it must still answer session queries');

      // A later approval delivered normally must come back accepted, which is what proves the previous
      // oversized read left nothing broken behind it.
      const { interactionId: second } = await r.raiseApproval();
      const accepted = await decide(r, second);
      assert.equal(accepted.receipt, 'accepted',
        `a normal answer after an oversized one must still work, got ${JSON.stringify(accepted.receipt)}`);
      assert.equal((await deliveryOf(r, second))?.delivery?.state, 'accepted',
        'and it must be recorded as accepted');
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-4 a receipt that cannot be parsed is reported as unproven, exactly like one that could not be read': async () => {
    const r = await rig('unreadable');
    try {
      const { interactionId } = await r.raiseApproval();
      // A small, well-formed HTTP 200 whose body is not a receipt at all. The Host answered, so the
      // answer was written and may have been applied: the outcome is unproven. Reporting this as a
      // refusal would tell an operator that an answer the Host may have taken never arrived.
      r.host.respondWithRaw(200, 'this is not json');
      const reply = await decide(r, interactionId);
      assert.equal(reply.error, undefined, `the decision itself still stands: ${JSON.stringify(reply.error)}`);
      assert.equal(reply.receipt, 'uncertain',
        `an unreadable receipt is an unproven outcome, got ${JSON.stringify(reply.receipt)} (${reply.note})`);
      assert.equal(reply.delivered, false, 'and it is not a delivery');
      const row = await deliveryOf(r, interactionId);
      assert.equal(row?.delivery?.state, 'uncertain',
        `the durable record must say unproven, got ${JSON.stringify(row?.delivery)}`);
      // The Host did receive it, which is why "not reached" would be wrong.
      assert.equal(r.host.respondReceipts.length, 1, 'the Host must have taken exactly one answer');
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-4 a non-200 status after the answer was sent is an unproven delivery, not a refusal': async () => {
    const r = await rig('status');
    try {
      const { interactionId, approval } = await r.raiseApproval();
      // The status alone used to decide the classification, and a Host that takes the answer and then
      // answers `500` — because its own downstream failed, because a proxy in front of it did — was
      // reported to the caller as a definite REFUSAL. That is the one report this path must never
      // invent: it says the answer never arrived, while the Host has it. A status is proof the request
      // was SENT, so delivery is unproven, exactly as for an unreadable receipt.
      r.host.respondWithRaw(500, '{"error":"the host failed after taking the answer"}');
      const reply = await decide(r, interactionId);

      assert.equal(r.host.respondReceipts.length, 1,
        'the control: the Host really did take the answer before answering 500');
      assert.equal(r.host.respondReceipts[0].rpcId, approval.rpcId,
        'and the answer it took is this interaction\'s');
      assert.equal(reply.error, undefined,
        `the decision itself must still be reported, got ${JSON.stringify(reply.error)}`);
      assert.equal(reply.receipt, 'uncertain',
        `a non-200 after send leaves the outcome unproven, never a refusal: got ${JSON.stringify(reply.receipt)} (${reply.note})`);
      assert.equal(reply.delivered, false, 'and an unproven delivery is not a delivery');
      assert.notEqual(reply.receipt, 'refused',
        'the caller must not be told the answer failed to arrive when the Host took it');
      const row = await deliveryOf(r, interactionId);
      assert.equal(row?.delivery?.state, 'uncertain',
        `the durable record must say unproven rather than not-reached, got ${JSON.stringify(row?.delivery)}`);
      // The other half of the requirement: a PROVABLE pre-send failure is still a refusal. That is the
      // case below, which asserts the distinction this case must not erase.
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-4 a failure before any byte is written is still a provable refusal, and is distinguishable from the unproven case': async () => {
    const r = await rig('before-send');
    try {
      const { interactionId } = await r.raiseApproval();
      // Nothing listening at all: the connection cannot be established, so "no byte was written" is a
      // fact about the transport rather than an inference from timing.
      await r.host.stop();
      const reply = await decide(r, interactionId);
      assert.equal(reply.error, undefined, 'the decision is an operator act and stands');
      assert.equal(reply.receipt, 'refused',
        `a request that never left the process is a refusal, not an unproven outcome: got ${JSON.stringify(reply.receipt)}`);
      const row = await deliveryOf(r, interactionId);
      assert.equal(row?.delivery?.state, 'refused',
        `and it must be recorded as a refusal, got ${JSON.stringify(row?.delivery)}`);
      assert.notEqual(row?.delivery?.state, 'dispatching',
        'nothing reached the Host, so this is not the unproven state either — an operator may retry a refusal');
      assert.equal(r.host.respondReceipts.length, 0, 'a stopped Host cannot have received the answer');
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-4 the deadline is per attempt: three held responses in a row each end on their own bound with no timer left behind': async () => {
    const r = await rig('repeat', { DSH_PILOT_HOST_TIMEOUT_MS: '600' });
    try {
      // Three silently held attempts in a row. If the deadline's timer were not cleared, or the socket
      // not destroyed, a later attempt would behave differently from the first — which is how a
      // per-request bound silently becomes a per-process one, and then a slow leak of timers.
      const elapsedList = [];
      for (let i = 1; i <= 3; i += 1) {
        const { interactionId } = await r.raiseApproval();
        r.host.holdResponseFor('respond');
        const startedAt = Date.now();
        const reply = await decide(r, interactionId);
        elapsedList.push(Date.now() - startedAt);
        assert.equal(reply.receipt, 'uncertain',
          `attempt ${i} must end as unproven, got ${JSON.stringify(reply.receipt)}`);
        assert.ok(elapsedList[i - 1] < 8000, `attempt ${i} must end on its deadline, took ${elapsedList[i - 1]}ms`);
        assert.equal((await deliveryOf(r, interactionId))?.delivery?.state, 'uncertain',
          `attempt ${i} must record the unproven outcome`);
        r.host.releaseHeldResponses('respond');
      }
      // Exactly the three explicit attempts reached the Host: nothing was retried behind the caller,
      // and no attempt was skipped because a previous deadline was still pending.
      assert.equal(r.host.respondReceipts.length, 3,
        `exactly the three attempts may have reached the Host, got ${r.host.respondReceipts.length}`);
      assert.ok(elapsedList.every((ms) => ms > 300),
        `each attempt must actually have waited for its deadline: ${JSON.stringify(elapsedList)}`);
    } finally {
      await r.teardown();
    }
  },
};
