/**
 * FR-SESS-4 and FR-ID-1 over real MCP stdio: two caller processes, one durable task.
 *
 * Why this file exists: `docs/test-matrix.md` records FR-SESS-4 as **unverified** — "no test drives
 * two independent caller processes against one durable task" — and FR-ID-1 as only partial, with no
 * `task.get`-shaped read and with `turnId`/`interactionId` stability across a restart never
 * asserted. This file closes those two rows, and it closes them the only way the project's rules
 * allow: the built MCP binary is spawned as a REAL MCP server over REAL stdio, at least two at a
 * time, each an operating-system process with its own stdin/stdout, driven by newline-delimited
 * JSON-RPC 2.0 (`initialize` / `notifications/initialized` / `tools/list` / `tools/call`). Nothing
 * here calls a `Daemon` method, and nothing here imports `src/`.
 *
 * What the oracles can and cannot see, stated up front so no reader over-reads this file:
 *
 *   - There is no `task.get` tool. The durable task is observable through `dsh_task_start` (the
 *     idempotent task lookup keyed by the caller's key) and through `dsh_session_state` (the
 *     per-session snapshot: session, connection, execution, cursor, queue, operations,
 *     interactions, event count). "Byte-identical" below means the exact text the gateway wrote on
 *     stdout, compared with `===` — not a field-by-field resemblance.
 *   - There is no `session.list` tool either, so the "exactly one session for this task" oracle is
 *     the durable journal itself: the SQLite state file the daemon owns, read by this process over
 *     a read-only connection. That is an observation of the durable ARTIFACT, not a call into the
 *     implementation — this file imports no `dist/lib/*` module at all — and it is the same kind of
 *     evidence FR-STATE-1's own oracle names ("observing the journal file"). The second, independent
 *     count oracle is the Host's received-request log: a duplicate session would need a second
 *     `session.create` on the wire.
 *   - "The ids appear in the journal before any dispatch" (FR-ID-1) is answered with the strongest
 *     observation the outside can make: while the Host is holding the reply to a dispatch that is
 *     provably in flight, the journal must ALREADY hold the intent and the exact request body that
 *     went on the wire; and a SIGKILL of the daemon at that moment must leave that record behind,
 *     written by a process that never saw a reply. A record written after the send leaves nothing
 *     (or a `pending` row with no outbox record) at both moments, so both checks can fail. What this
 *     cannot prove from the outside is the byte-level ordering INSIDE the daemon between the commit
 *     and the socket write; that boundary is asserted at unit level by `test/unit/core.test.mjs`
 *     ("durable-before-send: the dispatching row is committed before any network write").
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asRecord, assert, collect, jsonLines, scratchDir, spawnNode, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

const PROTOCOL_VERSION = '2024-11-05';
/** The caller key that names the durable task; the same value must resolve to the same task id. */
const TASK_KEY = 'multi-caller-task';
/** The idempotency key that names the task's session; the same value must resolve to the same session. */
const SESSION_KEY = 'multi-caller-session';
const CWD = '/tmp/multi-caller-workspace';

/**
 * One parsed JSON-RPC reply, as far as this client reads it.
 *
 * Every member is `unknown` on purpose: the line was parsed from another process's stdout, so the
 * only honest thing this file can claim about it is that it is a JSON object. Each read below is
 * checked where it happens, rather than the shape being asserted once and trusted everywhere.
 *
 * @typedef {object} JsonRpcReply
 * @property {unknown} [id]
 * @property {{content?: unknown, isError?: unknown}} [result]
 * @property {unknown} [error]
 */

/**
 * The ONE place this file admits a cast, and the boundary that makes it honest: a line that was
 * `JSON.parse`d from the peer's stdout, where a value that is not a JSON object cannot be a
 * JSON-RPC message at all. The check is a real runtime one, and every property read afterwards
 * stays `unknown` until it is checked.
 * @param {unknown} message
 * @returns {JsonRpcReply}
 */
function asReply(message) {
  return typeof message === 'object' && message !== null ? /** @type {JsonRpcReply} */ (message) : {};
}

/**
 * A value the test already knows is a string, said once and exactly.
 *
 * Why not a cast: `typeof x === 'string'` is a real check, and returning through this function makes
 * the check the thing that produced the type — a cast would assert the type without checking it.
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function mustBeString(value, what) {
  if (typeof value !== 'string') throw new Error(`expected ${what} to be a string, got ${typeof value}`);
  return value;
}

/**
 * Start one real MCP client process: its own OS process, its own stdio pipes, and a JSON-RPC
 * router that can hold several requests open at once (the crash case below needs a call that is in
 * flight while the test looks at something else).
 *
 * @param {{socketPath: string, stateDir: string, label: string}} options
 */
