/**
 * Fake-Host layer: FR-EXEC-3 — every current-turn terminal reason is explicit and distinguishable.
 *
 * Why this file exists: `docs/requirements.md` claims that a completed turn, a failed turn, a
 * cancelled turn, an unprovable outcome and a Host business refusal can be told apart, and
 * `docs/test-matrix.md` records that no table-driven test walks that whole set. This is the table.
 * Each row drives ONE termination path against the real fake Host — real HTTP, a real WebSocket,
 * a real daemon process — and asserts the terminal reason the bridge records for it, that the
 * reason is distinct from every other row's reason, and that the operation/turn facts underneath
 * it agree.
 *
 * Scope: this fixture is NOT the DSH product. A passing run here is evidence about our client
 * against our own fixture, never evidence about the official Host (that layer is test/isolated-host).
 *
 * WHERE EACH ASSERTED FACT COMES FROM (nothing here is invented by the test):
 *   - `reason` — the terminal classification the bridge itself records for the path: the turn
 *     row's `state` (`Store.closeTurn` in `src/lib/store.ts`) for a turn, the operation row's
 *     `state` (`Daemon#dispatch`) for a path with no turn. `lastTerminalReason` resolves
 *     `turns.reason ?? turns.state`, so the turn state IS the bridge's own terminal-reason
 *     vocabulary rather than a test-side construct.
 *   - the surfaced strings — `session.state.execution.lastTerminalReason` and `session.wait`'s
 *     closed-set `reason`, pinned as the contract states them, so any change in what the bridge
 *     reports is visible in the row that would be affected.
 *   - the authoritative event the reason was derived from, read back out of the bridge's own event
 *     log, so each row proves the derivation instead of restating it.
 *   - the durable turn/operation rows, read over a SEPARATE store connection, which is the
 *     convention `test/unit/core.test.mjs` documents ("proves the row was committed, not just
 *     staged in this process's memory"), because only the store holds a turn's terminal state.
 *
 * FINDING, recorded here rather than hidden (the full report ships with this file): the two
 * IP-facing surfaces do NOT carry which terminal state a turn reached. For all three turn paths
 * the surfaced reason is the same sentence — `authoritative turn/end at seq N` — and
 * `session.wait` answers `turn-ended` for all three, so a caller reading `session.state` cannot
 * tell a failed turn from a completed one. The classification survives only in the `turns.state`
 * column and in the raw `turn/end` payload the event log serves. These rows pin what each surface
 * does report (that is how the collapse is visible in one place) and assert the classification
 * everywhere it does exist. The requirement's own vocabulary also spells the refusal path
 * `host-rejected`, while the bridge records the operation state `refused`; that is the alias
 * `REQUIREMENT_SPELLING` below.
 */

import { assert, ipcClient, must, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';
import { OP_STATES } from '../../dist/lib/store.js';

/**
 * The turn states the durable store can hold. Declared here rather than imported because
 * `TurnState` is a type: the runtime spelling lives in the `turns` DDL and the exported type in
 * `src/lib/store.ts` (`'open' | 'completed' | 'failed' | 'cancelled' | 'uncertain'`).
 */
const DOCUMENTED_TURN_STATES = Object.freeze(['open', 'completed', 'failed', 'cancelled', 'uncertain']);

/** The operation states, taken from the store's own exported closed set. @type {string[]} */
const DOCUMENTED_OPERATION_STATES = [...OP_STATES];

/**
 * The bounded-wait reasons, from `docs/architecture.md` §9 and the `session.wait` tool text in
 * `src/lib/mcp-tools.ts`: `turn-ended`, `timeout`, `no-turn-observed`, `disconnected`.
 */
const DOCUMENTED_WAIT_REASONS = Object.freeze(['turn-ended', 'timeout', 'no-turn-observed', 'disconnected']);

/** The paths FR-EXEC-3 names, in the requirement's own words. */
const REQUIREMENT_PATHS = Object.freeze(['completed', 'failed', 'cancelled', 'uncertain', 'host-rejected']);

/**
 * The one spelling difference between the requirement's vocabulary and the code's: FR-EXEC-3 names
 * the path "host-rejected", and the bridge records the operation state `refused` for it. Reported
 * as a naming gap, not treated as a behaviour difference — the row asserts the semantics either way.
 * @type {Record<string, string>}
 */
const REQUIREMENT_SPELLING = { refused: 'host-rejected' };

/**
 * What one row observed, kept in one shape so the closed-set check can compare rows.
 * @typedef {object} RowObservation
 * @property {string} reason          the terminal classification the bridge recorded for the path
 * @property {string} reasonSet       `'turn'` or `'operation'` — which documented set it belongs to
 * @property {string} surfacedReason  `session.state.execution.lastTerminalReason`, or `''` if none
 * @property {string} waitReason      `session.wait`'s closed-set reason for this session
 * @property {string} terminalOutcome the authoritative `turn/end` outcome, or `''` if the path has none
 * @property {string} operationState  the operation row's state, or `''` if the path has no operation
 */

/**
 * What each row observed, keyed by path. The closed-set check at the end of this file reads it, and
 * asserts it is COMPLETE: a row that failed to record is a hole in that check, never a pass.
 * @type {Map<string, RowObservation>}
 */
const RECORDED = new Map();

/**
 * Bring up a fixture host plus a daemon against a scratch state directory, plus a second store
 * connection the test reads durable rows through. The host is up before the daemon so the daemon's
 * mux downlink connects to a real endpoint.
 * @param {string} label
 * @param {boolean} autoTurn whether the fixture answers a prompt with a whole turn
 */
async function rig(label, autoTurn) {
  const host = await new FakeHost().start();
  host.autoTurn = autoTurn;
  const scratch = scratchDir(`terminal-reason-${label}`);
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: `${scratch.dir}/state` });
  const ipc = await ipcClient(daemon.socketPath);
  const { Store } = await import('../../dist/lib/store.js');
  const observer = new Store({ stateDir: daemon.stateDir });
  const teardown = async () => {
    observer.close();
    ipc.close();
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready', {
    timeoutMs: 10000, what: 'the daemon mux downlink to reach ready',
  });
  // `ctx` is deliberately untyped at this boundary: it carries the fixture host and an IPC client
  // whose replies are the peer's JSON frames, which the assertions below are the oracle for.
  return { host, daemon, ipc, observer, teardown };
}

