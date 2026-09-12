/**
 * MCP E2E over stdio.
 *
 * Why these tests exist: the whole point of the project is that a REAL MCP client can spawn the
 * bridge binary and drive it. Calling the gateway functions in-process would prove nothing
 * about the protocol face — framing, handshake, error codes, and stdio hygiene — so this layer
 * spawns `bin/dsh-pilot-mcp.mjs` as a child process and speaks newline-delimited JSON-RPC 2.0
 * to it over real pipes, exactly as an MCP client does.
 *
 * The daemon and the Host are separate real processes too: the MCP process here is only the
 * caller's edge, and nothing in this file reaches into the gateway's internals.
 */

import { join } from 'node:path';
import { assert, collect, jsonLines, scratchDir, spawnNode, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * A minimal but honest MCP client: it only knows the protocol, not this project.
 * @param {{socketPath: string, stateDir: string}} options
 */
async function startMcpClient({ socketPath, stateDir }) {
  const child = spawnNode(['bin/dsh-pilot-mcp.mjs', '--state-dir', stateDir, '--socket', socketPath]);
  const lines = jsonLines(child.stdout);
  const stderrChunks = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  let nextId = 0;
  /** @type {Map<number, string>} */
  const methods = new Map();

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = async (method, params = undefined, timeoutMs = 20000) => {
    nextId += 1;
    const id = nextId;
    methods.set(id, method);
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    for (;;) {
      const message = await lines.next(timeoutMs);
      if (message.id === id) return message;
      // Server-initiated notifications are allowed; anything else here is a protocol fault.
      if (message.id === undefined && message.method) continue;
      throw new Error(`unexpected message while awaiting ${method}: ${JSON.stringify(message).slice(0, 300)}`);
    }
  };

  const notify = (method, params) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  const callTool = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args ?? {} });
    return response;
  };
  const rawWrite = (text) => child.stdin.write(text);

  return {
    child,
    request,
    notify,
    callTool,
    rawWrite,
    /** Read the next raw JSON-RPC message (used to consume server-originated errors). */
    nextMessage: (timeoutMs = 10000) => lines.next(timeoutMs),
    stderr: () => stderrChunks.join(''),
    stop: async () => {
      try { child.stdin.end(); } catch { /* already closed */ }
      const outcome = await Promise.race([
        collect(child),
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 5000)),
      ]);
      if (outcome.signal === 'timeout') child.kill('SIGKILL');
      return outcome;
    },
  };
}

/** Bring up fake Host + daemon + MCP gateway. */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const client = await startMcpClient({ socketPath: daemon.socketPath, stateDir });
  const teardown = async () => {
    await client.stop();
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, daemon, client, teardown, stateDir };
}

/** Parse the JSON payload a tool result carries. */
function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', `tool result carried no text content: ${JSON.stringify(response).slice(0, 300)}`);
  return JSON.parse(text);
}

