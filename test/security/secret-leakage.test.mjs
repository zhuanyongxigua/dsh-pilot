/**
 * FR-SEC-3 — a secret that passes THROUGH the bridge must not come out of it.
 *
 * The requirement names four surfaces: state, logs, errors, tool results. The existing
 * `security/bounds.test.mjs` case checks that the bridge does not COPY credential-shaped material
 * out of its own environment into durable state. That is a different claim. This file tests the
 * harder one: an upstream peer (a Host, a provider, a tool result) hands us a value that looks
 * like a credential, and that value must not survive the trip into anything we write down or
 * anything we hand back to a caller.
 *
 * The value is a synthetic sentinel, never a real secret, and it is deliberately shaped like a
 * real key so that a redaction step which keys on the SHAPE has something to key on. It is
 * assembled at runtime from parts so that the literal never appears in this repository — which
 * matters, because this repository is public and its CI job fails on credential-shaped literals.
 *
 * The sentinel-finding helper is itself tested (last case), because a scanner that silently finds
 * nothing would make every assertion in this file pass for every implementation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * Build the sentinel at runtime. Assembled from parts so no credential-shaped literal is committed.
 * @param {string} tag
 * @returns {string}
 */
function sentinel(tag) {
  const prefix = ['s', 'k'].join('');
  const body = ['ZZSENTINEL', tag, 'abcdefghijklmnop'].join('-');
  return `${prefix}-${body}`;
}

/**
 * Every file under a directory, as raw bytes decoded without a charset assumption.
 * @param {string} root
 * @returns {string}
 */
function dumpTree(root) {
  let out = '';
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out += dumpTree(path);
    else if (entry.isFile() && statSync(path).size < 32 * 1024 * 1024) {
      out += readFileSync(path).toString('latin1');
    }
  }
  return out;
}

/**
 * Find every occurrence of a needle in a haystack, returning the surrounding context so a failure
 * message can say WHERE it leaked rather than only that it did.
 * @param {string} haystack
 * @param {string} needle
 * @returns {string[]}
 */
function locate(haystack, needle) {
  /** @type {string[]} */
  const hits = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return hits;
    hits.push(haystack.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, ' '));
    from = at + needle.length;
  }
}

