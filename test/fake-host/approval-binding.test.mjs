/**
 * Approval binding and receipt meaning: FR-APPR-2 and FR-APPR-3, against the fake Host over
 * real HTTP and a real WebSocket.
 *
 * Why these tests exist: the approval path is the one place where a wrong answer runs a shell
 * tool, so "which answer is this, and is it still the one being asked for?" has to be answered by
 * something other than a comment. Every case below therefore asserts two things: the *typed*
 * outcome the bridge reports, and the fake Host's `/api/respond` request log — because a refusal
 * that still put bytes on the wire is not a refusal.
 *
 * Scope note: `test/fixtures/fake-host.mjs` is NOT the DSH product. These tests are evidence about
 * this bridge's own client and binding logic only; product behaviour is exercised in
 * `test/isolated-host`, which this file says nothing about.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS *NOT* COVERED HERE, AND WHY (measured, not assumed)
 *
 * The daemon never carries an approval answer to the Host. `DshHostAdapter.respond()`
 * (`src/lib/adapter.ts`) and `Store.recordResponseDelivery()` (`src/lib/store.ts`) have ZERO
 * callers anywhere in `src/`; `interactionDecide` performs a local compare-and-set and returns
 * `delivery: 'pending-async'` with a note promising a receipt that nothing ever asks for. Two
 * measurable consequences, both asserted below rather than hidden:
 *
 *   1. the fake Host's `/api/respond` log is empty even for a *correct, authorised* answer, so
 *      "the log shows no delivery for a refused answer" currently passes for the wrong reason;
 *   2. `getResponseDelivery()` is read by `interactionDecide` but written by nothing, so the
 *      `outcome === 'not-pending'` branch is unreachable, and FR-APPR-3's oracle (fake Host
 *      returns `not-pending`) cannot be driven at all.
 *
 * The three cases marked `[DEFECT ...]` in their names pin the observed behaviour so the gap is
 * visible in a green run. They are a defect ledger, not coverage: when the delivery path is
 * implemented, those assertions must be rewritten to assert the requirement.
 *
 * There is also no turn binding to test: `interactionDecide` takes only `taskId` and
 * `interactionId`, checks neither against a turn, and `shapeInteraction` does not even expose the
 * `turn_id` the row carries. See the case named `[DEFECT: no turn binding exists]`.
 * ---------------------------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { assert, scratchDir, startDaemon, ipcClient, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * How long a "nothing was ever delivered" claim is observed for.
 *
 * A negative existence claim has no condition to synchronise on, so it is observed over a bounded
 * quiet window — the same convention `contract.test.mjs` already uses for its own no-delivery
 * assertions. It is a window on an absence, never a substitute for waiting on a condition: every
 * positive fact in this file is waited for with `waitFor` and a reported timeout.
 */
const NO_DELIVERY_WINDOW_MS = 300;

/**
 * Bring up a fixture host plus a daemon against a scratch state directory.
 * @param {string} label the scratch-directory label, so a failure names its own case
 * @param {object} [options]
 */
async function rig(label, options = {}) {
  const host = await new FakeHost().start();
  if (options.autoTurn === false) host.autoTurn = false;
  const scratch = scratchDir(label);
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: `${scratch.dir}/state` });
  const ipc = await ipcClient(daemon.socketPath);
  const teardown = async () => {
    ipc.close();
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, daemon, ipc, teardown };
}

/** @param {object} ipc @param {string} clientKey */
async function newTask(ipc, clientKey) {
  const task = await ipc.request({ op: 'task.ensure', clientKey });
  assert.ok(task.task, `task.ensure failed: ${JSON.stringify(task)}`);
  return task.task.taskId;
}

/** @param {object} ipc @param {string} taskId @param {string} clientKey */
async function newSession(ipc, taskId, clientKey) {
  const started = await ipc.request({ op: 'session.start', taskId, clientKey });
  assert.ok(started.session, `session.start failed: ${JSON.stringify(started)}`);
  return started.session;
}

/** @param {object} ipc @param {string} taskId */
async function interactions(ipc, taskId) {
  return (await ipc.request({ op: 'interaction.list', taskId })).interactions;
}

/** @param {object} ipc @param {string} taskId @param {string} interactionId */
async function interactionById(ipc, taskId, interactionId) {
  return (await interactions(ipc, taskId)).find((row) => row.interactionId === interactionId);
}

/**
 * Wait until the daemon's mux downlink is up, so a frame pushed through the fixture's raw escape
 * hatch is actually delivered rather than broadcast into an empty socket set.
 * @param {object} ipc
 */
async function muxReady(ipc) {
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 5000, what: 'the mux downlink to be ready' });
}

/**
 * Ask the daemon to decide an interaction, capturing a typed refusal instead of throwing.
 *
 * The refusal is captured rather than caught-and-ignored because its *code* is the thing under
 * test: "it failed somehow" would be satisfied by a crash, a typo in the op name, or a timeout.
 * @param {object} ipc
 * @param {Record<string, unknown>} request the fields of the `interaction.decide` request
 */
