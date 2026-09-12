/**
 * The MCP tool surface, with strict schemas.
 *
 * Why this file exists: tool definitions are the bridge's public contract with a caller, and
 * they are also the enforcement point for "never fake a capability". Two rules are encoded
 * here deliberately:
 *
 *   1. Every tool maps 1:1 onto a single daemon operation. A tool never performs two
 *      mutations, and a tool that cannot be served is simply absent rather than returning a
 *      plausible-looking default.
 *   2. There is no approval/decision tool. Human authority is reached through a separate
 *      operator channel, so a model — or text inside a document the model read — can never
 *      authorize an approval.
 *
 * Schemas are validated by this module's own validator (a JSON-Schema subset) instead of a
 * dependency, and `additionalProperties: false` everywhere means a typo is an error rather
 * than a silently ignored field.
 */

/** @typedef {{name: string, description: string, inputSchema: object, op: (args: object) => object}} McpTool */

/** @type {McpTool[]} */
export const MCP_TOOLS = [
  {
    name: 'dsh_daemon_status',
    description: 'Report the bridge daemon state: connection state, store generation, event counters, negotiated host capabilities and effective limits. Read-only.',
    inputSchema: objectSchema({}, []),
    op: () => ({ op: 'health' }),
  },
  {
    name: 'dsh_task_start',
    description: 'Create or reuse the durable task for this caller key. The task survives daemon restarts and owns all sessions created under it.',
    inputSchema: objectSchema({
      clientKey: stringSchema({ description: 'Stable caller key identifying this task.' }),
      label: stringSchema({ description: 'Optional human label.', maxLength: 120 }),
    }, ['clientKey']),
    op: (args) => ({ op: 'task.ensure', clientKey: args.clientKey, label: args.label ?? null }),
  },
  {
    name: 'dsh_session_start',
    description: 'Start a durable DSH session for a task, or return the session already created for this client key. The session identity is stable across restarts.',
    inputSchema: objectSchema({
      taskId: stringSchema({ description: 'Task id from dsh_task_start.' }),
      clientKey: stringSchema({ description: 'Idempotency key; the same key returns the same session.' }),
      cwd: stringSchema({ description: 'Absolute working directory to own.', maxLength: 4000 }),
    }, ['taskId', 'clientKey']),
    op: (args) => ({
      op: 'session.start',
      taskId: args.taskId,
      clientKey: args.clientKey,
      cwd: args.cwd ?? null,
    }),
  },
  {
    name: 'dsh_session_prompt',
    description: 'Send a prompt to a session. Durable before send: if the outcome cannot be proven the operation is reported as uncertain rather than retried.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({ description: 'Bridge session id from dsh_session_start.' }),
      clientKey: stringSchema({ description: 'Idempotency key for this prompt.' }),
      text: stringSchema({ description: 'Prompt text.', maxLength: 65536 }),
      mode: enumSchema(['queue', 'steer']),
    }, ['taskId', 'sessionId', 'clientKey', 'text']),
    op: (args) => ({
      op: 'session.prompt',
      taskId: args.taskId,
      sessionId: args.sessionId,
      clientKey: args.clientKey,
      text: args.text,
      mode: args.mode ?? 'queue',
    }),
  },
  {
    name: 'dsh_session_state',
    description: 'Read one session full state: connection (transport) separately from execution (turn), current turn, queue scopes, recent operations and pending interactions.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
    }, ['taskId', 'sessionId']),
    op: (args) => ({ op: 'session.state', taskId: args.taskId, sessionId: args.sessionId }),
  },
  {
    name: 'dsh_session_events',
    description: 'Read a bounded, incremental page of a session event log. Reports completeness and any recorded gap explicitly; an incomplete stream is never presented as complete.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
      beforeSeq: integerSchema({ description: 'Return events with seq strictly below this value.', minimum: 0 }),
      limit: integerSchema({ description: 'Page size (1..200).', minimum: 1, maximum: 200 }),
    }, ['taskId', 'sessionId']),
    op: (args) => ({
      op: 'session.events',
      taskId: args.taskId,
      sessionId: args.sessionId,
      beforeSeq: args.beforeSeq ?? null,
      limit: args.limit ?? 50,
    }),
  },
  {
    name: 'dsh_session_wait',
    description: 'Wait a bounded time for the current turn to reach a terminal state. Returns a closed-set reason (turn-ended, timeout, disconnected, no-turn-observed) and never blocks past the deadline. Cancelling this wait does not cancel the turn.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
      timeoutMs: integerSchema({ description: 'Deadline in ms (50..120000).', minimum: 50, maximum: 120000 }),
    }, ['taskId', 'sessionId']),
    op: (args) => ({
      op: 'session.wait',
      taskId: args.taskId,
      sessionId: args.sessionId,
      timeoutMs: args.timeoutMs ?? 30000,
    }),
  },
  {
    name: 'dsh_session_cancel',
    description: 'Cancel the active turn of a session. Turn cancellation is separate from queue clearing, and an acknowledged cancel is not evidence that a tool subprocess stopped; the response says what was actually observed.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
      clientKey: stringSchema({ description: 'Idempotency key for this cancel.' }),
    }, ['taskId', 'sessionId', 'clientKey']),
    op: (args) => ({
      op: 'session.cancel',
      taskId: args.taskId,
      sessionId: args.sessionId,
      clientKey: args.clientKey,
    }),
  },
  {
    name: 'dsh_queue_clear',
    description: 'Clear the daemon-local pending queue for a session and report the remote queue scope separately (the remote scope is not cleared by this call).',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
    }, ['taskId', 'sessionId']),
    op: (args) => ({ op: 'queue.clear', taskId: args.taskId, sessionId: args.sessionId }),
  },
  {
    name: 'dsh_operation_get',
    description: 'Read one operation durable record, including whether its outcome is proven, uncertain, or refused.',
    inputSchema: objectSchema({
      operationId: stringSchema({ description: 'Operation id returned by a mutating tool.' }),
    }, ['operationId']),
    op: (args) => ({ op: 'ops.get', operationId: args.operationId }),
  },
  {
    name: 'dsh_interaction_list',
    description: 'List pending and decided approval/question interactions for a task. Listing is read-only; deciding them is deliberately not available to this interface.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      state: enumSchema(['pending', 'answered', 'rejected', 'expired', 'revoked', 'uncertain']),
    }, ['taskId']),
    op: (args) => ({ op: 'interaction.list', taskId: args.taskId, state: args.state ?? null }),
  },
];