async function startMcpClient({ socketPath, stateDir, label }) {
  const child = spawnNode(['dist/bin/dsh-pilot-mcp.js', '--state-dir', stateDir, '--socket', socketPath]);
  // `spawnNode` pipes stdio, so stdout is readable here; the declared `Readable|null` covers a
  // caller that spawned without pipes, which is why the narrowing stays explicit.
  const lines = jsonLines(/** @type {import('node:stream').Readable} */ (child.stdout));
  const stderrChunks = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));

  let nextId = 0;
  /** @type {Map<number, {resolve: (message: JsonRpcReply) => void, reject: (error: Error) => void}>} */
  const waiting = new Map();

  const send = (message) => { child.stdin?.write(`${JSON.stringify(message)}\n`); };

  // One reader owns the stdout stream; replies are routed to the request that carries the id, so a
  // client can genuinely have more than one call outstanding (a sequential reader would deadlock on
  // exactly the case this file needs). The loop is deliberately not awaited anywhere: it ends when
  // the stream does, and pending requests are rejected by `stop()`.
  const reader = (async () => {
    for (;;) {
      /** @type {unknown} */
      let line;
      try {
        line = await lines.next(600000);
      } catch {
        break; // the stream ended, or nobody wrote for the (long) bound
      }
      const message = asReply(line);
      const entry = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
      if (entry && typeof message.id === 'number') {
        waiting.delete(message.id);
        entry.resolve(message);
      }
      // A server-initiated notification carries no id and needs no reply; anything else that is not
      // one of our outstanding ids is not ours to answer.
    }
  })();
  reader.catch(() => { /* the loop reports through the requests it rejects, never by throwing */ });

  /**
   * Send one JSON-RPC request and resolve with the response that carries its id.
   * @param {string} method
   * @param {unknown} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<JsonRpcReply>}
   */
  const request = (method, params = undefined, timeoutMs = 30000) => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${label}: timed out after ${timeoutMs}ms waiting for a reply to ${method}`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  };

  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: `dsh-pilot-${label}`, version: '0.0.1' },
  });
  // The process under test must be the real bridge, not a stand-in that happens to answer.
  const serverInfo = asRecord(asRecord(init.result, "the initialize result").serverInfo, 'the server info');
  assert.equal(serverInfo.name, 'dsh-pilot', `${label}: expected the dsh-pilot gateway, got ${brief(init)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    label,
    child,
    request,
    /** @param {string} name @param {object} [args] @returns {Promise<JsonRpcReply>} */
    callTool: (name, args) => request('tools/call', { name, arguments: args ?? {} }),
    stderr: () => stderrChunks.join(''),
    stop: async () => {
      try { child.stdin?.end(); } catch { /* already closed */ }
      const outcome = await Promise.race([
        collect(child),
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timed-out', stdout: '', stderr: '' }), 5000)),
      ]);
      if (outcome.signal === 'timed-out') child.kill('SIGKILL');
      // A request that was in flight when the caller stopped ends without an answer; it is rejected
      // here rather than left to a timer, so the case fails fast and by name if it is awaited.
      for (const [, entry] of waiting) entry.reject(new Error(`${label}: the caller was stopped before the daemon answered`));
      waiting.clear();
      return outcome;
    },
  };
}

/** One real MCP caller process, as this file uses it. */
/** @typedef {Awaited<ReturnType<typeof startMcpClient>>} McpCaller */

/**
 * Fake Host + daemon on a scratch state dir, with callers, daemon restart and a hard kill on tap.
 * @param {string} label
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const stateDir = join(scratch.dir, 'state');
  let daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  /** @type {Array<Awaited<ReturnType<typeof startMcpClient>>>} */
  const callers = [];

  return {
    host,
    stateDir,
    get daemon() { return daemon; },
    /** @param {string} name */
    startCaller: async (name) => {
      const caller = await startMcpClient({ socketPath: daemon.socketPath, stateDir, label: name });
      callers.push(caller);
      return caller;
    },
    stopCallers: async () => {
      for (const caller of callers.splice(0)) await caller.stop();
    },
    /** Stop the daemon cleanly and start a NEW process on the same state dir and the same Host. */
    restartDaemon: async () => {
      await daemon.stop();
      daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
      return daemon;
    },
    /** Kill the daemon without giving it a chance to tidy up, and report how it died. */
    killDaemon: async () => {
      daemon.child.kill('SIGKILL');
      return collect(daemon.child);
    },
    teardown: async () => {
      for (const caller of callers.splice(0)) await caller.stop();
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/**
 * A short, always-printable view of a value for a failure message.
 *
 * `JSON.stringify(undefined)` is `undefined`, so a bare `.slice` on it throws inside the message
 * it was meant to explain — which is exactly how a real failure gets replaced by a confusing one.
 * @param {unknown} value
 * @returns {string}
 */
function brief(value) {
  if (typeof value === 'string') return value.slice(0, 400);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 400);
  } catch {
    return String(value).slice(0, 400);
  }
}

/**
 * Parse a tool result. `allowError` is for the two calls whose POINT is the error flag (reading an
 * uncertain operation); everywhere else an error result is a failure, not a payload.
 *
 * The payload is narrowed through the shared `asRecord` boundary helper, which is this project's one
 * stated narrowing step for JSON that arrived from elsewhere (see `test/helpers.mjs`): the tool
 * result text is a document this process did not author, so it is checked, not asserted.
 * @param {JsonRpcReply} response
 * @param {{allowError?: boolean}} [options]
 */