async function decide(ipc, request) {
  try {
    return { result: await ipc.request({ op: 'interaction.decide', ...request }), error: null };
  } catch (error) {
    return { result: null, error: /** @type {{code?: string, message?: string}} */ (error) };
  }
}

/** @param {object} daemon */
async function authorityToken(daemon) {
  const { readAuthorityToken } = await import('../../dist/lib/ipc.js');
  const token = readAuthorityToken(daemon.stateDir);
  assert.ok(typeof token === 'string' && token.length >= 32, 'the daemon must mint an authority token');
  return token;
}

/**
 * Push an approval frame carrying an explicit `expiresAt`.
 *
 * The fixture's `emitApprovalRequested` helper has no expiry parameter, so the identical envelope
 * is built here and sent through the fixture's own raw-mux entry point — the same bytes its
 * `#broadcast` would have produced, plus the one field under test. No fixture change is needed and
 * none was made.
 * @param {import('../fixtures/fake-host.mjs').FakeHost} host
 * @param {string} hostSessionId
 * @param {number|null} expiresAt
 */
function emitApprovalWithExpiry(host, hostSessionId, expiresAt) {
  const rpcId = randomUUID();
  const approvalId = `appr_${randomUUID()}`;
  host.emitRawMux(JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'mux',
    payload: {
      type: 'approval/requested',
      sessionId: hostSessionId,
      approvalId,
      toolName: 'bash',
      reason: 'fixture approval with an explicit expiry',
      expiresAt,
    },
  }));
  return { rpcId, approvalId };
}

/**
 * Push the Host's authoritative resolution frame for one interaction.
 * @param {import('../fixtures/fake-host.mjs').FakeHost} host
 * @param {string} hostSessionId
 * @param {string} rpcId the interaction's host rpc id
 * @param {string} outcome whatever the Host says the resolution was
 */
function emitResolved(host, hostSessionId, rpcId, outcome) {
  host.emitRawMux(JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'mux',
    payload: { type: 'approval/resolved', sessionId: hostSessionId, outcome },
  }));
}

/**
 * Assert the fake Host was never asked to carry an answer.
 *
 * `respondReceipts` — not `requestsFor('respond')` — is the `/api/respond` log: the fixture's
 * `/api/respond` handler returns before its generic request recorder runs, so the only honest
 * record of a respond attempt is the receipt list, and it captures the row even when the Host
 * answers `not-pending`.
 * @param {import('../fixtures/fake-host.mjs').FakeHost} host
 * @param {string} what the refused answer, named so a failure says which one leaked
 */
async function assertNoRespondDelivery(host, what, options = {}) {
  await new Promise((resolve) => setTimeout(resolve, NO_DELIVERY_WINDOW_MS));
  // A case that has ALREADY produced a legitimate delivery (the lost-receipt case) cannot assert an
  // empty log; it asserts the stronger, narrower thing — that no ADDITIONAL delivery appeared. The
  // expected count is named by the caller rather than inferred, so this helper never quietly relaxes
  // the assertions of the cases that do assert an empty log.
  const expected = options.expectOnly ? host.respondReceipts.filter((row) => row.rpcId === options.expectOnly).length : 0;
  assert.equal(
    host.respondReceipts.length,
    expected,
    `${what} must not reach POST /api/respond again, but the fake Host's log holds ${JSON.stringify(host.respondReceipts)}`,
  );
}