export default {
  'a secret in a host error never reaches a caller, a log, or durable state': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('sec3-error');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
    const secret = sentinel('ERROR');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec3-task' });
        const session = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: 'sec3-session',
        });
        // The Host fails the call and puts the secret in BOTH places a host controls: the human
        // message and a named detail field. Both are realistic leak sites.
        host.rejectWith('session.prompt', {
          code: 'agent-busy',
          message: `provider refused: authorization ${secret}`,
          details: { authHeader: `Bearer ${secret}`, harmless: 'kept' },
        });
        const result = await client.request({
          op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
          clientKey: 'sec3-prompt', text: 'x',
        });

        const toolResult = JSON.stringify(result);
        const hitsInResult = locate(toolResult, secret);
        assert.deepEqual(hitsInResult, [], `the secret leaked into the tool result: ${hitsInResult.join(' | ')}`);

        // The refusal still has to be USEFUL: a redaction that also destroys the diagnosis is a
        // broken fix, not a secure one. `shapeOperation` is the contract the caller reads, so the
        // assertions are on ITS fields (errorCode / errorMessage), not on an inner error object.
        assert.equal(result.operation.state, 'refused', 'the refusal must still be reported');
        assert.equal(result.operation.errorCode, 'agent-busy', 'the host business code must survive redaction');
        assert.match(String(result.operation.errorMessage), /provider refused/, 'the diagnosis must survive redaction');
        assert.match(
          String(result.operation.errorMessage),
          /redacted/,
          'the redaction must be visible in the message, not a silent deletion of the authorization clause',
        );
      } finally {
        client.close();
      }

      const logs = `${daemon.output().stdout}\n${daemon.output().stderr}`;
      const hitsInLogs = locate(logs, secret);
      assert.deepEqual(hitsInLogs, [], `the secret leaked into the daemon's output: ${hitsInLogs.join(' | ')}`);

      // Close before reading the database so no write is in flight, then read the durable state.
      await daemon.stop();
      const stateDump = dumpTree(stateDir);
      const hitsInState = locate(stateDump, secret);
      assert.deepEqual(hitsInState, [], `the secret leaked into durable state: ${hitsInState.join(' | ')}`);
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'a secret in an approval reason never reaches durable state or a caller': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('sec3-event');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
    const secret = sentinel('STREAM');
    try {
      const client = await ipcClient(daemon.socketPath);
      let approval = null;
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec3e-task' });
        const session = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: 'sec3e-session',
        });
        const hostSessionId = session.session.hostSessionId ?? session.session.sessionId;
        // The secret rides in the approval's reason. That text is the bridge's OWN to copy: it
        // turns it into an interaction payload of its own construction, which is exactly the kind
        // of copy FR-SEC-3 governs. (For the BYTES of an upstream event the bridge archives instead
        // of interpreting, see the next case and docs/conflicts.md C-1 — the two are not the same
        // claim and this file does not conflate them.)
        host.emitSessionEvent(hostSessionId, { type: 'turn/start', turn: 1 });
        approval = host.emitApprovalRequested(hostSessionId, { toolName: 'bash' });
        host.emitTurnEnd(hostSessionId, 1, 'completed');

        // Wait on the observable condition (the interaction becoming visible over IPC) rather than
        // sleeping and hoping. A timeout is reported as a timeout by `waitFor`, not swallowed.
        await waitFor(
          async () => {
            const probe = await client.request({ op: 'interaction.list', taskId: task.task.taskId });
            return Array.isArray(probe.interactions) && probe.interactions.length > 0;
          },
          { what: 'the approval to become visible over IPC', timeoutMs: 10_000 },
        );
        const listed = await client.request({ op: 'interaction.list', taskId: task.task.taskId });
        const serialized = JSON.stringify(listed);
        const hits = locate(serialized, secret);
        assert.deepEqual(hits, [], `the secret leaked into the interaction listing: ${hits.join(' | ')}`);
        // The listing is only a meaningful oracle if it actually contained the interaction.
        const items = Array.isArray(listed.interactions) ? listed.interactions : [];
        assert.ok(items.length > 0, 'expected the approval to be listed; an empty listing proves nothing');
      } finally {
        client.close();
      }

      await daemon.stop();
      const logs = `${daemon.output().stdout}\n${daemon.output().stderr}`;
      const hitsInLogs = locate(logs, secret);
      assert.deepEqual(hitsInLogs, [], `the secret leaked into the daemon's output: ${hitsInLogs.join(' | ')}`);

      // Durable state, read through the database rather than as raw bytes, so the claim is precise:
      // the bridge's OWN interaction record must not carry the peer's credential text. Stated as a
      // query against the table that holds it, because "the bytes are somewhere in this file" would
      // not distinguish our own record from the upstream archive that legitimately sits beside it.
      const sqlite = process.getBuiltinModule('node:sqlite');
      const db = new sqlite.DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
      const interactions = JSON.stringify(db.prepare('select * from interactions').all());
      const turns = JSON.stringify(db.prepare('select * from turns').all());
      db.close();
      const hitsInInteractions = locate(interactions, secret);
      assert.deepEqual(
        hitsInInteractions, [],
        `a credential from an approval reason reached the bridge's own interaction record: ${hitsInInteractions.join(' | ')}`,
      );
      const hitsInTurns = locate(turns, secret);
      assert.deepEqual(hitsInTurns, [], `a credential reached a turn record: ${hitsInTurns.join(' | ')}`);
      // The record is only a meaningful oracle if it exists and is the one the approval produced.
      assert.ok(
        interactions.includes('approval') || interactions.includes('bash'),
        `expected the interaction row to be present; got ${interactions.slice(0, 300)}`,
      );
      assert.ok(approval !== null, 'the fixture must have emitted an approval for this case to mean anything');
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'the bridge never reads a provider credential value, only the variable name': async () => {
    // The requirement is about the variable NAME. So: put a secret in the ambient environment of a
    // real daemon under every name a provider could plausibly use, drive real work, and assert that
    // the value appears nowhere in what the daemon produced. If the bridge ever read and forwarded
    // one, it would show up on the wire or in the state; this test makes that observable.
    const host = await new FakeHost().start();
    const scratch = scratchDir('sec3-env');
    const stateDir = join(scratch.dir, 'state');
    const envSecret = sentinel('ENV');
    const daemon = await startDaemon({
      hostBase: host.baseUrl,
      stateDir,
      extraEnv: {
        ANTHROPIC_AUTH_TOKEN: envSecret,
        ANTHROPIC_API_KEY: envSecret,
        DEEPSEEK_API_KEY: envSecret,
        OPENAI_API_KEY: envSecret,
        DSH_PILOT_MOCK_API_KEY: envSecret,
      },
    });
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec3v-task' });
        const session = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: 'sec3v-session',
        });
        await client.request({
          op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
          clientKey: 'sec3v-prompt', text: 'hello',
        }).catch(() => { /* the outcome is not the subject; the leak surface is */ });
      } finally {
        client.close();
      }
      await daemon.stop();

      // The Host's own request log is the strongest oracle available here: if the bridge forwarded
      // an ambient credential, it would be in a request body it sent.
      const wire = host.received.map((entry) => JSON.stringify(entry)).join('\n');
      const hitsOnWire = locate(wire, envSecret);
      assert.deepEqual(hitsOnWire, [], `an ambient credential value reached the Host: ${hitsOnWire.join(' | ')}`);

      const stateDump = dumpTree(stateDir);
      const hitsInState = locate(stateDump, envSecret);
      assert.deepEqual(hitsInState, [], `an ambient credential value reached durable state: ${hitsInState.join(' | ')}`);

      const logs = `${daemon.output().stdout}\n${daemon.output().stderr}`;
      const hitsInLogs = locate(logs, envSecret);
      assert.deepEqual(hitsInLogs, [], `an ambient credential value reached the daemon's output: ${hitsInLogs.join(' | ')}`);
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'the upstream event archive holds the NORMALISED payload, keeps every replay-critical field, and the secret is gone': async () => {
    // This case exists because writing it exposed a REAL conflict between two binding rules, and
    // the honest outcome is to state the conflict rather than to quietly redact an archive or to
    // quietly drop the claim. See docs/conflicts.md C-1.
    //
    // FR-SEC-3: a secret never appears in state. The event archive IS state.
    // Durability rule (AGENTS.md 6): reconciliation after a crash replays OBSERVED upstream events,
    // so the archived payload must be the bytes the peer sent. Redacting it would make a recovered
    // bridge reconcile against a different history than a live one — trading a confidentiality risk
    // for a correctness bug in the very subsystem the requirement exists to protect.
    //
    // So this case asserts the behaviour that exists, MEASURES it, and names the conflict. It is
    // deliberately not written as "no secret in any state byte", because that claim is false and a
    // test asserting a false claim would have to be satisfied by breaking the archive.
    const host = await new FakeHost().start();
    const scratch = scratchDir('sec3-archive');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
    const secret = sentinel('ARCHIVE');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec3a-task' });
        const session = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: 'sec3a-session',
        });
        const hostSessionId = session.session.hostSessionId ?? session.session.sessionId;
        host.emitSessionEvent(hostSessionId, { type: 'turn/start', turn: 1 });
        // The event body carries the secret exactly as a real provider's tool call could.
        host.emitSessionEvent(hostSessionId, {
          type: 'tool/call', seq: 9001, name: 'bash', input: { command: `echo ${secret}` },
        });
        host.emitTurnEnd(hostSessionId, 1, 'completed');
        // Wait on the archive itself: the condition is the event being DURABLE, which is what the
        // rest of this case reads, rather than the weaker "the frame arrived".
        await waitFor(
          async () => {
            const probe = await client.request({
              op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId,
            });
            const events = Array.isArray(probe.events) ? probe.events : [];
            return events.some((event) => event?.seq === 9001);
          },
          { what: 'the tool/call event to be archived', timeoutMs: 10_000 },
        );
      } finally {
        client.close();
      }
      await daemon.stop();

      const sqlite = process.getBuiltinModule('node:sqlite');
      const db = new sqlite.DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
      const archived = db.prepare('select kind, payload_json from events').all();
      const interactions = JSON.stringify(db.prepare('select * from interactions').all());
      db.close();

      const archivedText = JSON.stringify(archived);
      assert.ok(archived.length > 0, 'expected the event archive to contain the ingested events');

      // THIS IS THE C-1 CONTRACT, asserted on the archive itself.
      //
      // This case previously required the opposite — that the archive hold the peer payload
      // byte-for-byte — and the reversal is the resolution of conflict C-1, not a weakening. The
      // requirement FR-SEC-3 makes is that a credential does not sit in bridge-visible state, and the
      // archive is bridge-visible state. What the boundary replaces is the CLAIM, not the coverage:
      // byte fidelity was never required, semantic replay fidelity is, and that is asserted directly
      // rather than proxied by "the bytes are intact".
      assert.ok(
        !archivedText.includes(secret),
        'a credential reached the durable event archive; the inbound boundary must strip it before the '
        + 'event is stored, because the stored row is what a replay reduces',
      );
      assert.ok(
        archivedText.includes('redacted'),
        'the archive must show that something was redacted, so "the secret is absent" cannot be satisfied '
        + 'by the event never having been stored at all',
      );

      // The replay-critical facts must survive the boundary EXACTLY, or the fix for C-1 would have
      // bought secrecy by breaking the durability model. Read back per row from the archive and
      // compared against what the peer actually sent.
      // `DatabaseSync`'s row values are `SQLOutputValue` — it cannot know this table's column types —
      // so the two columns read here are narrowed at that boundary and then used. The `kind` assertion
      // below is the check that the narrowing was right, not the cast.
      const parsedArchived = archived.map((row) => ({
        kind: typeof row.kind === 'string' ? row.kind : '',
        payload: /** @type {{raw?: Record<string, unknown>, nativeType?: unknown}} */ (
          JSON.parse(String(row.payload_json))
        ),
      }));
      /** The `raw` sub-object as a bag, so the replay-critical fields below can be read by name. */
      const rawOf = (entry) => /** @type {Record<string, unknown>} */ (entry?.payload?.raw ?? {});
      const toolRow = parsedArchived.find((row) => rawOf(row)['seq'] === 9001);
      assert.ok(toolRow, `the tool/call event must be archived with its sequence intact, got ${JSON.stringify(parsedArchived.map((row) => rawOf(row)['seq']))}`);
      assert.equal(toolRow.payload.nativeType, 'tool/call', 'the native type must survive unchanged');
      assert.equal(rawOf(toolRow)['type'], 'tool/call', 'the event type must survive unchanged');
      assert.equal(rawOf(toolRow)['seq'], 9001, 'the sequence number must survive unchanged, or the cursor is meaningless');
      // The tool NAME is a non-sensitive string beside the redacted input, and it must survive: a
      // boundary that removed every string would pass "the secret is gone" while destroying the
      // event. `turn` lives on the separate `turn/start` row rather than on this one, so the turn
      // binding is asserted where it actually is.
      assert.equal(rawOf(toolRow)['name'], 'bash', 'the tool name must survive the boundary unchanged');
      const turnRow = parsedArchived.find((row) => rawOf(row)['type'] === 'turn/start');
      assert.ok(turnRow, 'the turn/start event must be archived');
      assert.equal(typeof rawOf(turnRow)['turn'], 'number',
        `turn numbering must survive unchanged, got ${JSON.stringify(rawOf(turnRow)['turn'])}`);

      // And the surfaces the bridge AUTHORS refuse the secret, which is what FR-SEC-3 requires.
      const hitsInInteractions = locate(interactions, secret);
      assert.deepEqual(hitsInInteractions, [], `a credential reached the bridge's own interaction record: ${hitsInInteractions.join(' | ')}`);
      const logs = `${daemon.output().stdout}\n${daemon.output().stderr}`;
      const hitsInLogs = locate(logs, secret);
      assert.deepEqual(hitsInLogs, [], `the secret leaked into the daemon's output: ${hitsInLogs.join(' | ')}`);
      // The measurement is printed, so a reader sees how much of the state tree is affected.
      process.stdout.write(
        `      archive measurement: ${archived.length} event rows; payloads normalised at ingress, replay-critical fields preserved (C-1 resolved)\n`,
      );
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'the sentinel scanner itself finds a planted secret, so the checks above are not vacuous': async () => {
    // Without this case, a `locate` that always returned [] would make all three cases above pass
    // against an implementation that leaked everything.
    const secret = sentinel('SELFTEST');
    const planted = `leading text ${secret} trailing text`;
    const hits = locate(planted, secret);
    assert.equal(hits.length, 1, `the scanner must find a planted secret, found ${hits.length}`);
    assert.ok(hits[0].includes(secret), 'the reported context must contain the secret');
    assert.deepEqual(locate('nothing here', secret), [], 'the scanner must not report a secret that is absent');
    // And the sentinel must be shaped like a real key, or a shape-keyed redactor would have nothing
    // to key on and this whole file would be testing a case that cannot occur.
    assert.match(secret, /^sk-[A-Za-z0-9-]{16,}$/, 'the sentinel must look like an API key');
  },
};