function toolResult(response, { allowError = false } = {}) {
  const error = response.error;
  assert.equal(error, undefined, `tool call failed: ${brief(error)}`);
  const content = response.result?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = typeof first === 'object' && first !== null ? asRecord(first, 'one content block').text : undefined;
  assert.ok(typeof text === 'string', `tool result carried no text content: ${brief(response)}`);
  if (!allowError) {
    assert.equal(response.result?.isError, false, `the bridge reported an error result: ${text.slice(0, 400)}`);
  }
  return { text, value: asRecord(JSON.parse(text), 'the tool result payload') };
}

/** @param {JsonRpcReply} response @param {{allowError?: boolean}} [options] */
const toolJson = (response, options) => toolResult(response, options).value;

/**
 * The exact text one tool call replied with — what "byte-identical" is measured against.
 * @param {McpCaller} caller
 * @param {string} name
 * @param {object} args
 * @returns {Promise<string>}
 */
async function rawToolText(caller, name, args) {
  return toolResult(await caller.callTool(name, args)).text;
}

/**
 * The tool names one MCP server advertises (`tools/list`).
 * @param {McpCaller} caller
 * @returns {Promise<string[]>}
 */
async function listToolNames(caller) {
  const reply = await caller.request('tools/list');
  const result = asRecord(reply.result, 'the tools/list result');
  const tools = result.tools;
  assert.ok(Array.isArray(tools), `tools/list must answer with an array of tools: ${brief(reply)}`);
  return tools.map((tool) => mustBeString(asRecord(tool, 'one advertised tool').name, 'an advertised tool name'));
}

/** @param {unknown} value @param {string} prefix @param {string} what */
function assertId(value, prefix, what) {
  assert.match(
    mustBeString(value, what),
    new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
    `${what} must be a ${prefix}_ id`,
  );
}

/**
 * Read rows out of the daemon's durable journal as an outside observer.
 *
 * Read-only, from this process, on the file the daemon owns: this cannot influence what the daemon
 * writes, and the daemon is free to hold it in WAL mode while this reads.
 * @param {string} stateDir the scratch state directory the daemon was started on
 * @param {string} sql statement to run
 * @param {...(string|number)} params values bound to its `?` placeholders
 */
function journal(stateDir, sql, ...params) {
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true, timeout: 2000 });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** The session ids recorded for one task — the "exactly one session" oracle. */
function journalSessionIds(stateDir, taskId) {
  return journal(stateDir, 'select session_id from sessions where task_id = ?', taskId)
    .map((row) => String(row.session_id));
}

/**
 * Drive the real MCP surface to create the durable fixture: one task, one session, one prompt whose
 * turn the fake Host completes deterministically.
 * @param {McpCaller} caller
 * @param {string} probeText
 */
async function createTaskAndSession(caller, probeText) {
  const task = toolJson(await caller.callTool('dsh_task_start', { clientKey: TASK_KEY }));
  const session = toolJson(await caller.callTool('dsh_session_start', {
    taskId: task.task.taskId, clientKey: SESSION_KEY, cwd: CWD,
  }));
  const prompt = toolJson(await caller.callTool('dsh_session_prompt', {
    taskId: task.task.taskId, sessionId: session.session.sessionId, clientKey: 'multi-caller-prompt-1', text: probeText,
  }));
  return {
    taskId: task.task.taskId,
    sessionId: session.session.sessionId,
    hostSessionId: session.session.hostSessionId,
    createOperationId: session.operation.operationId,
    promptOperationId: prompt.operation.operationId,
  };
}

/**
 * Wait until the prompt's turn has reached a terminal state, which is also the point at which every
 * event that turn produces is already stored — the snapshot comparisons below need that quiescence
 * to be a fact rather than a hope.
 * @param {McpCaller} caller
 * @param {{taskId: string, sessionId: string}} ids
 */
async function waitForTurnEnded(caller, ids) {
  await waitFor(async () => {
    const waited = toolJson(await caller.callTool('dsh_session_wait', {
      taskId: ids.taskId, sessionId: ids.sessionId, timeoutMs: 250,
    }));
    return waited.reason === 'turn-ended';
  }, { timeoutMs: 20000, what: 'the prompt turn to reach a terminal state (all of its events stored)' });
}

/**
 * The sequence numbers of an event page, checked to be an array rather than assumed to be one.
 * @param {unknown} rawEvents the `events` member of a `dsh_session_events` payload
 * @returns {number[]}
 */
function eventSeqs(rawEvents) {
  assert.ok(Array.isArray(rawEvents), `expected an events array, got ${brief(rawEvents)}`);
  return rawEvents.map((event) => Number(asRecord(event, 'one event row').seq));
}