/**
 * Start a task and a session, the way the other fake-Host suites do.
 * @param {object} ipc
 * @param {string} clientKey
 */
async function newSession(ipc, clientKey) {
  const task = await ipc.request({ op: 'task.ensure', clientKey });
  const session = await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `s-${clientKey}` });
  assert.ok(session.session, `session start failed: ${JSON.stringify(session)}`);
  return { taskId: task.task.taskId, sessionId: session.session.sessionId, hostSessionId: session.session.hostSessionId };
}

/**
 * The last `turn/end` the bridge stored for a session, as the bridge's own event log serves it.
 * @param {object} ctx
 * @param {string} taskId
 * @param {string} sessionId
 */
async function storedTerminalEvent(ctx, taskId, sessionId) {
  const page = await ctx.ipc.request({ op: 'session.events', taskId, sessionId, limit: 50 });
  const terminal = page.events.filter((event) => event.payload?.nativeType === 'turn/end').pop();
  assert.ok(terminal, `the bridge stored no turn/end event: ${JSON.stringify(page.events)}`);
  return terminal;
}

/**
 * Assert the terminal facts a turn-based path must report, and return them as this row's
 * observation. The wait is on a NEUTRAL observable condition (a turn row that is no longer open),
 * so a wrong classification fails as a plain assertion rather than as a timeout.
 * @param {object} ctx
 * @param {{taskId: string, sessionId: string}} ids
 * @param {string} expectedTerminal the outcome the Host's own terminal event carried
 * @returns {Promise<RowObservation>}
 */