/** @param {string} name */
export function toolByName(name) {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Validate tool arguments against the declared schema, then build the IPC request.
 * @param {McpTool} tool
 * @param {unknown} args
 * @returns {{ok: true, request: object} | {ok: false, errors: string[]}}
 */
export function validateToolInput(tool, args) {
  const errors = [];
  const value = args === undefined || args === null ? {} : args;
  validateAgainst(tool.inputSchema, value, '', errors);
  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };
  return { ok: true, request: tool.op(value) };
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateAgainst(schema, value, path, errors) {
  const where = path || '(root)';
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${where}: expected object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${where}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) errors.push(`${where}.${key}: unexpected property`);
        continue;
      }
      if (child === undefined) continue;
      validateAgainst(childSchema, child, path ? `${path}.${key}` : key, errors);
    }
    return;
  }
  if (value === undefined) return;
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') { errors.push(`${where}: expected string`); return; }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: exceeds maxLength ${schema.maxLength}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: below minLength ${schema.minLength}`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) { errors.push(`${where}: expected integer`); return; }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: above maximum ${schema.maximum}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) { errors.push(`${where}: expected number`); return; }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${where}: expected boolean`);
      break;
    default:
      if (schema.enum) {
        if (!schema.enum.includes(value)) errors.push(`${where}: expected one of ${schema.enum.join(', ')}`);
        return;
      }
      errors.push(`${where}: unsupported schema type ${String(schema.type)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${where}: expected one of ${schema.enum.join(', ')}`);
  }
}

/** @param {object} properties @param {string[]} required */
function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** @param {object} [extra] */
function stringSchema(extra = {}) {
  return { type: 'string', minLength: 1, ...extra };
}

/** @param {object} [extra] */
function integerSchema(extra = {}) {
  return { type: 'integer', ...extra };
}

/** @param {string[]} values */
function enumSchema(values) {
  return { type: 'string', enum: values };
}