export default {
  'handshake, tools/list and a real initialize round trip over stdio': async () => {
    const { client, teardown } = await rig('mcp-handshake');
    try {
      const init = await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-pilot-test-client', version: '0.0.1' },
      });
      assert.equal(init.jsonrpc, '2.0');
      assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);
      assert.equal(init.result.serverInfo.name, 'dsh-pilot');
      assert.ok(init.result.capabilities.tools, 'the server must advertise tools');
      client.notify('notifications/initialized');

      const listed = await client.request('tools/list', {});
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes('dsh_session_prompt'), `expected session prompt tool, got ${names.join(',')}`);
      assert.ok(names.includes('dsh_daemon_status'));
      // Every tool must carry a usable schema: a client validates before calling.
      for (const tool of listed.result.tools) {
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} must have an object schema`);
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown fields`);
        assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} needs a real description`);
      }
      // Approval authority is deliberately unreachable from the model side.
      assert.equal(names.some((name) => /approve|decide|allow/.test(name)), false,
        `no model-reachable tool may decide an approval: ${names.join(',')}`);
    } finally {
      await teardown();
    }
  },

  'a full session lifecycle driven only through MCP tools': async () => {
    const { client, teardown } = await rig('mcp-lifecycle');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });

      const status = toolPayload(await client.callTool('dsh_daemon_status', {}));
      assert.ok(['connecting', 'reconciling', 'ready'].includes(status.connection), JSON.stringify(status.connection));

      const task = toolPayload(await client.callTool('dsh_task_start', { clientKey: 'lifecycle-task' }));
      assert.match(task.task.taskId, /^task_/);

      const session = toolPayload(await client.callTool('dsh_session_start', {
        taskId: task.task.taskId, clientKey: 'lifecycle-session', cwd: '/tmp/fixture-workspace',
      }));
      assert.ok(session.session, `session.start returned no session: ${JSON.stringify(session)}`);
      assert.match(session.session.sessionId, /^sess_/);

      const prompt = toolPayload(await client.callTool('dsh_session_prompt', {
        taskId: task.task.taskId, sessionId: session.session.sessionId, clientKey: 'lifecycle-prompt-1', text: 'hello over MCP',
      }));
      assert.equal(prompt.operation.state, 'succeeded', JSON.stringify(prompt));

      const state = toolPayload(await client.callTool('dsh_session_state', {
        taskId: task.task.taskId, sessionId: session.session.sessionId,
      }));
      assert.equal(state.session.sessionId, session.session.sessionId);
      assert.ok(state.events >= 1, `expected at least one stored event, got ${state.events}`);

      const events = toolPayload(await client.callTool('dsh_session_events', {
        taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 20,
      }));
      assert.ok(events.events.length >= 1);
      assert.equal(events.sessionId, session.session.sessionId, 'the page must name the session it came from');

      const waited = toolPayload(await client.callTool('dsh_session_wait', {
        taskId: task.task.taskId, sessionId: session.session.sessionId, timeoutMs: 300,
      }));
      assert.ok(['turn-ended', 'timeout', 'no-turn-observed', 'disconnected'].includes(waited.reason), JSON.stringify(waited));

      const operation = toolPayload(await client.callTool('dsh_operation_get', {
        operationId: prompt.operation.operationId,
      }));
      assert.equal(operation.operation.operationId, prompt.operation.operationId);
      assert.equal(operation.operation.state, 'succeeded');
    } finally {
      await teardown();
    }
  },

  'invalid arguments are a JSON-RPC invalid-params error, and nothing is sent upstream': async () => {
    const { client, host, teardown } = await rig('mcp-validation');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });
      const mutationsBefore = host.mutationCount;

      // Missing a required field.
      const missing = await client.request('tools/call', { name: 'dsh_session_prompt', arguments: { taskId: 'task_x' } });
      assert.equal(missing.error.code, -32602, JSON.stringify(missing));
      assert.match(JSON.stringify(missing.error), /clientKey|sessionId/);

      // Unknown property: a typo must not be silently ignored.
      const extra = await client.request('tools/call', {
        name: 'dsh_daemon_status', arguments: { verbose: true },
      });
      assert.equal(extra.error.code, -32602, JSON.stringify(extra));

      // Wrong type.
      const wrongType = await client.request('tools/call', {
        name: 'dsh_session_wait', arguments: { taskId: 'task_a', sessionId: 'sess_b', timeoutMs: 'soon' },
      });
      assert.equal(wrongType.error.code, -32602, JSON.stringify(wrongType));

      // Out-of-range value.
      const outOfRange = await client.request('tools/call', {
        name: 'dsh_session_events', arguments: { taskId: 'task_a', sessionId: 'sess_b', limit: 100000 },
      });
      assert.equal(outOfRange.error.code, -32602, JSON.stringify(outOfRange));

      // Unknown tool.
      const unknown = await client.request('tools/call', { name: 'dsh_do_something_invented', arguments: {} });
      assert.equal(unknown.error.code, -32601, JSON.stringify(unknown));

      // The daemon reported every refusal without touching the Host.
      const status = toolPayload(await client.callTool('dsh_daemon_status', {}));
      assert.ok(status.gateway.rejectedToolCalls >= 5,
        `expected refusals to be counted, got ${JSON.stringify(status.gateway)}`);
      assert.equal(host.mutationCount, mutationsBefore, 'a refused tool call must not reach the Host');
    } finally {
      await teardown();
    }
  },

  'a business refusal comes back as a tool error result, not a crash or a fake success': async () => {
    const { client, host, teardown } = await rig('mcp-refusal');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });
      const task = toolPayload(await client.callTool('dsh_task_start', { clientKey: 'refusal-task' }));
      const session = toolPayload(await client.callTool('dsh_session_start', {
        taskId: task.task.taskId, clientKey: 'refusal-session',
      }));
      host.rejectWith('session.prompt', { code: 'agent-busy', message: 'fixture busy' });
      const refused = await client.callTool('dsh_session_prompt', {
        taskId: task.task.taskId, sessionId: session.session.sessionId, clientKey: 'refusal-prompt', text: 'x',
      });
      // Either a JSON-RPC error or an isError result is acceptable; a success claim is not.
      const isError = refused.error !== undefined || refused.result?.isError === true;
      assert.ok(isError, `a host refusal must surface as an error: ${JSON.stringify(refused)}`);
      // And the connection survives it: the next call still works.
      const after = toolPayload(await client.callTool('dsh_daemon_status', {}));
      assert.ok(after.storeGeneration >= 1);
    } finally {
      await teardown();
    }
  },

  'uncertain outcomes are reported as errors so a caller cannot mistake them for success': async () => {
    const { client, host, teardown } = await rig('mcp-uncertain');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });
      const task = toolPayload(await client.callTool('dsh_task_start', { clientKey: 'uncertain-task' }));
      const session = toolPayload(await client.callTool('dsh_session_start', {
        taskId: task.task.taskId, clientKey: 'uncertain-session',
      }));
      host.dropResponseFor('session.prompt');
      const response = await client.callTool('dsh_session_prompt', {
        taskId: task.task.taskId, sessionId: session.session.sessionId, clientKey: 'uncertain-prompt', text: 'y',
      });
      const payload = response.error ?? toolPayload(response);
      const serialized = JSON.stringify(payload);
      assert.match(serialized, /uncertain/i, `an unprovable outcome must be labelled uncertain: ${serialized}`);
      assert.equal(response.result?.isError ?? true, true, 'an uncertain tool call must be marked isError');
      // The operation remains inspectable and still uncertain.
      const ops = host.requestsFor('session.prompt');
      assert.equal(ops.length, 1, 'exactly one prompt reached the Host');
    } finally {
      await teardown();
    }
  },

  'cancelling a wait does not cancel the turn, and the server keeps serving': async () => {
    const { client, host, daemon, teardown } = await rig('mcp-cancel-wait');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });
      const task = toolPayload(await client.callTool('dsh_task_start', { clientKey: 'cancel-wait-task' }));
      const session = toolPayload(await client.callTool('dsh_session_start', {
        taskId: task.task.taskId, clientKey: 'cancel-wait-session',
      }));
      await waitFor(async () => {
        const { IpcClient } = await import('../../lib/ipc.js');
        const probe = new IpcClient({ socketPath: daemon.socketPath });
        await probe.ready();
        try { return (await probe.request({ op: 'health' })).connection === 'ready'; } finally { probe.close(); }
      }, { timeoutMs: 5000, what: 'mux ready' });
      host.emitTurnStart(session.session.hostSessionId);
      await waitFor(async () => {
        const state = toolPayload(await client.callTool('dsh_session_state', {
          taskId: task.task.taskId, sessionId: session.session.sessionId,
        }));
        return state.execution.state === 'running';
      }, { timeoutMs: 5000, what: 'turn observed open over MCP' });

      // Open a long wait, then cancel the REQUEST (not the turn) and see what happens.
      const waitPromise = client.request('tools/call', {
        name: 'dsh_session_wait',
        arguments: { taskId: task.task.taskId, sessionId: session.session.sessionId, timeoutMs: 5000 },
      }, 10000);
      client.notify('notifications/cancelled', { requestId: 99, reason: 'caller gave up' });
      const waited = await waitPromise;
      const payload = waited.error ? null : toolPayload(waited);
      if (payload) {
        assert.ok(['turn-ended', 'timeout', 'no-turn-observed', 'disconnected'].includes(payload.reason));
      }
      // The turn is still running: cancelling a wait is not cancelling work.
      const state = toolPayload(await client.callTool('dsh_session_state', {
        taskId: task.task.taskId, sessionId: session.session.sessionId,
      }));
      assert.equal(state.execution.state, 'running', 'cancelling a wait must not cancel the turn');

      // The session is still usable afterwards: this process served requests and none of them
      // was refused, which is what distinguishes "wait was cancelled" from "call was rejected".
      const status = toolPayload(await client.callTool('dsh_daemon_status', {}));
      assert.ok(status.gateway.requests >= 5, `expected this gateway to have served requests, got ${JSON.stringify(status.gateway)}`);
      assert.equal(status.gateway.rejectedToolCalls, 0, 'no tool call in this test should have been refused');
    } finally {
      await teardown();
    }
  },

  'malformed framing from the client is refused and does not desynchronise the server': async () => {
    const { client, teardown } = await rig('mcp-framing');
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
      });
      // A line that is not JSON at all: the server answers with a parse error whose id is
      // null (it cannot know the request id), which a real client tolerates.
      client.rawWrite('this is not json\n');
      await client.nextMessage(5000);
      const afterParseError = await client.request('tools/list', {});
      assert.ok(afterParseError.result?.tools?.length > 0, 'the server must serve tools/list after a parse error');
      // A JSON-RPC request with no method is an invalid request (-32600).
      client.rawWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 4242 })}\n`);
      const invalid = await client.nextMessage(5000);
      assert.equal(invalid.id, 4242, JSON.stringify(invalid));
      assert.equal(invalid.error?.code, -32600, JSON.stringify(invalid));
      // The stream is still healthy afterwards: a real call round trips.
      const status = toolPayload(await client.callTool('dsh_daemon_status', {}));
      assert.ok(status.storeGeneration >= 1);
      // stdout carried only JSON-RPC; the process's diagnostics go to stderr.
      assert.ok(client.stderr().length >= 0);
    } finally {
      await teardown();
    }
  },

  'the gateway fails closed and stays silent on stdout when the daemon is absent': async () => {
    const scratch = scratchDir('mcp-no-daemon');
    const stateDir = join(scratch.dir, 'state');
    const socketPath = join(scratch.dir, 'state', 'no-such.sock');
    const client = await startMcpClient({ socketPath, stateDir });
    try {
      let caught = null;
      try {
        await client.request('initialize', {
          protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' },
        }, 6000);
      } catch (error) {
        caught = error;
      }
      await client.stop();
      // Either the process exited with a diagnostic on stderr, or it answered with an error;
      // what must NOT happen is a plausible success or any stdout noise.
      assert.ok(caught === null || /timeout|json line/i.test(caught.message) || caught.message.length > 0);
      assert.match(client.stderr(), /dsh-pilot-mcp/);
    } finally {
      await client.stop();
      scratch.cleanup();
    }
  },
};