export default {
  'FR-SESS-4: two independent caller processes read the same durable task snapshot, byte for byte': async () => {
    const r = await rig('mcp-multi-snapshot');
    try {
      const a = await r.startCaller('A');
      const created = await createTaskAndSession(a, 'first prompt from caller A');
      await waitForTurnEnded(a, created);

      // A second MCP client PROCESS: its own stdin/stdout, its own gateway, same daemon, same state.
      const b = await r.startCaller('B');
      const statusA = toolJson(await a.callTool('dsh_daemon_status', {}));
      const statusB = toolJson(await b.callTool('dsh_daemon_status', {}));
      assert.notEqual(statusA.gateway.pid, statusB.gateway.pid,
        'the two callers must be two operating-system processes, not one client reused');
      assert.equal(statusA.pid, statusB.pid, 'and both must be talking to the SAME daemon process');

      // The durable task is reached by the caller key, and the id it answers with is the same value.
      const taskB = toolJson(await b.callTool('dsh_task_start', { clientKey: TASK_KEY }));
      assert.equal(taskB.created, false, 'the second caller must reconnect to the durable task, not create one');
      assertId(taskB.task.taskId, 'task', "caller B's task id");
      assert.equal(taskB.task.taskId, created.taskId, 'the task id must be the same value in both callers');
      const taskTextA = await rawToolText(a, 'dsh_task_start', { clientKey: TASK_KEY });
      const taskTextB = await rawToolText(b, 'dsh_task_start', { clientKey: TASK_KEY });
      assert.equal(taskTextB, taskTextA, 'both callers must read the same task record, byte for byte');

      const stateArgs = { taskId: created.taskId, sessionId: created.sessionId };
      const stateTextA = await rawToolText(a, 'dsh_session_state', stateArgs);
      const stateTextB = await rawToolText(b, 'dsh_session_state', stateArgs);
      assert.equal(stateTextB, stateTextA, 'two independent callers must read a byte-identical snapshot of the same task');
      const stateTextA2 = await rawToolText(a, 'dsh_session_state', stateArgs);
      assert.equal(stateTextA2, stateTextA, 'the snapshot must be stable across reads, not equal once by coincidence');

      // Both processes advertise the MCP surface this file drives: a tool that were not listed would
      // make every call below a test of nothing.
      const listedA = await listToolNames(a);
      const listedB = await listToolNames(b);
      assert.deepEqual(listedB, listedA, 'two callers of the same server must be advertised the same tools');
      for (const name of ['dsh_task_start', 'dsh_session_start', 'dsh_session_state', 'dsh_session_events', 'dsh_operation_get', 'dsh_interaction_list', 'dsh_daemon_status', 'dsh_session_prompt', 'dsh_session_wait']) {
        assert.ok(listedA.includes(name), `${name} must be advertised over tools/list, got ${listedA.join(', ')}`);
      }

      // Non-vacuous: the identical payload is a real snapshot with the ids and a completed turn in it.
      const state = JSON.parse(stateTextA);
      assert.equal(state.session.sessionId, created.sessionId);
      assert.equal(state.session.taskId, created.taskId);
      assertId(state.session.sessionId, 'sess', 'the session id in the snapshot');
      assert.equal(state.connection, 'ready', 'both callers read the same connection state');
      assert.equal(state.execution.state, 'idle', 'the prompt turn has ended, so no turn is open');
      assert.ok(state.events >= 3, `the prompt's events must be stored before the snapshots are compared, got ${state.events}`);
    } finally {
      await r.teardown();
    }
  },

  'FR-SESS-4: both callers read identical event cursor semantics and the same sequence set': async () => {
    const r = await rig('mcp-multi-cursor');
    try {
      const a = await r.startCaller('A');
      const created = await createTaskAndSession(a, 'cursor probe');
      await waitForTurnEnded(a, created);
      const b = await r.startCaller('B');
      const args = { taskId: created.taskId, sessionId: created.sessionId };

      // The newest page, and then the page strictly older than it: the two callers must agree on
      // both, and each page must be bounded and non-overlapping.
      const pageTextA = await rawToolText(a, 'dsh_session_events', { ...args, limit: 2 });
      const pageTextB = await rawToolText(b, 'dsh_session_events', { ...args, limit: 2 });
      assert.equal(pageTextB, pageTextA, 'both callers must read the same event page, byte for byte');
      const page = JSON.parse(pageTextA);
      assert.equal(page.sessionId, created.sessionId);
      assert.equal(page.taskId, created.taskId);
      const first = eventSeqs(page.events);
      assert.equal(first.length, 2, `a bounded page must be bounded: ${brief(page.events)}`);
      assert.deepEqual(first, [...first].sort((left, right) => left - right), 'a page must be in ascending sequence order');

      const olderTextA = await rawToolText(a, 'dsh_session_events', { ...args, limit: 20, beforeSeq: first[0] });
      const olderTextB = await rawToolText(b, 'dsh_session_events', { ...args, limit: 20, beforeSeq: first[0] });
      assert.equal(olderTextB, olderTextA, 'both callers must read the same continuation page, byte for byte');
      const older = JSON.parse(olderTextA);
      const rest = eventSeqs(older.events);
      assert.ok(rest.every((seq) => seq < first[0]), `the continuation page must be strictly older: ${rest.join(',')}`);

      // The union of the two pages must be exactly what the journal holds: same set, no duplicate,
      // no gap — the "identical cursor semantics" claim, tied to the durable record.
      const union = [...rest, ...first];
      const inJournal = journal(r.stateDir, 'select seq from events where task_id = ? and session_id = ? order by seq', created.taskId, created.sessionId)
        .map((row) => Number(row.seq));
      assert.deepEqual(union, inJournal, 'the pages both callers read must be exactly the stored sequence set');
      assert.equal(new Set(union).size, union.length, 'no sequence may be delivered twice across pages');

      // The cursor both callers report must agree, and must describe the same stored window.
      const cursorA = JSON.parse(await rawToolText(a, 'dsh_session_state', args)).cursor;
      const cursorB = JSON.parse(await rawToolText(b, 'dsh_session_state', args)).cursor;
      assert.deepEqual(cursorB, cursorA, 'both callers must read the same cursor, field for field');
      assert.equal(cursorA.status, 'ok');
      assert.equal(cursorA.lastSeq, Math.max(...inJournal));
      assert.equal(cursorA.completedThrough, Math.max(...inJournal));
      assert.equal(cursorA.highWater, Math.max(...inJournal));
      assert.equal(cursorA.completeness, 'complete');
      assert.equal(cursorA.gapFrom, null);
      assert.equal(cursorA.gapTo, null);
    } finally {
      await r.teardown();
    }
  },

  'FR-SESS-4: a second attach neither steals nor duplicates the session': async () => {
    const r = await rig('mcp-second-attach');
    try {
      const a = await r.startCaller('A');
      const created = await createTaskAndSession(a, 'attach probe');
      await waitForTurnEnded(a, created);

      const before = journalSessionIds(r.stateDir, created.taskId);
      assert.deepEqual(before, [created.sessionId], 'the task must own exactly one session before the second caller attaches');
      assert.equal(r.host.requestsFor('session.create').length, 1, 'the Host must have seen exactly one session.create');

      const b = await r.startCaller('B');
      const attach = toolJson(await b.callTool('dsh_session_start', {
        taskId: created.taskId, clientKey: SESSION_KEY, cwd: CWD,
      }));
      assert.ok(attach.session !== null, `a second attach must return the session it attached to, not null: ${brief(attach)}`);
      assert.equal(attach.session.sessionId, created.sessionId, 'the second attach must return the SAME session id');
      assert.equal(attach.reused, true, 'the second attach must be reported as a reuse, not a creation');
      assert.equal(attach.operation.operationId, created.createOperationId, 'the attach must reuse the original session.create operation');

      // Neither oracle moved: still one session in the journal, still one session.create on the wire.
      assert.deepEqual(journalSessionIds(r.stateDir, created.taskId), [created.sessionId], 'a second attach must not create a second session');
      assert.equal(r.host.requestsFor('session.create').length, 1, 'a second attach must not reach the Host with another session.create');

      // Not stolen either: caller A still drives the same session, its work is attributed to that
      // session, and the Host sees the second prompt addressed to the SAME Host session as the first.
      const prompt = toolJson(await a.callTool('dsh_session_prompt', {
        taskId: created.taskId, sessionId: created.sessionId, clientKey: 'multi-caller-prompt-2', text: 'A still owns this session',
      }));
      assert.equal(prompt.operation.sessionId, created.sessionId, 'caller A\'s work must still be attributed to the same session');
      assert.equal(prompt.operation.state, 'succeeded', brief(prompt.operation));
      assert.notEqual(prompt.operation.operationId, created.promptOperationId, 'a new client key must be a new operation, not a silent reuse');
      await waitForTurnEnded(a, created);
      const promptsOnWire = r.host.requestsFor('session.prompt');
      assert.equal(promptsOnWire.length, 2, 'both prompts must have reached the Host');
      for (const request of promptsOnWire) {
        assert.equal(request.payload.sessionId, created.hostSessionId,
          'every prompt must be addressed to the Host session this task created — an attach must not redirect it');
      }

      const statusB = toolJson(await b.callTool('dsh_daemon_status', {}));
      assert.equal(statusB.gateway.rejectedToolCalls, 0, 'no call in this case may have been refused');
      assert.deepEqual(journalSessionIds(r.stateDir, created.taskId), [created.sessionId], 'the session count must still be exactly one');
    } finally {
      await r.teardown();
    }
  },

  'FR-SESS-4 / FR-ID-1: a restarted caller process resumes the same cursor and creates no session': async () => {
    const r = await rig('mcp-caller-restart');
    try {
      const a = await r.startCaller('A');
      const created = await createTaskAndSession(a, 'restart probe');
      await waitForTurnEnded(a, created);
      const args = { taskId: created.taskId, sessionId: created.sessionId };

      const b = await r.startCaller('B');
      const bStatus = toolJson(await b.callTool('dsh_daemon_status', {}));
      const bState = await rawToolText(b, 'dsh_session_state', args);
      const bPage = await rawToolText(b, 'dsh_session_events', { ...args, limit: 20 });

      // Caller B's process goes away entirely; a NEW process takes its place.
      const bStop = await b.stop();
      assert.equal(bStop.signal, null, `caller B must exit on its own when its stdin closes, not be killed by the test: ${brief(bStop)}`);
      assert.equal(bStop.code, 0, `caller B must exit cleanly, so "the process went away" is a fact and not a kill by the test: ${brief(bStop)}`);

      const c = await r.startCaller('C');
      const cStatus = toolJson(await c.callTool('dsh_daemon_status', {}));
      assert.notEqual(cStatus.gateway.pid, bStatus.gateway.pid, 'caller C must be a new process, not the one that was stopped');
      assert.equal(cStatus.pid, bStatus.pid, 'caller C must still be talking to the same daemon');

      const taskC = toolJson(await c.callTool('dsh_task_start', { clientKey: TASK_KEY }));
      assert.equal(taskC.task.taskId, created.taskId, 'the new process must resolve the same task id');
      assert.equal(taskC.created, false);
      const attachC = toolJson(await c.callTool('dsh_session_start', { taskId: created.taskId, clientKey: SESSION_KEY, cwd: CWD }));
      assert.ok(attachC.session !== null, `the new process must attach to the existing session, not get null: ${brief(attachC)}`);
      assert.equal(attachC.session.sessionId, created.sessionId, 'the new process must resolve the same session id');
      assert.equal(attachC.reused, true);

      // Same snapshot, same cursor, same page — read by a process that did not exist when B read them.
      assert.equal(await rawToolText(c, 'dsh_session_state', args), bState, 'a restarted caller must read the same snapshot, byte for byte');
      assert.equal(await rawToolText(c, 'dsh_session_events', { ...args, limit: 20 }), bPage, 'a restarted caller must resume at the same cursor and read the same page');

      assert.deepEqual(journalSessionIds(r.stateDir, created.taskId), [created.sessionId], 'reconnecting a new caller must not create a second session');
      assert.equal(r.host.requestsFor('session.create').length, 1, 'reconnecting a new caller must not reach the Host with another session.create');
    } finally {
      await r.teardown();
    }
  },

  'FR-ID-1: taskId, sessionId, turnId, operationId and interactionId are byte-identical across a daemon restart': async () => {
    const r = await rig('mcp-id-restart');
    try {
      const a = await r.startCaller('A');
      const created = await createTaskAndSession(a, 'id stability probe');
      await waitForTurnEnded(a, created);
      const args = { taskId: created.taskId, sessionId: created.sessionId };

      // An OPEN turn, so `execution.currentTurnId` is a live id on both sides of the restart. The
      // fixture numbers prompt events from a global counter and fixture-emitted events from a
      // per-session one; advancing the per-session counter past what is stored is what keeps the
      // emitted frame from colliding with an already-stored sequence (which the daemon would
      // correctly drop as a duplicate).
      const storedSeqs = eventSeqs(toolJson(await a.callTool('dsh_session_events', { ...args, limit: 20 })).events);
      r.host.skipSequences(created.hostSessionId, Math.max(...storedSeqs));
      r.host.emitTurnStart(created.hostSessionId);
      await waitFor(async () => {
        const state = toolJson(await a.callTool('dsh_session_state', args));
        return typeof state.execution.currentTurnId === 'string';
      }, { timeoutMs: 10000, what: 'the open turn to be observed over MCP' });

      // An answerable host request, so an interactionId exists at all.
      const approval = r.host.emitApprovalRequested(created.hostSessionId);
      await waitFor(async () => {
        const listed = toolJson(await a.callTool('dsh_interaction_list', { taskId: created.taskId }));
        return listed.interactions.length >= 1;
      }, { timeoutMs: 10000, what: 'the approval frame to be recorded as an interaction' });

      const before = {
        taskId: toolJson(await a.callTool('dsh_task_start', { clientKey: TASK_KEY })).task.taskId,
        sessionId: toolJson(await a.callTool('dsh_session_state', args)).session.sessionId,
        turnId: toolJson(await a.callTool('dsh_session_state', args)).execution.currentTurnId,
        operationId: toolJson(await a.callTool('dsh_operation_get', { operationId: created.promptOperationId })).operation.operationId,
        interactionId: toolJson(await a.callTool('dsh_interaction_list', { taskId: created.taskId })).interactions[0].interactionId,
      };
      assertId(before.taskId, 'task', 'taskId before the restart');
      assertId(before.sessionId, 'sess', 'sessionId before the restart');
      assertId(before.turnId, 'turn', 'turnId before the restart');
      assertId(before.operationId, 'op', 'operationId before the restart');
      assertId(before.interactionId, 'int', 'interactionId before the restart');

      // Every one of those ids is a durable record of its own kind, in the journal, before the restart.
      for (const [kind, table, column, id] of [
        ['task', 'tasks', 'task_id', before.taskId],
        ['session', 'sessions', 'session_id', before.sessionId],
        ['turn', 'turns', 'turn_id', before.turnId],
        ['operation', 'operations', 'operation_id', before.operationId],
        ['interaction', 'interactions', 'interaction_id', before.interactionId],
      ]) {
        assert.equal(journal(r.stateDir, `select ${column} from ${table} where ${column} = ?`, id).length, 1,
          `the ${kind} id the caller received must exist as a ${table} record`);
      }
      assert.equal(journal(r.stateDir, 'select interaction_id from interactions where host_rpc_id = ?', approval.rpcId).length, 1,
        'the interaction must be the one the Host asked about');

      // A different process, on the same state directory and the same Host, reads the ids again.
      const firstDaemonPid = toolJson(await a.callTool('dsh_daemon_status', {})).pid;
      await r.stopCallers();
      await r.restartDaemon();
      const c = await r.startCaller('C');
      const secondDaemonPid = toolJson(await c.callTool('dsh_daemon_status', {})).pid;
      assert.notEqual(secondDaemonPid, firstDaemonPid,
        'the daemon must be a new operating-system process, or "across a restart" means nothing');

      const reAttachAfterRestart = toolJson(await c.callTool('dsh_session_start', { taskId: before.taskId, clientKey: SESSION_KEY, cwd: CWD }));
      assert.ok(reAttachAfterRestart.session !== null,
        `the re-attach after a restart must return the durable session, not null: ${brief(reAttachAfterRestart)}`);
      const after = {
        taskId: toolJson(await c.callTool('dsh_task_start', { clientKey: TASK_KEY })).task.taskId,
        sessionId: reAttachAfterRestart.session.sessionId,
        turnId: toolJson(await c.callTool('dsh_session_state', args)).execution.currentTurnId,
        operationId: toolJson(await c.callTool('dsh_operation_get', { operationId: before.operationId })).operation.operationId,
        interactionId: toolJson(await c.callTool('dsh_interaction_list', { taskId: before.taskId })).interactions[0].interactionId,
      };
      assert.equal(after.taskId, before.taskId, 'taskId must not change across a daemon restart');
      assert.equal(after.sessionId, before.sessionId, 'sessionId must not change across a daemon restart');
      assert.equal(after.turnId, before.turnId, 'turnId must not change across a daemon restart');
      assert.equal(after.operationId, before.operationId, 'operationId must not change across a daemon restart');
      assert.equal(after.interactionId, before.interactionId, 'interactionId must not change across a daemon restart');

      // The re-attach is the same session, not a replacement: one session, one session.create, ever.
      assert.deepEqual(journalSessionIds(r.stateDir, before.taskId), [before.sessionId], 'the session count must still be exactly one after the restart');
      assert.equal(r.host.requestsFor('session.create').length, 1, 'the re-attach after a restart must not create another Host session');
      const reAttach = toolJson(await c.callTool('dsh_session_start', { taskId: before.taskId, clientKey: SESSION_KEY, cwd: CWD }));
      assert.equal(reAttach.reused, true);
      assert.equal(reAttach.operation.operationId, created.createOperationId, 'the session.create operation must be the same durable operation after the restart');
    } finally {
      await r.teardown();
    }
  },

  'FR-ID-1: the ids are in the journal, and the intent record is durable before the Host sees the send': async () => {
    const r = await rig('mcp-journal-order');
    try {
      const a = await r.startCaller('A');
      const task = toolJson(await a.callTool('dsh_task_start', { clientKey: TASK_KEY }));
      const session = toolJson(await a.callTool('dsh_session_start', {
        taskId: task.task.taskId, clientKey: SESSION_KEY, cwd: CWD,
      }));
      const taskId = task.task.taskId;
      const sessionId = session.session.sessionId;
      const createOperationId = session.operation.operationId;
      assert.equal(journalSessionIds(r.stateDir, taskId).length, 1, 'the created session must be in the journal');

      // Session creation is a dispatch too: its durable record must hold what went on the wire.
      const createOnWire = r.host.requestsFor('session.create')[0];
      assert.ok(createOnWire, 'the Host must have received the session.create');
      const createDispatch = journal(r.stateDir, 'select method, state, payload_json from outbox where operation_id = ?', createOperationId);
      assert.equal(createDispatch.length, 1, 'the session.create dispatch record must be in the journal');
      assert.equal(createDispatch[0].method, 'session.create');
      assert.equal(createDispatch[0].state, 'acknowledged');
      assert.deepEqual(JSON.parse(String(createDispatch[0].payload_json)), createOnWire.payload,
        'the durable dispatch record must hold the exact body session.create went out with');

      // Hold the Host's reply open. The request is then provably ON THE WIRE and unacknowledged,
      // which is the only window in which "recorded before the send" is observable from outside.
      // 10s is free: the daemon is killed below without waiting for this reply, so the hold costs the
      // case nothing while making the "in flight and unacknowledged" window far wider than the three
      // journal reads that have to happen inside it.
      r.host.delayFor('session.prompt', 10000);
      const pending = a.callTool('dsh_session_prompt', {
        taskId, sessionId, clientKey: 'multi-caller-prompt-order', text: 'record me before you send me',
      });
      // Nobody is allowed to await this without a handler: after the SIGKILL below it settles
      // without an answer, and an unhandled rejection would take the whole runner down.
      const settled = pending.then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error }),
      );

      await waitFor(() => r.host.requestsFor('session.prompt').length === 1,
        { timeoutMs: 20000, what: 'the Host to receive the prompt while its reply is still withheld' });
      const onWire = r.host.requestsFor('session.prompt')[0];

      // ---- while the dispatch is in flight, the journal must ALREADY hold the intent ----
      const intents = journal(r.stateDir,
        "select operation_id, state, request_id, created_at from operations where task_id = ? and kind = 'session.prompt'", taskId);
      assert.equal(intents.length, 1, 'exactly one prompt intent must be recorded');
      const intent = intents[0];
      assert.equal(intent.state, 'dispatching',
        `the intent must be committed before the send is acknowledged, got ${String(intent.state)}`);
      assertId(String(intent.request_id), 'op', "the journal's requestId for the in-flight intent");
      const dispatches = journal(r.stateDir,
        'select request_id, method, state, payload_json, created_at from outbox where operation_id = ?', String(intent.operation_id));
      assert.equal(dispatches.length, 1,
        'the durable dispatch record must exist before the send completes; a record written after the send leaves nothing here');
      const dispatch = dispatches[0];
      assert.equal(dispatch.method, 'session.prompt');
      assert.equal(dispatch.state, 'dispatching');
      assert.equal(String(dispatch.request_id), String(intent.request_id), 'the dispatch record must carry the intent request id');
      assert.deepEqual(JSON.parse(String(dispatch.payload_json)), onWire.payload,
        'the durable dispatch record must hold the exact body that went on the wire');
      assert.ok(Number(intent.created_at) <= Number(dispatch.created_at),
        `the intent must be recorded before its dispatch record: ${String(intent.created_at)} > ${String(dispatch.created_at)}`);
      assert.ok(Number(dispatch.created_at) <= Number(onWire.at),
        `the dispatch record must be written no later than the Host saw the request: ${String(dispatch.created_at)} > ${String(onWire.at)}`);

      // ---- the crash window: whatever survives was written by a process that never saw a reply ----
      const killed = await r.killDaemon();
      assert.equal(killed.signal, 'SIGKILL', `the daemon must die hard, got ${JSON.stringify({ code: killed.code, signal: killed.signal })}`);
      const afterCrash = journal(r.stateDir,
        "select operation_id, state, request_id from operations where task_id = ? and kind = 'session.prompt'", taskId);
      assert.equal(afterCrash.length, 1, 'the intent must still be on disk after the process that wrote it died mid-dispatch');
      assert.equal(String(afterCrash[0].operation_id), String(intent.operation_id), 'the id must not be rewritten by a crash');
      assert.equal(afterCrash[0].state, 'dispatching', 'nothing may have swept the record before the kill');

      await a.stop();
      // The gateway either goes silent (the request rejects) or answers with a JSON-RPC failure.
      // Both are honest; a tool result claiming the prompt succeeded is not.
      const outcome = await settled;
      const claimedSuccess = outcome.response !== null
        && outcome.response.error === undefined
        && outcome.response.result?.isError !== true;
      assert.equal(claimedSuccess, false,
        `a dispatch whose daemon died before acknowledging it must not come back as a success: ${brief(outcome.response)}`);
      assert.ok(outcome.error instanceof Error || outcome.response?.error !== undefined,
        `the in-flight call must end with a reported failure in one of the two shapes: ${brief(outcome)}`);

      // A new daemon reconciles instead of re-sending, and reports the id the caller could not get.
      await r.restartDaemon();
      const c = await r.startCaller('C');
      const operation = toolJson(await c.callTool('dsh_operation_get', { operationId: String(intent.operation_id) }), { allowError: true });
      assert.equal(operation.operation.operationId, String(intent.operation_id), 'the operation id must survive the crash');
      assert.equal(operation.operation.state, 'uncertain', 'an interrupted dispatch must be uncertain, never succeeded');
      assert.match(String(operation.operation.uncertainReason), /crash/i, brief(operation.operation));
      assert.equal(r.host.requestsFor('session.prompt').length, 1,
        'the reconciled process must never blindly re-send the prompt the Host may already have applied');
      assert.equal(r.host.requestsFor('session.create').length, 1);

      // Every id the caller holds is a durable record of its own kind. (`turnId` is asserted in the
      // case above, where a turn actually ran before the restart; here the dispatch was killed
      // before the Host's turn could be observed, and the daemon's post-restart history refetch is
      // what recovers those events — timing that this case deliberately does not depend on.)
      assert.equal(journal(r.stateDir, 'select task_id from tasks where task_id = ?', taskId).length, 1);
      assert.equal(journal(r.stateDir, 'select session_id from sessions where session_id = ?', sessionId).length, 1);
      assert.equal(journal(r.stateDir, 'select operation_id from operations where operation_id = ?', createOperationId).length, 1);
      // This operation id was never handed to the caller — the call it belonged to died before it
      // could answer. It is read straight out of the journal, which is the point: the id was durable
      // before the send, not minted afterwards to describe an outcome.
      assert.equal(journal(r.stateDir, 'select operation_id from operations where operation_id = ?', String(intent.operation_id)).length, 1);
      assert.equal(journalSessionIds(r.stateDir, taskId).length, 1, 'still exactly one session for the task');
    } finally {
      await r.teardown();
    }
  },
};