async function turnFacts(ctx, ids, expectedTerminal) {
  await waitFor(() => {
    const turns = ctx.observer.listTurns(ids.sessionId);
    return turns.length === 1 && turns[0].state !== 'open';
  }, { timeoutMs: 10000, what: `the current turn to stop being open (expected terminal state: ${expectedTerminal})` });

  const turn = ctx.observer.listTurns(ids.sessionId)[0];
  assert.ok(DOCUMENTED_TURN_STATES.includes(turn.state), `turn state ${turn.state} is outside the documented set`);
  assert.equal(turn.state, expectedTerminal,
    `the terminal classification must follow the Host's own terminal outcome '${expectedTerminal}'`);
  assert.ok(turn.ended_at !== null, 'a closed turn must record when it ended');

  // The authoritative event the classification was derived from, read back through the bridge.
  const terminal = await storedTerminalEvent(ctx, ids.taskId, ids.sessionId);
  assert.equal(terminal.payload.raw.outcome, expectedTerminal,
    `the stored terminal event must be the one that carried '${expectedTerminal}'`);

  const state = await ctx.ipc.request({ op: 'session.state', taskId: ids.taskId, sessionId: ids.sessionId });
  assert.equal(state.execution.state, 'idle', 'a closed turn leaves execution idle');
  assert.equal(state.execution.currentTurnId, null, 'no turn may still be reported as current');
  const surfacedReason = String(state.execution.lastTerminalReason);
  // Deliberately not anchored at the end: the rule being asserted is that the reason names the
  // authoritative terminal event it was derived from, not that it is exactly that sentence. A
  // reason that also named the terminal state (which it does not today — see FINDING above) would
  // still satisfy this, while a reason that stopped naming its evidence would not.
  assert.match(surfacedReason, /authoritative turn\/end at seq \d+/,
    'the terminal reason is only ever recorded from an authoritative terminal event');

  const waited = await ctx.ipc.request({ op: 'session.wait', taskId: ids.taskId, sessionId: ids.sessionId, timeoutMs: 500 });
  assert.ok(DOCUMENTED_WAIT_REASONS.includes(waited.reason),
    `session.wait returned '${waited.reason}', which is outside the documented closed set ${DOCUMENTED_WAIT_REASONS.join('/')}`);
  assert.equal(waited.reason, 'turn-ended');
  assert.equal(waited.terminalReason, surfacedReason, 'both surfaces must report the same terminal reason');

  return {
    reason: turn.state,
    reasonSet: 'turn',
    surfacedReason,
    waitReason: String(waited.reason),
    terminalOutcome: expectedTerminal,
    operationState: '',
  };
}

/**
 * Assert what a path with NO observed turn must report: nothing at all about execution.
 * @param {object} ctx
 * @param {{taskId: string, sessionId: string}} ids
 */
async function noTurnFacts(ctx, ids) {
  const turns = ctx.observer.listTurns(ids.sessionId);
  assert.deepEqual(turns.map((row) => row.state), [],
    'no turn may be recorded for a path where no turn was ever observed');

  const state = await ctx.ipc.request({ op: 'session.state', taskId: ids.taskId, sessionId: ids.sessionId });
  assert.equal(state.execution.state, 'idle');
  assert.equal(state.execution.currentTurnId, null);
  assert.equal(state.execution.lastTerminalReason, null,
    'no terminal reason may be reported for a turn that was never observed');

  const waited = await ctx.ipc.request({ op: 'session.wait', taskId: ids.taskId, sessionId: ids.sessionId, timeoutMs: 500 });
  assert.ok(DOCUMENTED_WAIT_REASONS.includes(waited.reason),
    `session.wait returned '${waited.reason}', which is outside the documented closed set ${DOCUMENTED_WAIT_REASONS.join('/')}`);
  assert.equal(waited.reason, 'no-turn-observed');
  assert.equal(waited.terminalReason, null);
  return { waitReason: String(waited.reason) };
}

/** Wait until the daemon's own current turn is reported as open. */
async function waitRunning(ctx, ids) {
  await waitFor(async () => (await ctx.ipc.request({ op: 'session.state', taskId: ids.taskId, sessionId: ids.sessionId })).execution.state === 'running',
    { timeoutMs: 5000, what: 'the turn/start event to open the current turn' });
}

/**
 * The table. Every row drives a REAL termination path and asserts the reason the bridge records
 * for it. `autoTurn` is per row: the fixture's scripted whole-turn answer is used for the normal
 * completion, and turned off wherever the row must control the terminal event itself.
 */
