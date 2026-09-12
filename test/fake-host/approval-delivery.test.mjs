/**
 * Fake-Host layer: FR-APPR-2/3 — the answer delivery is classified from a CLOSED set, and a crash
 * between deciding and delivering is reported as what it actually was.
 *
 * Why this file exists. Two separate defects lived on this surface, and both made the bridge say
 * something reassuring that was not true:
 *
 *   1. `#recordDelivery` read the carrier receipt as
 *      `typeof receiptField === 'string' ? receiptField : 'accepted'` and then special-cased only
 *      `not-pending`. Every OTHER string — `bad-response`, a reason a future Host might add, any
 *      arbitrary text at all — was therefore recorded as an acceptance with `delivered: true`. On a
 *      safety surface that is the worst available default, because it makes "the Host took the
 *      answer" indistinguishable from "the Host said a word this bridge had never seen". Separately,
 *      the adapter itself collapsed `accepted: false` into `not-pending` whatever the reason, so a
 *      `bad-response` — the Host rejecting the answer as malformed, i.e. a defect in what we sent —
 *      was reported as "the Host has no pending request for this rpc id".
 *   2. Nothing durable was written between committing the decision and sending it. A process that
 *      died after the POST but before the outcome was recorded left NO trace, so on restart the
 *      decision looked exactly like one that had never been delivered — and "never delivered" is an
 *      invitation to deliver again. `Store.recordResponseDelivery` now takes a `dispatching` write
 *      BEFORE the request, so the three cases are distinguishable: no row (never attempted),
 *      `dispatching` (may have reached the Host), and a terminal outcome (answered).
 *
 * The oracle for "did the Host receive a second answer?" is the fixture's own receipt log, never a
 * bridge-side report. The crash is a real SIGKILL of a real daemon child, not a simulated one.
 *
 * Scope: this fixture is NOT the DSH product. A passing run here is evidence about our client against
 * our own fixture, never evidence about the official Host (that layer is `test/isolated-host`).
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A fixture host, a real daemon child, and one open session.
 * @param {string} label
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`approval-delivery-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the daemon mux downlink to reach ready' });
  const task = await ipc.request({ op: 'task.ensure', clientKey: `t-${label}` });
  const taskId = task.task.taskId;
  const started = await ipc.request({ op: 'session.start', taskId, clientKey: `s-${label}` });
  assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
  const hostSessionId = started.session.hostSessionId;
  const sessionId = started.session.sessionId;
  // The operator token is read from the daemon's private state directory through the same helper the
  // other approval suites use, imported here rather than reimplemented.
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

/** Restart a daemon over the same state directory, waiting for the previous owner to be gone. */
async function restartDaemon(r, pid) {
  try { r.ipc.close(); } catch { /* already closed */ }
  await r.daemon.stop();
  if (Number.isInteger(pid) && pid > 0) {
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, { timeoutMs: 20_000, what: `daemon pid ${pid} to exit` });
  }
  const daemon = await startDaemon({ hostBase: r.host.baseUrl, stateDir: r.stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the restarted daemon to attach' });
  return { daemon, ipc };
}

export default {
  'FR-APPR-3: the adapter closes the receipt set, so a bad-response is never reported as not-pending': async () => {
    const r = await rig('bad-response');
    try {
      const { DshHostAdapter } = await import('../../dist/lib/adapter.js');
      const adapter = new DshHostAdapter({ baseUrl: r.host.baseUrl, timeoutMs: 5000 });
      const parsed = new URL(r.host.baseUrl);

      // `bad-response` and `not-pending` are different facts and must be reported differently: the
      // first says the Host HELD the request and rejected our answer, the second says it had no
      // request at all. Collapsing them hid a malformed answer behind a reassurance.
      r.host.forceRespondReason('bad-response');
      // `AdapterCallResult` PROMOTES its fields to the top level rather than nesting them: measured,
      // `Object.keys(result)` is `['status','receipt','reason']`. Reading `.value.receipt` here is
      // exactly the kind of wrong-slot read the daemon's own delivery classifier has a paragraph
      // about, so it is spelled out with the measured shape above it.
      /** @param {any} result */
      const receiptOf = (result) => result;
      const bad = await adapter.respond({ rpcId: 'rpc-bad-response-probe', value: { sessionId: r.hostSessionId } });
      assert.equal(bad.status, 'ok', 'a carrier refusal is still a well-formed exchange');
      assert.equal(receiptOf(bad)?.receipt, 'bad-response',
        `the adapter must surface the Host's own reason, got ${JSON.stringify(receiptOf(bad))}`);

      r.host.forceRespondReason('not-pending');
      const notPending = await adapter.respond({ rpcId: 'rpc-not-pending-probe', value: { sessionId: r.hostSessionId } });
      assert.equal(receiptOf(notPending)?.receipt, 'not-pending',
        `not-pending must keep its own name, got ${JSON.stringify(receiptOf(notPending))}`);

      // A reason this bridge does not know must be named as unknown, NOT assumed to be a delivery
      // and not collapsed into either known refusal. This is the negative case that the old
      // `?? 'accepted'` default failed.
      r.host.forceRespondReason('a-reason-this-bridge-has-never-seen');
      const unknown = await adapter.respond({ rpcId: 'rpc-unknown-probe', value: { sessionId: r.hostSessionId } });
      assert.equal(receiptOf(unknown)?.receipt, 'unclassified',
        `an unrecognised reason must be reported as unrecognised, got ${JSON.stringify(receiptOf(unknown))}`);
      assert.notEqual(receiptOf(unknown)?.receipt, 'accepted', 'an unknown reason is never an acceptance');
      r.host.forceRespondReason(null);
      assert.ok(parsed.host, 'the fixture must be on a real origin');
    } finally {
      await r.teardown();
    }
  },

  'FR-APPR-3: a crash while the answer is in flight is reported as unproven, and the answer is never sent twice': async () => {
    const r = await rig('crash-in-flight');
    /** @type {{daemon: any, ipc: any}|null} */
    let revived = null;
    try {
      const { interactionId } = await r.raiseApproval();
      const pid = Number((await r.ipc.request({ op: 'health' })).pid);

      // The Host RECEIVES the answer and then takes a long time to reply, so the window in which the
      // daemon is waiting — with `dispatching` durable and no outcome — is wide enough to kill.
      // Delaying the RESPONSE rather than dropping the request is what makes "bytes reached the Host"
      // a fact rather than an assumption.
      r.host.delayFor('respond', 4000);
      const deciding = r.ipc.request({
        op: 'interaction.decide', taskId: r.taskId, interactionId,
        decision: 'allowed-once', authorityToken: r.token,
      }).catch(() => null);

      // Wait until the Host has the answer, then kill the process before it can record an outcome.
      await waitFor(() => r.host.respondReceipts.length >= 1,
        { timeoutMs: 5000, what: 'the answer to reach the Host' });
      process.kill(pid, 'SIGKILL');
      await deciding;

      // The Host has the answer exactly once, and the bridge never recorded what it said.
      assert.equal(r.host.respondReceipts.length, 1, 'the answer was delivered once, before the crash');

      revived = await restartDaemon(r, pid);
      const after = await revived.ipc.request({ op: 'interaction.list', taskId: r.taskId });
      const shaped = after.interactions.find((row) => row.interactionId === interactionId);
      assert.ok(shaped, `the interaction must survive the crash, got ${JSON.stringify(after.interactions)}`);
      assert.equal(shaped.state, 'allowed-once', 'the operator decision is durable and survives the crash');
      // THE claim: "decided" is NOT "delivered". The delivery is recorded as dispatching — an
      // unproven outcome — and explicitly not as a delivery that succeeded.
      assert.equal(shaped.delivery?.state, 'dispatching',
        `a crash with the answer in flight must leave an unproven delivery, got ${JSON.stringify(shaped.delivery)}`);
      assert.notEqual(shaped.delivery?.state, 'accepted', 'an unobserved outcome is never an acceptance');

      // No automatic retry, and no auto-approval: a second decision is refused, and the refusal says
      // the answer may already have reached the Host.
      let replay = null;
      try {
        await revived.ipc.request({
          op: 'interaction.decide', taskId: r.taskId, interactionId,
          decision: 'allowed-once', authorityToken: r.token,
        });
      } catch (error) { replay = /** @type {{code?: string, details?: {deliveredToHost?: string|null}}} */ (error); }
      assert.equal(replay?.code, 'APPROVAL_REPLAYED',
        `a re-decide after the crash must be refused, got ${JSON.stringify(replay)}`);
      assert.equal(replay?.details?.deliveredToHost, 'dispatching',
        'the refusal must report the delivery as unproven rather than as not-sent, so an operator is not '
        + 'told to deliver an answer that may already be in the Host');
      assert.equal(r.host.respondReceipts.length, 1,
        'nothing may deliver the answer a second time without an operator asking for it');
      assert.equal(r.host.appliedApprovals?.length ?? 0, 0,
        'and no approval may be applied by recovery itself');
    } finally {
      if (revived) { try { revived.ipc.close(); } catch { /* already closed */ } await revived.daemon.stop(); }
      await r.teardown();
    }
  },

  'FR-APPR-3: an unreachable host records a provable refusal, which is a different state from dispatching': async () => {
    const r = await rig('refused');
    try {
      const { interactionId } = await r.raiseApproval();
      // Make the Host genuinely unreachable by stopping it. The answer is then provably NOT sent —
      // a connection that was never established writes no bytes — so the recorded state must be
      // `refused`, and crucially NOT `dispatching`. The distinction is not pedantry: an operator may
      // deliberately retry a refused delivery, and if a refusal were recorded as an unproven outcome
      // that retry would be refused as a possible duplicate, while if it were recorded as nothing the
      // operator could not tell it had been attempted at all.
      await r.host.stop();
      const result = await r.ipc.request({
        op: 'interaction.decide', taskId: r.taskId, interactionId,
        decision: 'allowed-once', authorityToken: r.token,
      }).catch((error) => ({ error: /** @type {any} */ (error) }));
      const refusalResult = /** @type {{error?: {code?: string}}} */ (result);
      assert.equal(refusalResult.error, undefined,
        `the DECISION is a success even when its delivery fails, got ${JSON.stringify(refusalResult.error?.code)}`);
      const decideReply = /** @type {{delivered?: boolean, receipt?: string}} */ (result);
      assert.equal(decideReply.delivered, false, 'a failed delivery must not be reported as delivered');
      assert.equal(decideReply.receipt, 'refused', `expected a refusal receipt, got ${JSON.stringify(decideReply.receipt)}`);

      const list = await r.ipc.request({ op: 'interaction.list', taskId: r.taskId });
      const shaped = list.interactions.find((row) => row.interactionId === interactionId);
      assert.ok(shaped, 'the interaction must still be listed after a refused delivery');
      assert.equal(shaped.state, 'allowed-once', 'the decision stands even when its delivery did not');
      assert.equal(shaped.delivery?.state, 'refused',
        'a refusal proven before any byte was written must be recorded as itself, got '
        + JSON.stringify(shaped.delivery));
      assert.notEqual(shaped.delivery?.state, 'accepted', 'a refused delivery is not an acceptance');
      assert.notEqual(shaped.delivery?.state, 'dispatching',
        'nothing reached the Host, so this is not an unproven outcome either');
      // And the refusal is not reported as an approval: no receipt reached the Host at all.
      assert.equal(r.host.respondReceipts.length, 0,
        'an unreachable host cannot have received the answer');
    } finally {
      await r.teardown();
    }
  },
};
