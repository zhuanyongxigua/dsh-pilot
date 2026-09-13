/**
 * Isolated official-DSH-Host layer: turns.
 *
 * Why these tests exist: the fake-Host layer proves our client agrees with a Host we wrote. This
 * layer proves it agrees with the REAL Host — its real agent loop, its real event stream, its real
 * turn boundaries. The model route is a deterministic mock on loopback, so a turn ends because DSH
 * actually ran, not because we fabricated an ending.
 *
 * The mock provider never hardcodes an outcome: it emits a legal Anthropic SSE cycle built from a
 * script the test sets, and each test asserts that ITS OWN text or tool effect arrived. A test that
 * could pass with the mock returning nothing would be worthless, so every assertion below names
 * something the mock produced.
 *
 * Opt-in: `--isolated`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, ipcClient, skip, startDaemon, waitFor } from '../helpers.mjs';
import { OPERATOR_SANDBOX_MODE } from '../fixtures/mock-provider.mjs';
import { MOCK_API_KEY_ENV, recordSandboxCapability, resolveDshBin, sandboxCapability, startMockedDshHost } from './rig.mjs';

/** @param {any} context */
function requireIsolated(context) {
  if (!context?.isolated) skip('opt-in: run with --isolated (this layer starts a real DSH Host)');
  if (!resolveDshBin()) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
  // Guard against the reviewed defect coming back: no test in this layer may request a wider
  // sandbox policy than the operator gets. The rig no longer accepts such an option at all, so this
  // assertion is the second line of defence and fails loudly rather than silently relaxing.
  if (process.env.DSH_PILOT_ALLOW_UNCONFINED_TOOLS) {
    throw new Error('refusing to run: DSH_PILOT_ALLOW_UNCONFINED_TOOLS would widen the sandbox boundary for a test');
  }
}

/**
 * Start the whole rig: a mocked real Host plus a bridge daemon pointed at it.
 * @param {string} label
 */
async function rig(label) {
  const host = await startMockedDshHost({ label });
  const daemon = await startDaemon({
    hostBase: host.hostBase,
    stateDir: join(host.scratch.dir, 'state'),
    // The NAME the settings reference, with a value that is obviously not a credential. The Host
    // resolves its own route; this is supplied so a daemon that resolves the same name also works.
    extraEnv: { [MOCK_API_KEY_ENV]: 'mock-value-not-a-real-credential' },
  });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 20_000, what: 'the bridge to attach to the real Host downlinks' });
  let seq = 0;
  const key = (prefix) => `${prefix}-${Date.now()}-${seq++}`;
  /**
   * Start a task and a session, returning the ids a test needs.
   * The workspace is inside the test scratch dir, so a tool effect can be verified on disk without
   * ever writing into the operator's tree.
   */
  const openSession = async (options = {}) => {
    const task = await ipc.request({ op: 'task.ensure', clientKey: key('task') });
    const workspace = join(host.scratch.dir, options.workspace ?? 'workspace');
    // Created here rather than left to the Host: a session's cwd must be an existing directory, which is
    // both what the bridge now enforces (`security/workspace-cwd`) and what a real caller does. Relying on
    // the Host to create it would have made these cases depend on behaviour this project does not control.
    mkdirSync(workspace, { recursive: true });
    const started = await ipc.request({
      op: 'session.start',
      taskId: task.task.taskId,
      clientKey: key('session'),
      cwd: workspace,
    });
    assert.equal(started.operation.state, 'succeeded', `session.start failed: ${JSON.stringify(started.operation)}`);
    return { taskId: task.task.taskId, sessionId: started.session.sessionId, workspace, started };
  };
  return {
    host, daemon, ipc, key, openSession,
    teardown: async () => {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      host.cleanup();
    },
  };
}

/** Pull the concatenated assistant text out of the stored event log. */
function assistantText(events) {
  const parts = [];
  for (const event of events) {
    const raw = event.payload?.raw;
    if (raw?.type !== 'assistant/chunk') continue;
    const chunk = raw.data?.chunk;
    if (chunk?.type === 'text-delta') parts.push(chunk.textDelta ?? chunk.text ?? '');
    if (chunk?.type === 'block-end' && typeof chunk.block?.text === 'string') parts.push(`[block]${chunk.block.text}`);
  }
  return parts.join('');
}