const ROWS = [
  {
    path: 'completed',
    reason: 'completed',
    reasonSet: 'turn',
    autoTurn: true,
    // A turn that ends normally: the fixture answers a real `session.prompt` with the
    // turn/start + `turn/end outcome=completed` pair a well-behaved Host emits, over the wire.
    drive: async (ctx) => {
      const ids = await newSession(ctx.ipc, 'tr-completed');
      const prompt = await ctx.ipc.request({
        op: 'session.prompt', taskId: ids.taskId, sessionId: ids.sessionId, clientKey: 'c-1', text: 'terminal reason: completed',
      });
      assert.equal(prompt.operation.state, 'succeeded', `the prompt itself must be acknowledged: ${JSON.stringify(prompt)}`);
      return ids;
    },
    check: async (ctx, ids) => turnFacts(ctx, ids, 'completed'),
  },
  {
    path: 'failed',
    reason: 'failed',
    reasonSet: 'turn',
    // A turn whose terminal event carries a failure: the Host itself says the turn failed.
    autoTurn: false,
    drive: async (ctx) => {
      const ids = await newSession(ctx.ipc, 'tr-failed');
      const start = ctx.host.emitTurnStart(ids.hostSessionId);
      await waitRunning(ctx, ids);
      ctx.host.emitTurnEnd(ids.hostSessionId, start.turn, 'failed');
      return ids;
    },
    check: async (ctx, ids) => turnFacts(ctx, ids, 'failed'),
  },
  {
    path: 'cancelled',
    reason: 'cancelled',
    reasonSet: 'turn',
    // A turn ended by `session.cancel`: the cancel travels over real HTTP, and the terminal event
    // with outcome `cancelled` is the Host's own answer to it, emitted on the real downlink.
    autoTurn: false,
    drive: async (ctx) => {
      const ids = await newSession(ctx.ipc, 'tr-cancelled');
      ctx.host.emitTurnStart(ids.hostSessionId);
      await waitRunning(ctx, ids);
      // The fixture answers a cancel with the turn's terminal event only while autoTurn is on;
      // it is switched on here so the cancel is the thing that ends the turn.
      ctx.host.autoTurn = true;
      const cancelled = await ctx.ipc.request({ op: 'session.cancel', taskId: ids.taskId, sessionId: ids.sessionId, clientKey: 'cancel-1' });
      assert.equal(cancelled.operation.state, 'succeeded', `the cancel must be acknowledged: ${JSON.stringify(cancelled)}`);
      assert.equal(cancelled.target.scope, 'local-open-turn', 'the cancel must name the turn it targets');
      assert.equal(cancelled.processEvidence.observed, false,
        'a turn-level ack is not process evidence, and this row must not pretend otherwise');
      return ids;
    },
    check: async (ctx, ids) => turnFacts(ctx, ids, 'cancelled'),
  },
  {
    path: 'uncertain',
    reason: 'uncertain',
    reasonSet: 'operation',
    // An outcome the bridge cannot prove: the Host applies the prompt and the reply is destroyed.
    // `autoTurn` is off so the Host emits no turn event either — nothing about a turn is provable.
    autoTurn: false,
    drive: async (ctx) => {
      const ids = await newSession(ctx.ipc, 'tr-uncertain');
      ctx.host.dropResponseFor('session.prompt');
      const prompt = await ctx.ipc.request({
        op: 'session.prompt', taskId: ids.taskId, sessionId: ids.sessionId, clientKey: 'u-1', text: 'terminal reason: uncertain',
      });
      return { ...ids, operationId: prompt.operation.operationId };
    },
    check: async (ctx, ids) => {
      const operation = must((await ctx.ipc.request({ op: 'ops.get', operationId: ids.operationId })).operation, 'the operation row');
      assert.equal(operation.state, 'uncertain', `an unprovable outcome must be recorded as uncertain: ${JSON.stringify(operation)}`);
      assert.match(String(operation.uncertainReason), /after-send/,
        'the reason must say the outcome is unproven AND that the request had already been sent');
      // The dangerous direction, asserted directly: an unprovable outcome is never success or failure.
      assert.notEqual(operation.state, 'succeeded');
      assert.notEqual(operation.state, 'failed');

      // The Host really did apply it (its event reached the log), so "no turn observed" below is
      // about what the bridge could PROVE, not about a request that never arrived.
      await waitFor(async () => {
        const page = await ctx.ipc.request({ op: 'session.events', taskId: ids.taskId, sessionId: ids.sessionId, limit: 50 });
        return page.events.some((event) => event.payload?.nativeType === 'user/message');
      }, { timeoutMs: 10000, what: 'the Host event for the applied prompt to be stored' });
      assert.equal(ctx.host.requestsFor('session.prompt').length, 1, 'an unprovable outcome must never be re-sent');

      const facts = await noTurnFacts(ctx, ids);
      return {
        reason: operation.state,
        reasonSet: 'operation',
        surfacedReason: '',
        waitReason: facts.waitReason,
        terminalOutcome: '',
        operationState: operation.state,
      };
    },
  },
  {
    path: 'host-rejected',
    reason: 'refused',
    reasonSet: 'operation',
    // The Host itself refuses the operation, with its own business code.
    autoTurn: false,
    drive: async (ctx) => {
      const ids = await newSession(ctx.ipc, 'tr-rejected');
      ctx.host.rejectWith('session.prompt', { code: 'session-conflict', message: 'fixture: session already owned by another turn' });
      const refused = await ctx.ipc.request({
        op: 'session.prompt', taskId: ids.taskId, sessionId: ids.sessionId, clientKey: 'r-1', text: 'terminal reason: host-rejected',
      });
      return { ...ids, operationId: refused.operation.operationId };
    },
    check: async (ctx, ids) => {
      const operation = must((await ctx.ipc.request({ op: 'ops.get', operationId: ids.operationId })).operation, 'the operation row');
      assert.equal(operation.state, 'refused', `a Host refusal is a definite outcome: ${JSON.stringify(operation)}`);
      // The Host's own business code survives: flattening it to the carrier's generic code would
      // erase which refusal actually happened.
      assert.equal(operation.errorCode, 'session-conflict', 'the Host\'s own business code must be preserved');
      assert.notEqual(operation.errorCode, 'HOST_REFUSED', 'the generic carrier code is not the refusal');
      assert.match(String(operation.errorMessage), /already owned by another turn/, 'the Host\'s own message must be preserved');
      assert.equal(operation.uncertainReason, null, 'a refusal is definite and must not be reported as unproven');

      // A refusal ends nothing: no turn was ever observed, so nothing about execution is claimed.
      const facts = await noTurnFacts(ctx, ids);
      return {
        reason: operation.state,
        reasonSet: 'operation',
        surfacedReason: '',
        waitReason: facts.waitReason,
        terminalOutcome: '',
        operationState: operation.state,
      };
    },
  },
];

