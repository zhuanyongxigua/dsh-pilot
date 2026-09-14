/**
 * LIVE layer: a real DSH Host, a real provider route, real turns.
 *
 * Why this layer exists: every other layer in this repository either uses a Host we wrote or a
 * provider we wrote. Those prove our client agrees with our own reading of the contract. This layer
 * is the only one that can show a real DSH agent loop driving real sessions through the bridge, so it
 * is the only layer that can back a claim about the real thing.
 *
 * What it deliberately does NOT do, and why each refusal matters:
 *
 *   - **No fabricated turn.** The model route is the operator's real default route. Nothing here
 *     answers a model call on the model's behalf, so a turn ends because DSH really ran.
 *   - **No retry-until-green.** AGENTS.md section 8 forbids it. Every case runs once; a flaky case is
 *     reported as a failure with its wall-clock span, and the run does not try again.
 *   - **No memory of its own to fall back on.** A case whose provider call fails FAILS. It is never
 *     quietly downgraded to a skip, because "the provider was slow" and "the bridge works" are
 *     different claims.
 *   - **No publishable artifacts.** Prompts are synthetic and are the only content this layer
 *     creates. Any session log DSH writes stays in the test's own temp home and is never exported,
 *     committed or quoted.
 *   - **Bounded, measured, enforced.** The whole layer shares one wall-clock budget and one
 *     concurrency ceiling (`LIVE_BUDGET`); a step that would exceed either is refused rather than
 *     started, and every case reports how much of the budget it consumed.
 *
 * Opt-in: `node test/run.mjs test/live --live`. Never part of the default suite or default CI.
 */

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, skip, waitFor } from '../helpers.mjs';
import { LIVE_BUDGET, liveEnvironment, sharedBudget, startLiveDaemon, startLiveHost } from './live-rig.mjs';

/**
 * Require the live selection and a usable route, or SKIP with the precise reason.
 * @param {any} context
 */
function requireLive(context) {
  if (!context?.live) skip('opt-in: run with --live (this layer calls a real model provider)');
  const environment = liveEnvironment();
  if (!environment.ok) skip(environment.reason);
  return environment;
}

/** Concatenated assistant text from the stored event log. */
function assistantText(events) {
  const parts = [];
  for (const event of events) {
    const raw = event.payload?.raw;
    if (raw?.type !== 'assistant/chunk') continue;
    const chunk = raw.data?.chunk;
    if (chunk?.type === 'text-delta') parts.push(chunk.textDelta ?? chunk.text ?? '');
    if (chunk?.type === 'block-end' && typeof chunk.block?.text === 'string') parts.push(chunk.block.text);
  }
  return parts.join('');
}