export default {
  'a real turn runs to an authoritative end, and the model reply arrives in the event log': async (context) => {
    requireIsolated(context);
    const r = await rig('isolated-turn');
    try {
      // A distinctive marker, so a passing assertion cannot be satisfied by the mock's default.
      const marker = 'REAL-TURN-MARKER-9c41';
      r.host.mock.routeByText('Reply with the marker', { text: marker });
      const { taskId, sessionId } = await r.openSession();

      const prompt = await r.ipc.request({
        op: 'session.prompt', taskId, sessionId, clientKey: r.key('prompt'),
        text: 'Reply with the marker you were given.',
      });
      assert.equal(prompt.operation.state, 'succeeded', JSON.stringify(prompt.operation));

      const waited = await r.ipc.request({
        op: 'session.wait', taskId, sessionId, clientKey: r.key('wait'), timeoutMs: 90_000,
      });
      // The turn must end on the Host's own authoritative terminal event, named in the reason.
      assert.equal(waited.reason, 'turn-ended', JSON.stringify(waited));
      assert.match(String(waited.terminalReason), /authoritative turn\/end/);

      const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 200 });
      const kinds = events.events.map((e) => e.kind);
      for (const required of ['turn/start', 'assistant/message', 'turn/end']) {
        assert.ok(kinds.includes(required), `the real Host's stream must contain ${required}; saw ${[...new Set(kinds)].join(', ')}`);
      }
      const text = assistantText(events.events);
      assert.ok(text.includes(marker),
        `the model reply must be stored verbatim; got ${text.slice(0, 120)}; route misses=${JSON.stringify(r.host.mock.routeMisses).slice(0, 600)}`);
      // The mock really was called, with the configured model, and the credential header was present.
      assert.ok(r.host.mock.requests.length >= 1, 'the mock provider must have been called');
      assert.equal(r.host.mock.requests[0].model, 'dsh-pilot-mock-1');
      assert.equal(r.host.mock.requests[0].authorizationPresent, true, 'the authenticated client must send a credential header');
      // The route the Host used is recorded in its own stream, so no ambient provider substitution
      // can hide here.
      const header = events.events.find((e) => e.kind === 'request/header');
      assert.equal(header.payload.raw.data.header.config.provider, 'dsh-pilot-mock');
      assert.equal(header.payload.raw.data.header.config.model, 'dsh-pilot-mock-1');

      const state = await r.ipc.request({ op: 'session.state', taskId, sessionId });
      assert.equal(state.execution.state, 'idle', 'a finished turn must leave execution idle');
      assert.equal(state.cursor.completeness, 'complete');
    } finally {
      await r.teardown();
    }
  },

  'a tool call really executes, and the file it writes is the oracle': async (context) => {
    requireIsolated(context);
    // The DEFAULT posture, deliberately: `workspace-write` + `ask`, the mode a real operator runs.
    //
    // This test used to pass `danger-full-access` after observing that `workspace-write` refuses
    // every bash call on a machine with no usable sandbox backend. That was wrong, and the review
    // was right to reject it: loosening the sandbox policy because the strict policy refused is a
    // failure-becomes-permission-escalation, and it also destroys the value of the test, because a
    // tool that runs with no confinement is not the tool DSH runs for an operator.
    //
    // Nothing is escalated here. The Host runs exactly the posture the operator gets, and whether a
    // command can actually execute is reported as a measured capability by the suite's capability
    // test rather than assumed either way. If this machine's sandbox refuses the write, the
    // assertion below fails LOUDLY instead of being relaxed — and the capability test says why.
    const r = await rig('isolated-tool');
    try {
      // The posture is asserted, not assumed: if the rig ever booted anything other than the
      // operator's confinement mode, this test would be measuring a different product.
      assert.equal(r.host.sandboxMode, OPERATOR_SANDBOX_MODE,
        `this layer must run at the operator posture, got sandbox-policy mode ${r.host.sandboxMode}`);
      const token = 'TOOL-EFFECT-7f3a';
      // ONE callback for the whole conversation, keyed on whether the request already carries a
      // tool result. This is the only shape that works: the continuation call carries the SAME
      // prompt as the first call, so a text route matches both; a single-use route is consumed by
      // the first; and a fixed queue breaks under DSH's retry of a failed call. All three were
      // tried, and each failed in a different way.
      let callCount = 0;
      // `times: Infinity`, because every continuation call of this turn carries the same prompt and
      // must keep matching. A default single-use registration was consumed by the first call, which
      // is how this was discovered.
      r.host.mock.pushCallback((request) => {
        if (!request.userTexts.some((text) => text.includes('Run the echo tool'))) return null;
        callCount += 1;
        if (callCount > 1) return { text: `TOOL-DONE-${token}` };
        return {
          toolCalls: [{
            name: 'bash',
            // `description` is required by this Host's bash tool: omitting it produced a real
            // ToolArgsError, which is how the requirement was discovered.
            input: { command: `printf '%s' ${token} > tool-effect.txt`, description: 'write the effect marker' },
          }],
        };
      }, { times: Infinity });
      const { taskId, sessionId, workspace } = await r.openSession();

      await r.ipc.request({ op: 'session.prompt', taskId, sessionId, clientKey: r.key('prompt'), text: 'Run the echo tool.' });
      await r.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: r.key('wait'), timeoutMs: 90_000 });

      const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 300 });
      const kinds = [...new Set(events.events.map((e) => e.kind))];
      const call = events.events.find((e) => e.kind === 'tool/call');
      const result = events.events.find((e) => e.kind === 'tool/result');
      // MEASURE, from what actually happened. A refusal here is a property of this host's
      // confinement backend, and it is reported as exactly that — with the Host's own error text —
      // rather than being worked around by widening the policy.
      const wrote = existsSync(join(workspace, 'tool-effect.txt'));
      recordSandboxCapability({
        possible: wrote,
        evidence: wrote
          ? 'a real bash tool executed and wrote inside its workspace under the operator posture'
          : `this host's confinement refused the tool: ${JSON.stringify(result?.payload?.raw?.data ?? null).slice(0, 260)}`,
      });
      if (!wrote) {
        // The Host's own words, untruncated, so the limitation is quoted evidence rather than a
        // paraphrase. This is the confinement backend explaining itself.
        const refusalText = (result?.payload?.raw?.data?.message?.content ?? [])
          .flatMap((part) => (part?.type === 'tool-result' ? part.content ?? [] : [part]))
          .flatMap((part) => (part?.type === 'text' ? [part.text] : []))
          .join('\n');
        const refusal = refusalText || JSON.stringify(result?.payload?.raw?.data ?? null);
        process.stdout.write(`       measured limitation: ${refusal}\n`);
        assert.fail(
          'a real tool must execute for this oracle, and this host could not run one under the operator posture. '
          + `This is an environment limitation of the confinement backend, not a bridge defect. The Host said: ${refusal}. `
          + 'It is deliberately NOT worked around by relaxing the sandbox policy. '
          + 'A host with a working sandbox backend (for example the Linux CI runner) exercises this test for real.');
      }
      assert.ok(call, `the stream must contain the tool call; kinds=${kinds.join(',')}`);
      assert.equal(call.payload.raw.data.name, 'bash');
      assert.match(String(call.payload.raw.data.arguments), /TOOL-EFFECT-7f3a/);
      assert.ok(result, 'the stream must contain the tool result');
      // `(no output)` is what a bash command that succeeds silently reports. A caller must not read
      // that as a failure, so the assertion is on the ERROR channel rather than on text.
      assert.equal(result.payload.raw.data.error ?? null, null,
        `the tool must not have errored: ${JSON.stringify(result.payload.raw.data).slice(0, 300)}`);
      // The strongest oracle available: the file on disk, inside the test's own scratch workspace.
      // A Host that invented a plausible result could not create it.
      const produced = readFileSync(join(workspace, 'tool-effect.txt'), 'utf8');
      assert.equal(produced, token, `the tool's file must exist with its content, got ${JSON.stringify(produced)}`);
      // The file must hold the token AND NOTHING ELSE. Under the unconfined policy this test used to
      // run with, the agent's injected context appeared in the command's output, and the content
      // check alone silently accepted that. An exact equality is the oracle; a substring check would
      // have hidden a real contamination of the operator's workspace.
      assert.ok(!produced.includes('system-reminder') && produced.length === token.length,
        `the written file must contain only the token, got ${JSON.stringify(produced.slice(0, 200))}`);
      // And no policy escalation may appear anywhere in the run's own logs.
      assert.ok(!/danger-full-access/.test(r.host.output()),
        'the capability the test runs under must never be relaxed to full access');
      assert.ok(events.events.some((e) => e.kind === 'turn/end'), 'the turn must end after the tool ran');
      // The loop continued: at least one model call arrived AFTER the tool result.
      // The loop continued: this callback was asked more than once, and only the calls after the
      // first could have produced the completion text.
      const toolBearing = r.host.mock.requests.filter((q) => q.toolNames.length > 0);
      assert.ok(toolBearing.length >= 2,
        `the loop must call the model again after a tool result; saw ${toolBearing.length} tool-bearing calls`);
      assert.ok(assistantText(events.events).includes(`TOOL-DONE-${token}`),
        'the completion text from the follow-up call must be in the log');
      process.stdout.write(`       tool ran and wrote ${token}; model calls=${r.host.mock.requests.map((q) => `${q.toolNames.length}t`).join(',')}\n`);
    } finally {
      await r.teardown();
    }
  },

  'a confined sandbox refusal is carried through as a refusal, not as a silent success': async (context) => {
    requireIsolated(context);
    // Deliberately the DEFAULT posture (workspace-write + ask), so this test runs in the mode a
    // real operator runs. On this machine there is no usable sandbox backend, so the refusal is
    // SANDBOX_UNAVAILABLE; on a machine that has one, it would be a policy refusal instead. The
    // assertion covers both, because what matters is that a refusal never becomes a success.
    const r = await rig('isolated-sandbox-refusal');
    try {
      // The posture is the operator's, asserted rather than assumed.
      assert.equal(r.host.sandboxMode, OPERATOR_SANDBOX_MODE,
        `this test must exercise the operator posture, got sandbox-policy mode ${r.host.sandboxMode}`);
      r.host.mock.routeByText('Try to write', {
        toolCalls: [{
          name: 'bash',
          input: { command: 'printf x > sandbox-refusal.txt', description: 'attempt a write' },
        }],
      });
      r.host.mock.pushScript({ text: 'WRITE-ATTEMPT-FINISHED' });
      const { taskId, sessionId, workspace } = await r.openSession();
      await r.ipc.request({ op: 'session.prompt', taskId, sessionId, clientKey: r.key('prompt'), text: 'Try to write a file.' });
      await r.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: r.key('wait'), timeoutMs: 90_000 });

      const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 300 });
      const result = events.events.find((e) => e.kind === 'tool/result');
      assert.ok(result, 'the attempted write must produce a tool result');
      const blob = JSON.stringify(result.payload.raw.data);
      const wrote = existsSync(join(workspace, 'sandbox-refusal.txt'));
      // This observation IS the layer's capability measurement, and it is taken from a real tool
      // result rather than inferred from the environment. The tool-effect test reads it back.
      recordSandboxCapability({
        possible: wrote,
        evidence: wrote
          ? 'workspace-write permitted an in-workspace write, so real tool effects are verifiable here'
          : `workspace-write refused an in-workspace write: ${blob.slice(0, 260)}`,
      });
      if (wrote) {
        // A usable backend that permits this write is fine — but then the result must NOT claim a
        // refusal, and the file must hold what the command wrote.
        assert.equal(readFileSync(join(workspace, 'sandbox-refusal.txt'), 'utf8'), 'x');
        assert.equal(result.payload.raw.data.error ?? null, null, `a permitted write must not be reported as an error: ${blob.slice(0, 300)}`);
        process.stdout.write('       workspace-write was permitted on this host; refusal path not exercised\n');
      } else {
        assert.match(blob, /sandbox|denied|refus|not permitted|SANDBOX_UNAVAILABLE/i,
          `a refused write must be reported as a refusal, got ${blob.slice(0, 300)}`);
        process.stdout.write(`       confined refusal carried through: ${blob.slice(0, 220)}\n`);
      }
      assert.ok(events.events.some((e) => e.kind === 'turn/end'), 'the turn must still terminate');
      // Whichever way it went, the bridge must not have manufactured a completion for a command
      // that never ran.
      if (!wrote) {
        assert.notEqual(result.payload.raw.data.error ?? null, null, 'a refused command must carry an error');
      }
    } finally {
      await r.teardown();
    }
  },

  'a provider failure does not become a completed turn': async (context) => {
    requireIsolated(context);
    const r = await rig('isolated-provider-fail');
    try {
      const { taskId, sessionId } = await r.openSession();
      // The route fails BEFORE any stream is written, so no turn can legitimately complete.
      // Only a TOOL-BEARING call fails: that is the turn. A blanket failure can be absorbed by
      // DSH's separate title-generation call, which then succeeds and records an assistant message
      // in a session whose real turn never ran — a phantom success this filter exists to prevent.
      r.host.mock.failNextRequest({ status: 500, when: (body) => Array.isArray(body?.tools) && body.tools.length > 0 });
      const prompt = await r.ipc.request({
        op: 'session.prompt', taskId, sessionId, clientKey: r.key('prompt'), text: 'This one will fail upstream.',
      });
      // The prompt itself was accepted by the Host (it is queued), so the bridge reporting
      // "succeeded" for the SEND is correct; what must not happen is a completed TURN.
      assert.equal(prompt.operation.state, 'succeeded', JSON.stringify(prompt.operation));

      // Wait for the turn to reach a terminal state, or for the wait to time out. Either way the
      // assertion below is about the RECORDED outcome, not about how long we waited.
      let waited = null;
      try {
        waited = await r.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: r.key('wait'), timeoutMs: 60_000 });
      } catch (error) {
        waited = { timedOut: true, error: error instanceof Error ? error.message : String(error) };
      }
      const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 300 });
      const kinds = [...new Set(events.events.map((e) => e.kind))];
      const ends = events.events.filter((e) => e.kind === 'turn/end');
      const reasons = ends.map((e) => JSON.stringify(e.payload.raw.data.reason));
      // What the bridge must guarantee is narrower than "the turn reports failure", because how the
      // real Host terminates a turn whose model call failed is the Host's decision. The guarantees
      // are: no tool ran, and no non-empty model text appeared. Both would be phantom success.
      assert.equal(events.events.some((e) => e.kind === 'tool/call'), false,
        'a failed model call must not produce a tool call');
      assert.equal(assistantText(events.events).trim(), '',
        `a failed model call must not produce model text; got ${JSON.stringify(assistantText(events.events).slice(0, 160))}`);
      // The mock really was asked and really did fail: this is what makes the assertions above
      // meaningful rather than vacuous.
      const failedCalls = r.host.mock.requests.filter((request) => request.toolNames.length > 0);
      assert.ok(failedCalls.length >= 1, 'the failure must have been attempted on a tool-bearing call');
      process.stdout.write(`       provider-failure: toolBearingCalls=${failedCalls.length} turnEnds=${ends.length} reasons=${reasons.join(', ') || 'none'} kinds=${kinds.join(',')}\n`);
      process.stdout.write(`       provider-failure wait=${JSON.stringify(waited).slice(0, 140)}\n`);
    } finally {
      await r.teardown();
    }
  },

  'two sessions on one real Host stay isolated, and each ends on its own turn': async (context) => {
    requireIsolated(context);
    const r = await rig('isolated-isolation');
    try {
      const markerA = 'SESSION-A-MARKER-11aa';
      const markerB = 'SESSION-B-MARKER-22bb';
      const workspaceA = join(r.host.scratch.dir, 'ws-a');
      const workspaceB = join(r.host.scratch.dir, 'ws-b');
      // Real directories, because a session's cwd must be one: the real Host accepted these paths without
      // them existing, and this bridge no longer does (see docs/conflicts.md C-10). The test's own oracle
      // is two sessions staying isolated on a real Host, so the workspaces are made real rather than the
      // production rule being relaxed for a fixture.
      mkdirSync(workspaceA, { recursive: true });
      mkdirSync(workspaceB, { recursive: true });

      const taskA = await r.ipc.request({ op: 'task.ensure', clientKey: r.key('task-a') });
      const taskB = await r.ipc.request({ op: 'task.ensure', clientKey: r.key('task-b') });
      const sessionA = await r.ipc.request({ op: 'session.start', taskId: taskA.task.taskId, clientKey: r.key('sess-a'), cwd: workspaceA });
      const sessionB = await r.ipc.request({ op: 'session.start', taskId: taskB.task.taskId, clientKey: r.key('sess-b'), cwd: workspaceB });
      assert.notEqual(sessionA.session.hostSessionId, sessionB.session.hostSessionId, 'two sessions must have distinct host ids');

      // Each session gets its own script, so the reply proves which route was used when.
      r.host.mock.routeByText('SESSION-PROMPT-A', { text: markerA });
      r.host.mock.routeByText('SESSION-PROMPT-B', { text: markerB });

      await Promise.all([
        r.ipc.request({ op: 'session.prompt', taskId: taskA.task.taskId, sessionId: sessionA.session.sessionId, clientKey: r.key('p-a'), text: 'SESSION-PROMPT-A' }),
        r.ipc.request({ op: 'session.prompt', taskId: taskB.task.taskId, sessionId: sessionB.session.sessionId, clientKey: r.key('p-b'), text: 'SESSION-PROMPT-B' }),
      ]);
      await Promise.all([
        r.ipc.request({ op: 'session.wait', taskId: taskA.task.taskId, sessionId: sessionA.session.sessionId, clientKey: r.key('w-a'), timeoutMs: 90_000 }),
        r.ipc.request({ op: 'session.wait', taskId: taskB.task.taskId, sessionId: sessionB.session.sessionId, clientKey: r.key('w-b'), timeoutMs: 90_000 }),
      ]);

      const eventsA = await r.ipc.request({ op: 'session.events', taskId: taskA.task.taskId, sessionId: sessionA.session.sessionId, limit: 300 });
      const eventsB = await r.ipc.request({ op: 'session.events', taskId: taskB.task.taskId, sessionId: sessionB.session.sessionId, limit: 300 });
      const textA = assistantText(eventsA.events);
      const textB = assistantText(eventsB.events);
      // Each session must hold exactly its own reply. A shared mix-up here would be the classic
      // cross-session leak.
      assert.ok(textA.includes(markerA), `session A must receive its own reply, got ${textA.slice(0, 200)}`);
      assert.ok(textB.includes(markerB), `session B must receive its own reply, got ${textB.slice(0, 200)}`);
      assert.equal(textA.includes(markerB), false, `session A must not contain session B's reply: ${textA.slice(0, 200)}`);
      assert.equal(textB.includes(markerA), false, `session B must not contain session A's reply: ${textB.slice(0, 200)}`);
      // Distinct native sequence spaces: the Host numbers events per session, and our store must
      // keep them apart rather than merging them into one counter.
      const seqsA = new Set(eventsA.events.map((e) => e.seq));
      const seqsB = new Set(eventsB.events.map((e) => e.seq));
      assert.ok(seqsA.size > 0 && seqsB.size > 0);
      assert.ok([...seqsA].some((seq) => seqsB.has(seq)), 'both sessions number from their own zero, so the ranges must overlap');
    } finally {
      await r.teardown();
    }
  },

  'cancel is reported as a turn-level ack with no subprocess evidence, never as proof': async (context) => {
    requireIsolated(context);
    const r = await rig('isolated-cancel');
    try {
      // The mock stalls so the turn is genuinely still running when cancel arrives.
      r.host.mock.routeByText('Think for a while', { text: 'SLOW-REPLY-never-completes-quickly', latencyMs: 20_000 });
      const { taskId, sessionId } = await r.openSession();
      await r.ipc.request({ op: 'session.prompt', taskId, sessionId, clientKey: r.key('prompt'), text: 'Think for a while.' });
      // Wait for the Host to actually start the turn before cancelling, so this is not a race.
      await waitFor(async () => {
        const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 50 });
        return events.events.some((e) => e.kind === 'turn/start');
      }, { timeoutMs: 30_000, what: 'the turn to start on the real Host' });

      const cancelled = await r.ipc.request({ op: 'session.cancel', taskId, sessionId, clientKey: r.key('cancel') });
      assert.ok(cancelled.target, 'cancel must name what it targeted');
      // The honest report: no Host receipt exists for tool-subprocess termination, so the bridge
      // must say it did not observe a stop rather than implying one.
      assert.equal(cancelled.processEvidence.observed, false, 'subprocess termination must not be claimed');
      assert.match(String(cancelled.processEvidence.reason), /no receipt|no Host receipt|only a turn-level/i);
      assert.match(String(cancelled.note), /turn/i, 'the note must scope the ack to turn level');
      process.stdout.write(`       cancel result=${JSON.stringify(cancelled.result).slice(0, 120)} target=${JSON.stringify(cancelled.target)}\n`);
      // Whatever the Host decided, the bridge must not have manufactured an assistant message.
      const events = await r.ipc.request({ op: 'session.events', taskId, sessionId, limit: 100 });
      assert.equal(events.events.some((e) => e.kind === 'assistant/message'), false,
        'a cancelled turn must not yield an assistant message');
    } finally {
      await r.teardown();
    }
  },
};