/**
 * The generated case name for one row.
 *
 * Extracted into a function, and the resulting list exported as `names` below, so that the
 * requirement-to-test gate (`test/unit/matrix-gate.test.mjs`) can resolve a citation of one of these
 * cases WITHOUT re-deriving it from this template. That matters: the gate first tried to predict
 * these names from the template text and got it wrong in several ways, and the alternative — a
 * second implementation of this naming scheme living in the gate — would let the documentation and
 * the tests drift apart while both kept looking consistent.
 * @param {{ path: string, reason: string }} row one table row
 * @returns {string} the case name that row's suite is registered under
 */
const caseNameFor = (row) =>
  `FR-EXEC-3 ${row.path}: the terminal reason is '${row.reason}', with the operation and turn facts under it`;

/** One suite per row, generated from the table above. */
const rowSuites = Object.fromEntries(ROWS.map((row) => [
  caseNameFor(row),
  async () => {
    const ctx = await rig(row.path, row.autoTurn);
    try {
      const ids = await row.drive(ctx);
      const observed = await row.check(ctx, ids);
      assert.equal(observed.reason, row.reason,
        `the ${row.path} path reported '${observed.reason}' where the table declares '${row.reason}'`);
      RECORDED.set(row.path, observed);
    } finally {
      await ctx.teardown();
    }
  },
]));

export default {
  // The generated names, declared so a documentation citation resolves against an authoritative list
  // rather than against the gate's guess at how this file builds them. `$` marks it as metadata; the
  // runner skips such keys instead of trying to run them.
  $names: ROWS.map(caseNameFor),
  ...rowSuites,

  'FR-EXEC-3 the set of terminal reasons is closed, and no two paths share a reason': async () => {
    // A row that did not record is a HOLE in this check, not a pass: the completeness assertion is
    // what stops "the set is closed" from being vacuously true after a row failed or never ran.
    assert.deepEqual(
      [...RECORDED.keys()].sort(),
      ROWS.map((row) => row.path).sort(),
      `every row must record its reason before the set can be checked (recorded: ${[...RECORDED.keys()].join(', ') || 'none'})`,
    );

    const observations = ROWS.map((row) => must(RECORDED.get(row.path), `the recorded observation for the ${row.path} path`));

    // Distinctness: a terminal reason that two paths share is not a distinguishable reason.
    const reasons = observations.map((observation) => observation.reason);
    const shared = reasons.filter((reason, index) => reasons.indexOf(reason) !== index);
    assert.deepEqual(shared, [], `two termination paths reported the same terminal reason: ${shared.join(', ')}`);

    // Closure, against the documented set each reason belongs to — not against the table's own list.
    for (const [index, row] of ROWS.entries()) {
      const documented = row.reasonSet === 'turn' ? DOCUMENTED_TURN_STATES : DOCUMENTED_OPERATION_STATES;
      const reason = observations[index].reason;
      assert.ok(documented.includes(reason),
        `the ${row.path} path produced '${reason}', which is outside the documented ${row.reasonSet} set (${documented.join('/')})`);
      assert.ok(DOCUMENTED_WAIT_REASONS.includes(observations[index].waitReason),
        `the ${row.path} path's wait reported '${observations[index].waitReason}', outside the documented wait set`);
    }

    // Coverage: the table walks exactly the paths FR-EXEC-3 names, in the requirement's vocabulary
    // (`host-rejected` is spelled `refused` by the bridge; see REQUIREMENT_SPELLING).
    const named = reasons.map((reason) => REQUIREMENT_SPELLING[reason] ?? reason);
    assert.deepEqual([...named].sort(), [...REQUIREMENT_PATHS].sort(),
      'the table must walk every terminal path the requirement names, and no path it does not name');
  },
};