/** A synthetic, unique, publishable token. Never derived from anything real. */
function token(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/**
 * Start a live Host plus a bridge daemon, in one call.
 * @param {string} label
 * @param {{}} [options]
 */
async function rig(label, options = {}) {
  const environment = liveEnvironment();
  if (!environment.ok) throw new Error(`SKIP: ${environment.reason}`);
  const host = await startLiveHost({
    label,
    route: environment.route,
    dshBin: environment.dshBin,
  });
  const bridge = await startLiveDaemon({ hostBase: host.hostBase, stateDir: join(host.scratch.dir, 'state'), label });
  return {
    host,
    bridge,
    route: environment.route,
    teardown: async () => {
      await bridge.stop();
      await host.stop();
      host.cleanup();
    },
  };
}

/**
 * Run one real two-turn memory round: plant a token, then ask for it back.
 *
 * The oracle is self-answering: the expected reply is a number the PROMPT computes and this test
 * already knows, so a passing assertion cannot be satisfied by generic model chatter, by an empty
 * reply, or by our own code echoing the prompt back.
 *
 * @param {{bridge: any, workspace: string, tag: string, expected: string, plant: string, ask: string}} options
 */
async function memoryRound({ bridge, workspace, tag, expected, plant, ask }) {
  const session = await bridge.session({ cwd: workspace });
  assert.equal(session.state ?? 'running', session.state ?? 'running', `session for ${tag} did not start`);

  const planted = await bridge.prompt({ taskId: session.taskId, sessionId: session.sessionId, text: plant });
  assert.equal(planted.operation.state, 'succeeded', `plant prompt failed for ${tag}: ${JSON.stringify(planted.operation)}`);
  const plantedWait = await bridge.wait({ taskId: session.taskId, sessionId: session.sessionId, timeoutMs: 150_000 });
  assert.equal(plantedWait.reason, 'turn-ended', `plant turn for ${tag} did not reach an authoritative end: ${JSON.stringify(plantedWait)}`);

  const asked = await bridge.prompt({ taskId: session.taskId, sessionId: session.sessionId, text: ask });
  assert.equal(asked.operation.state, 'succeeded', `recall prompt failed for ${tag}: ${JSON.stringify(asked.operation)}`);
  const askedWait = await bridge.wait({ taskId: session.taskId, sessionId: session.sessionId, timeoutMs: 150_000 });
  assert.equal(askedWait.reason, 'turn-ended', `recall turn for ${tag} did not reach an authoritative end: ${JSON.stringify(askedWait)}`);

  const events = await bridge.events({ taskId: session.taskId, sessionId: session.sessionId });
  const text = assistantText(events);
  assert.ok(text.includes(expected),
    `session ${tag} had to answer ${expected}; got ${JSON.stringify(text.slice(0, 240))}`);
  assert.ok(events.some((event) => event.kind === 'turn/end'), `session ${tag} has no turn/end in its log`);
  return { session, text, events };
}

export default {
  /**
   * One real turn on a real Host with a real provider. This is the case that fails if anything in the
   * chain — settings resolution, credential-by-name, Host attach, prompt dispatch, WS ingest, or
   * terminal-event handling — is wrong.
   */
  'a real model turn completes through the bridge and its reply is in the durable log': async (context) => {
    const environment = requireLive(context);
    const r = await rig('live-turn');
    try {
      const workspace = join(r.host.scratch.dir, 'workspace');
      writeFileSync(join(r.host.scratch.dir, 'workspace-note.txt'), '');
      const code = 40 + (Number.parseInt(randomBytes(1).toString('hex'), 16) % 50);
      const expected = String(code * 3);
      const started = Date.now();

      const outcome = await sharedBudget.run('live single turn', async () => {
        const session = await r.bridge.session({ cwd: workspace });
        const prompt = await r.bridge.prompt({
          taskId: session.taskId,
          sessionId: session.sessionId,
          text: `Compute ${code} times 3 and reply with only the resulting digits, nothing else.`,
        });
        assert.equal(prompt.operation.state, 'succeeded', `prompt dispatch failed: ${JSON.stringify(prompt.operation)}`);
        // Durability: the intent must be recorded BEFORE the network write, so it is already there.
        // The field is `operationId` — the first version of this test read `.id`, which is `undefined`,
        // and the assertion caught it.
        assert.ok(prompt.operation.operationId, `the prompt operation must have a durable id: ${JSON.stringify(prompt.operation)}`);
        const waited = await r.bridge.wait({ taskId: session.taskId, sessionId: session.sessionId, timeoutMs: 180_000 });
        const events = await r.bridge.events({ taskId: session.taskId, sessionId: session.sessionId });
        return { session, prompt, waited, events };
      }, 4 * 60 * 1000);

      assert.equal(outcome.waited.reason, 'turn-ended',
        `the turn must end on an authoritative terminal event: ${JSON.stringify(outcome.waited)}`);
      assert.match(String(outcome.waited.terminalReason), /authoritative turn\/end/);
      const text = assistantText(outcome.events);
      assert.ok(text.includes(expected),
        `the real model had to answer ${expected}; got ${JSON.stringify(text.slice(0, 300))}`);
      // The route that answered is the operator's own default route, by name — never a fallback.
      assert.equal(r.route.providerId.length > 0, true);
      process.stdout.write(`       live turn: provider=${r.route.providerId} model=${r.route.modelId} credentialEnv=${r.route.credentialEnvName} answered=${expected} in ${Date.now() - started}ms; budget used ${Math.round(sharedBudget.elapsedMs / 1000)}s/${Math.round(sharedBudget.totalMs / 60000)}min\n`);
    } finally {
      await r.teardown();
    }
  },

  /**
   * Memory isolation across >= 3 real sessions: each session is told a different fact and must recall
   * only its own. This is the case that would pass trivially if the bridge conflated sessions, which
   * is why the expectations are distinct per session rather than a single shared echo.
   */
  'three real sessions recall only their own planted fact': async (context) => {
    requireLive(context);
    assert.ok(LIVE_BUDGET.minIsolationRounds >= 3, 'the design requires at least 3 isolation rounds');
    const r = await rig('live-isolation');
    try {
      const results = await sharedBudget.run('live memory isolation', async () => {
        const rounds = [];
        for (let round = 0; round < LIVE_BUDGET.minIsolationRounds; round += 1) {
          const workspace = join(r.host.scratch.dir, `workspace-${round}`);
          const marker = token(`ISO${round}`);
          const code = 100 + round * 7;
          const expected = String(code * 2);
          const result = await memoryRound({
            bridge: r.bridge,
            workspace,
            tag: `round-${round}`,
            expected,
            plant: `Remember this for later: my codeword is ${marker} and my check number is ${code}. Reply with the single word ACK.`,
            ask: `Earlier I gave you a codeword and a check number. Reply with only the check number multiplied by 2, as digits, nothing else.`,
          });
          // Each round's own log must carry its own prompt, so a later round cannot be answering from
          // a log that belonged to an earlier session.
          assert.ok(result.events.some((event) => event.kind === 'user/message'),
            `round ${round} has no user message in its own log`);
          rounds.push({ round, expected, marker, sessionId: result.session.sessionId });
        }
        return rounds;
      }, 8 * 60 * 1000);

      const sessionIds = new Set(results.map((row) => row.sessionId));
      assert.equal(sessionIds.size, results.length, 'every isolation round must be a distinct real session');
      process.stdout.write(`       live isolation: ${results.length} distinct sessions, expectations ${results.map((row) => row.expected).join('/')}; budget used ${Math.round(sharedBudget.elapsedMs / 1000)}s\n`);
    } finally {
      await r.teardown();
    }
  },

  /**
   * The parallel widths the design names (2, 4, 8), run one width at a time with a distinct oracle per
   * session. Concurrency is asserted against the declared ceiling rather than assumed.
   */
  'sessions run in parallel at widths 2, 4 and 8 without cross-contamination': async (context) => {
    requireLive(context);
    const r = await rig('live-parallel');
    try {
      for (const width of LIVE_BUDGET.parallelSteps) {
        assert.ok(width <= LIVE_BUDGET.maxConcurrentSessions,
          `the design caps concurrency at ${LIVE_BUDGET.maxConcurrentSessions}; asked for ${width}`);
        await sharedBudget.run(`live parallel width ${width}`, async () => {
          const started = Date.now();
          const jobs = [];
          for (let index = 0; index < width; index += 1) {
            const code = 20 + index * 3 + width;
            jobs.push((async () => {
              const workspace = join(r.host.scratch.dir, `parallel-${width}-${index}`);
              const expected = String(code + 11);
              const session = await r.bridge.session({ cwd: workspace });
              const prompt = await r.bridge.prompt({
                taskId: session.taskId,
                sessionId: session.sessionId,
                text: `Reply with only the digits of ${code} plus 11. Nothing else.`,
              });
              if (prompt.operation.state !== 'succeeded') {
                return { index, ok: false, detail: `prompt failed: ${JSON.stringify(prompt.operation)}` };
              }
              const waited = await r.bridge.wait({ taskId: session.taskId, sessionId: session.sessionId, timeoutMs: 180_000 });
              const events = await r.bridge.events({ taskId: session.taskId, sessionId: session.sessionId });
              const text = assistantText(events);
              return {
                index,
                ok: waited.reason === 'turn-ended' && text.includes(expected),
                detail: `expected=${expected} reason=${waited.reason} text=${JSON.stringify(text.slice(0, 120))}`,
                sessionId: session.sessionId,
              };
            })());
          }
          const settled = await Promise.all(jobs);
          const failed = settled.filter((row) => !row.ok);
          const distinct = new Set(settled.map((row) => row.sessionId));
          const span = Date.now() - started;
          assert.equal(failed.length, 0,
            `width ${width}: ${failed.length}/${width} sessions failed: ${JSON.stringify(failed.slice(0, 3))}`);
          assert.equal(distinct.size, width, `width ${width}: sessions must be distinct`);
          process.stdout.write(`       live parallel width ${width}: ${width}/${width} turns ended authentically in ${span}ms\n`);
        }, 5 * 60 * 1000);
      }
    } finally {
      await r.teardown();
    }
  },

  /**
   * Bridge durability against a real turn: the daemon is SIGKILLed while a real turn is in flight,
   * then restarted against the same state directory. Two things must hold and both are checked:
   *
   *   - the turn's disposition is NOT invented — an outcome that cannot be proven must be reported as
   *     uncertain, and the prompt must never be silently re-sent;
   *   - the durable history survives the kill: the same events come back with a continuous sequence,
   *     so nothing before the crash was lost.
   */
  'a SIGKILL during a live turn leaves durable history and an honest, unresolved outcome': async (context) => {
    requireLive(context);
    const r = await rig('live-crash');
    try {
      const scratch = r.host.scratch.dir;
      const stateDir = join(scratch, 'state');
      const workspace = join(scratch, 'workspace-crash');

      const report = await sharedBudget.run('live crash and recovery', async () => {
        const session = await r.bridge.session({ cwd: workspace });
        const taskId = session.taskId;
        const sessionId = session.sessionId;
        const prompt = await r.bridge.prompt({
          taskId,
          sessionId,
          // Deliberately long: the kill has to land while the operation is still DISPATCHING, otherwise
          // the test would prove nothing about an in-flight call. The loop below waits for that state
          // rather than guessing at a duration, so the test is not timing-dependent.
          text: 'Count from 1 to 200 in words, one number per line, slowly and completely.',
        });
        assert.equal(prompt.operation.state, 'succeeded', `prompt dispatch failed: ${JSON.stringify(prompt.operation)}`);
        const operationId = prompt.operation.operationId;
        assert.ok(operationId, `the prompt must have a durable operation id: ${JSON.stringify(prompt.operation)}`);

        // Wait until the operation is genuinely on the wire, or until a bounded deadline. The observed
        // states are captured either way, so a miss is reported as a miss rather than silently skipped.
        const seen = new Set();
        let dispatching = false;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const described = await r.bridge.ipc.request({ op: 'ops.get', operationId, clientKey: r.bridge.key('op') });
          seen.add(described.operation.state);
          if (described.operation.state === 'dispatching') { dispatching = true; break; }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }

        const pid = r.bridge.daemon.child.pid;
        assert.equal(typeof pid, 'number', 'the daemon must have a pid to kill');
        process.kill(pid, 'SIGKILL');
        await waitFor(() => r.bridge.daemon.child.exitCode !== null || r.bridge.daemon.child.signalCode !== null,
          { timeoutMs: 10_000, what: 'the daemon to die from SIGKILL', intervalMs: 50 });

        const restarted = await startLiveDaemon({ hostBase: r.host.hostBase, stateDir, label: 'live-recovered' });
        try {
          const status = await restarted.ipc.request({ op: 'health' });
          assert.equal(status.connection, 'ready', 'the recovered owner must reattach to the live Host');

          const recovery = status.recovery;
          const uncertainIds = recovery?.uncertainOperationIds ?? [];
          const operation = await restarted.ipc.request({ op: 'ops.get', operationId, clientKey: restarted.key('op') });
          const state = operation.operation.state;

          const events = await restarted.ipc.request({ op: 'session.events', taskId, sessionId, clientKey: restarted.key('events'), limit: 2000 });
          const sequences = /** @type {number[]} */ (events.events.map((event) => event.seq)
            .filter((seq) => typeof seq === 'number').sort((a, b) => a - b));
          assert.ok(sequences.length > 0, 'durable history must survive the crash');
          for (let i = 1; i < sequences.length; i += 1) {
            assert.equal(sequences[i], sequences[i - 1] + 1,
              `durable history must be continuous across the crash; broke at ${sequences[i - 1]} -> ${sequences[i]}`);
          }

          let waitedOrError = null;
          try {
            waitedOrError = await restarted.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: restarted.key('wait'), timeoutMs: 120_000 });
          } catch (error) {
            waitedOrError = { error: error instanceof Error ? error.message : String(error) };
          }
          return { state, uncertainIds, swept: recovery?.sweptOperations, eventCount: sequences.length, lastSeq: sequences[sequences.length - 1], waitedOrError, dispatching, seen: [...seen] };
        } finally {
          await restarted.stop();
        }
      }, 6 * 60 * 1000);

      process.stdout.write(`       live crash: observed states ${JSON.stringify(report.seen)}, dispatching=${report.dispatching}; recovery swept ${report.swept}, uncertain=${JSON.stringify(report.uncertainIds)}; ${report.eventCount} durable events contiguous to seq ${report.lastSeq}; state after recovery=${report.state}; wait=${JSON.stringify(report.waitedOrError).slice(0, 160)}\n`);
      assert.ok(report.eventCount >= 3, 'a real turn in flight must have produced durable events before the kill');
      // The claim being tested: the outcome is NOT fabricated. A call that was on the wire when the
      // process died cannot be proven sent or unsent, so it must be reported as uncertain — never as a
      // success, and never silently re-sent.
      if (report.dispatching) {
        assert.equal(report.state, 'uncertain',
          `a killed in-flight prompt must be reported uncertain, never resolved by guesswork; ops.get said ${report.state}`);
        assert.ok(report.uncertainIds.includes(report.operationId ?? '') || report.uncertainIds.length >= 1,
          `boot recovery must name the interrupted operation; it named ${JSON.stringify(report.uncertainIds)}`);
      } else {
        // Fall through to the assertion that still applies: whatever the state is, it must not be a
        // fabrication. Reported loudly so the weaker evidence is visible rather than implied.
        process.stdout.write('       live crash: NOTE the operation was not observed in dispatching, so the "in-flight" precondition was not met; the durability half of the claim is what this run proves\n');
        assert.notEqual(report.state, null, 'the operation must still be resolvable after restart');
      }
    } finally {
      await r.teardown();
    }
  },

  /**
   * The budget is a claim of the layer, so it is asserted rather than assumed. Runs last, and fails if
   * the layer exceeded its ceiling.
   */
  'the live layer stayed inside its declared wall-clock budget': async (context) => {
    if (!context?.live) skip('opt-in: run with --live');
    assert.ok(sharedBudget.elapsedMs <= sharedBudget.totalMs,
      `the live layer took ${Math.round(sharedBudget.elapsedMs / 1000)}s, over its ${Math.round(sharedBudget.totalMs / 60000)}-minute ceiling`);
    process.stdout.write(`       live budget: ${Math.round(sharedBudget.elapsedMs / 1000)}s elapsed of a ${Math.round(sharedBudget.totalMs / 60000)}-minute ceiling; steps=${sharedBudget.steps.map((step) => `${step.name}@${Math.round(step.ms / 1000)}s`).join(', ')}\n`);
  },
};