export default {
  'FR-APPR-2 wrong task: a token valid for task A cannot decide task B\'s interaction, and nothing is delivered': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-wrong-task');
    try {
      const taskA = await newTask(ipc, 'wrong-task-a');
      const taskB = await newTask(ipc, 'wrong-task-b');
      const sessionB = await newSession(ipc, taskB, 'wrong-task-session-b');
      const approval = host.emitApprovalRequested(sessionB.hostSessionId);
      // Marked pending in the fixture, so a delivered answer WOULD have been accepted: the
      // "nothing was delivered" assertion below cannot pass merely because the Host would refuse.
      host.markApprovalPending(approval.rpcId);
      await waitFor(async () => (await interactions(ipc, taskB)).length >= 1,
        { timeoutMs: 5000, what: 'the task-B approval to be recorded' });
      const interaction = (await interactions(ipc, taskB))[0];
      assert.equal(interaction.taskId, taskB, 'the interaction must be recorded against its own task');

      // The authority token is minted per STATE DIRECTORY, not per task, so "valid for task A" and
      // "valid for task B" are the same string; what this case binds is the taskId argument
      // against the interaction's stored task_id. The token is real and correct throughout.
      const token = await authorityToken(daemon);
      const refused = await decide(ipc, {
        taskId: taskA, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
      });

      assert.equal(refused.result, null, `a foreign-task answer must not succeed, got ${JSON.stringify(refused.result)}`);
      // Reported defect, asserted as it exists rather than as it should be: `interactionDecide`
      // deliberately does not call `#requireTask`, so a FOREIGN task id comes back as
      // APPROVAL_STALE ("interaction belongs to another task") instead of NOT_FOUND. The code is
      // misleading here — APPROVAL_STALE is the taxonomy's name for a stale decision, while the
      // caller's actual mistake is naming an interaction its task does not own. Left unfixed on
      // purpose; this assertion pins the current contract so a change to it is noticed.
      assert.equal(refused.error?.code, 'APPROVAL_STALE', `expected APPROVAL_STALE, got ${JSON.stringify(refused.error)}`);
      assert.match(String(refused.error?.message), /another task/);

      // The refused answer changed nothing...
      assert.equal((await interactionById(ipc, taskB, interaction.interactionId)).state, 'pending',
        'a refused answer must leave the interaction pending');
      // ...and it never reached the Host.
      await assertNoRespondDelivery(host, 'a wrong-task answer');
    } finally {
      await teardown();
    }
  },

  'FR-APPR-2 wrong interaction: a decision naming another interaction is refused, and a sibling stays pending': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-wrong-interaction');
    try {
      const taskId = await newTask(ipc, 'wrong-interaction');
      const session = await newSession(ipc, taskId, 'wrong-interaction-session');
      const first = host.emitApprovalRequested(session.hostSessionId);
      const second = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(first.rpcId);
      host.markApprovalPending(second.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 2,
        { timeoutMs: 5000, what: 'both approvals to be recorded' });
      const target = (await interactions(ipc, taskId)).find((row) => row.nativeId === first.approvalId);
      const sibling = (await interactions(ipc, taskId)).find((row) => row.nativeId === second.approvalId);
      assert.ok(target && sibling, 'both approvals must be recorded as distinct interactions');
      assert.notEqual(target.interactionId, sibling.interactionId, 'two approvals must not collapse into one interaction');

      const token = await authorityToken(daemon);

      // (a) An id that names no stored interaction is not an answer to anything: a typed NOT_FOUND,
      //     nothing decided, nothing delivered.
      const unknown = await decide(ipc, {
        taskId, interactionId: 'int_this_interaction_does_not_exist', decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(unknown.result, null, 'an unknown interaction id must not succeed');
      assert.equal(unknown.error?.code, 'NOT_FOUND', `expected NOT_FOUND, got ${JSON.stringify(unknown.error)}`);
      assert.equal(host.respondReceipts.length, 0, 'an unknown-interaction answer must not reach the Host');

      // (b) An answer that names the FIRST interaction is bound to that row and to no other: the
      //     sibling it does not name must be untouched. A decision keyed by session or by rpcId
      //     would decide both, and this is what catches that.
      const applied = await decide(ipc, {
        taskId, interactionId: target.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(applied.error, null, `the correct interaction must be decidable, got ${JSON.stringify(applied.error)}`);
      assert.equal(applied.result.interaction.interactionId, target.interactionId);
      assert.equal(applied.result.interaction.state, 'allowed-once');
      assert.equal((await interactionById(ipc, taskId, sibling.interactionId)).state, 'pending',
        'deciding one interaction must not decide its sibling');

      // The delivery that must NOT happen is a delivery for the SIBLING. Before the delivery path
      // existed this case asserted "no /api/respond at all", which passed for the wrong reason — no
      // delivery code existed. The binding claim is about WHICH rpcId is answered, so it is asserted
      // positively now: exactly one delivery, carrying the decided interaction's own rpcId, and none
      // carrying the sibling's. A decision keyed by session would echo the sibling's id, or both.
      const receipts = host.respondReceipts;
      assert.equal(receipts.length, 1,
        `exactly one delivery, for the decided interaction; got ${JSON.stringify(receipts)}`);
      assert.equal(receipts[0].rpcId, target.hostRpcId,
        'the delivered answer must echo the decided interaction\'s own rpcId');
      assert.notEqual(receipts[0].rpcId, sibling.hostRpcId,
        'the sibling interaction\'s rpcId must never be answered by a decision that named another row');
      // And the answer's own payload must name the decided row's session and approval, not the sibling's.
      const value = receipts[0].result?.value;
      assert.equal(value?.sessionId, session.hostSessionId, 'the answered payload must name the session it answers');
      assert.equal(value?.approvalId, first.approvalId, 'the answered payload must name the approval it answers');
      assert.notEqual(value?.approvalId, second.approvalId, 'the sibling approval must not be the one answered');
    } finally {
      await teardown();
    }
  },

  'FR-APPR-2 wrong turn: an answer naming a different turn is refused, and naming its own turn is accepted': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-wrong-turn', { autoTurn: false });
    try {
      const taskId = await newTask(ipc, 'wrong-turn');
      const session = await newSession(ipc, taskId, 'wrong-turn-session');
      await muxReady(ipc);

      // The approval arrives while host turn 1 is open, so the interaction row is bound to turn 1.
      host.forceTurnNumber(session.hostSessionId, 1);
      host.emitSessionEvent(session.hostSessionId, { type: 'turn/start', turn: 1 });
      await waitFor(async () => (await ipc.request({ op: 'session.state', taskId, sessionId: session.sessionId })).execution.state === 'running',
        { timeoutMs: 5000, what: 'turn 1 to be open' });
      const approval = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(approval.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 1,
        { timeoutMs: 5000, what: 'the approval to be recorded on the open turn' });
      const interaction = (await interactions(ipc, taskId))[0];
      // The binding is observable from a caller: `shapeInteraction` exposes the turn the
      // interaction belongs to. A binding a caller cannot see is a binding it cannot verify, so
      // this assertion is the first half of the requirement rather than incidental.
      assert.equal(typeof interaction.turnId, 'string',
        `the shaped interaction must expose the turn it is bound to, got ${JSON.stringify(interaction.turnId)}`);
      assert.equal(typeof interaction.hostRpcId, 'string',
        'the shaped interaction must expose the rpcId the answer has to echo');

      // Turn 1 ends. The interaction still belongs to turn 1; the open turn is now none.
      host.emitTurnEnd(session.hostSessionId, 1, 'completed');
      await waitFor(async () => (await ipc.request({ op: 'session.state', taskId, sessionId: session.sessionId })).execution.state === 'idle',
        { timeoutMs: 5000, what: 'turn 1 to close' });

      const token = await authorityToken(daemon);

      // (a) An answer that names a DIFFERENT turn is refused with a typed error and nothing is
      //     delivered. The turn it names is a real, well-formed turn id — the point is that it is
      //     not this interaction's turn. A fabricated string would only re-test NOT_FOUND.
      const wrongTurn = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
        turnId: 'turn_00000000-0000-4000-8000-000000000000',
      });
      assert.equal(wrongTurn.result, null, 'a wrong-turn answer must not succeed');
      assert.equal(wrongTurn.error?.code, 'APPROVAL_STALE',
        `a wrong-turn answer must be refused with a typed error, got ${JSON.stringify(wrongTurn.error)}`);
      assert.equal(host.respondReceipts.length, 0,
        `a wrong-turn answer must never reach the Host, got ${JSON.stringify(host.respondReceipts)}`);
      const afterWrongTurn = await interactionById(ipc, taskId, interaction.interactionId);
      assert.equal(afterWrongTurn.state, 'pending',
        'a refused wrong-turn answer must leave the interaction pending, not decide it');

      // (b) The control: naming the interaction's OWN turn is accepted and delivered. Without this
      //     the refusal above would also be satisfied by rejecting every answer that names a turn.
      const rightTurn = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
        turnId: interaction.turnId,
      });
      assert.equal(rightTurn.error, null,
        `naming the interaction's own turn must be accepted, got ${JSON.stringify(rightTurn.error)}`);
      assert.equal(rightTurn.result.interaction.state, 'allowed-once');
      assert.equal(host.respondReceipts.length, 1, 'the accepted answer must be carried to the Host once');
      assert.equal(host.respondReceipts[0].rpcId, interaction.hostRpcId,
        "the delivered answer must echo the interaction's rpcId");
    } finally {
      await teardown();
    }
  },

  'FR-APPR-3 not-pending: the carrier receipt is surfaced, and the interaction is host-resolved rather than answered': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-not-pending');
    try {
      const taskId = await newTask(ipc, 'not-pending');
      const session = await newSession(ipc, taskId, 'not-pending-session');
      await muxReady(ipc);
      const token = await authorityToken(daemon);

      // (i) The half of FR-APPR-3 that must hold whichever way the receipt arrives: an answer we
      //     sent is never reported as the Host having resolved it. The state after our own decision
      //     is our decision, not "answered".
      const decided = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(decided.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 1,
        { timeoutMs: 5000, what: 'the decidable approval to be recorded' });
      const decidable = (await interactions(ipc, taskId))[0];
      const applied = await decide(ipc, {
        taskId, interactionId: decidable.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(applied.error, null, `the decision must be accepted: ${JSON.stringify(applied.error)}`);
      assert.notEqual(applied.result.interaction.state, 'answered',
        'our own answer must never be reported as the Host having answered');
      // The host held this request pending, so the carrier accepted it.
      assert.equal(applied.result.delivered, true, `expected a delivered answer, got ${JSON.stringify(applied.result)}`);
      assert.equal(applied.result.receipt, 'accepted');

      // (ii) FR-APPR-3's actual oracle, now reachable: the fixture answers `not-pending` for an rpc id
      //      it is NOT holding pending. That is the receipt the requirement is written about, and the
      //      bridge must not read it as "answered".
      const vanished = host.emitApprovalRequested(session.hostSessionId);
      // Deliberately NOT marked pending: the Host will answer `{accepted:false, reason:'not-pending'}`.
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 2,
        { timeoutMs: 5000, what: 'the already-gone approval to be recorded' });
      const gone = (await interactions(ipc, taskId)).find((row) => row.nativeId === vanished.approvalId);
      assert.ok(gone, 'the second approval must be recorded as its own interaction');

      const notPending = await decide(ipc, {
        taskId, interactionId: gone.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(notPending.error, null, `the call itself must not error: ${JSON.stringify(notPending.error)}`);
      // The receipt is surfaced, not swallowed.
      assert.equal(notPending.result.receipt, 'not-pending',
        `the carrier receipt must be reported verbatim, got ${JSON.stringify(notPending.result)}`);
      assert.equal(notPending.result.delivered, false,
        'a not-pending receipt must not be reported as delivered');
      // And the interaction is NOT answered. This is the requirement's core sentence.
      const goneAfter = await interactionById(ipc, taskId, gone.interactionId);
      assert.notEqual(goneAfter.state, 'answered',
        'a not-pending receipt must never leave the interaction looking answered by us');
      // The state records BOTH facts, because either alone would be a lie: the operator did answer,
      // and the Host had nothing pending to apply that answer to. `decideInteraction` cannot perform
      // this transition (its compare-and-set only moves a row out of `pending`, and the answer
      // already moved it), which is why the store has a dedicated `markAnswerNotPending`.
      assert.equal(goneAfter.state, 'answer-not-pending',
        `expected the answered-but-not-pending state, got ${goneAfter.state}`);
      assert.notEqual(goneAfter.state, 'allowed-once',
        'the operator decision must not be left standing as if the Host had applied it');
      const receiptRow = host.respondReceipts.find((row) => row.rpcId === gone.hostRpcId);
      assert.ok(receiptRow, 'the attempt must be visible in the Host log');
      assert.equal(receiptRow.outcome, 'not-pending',
        'the Host must have answered not-pending for an rpc id it was not holding');

      // (iii) The reachable resolution path is the Host's own resolved frame, and it does land:
      //       `expired` becomes a terminal 'expired', i.e. resolved-by-host and not answered-by-us.
      const expiring = host.emitApprovalRequested(session.hostSessionId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 2,
        { timeoutMs: 5000, what: 'the expiring approval to be recorded' });
      const expiringRow = (await interactions(ipc, taskId)).find((row) => row.nativeId === expiring.approvalId);
      emitResolved(host, session.hostSessionId, expiring.rpcId, 'expired');
      await waitFor(async () => (await interactionById(ipc, taskId, expiringRow.interactionId)).state !== 'pending',
        { timeoutMs: 5000, what: 'the expiry frame to resolve the interaction' });
      const resolved = await interactionById(ipc, taskId, expiringRow.interactionId);
      assert.equal(resolved.state, 'expired', `expected a terminal expired, got ${resolved.state}`);
      assert.notEqual(resolved.state, 'answered', 'an expiry must not be recorded as an answer');

      // (iv) The resolved-frame path must NOT map an outcome it does not recognise to `answered`. An
      //      outcome nobody understands is an unknown outcome, which this project's rules require to
      //      surface as unknown rather than as a definite answer. This was a real defect found while
      //      driving (iii) and it is fixed; the assertion below is the requirement, not a description.
      const unclear = host.emitApprovalRequested(session.hostSessionId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 3,
        { timeoutMs: 5000, what: 'the third approval to be recorded' });
      const unclearRow = (await interactions(ipc, taskId)).find((row) => row.nativeId === unclear.approvalId);
      emitResolved(host, session.hostSessionId, unclear.rpcId, 'an-outcome-this-bridge-does-not-know');
      await waitFor(async () => (await interactionById(ipc, taskId, unclearRow.interactionId)).state !== 'pending',
        { timeoutMs: 5000, what: 'the unrecognised resolution frame to be folded in' });
      const unclearState = (await interactionById(ipc, taskId, unclearRow.interactionId)).state;
      assert.notEqual(unclearState, 'answered',
        'an unrecognised resolution outcome must never become a definite answer');
      assert.equal(unclearState, 'unresolved-by-host',
        `an unrecognised outcome must surface as unresolved, got ${unclearState}`);

      // (v) The control on the same path: the ONE outcome that really does mean the answer was used
      //     must still land on `answered`, so (iv) is not satisfied by refusing every frame.
      const used = host.emitApprovalRequested(session.hostSessionId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 4,
        { timeoutMs: 5000, what: 'the fourth approval to be recorded' });
      const usedRow = (await interactions(ipc, taskId)).find((row) => row.nativeId === used.approvalId);
      emitResolved(host, session.hostSessionId, used.rpcId, 'allowed-once');
      await waitFor(async () => (await interactionById(ipc, taskId, usedRow.interactionId)).state !== 'pending',
        { timeoutMs: 5000, what: 'the allowed-once frame to be folded in' });
      assert.equal((await interactionById(ipc, taskId, usedRow.interactionId)).state, 'answered',
        "the authoritative allowed-once frame is the one path that means the answer was used");
    } finally {
      await teardown();
    }
  },

  'FR-APPR-2 replay: a second decision is refused as stale and the receipt is never sent twice': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-replay');
    try {
      const taskId = await newTask(ipc, 'replay');
      const session = await newSession(ipc, taskId, 'replay-session');
      const approval = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(approval.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 1,
        { timeoutMs: 5000, what: 'the approval to be recorded' });
      const interaction = (await interactions(ipc, taskId))[0];
      const token = await authorityToken(daemon);

      const first = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(first.error, null, `the first decision must be accepted: ${JSON.stringify(first.error)}`);
      assert.equal(first.result.interaction.state, 'allowed-once');
      const deliveriesAfterFirst = host.respondReceipts.length;

      // A CONFLICTING second decision is a typed refusal: the interaction is already settled and the
      // new answer is stale relative to it.
      const conflicting = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'rejected', authorityToken: token,
      });
      assert.equal(conflicting.result, null, 'a conflicting replay must not succeed');
      assert.equal(conflicting.error?.code, 'APPROVAL_STALE', `expected APPROVAL_STALE, got ${JSON.stringify(conflicting.error)}`);
      assert.equal((await interactionById(ipc, taskId, interaction.interactionId)).state, 'allowed-once',
        'a refused replay must not overwrite the settled decision');

      // An IDENTICAL second decision is ALSO a typed refusal, not a success-shaped no-op.
      //
      // This replaces an assertion that pinned the opposite, and the change is worth recording: the
      // original contract claimed an identical replay was "idempotent by design" and returned
      // `receipt: 'duplicate'` with `delivered: false` — but on the SAME success-shaped reply as a
      // first decision that worked. A caller could therefore not distinguish "your approval was
      // applied and delivered" from "you already answered", and an operator's second click reported
      // as a success is exactly the wrong signal on a safety surface. `ERROR_CODES.APPROVAL_REPLAYED`
      // existed for this path with no callers. A replay is now refused with that code, and the detail
      // says whether the FIRST decision reached the Host, since that is the fact an operator needs.
      const identical = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(identical.result, null, 'a replay must not be returned as a success');
      assert.equal(identical.error?.code, 'APPROVAL_REPLAYED',
        `expected APPROVAL_REPLAYED, got ${JSON.stringify(identical.error)}`);
      // The error is cast once at the wire boundary and then read, because a cast over an
      // already-erroring expression still checks the expression inside it.
      const replayError = /** @type {{code?: string, details?: {deliveredToHost?: string, hint?: string}}|null} */ (identical.error);
      const replayDetails = replayError?.details;
      // The POSITIVE control for the hint: for the one state where the answer really was taken, the hint
      // must still say it was delivered. Without this, a fix that replaced every hint with "unproven"
      // would pass the negative cases while telling an operator nothing.
      //
      // The assertion deliberately checks the CLAIM and not the exact sentence. An earlier form pinned
      // the full phrasing, and the negative control then fired on a copy difference instead of on the
      // defect — a check that fires for the wrong reason is a check that hides the right one. The
      // claim being asserted is "this hint says the Host has the answer", which is true of any correct
      // wording and false of every unproven one.
      assert.match(String(replayDetails?.hint ?? ''), /delivered/i,
        `an accepted delivery must still be described as delivered, got: ${String(replayDetails?.hint)}`);
      assert.ok(!/MAY have been applied/.test(String(replayDetails?.hint ?? '')),
        'and it must not hedge as unproven when the Host accepted the answer');
      assert.equal(replayDetails?.deliveredToHost, 'accepted',
        'the refusal must say the first decision DID reach the Host, so an operator knows nothing is left to deliver');
      assert.match(String(replayDetails?.hint ?? ''), /already delivered/i,
        'the refusal must state what the operator should do about it');

      // Neither the conflicting nor the identical repeat put another receipt on the wire.
      assert.equal(deliveriesAfterFirst, 1,
        `the first, accepted answer must be delivered exactly once, got ${JSON.stringify(host.respondReceipts)}`);
      assert.equal(host.respondReceipts[0].rpcId, interaction.hostRpcId,
        "the delivered answer must echo the interaction's own rpcId");
      assert.equal(host.respondReceipts.length, deliveriesAfterFirst,
        'neither a conflicting nor an identical replay may send a second receipt');
    } finally {
      await teardown();
    }
  },

  'FR-APPR-2 stale: an interaction past its expires_at is terminal (expired), never allowed-once': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-stale');
    try {
      const taskId = await newTask(ipc, 'stale');
      const session = await newSession(ipc, taskId, 'stale-session');
      await muxReady(ipc);

      const expiry = Date.now() - 60_000;
      const stale = emitApprovalWithExpiry(host, session.hostSessionId, expiry);
      await waitFor(async () => (await interactions(ipc, taskId)).some((row) => row.nativeId === stale.approvalId),
        { timeoutMs: 5000, what: 'the already-expired approval to be recorded' });
      const row = (await interactions(ipc, taskId)).find((candidate) => candidate.nativeId === stale.approvalId);
      assert.equal(row.expiresAt, expiry, 'the expiry must survive ingestion verbatim');

      const token = await authorityToken(daemon);
      const decided = await decide(ipc, {
        taskId, interactionId: row.interactionId, decision: 'allowed-once', authorityToken: token,
      });

      // Stale is reported as a typed OUTCOME rather than a thrown typed error: the caller gets
      // `receipt: 'expired'` and `delivered: false`. That is a weaker shape than FR-APPR-2's
      // "refused with a typed error" asks for, and it is asserted as it exists so the deviation is
      // visible instead of assumed away.
      assert.equal(decided.error, null, `a stale decision is reported, not thrown: ${JSON.stringify(decided.error)}`);
      assert.equal(decided.result.receipt, 'expired', `expected receipt expired, got ${decided.result.receipt}`);
      assert.equal(decided.result.delivered, false, 'a stale answer must report itself as not delivered');
      assert.equal(decided.result.interaction.state, 'expired', 'the interaction must become terminal-expired');
      assert.notEqual(decided.result.interaction.state, 'allowed-once',
        'an interaction past its expiry must never become an applied approval');

      // Terminal: a second, differently-shaped attempt must not revive it either.
      const repeated = await decide(ipc, {
        taskId, interactionId: row.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(repeated.error, null, 'a decided interaction is reported, not thrown at');
      assert.equal(repeated.result.interaction.state, 'expired', 'an expired interaction stays expired');

      await assertNoRespondDelivery(host, 'a stale answer');
    } finally {
      await teardown();
    }
  },

  'FR-APPR-1/FR-APPR-2 timeout and reconnect never auto-approve, and nothing is delivered for an undecided interaction': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-no-auto');
    try {
      const taskId = await newTask(ipc, 'no-auto');
      const session = await newSession(ipc, taskId, 'no-auto-session');
      await muxReady(ipc);

      // Two approvals arrive and NOTHING decides either one.
      const first = host.emitApprovalRequested(session.hostSessionId);
      const second = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(first.rpcId);
      host.markApprovalPending(second.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 2,
        { timeoutMs: 5000, what: 'both undecided approvals to be recorded' });

      // The carrier is torn down and comes back. A lost connection says nothing about intent, so a
      // reconnect must not turn into an answer for either interaction.
      host.dropDownlinks();
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection !== 'ready',
        { timeoutMs: 5000, what: 'the downlink to be observed as lost' });
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
        { timeoutMs: 15000, what: 'the downlink to be re-established' });

      const afterReconnect = await interactions(ipc, taskId);
      for (const row of afterReconnect) {
        assert.equal(row.state, 'pending', `an undecided interaction must stay pending across a reconnect, saw ${row.state}`);
      }

      // Zero deliveries for the interaction nothing decided. This is the requirement's own oracle.
      await assertNoRespondDelivery(host, 'an interaction nothing decided');

      // The requirement's second half — "zero for the one whose receipt was lost" — is tested here
      // rather than documented as untestable. It READ as untestable because the fixture's
      // `/api/respond` branch returned before its fault-injection block, so `dropResponseFor` could
      // not reach that path; that was a gap in OUR fixture, not a fact about the requirement, and it
      // is fixed. A lost receipt now means exactly what it should: the Host APPLIED the answer and
      // then the socket died before the client could learn the outcome.
      const lost = host.emitApprovalRequested(session.hostSessionId);
      host.markApprovalPending(lost.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).some((row) => row.hostRpcId === lost.rpcId),
        { timeoutMs: 5000, what: 'the lost-receipt approval to be recorded' });
      const lostRow = (await interactions(ipc, taskId)).find((row) => row.hostRpcId === lost.rpcId);
      const token = await authorityToken(daemon);
      host.dropResponseFor('respond');
      const { result: decided } = await decide(ipc, {
        taskId, interactionId: lostRow.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      host.stopDropping('respond');
      assert.ok(decided, 'the decision itself must succeed even when its receipt is lost');

      // The Host has the answer — so this is NOT a "nothing was delivered" case — and the bridge must
      // report the outcome as unproven rather than as either success or failure.
      assert.equal(host.respondReceipts.filter((row) => row.rpcId === lost.rpcId).length, 1,
        'the answer reached the Host before the receipt was lost');
      assert.equal(decided.delivered, false, 'a lost receipt is not a delivery the bridge can call done');
      assert.equal(decided.receipt, 'uncertain',
        `a lost receipt must be reported as unproven, got ${JSON.stringify(decided.receipt)}`);
      const afterLoss = (await interactions(ipc, taskId)).find((row) => row.hostRpcId === lost.rpcId);
      assert.equal(afterLoss.state, 'allowed-once', 'the operator decision stands');
      assert.equal(afterLoss.delivery?.state, 'uncertain',
        `the durable record must keep the unproven outcome, got ${JSON.stringify(afterLoss.delivery)}`);

      // And the second half itself: NOTHING may be delivered again. The count stays at exactly one,
      // across a reconnect, because an unproven outcome is never retried automatically.
      // A reconnect, using the same downlink teardown the earlier half of this case uses, so the
      // "nothing is re-delivered" claim is made across exactly the event that would trigger a naive
      // retry. `NO_DELIVERY_WINDOW_MS` elapses inside the helper before the count is read.
      host.dropDownlinks();
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection !== 'ready',
        { timeoutMs: 5000, what: 'the downlink to be observed as lost' });
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
        { timeoutMs: 15000, what: 'the downlink to be re-established' });
      await assertNoRespondDelivery(host, 'the interaction whose receipt was lost', { expectOnly: lost.rpcId });
    } finally {
      await teardown();
    }
  },

  'FR-APPR-2 control: a correct answer is accepted, carried to the Host, and durably recorded': async () => {
    const { host, ipc, daemon, teardown } = await rig('appr-control');
    try {
      const taskId = await newTask(ipc, 'control');
      const session = await newSession(ipc, taskId, 'control-session');
      const approval = host.emitApprovalRequested(session.hostSessionId);
      // Pending in the fixture too, so that IF the bridge carried the answer the Host would accept
      // it and the log would show `accepted:true` rather than `not-pending`.
      host.markApprovalPending(approval.rpcId);
      await waitFor(async () => (await interactions(ipc, taskId)).length >= 1,
        { timeoutMs: 5000, what: 'the approval to be recorded' });
      const interaction = (await interactions(ipc, taskId))[0];
      const token = await authorityToken(daemon);

      // The control the refusals above are measured against: the RIGHT answer, for the RIGHT
      // interaction, in the RIGHT task, with the RIGHT token, is accepted and durably recorded.
      const applied = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'allowed-once', authorityToken: token,
      });
      assert.equal(applied.error, null, `a correct answer must be accepted: ${JSON.stringify(applied.error)}`);
      assert.equal(applied.result.interaction.interactionId, interaction.interactionId);
      assert.equal(applied.result.interaction.state, 'allowed-once',
        'the accepted decision must be visible on the interaction');
      assert.equal(applied.result.delivered, true,
        `the correct answer must be carried to the Host, got ${JSON.stringify(applied.result)}`);
      assert.equal(applied.result.receipt, 'accepted', 'the Host held it pending, so it must accept');

      // Durability: the decision is readable through a later, independent read, not only in the reply.
      assert.equal((await interactionById(ipc, taskId, interaction.interactionId)).state, 'allowed-once');

      // The control also proves the interaction was armed for exactly one answer: a second,
      // different answer for it is refused.
      const conflicting = await decide(ipc, {
        taskId, interactionId: interaction.interactionId, decision: 'rejected', authorityToken: token,
      });
      assert.equal(conflicting.error?.code, 'APPROVAL_STALE',
        `a correct-but-late answer must still be refused, got ${JSON.stringify(conflicting.error)}`);

      // The delivery itself, which is the half of FR-APPR-2 this file previously could not test: the
      // Host's own log must show exactly one answer, for this rpc id, carrying the answer's payload.
      assert.equal(host.respondReceipts.length, 1,
        `the accepted answer must be delivered exactly once, got ${JSON.stringify(host.respondReceipts)}`);
      const receipt = host.respondReceipts[0];
      assert.equal(receipt.rpcId, interaction.hostRpcId, "the delivery must echo the interaction's rpcId");
      assert.equal(receipt.outcome, 'accepted', 'the Host held it pending, so it must accept');
      const delivered = receipt.result?.value;
      assert.equal(delivered?.outcome, 'allowed-once', 'the delivery must carry the decision the operator made');
      assert.equal(delivered?.approvalId, approval.approvalId,
        'the delivery must name the approval it answers');
      // The session id in the answer must be the HOST's, not the bridge's own internal id. Measured:
      // the internal id is `sess_…` and the Host's is `session-…`, so a bridge that echoed its own id
      // would be answering about a session the Host has never heard of.
      assert.equal(delivered?.sessionId, session.hostSessionId,
        'the delivery must be addressed to the Host-issued session id, not the bridge-internal one');
      assert.notEqual(delivered?.sessionId, session.sessionId,
        'the bridge-internal session id must never be sent to the Host');

    } finally {
      await teardown();
    }
  },
};
