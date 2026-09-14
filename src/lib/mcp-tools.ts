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

/**
 * One node of the JSON-Schema subset this validator implements.
 *
 * `type` is deliberately left as an open `string` rather than a closed literal union of the
 * keywords handled below: `validateAgainst` has a `default` branch whose whole job is to REPORT a
 * `type` keyword it does not implement (`unsupported schema type …`), so a union would have made
 * the one branch that exists for unknown input unreachable. Every keyword the validator reads is
 * typed; the tag itself stays as open as the wire.
 */
export interface ToolSchema {
  readonly type?: string;
  readonly properties?: Record<string, ToolSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  /** For `type: 'array'`: the schema every element must satisfy. */
  readonly items?: ToolSchema;
}

/** One advertised tool: its schema, and the single daemon request it maps onto. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  /**
   * Build the daemon request for already-validated arguments. The argument bag is a
   * string-keyed record because that is what came off the wire and what `validateToolInput`
   * has just checked against the schema; the request it returns is sent verbatim as JSON.
   */
  readonly op: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** Outcome of checking one call's arguments: the built request, or the schema violations. */
export type ToolValidation =
  | { readonly ok: true; readonly request: Record<string, unknown> }
  | { readonly ok: false; readonly errors: string[] };

export const MCP_TOOLS: readonly McpTool[] = [
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
    description: 'Clear the daemon-local pending queue for a session, and optionally ask the Host to ' +
      'remove specific queued items. A queued item is removed only by naming it in `itemIds`, and only ' +
      'if it appears in the last `session/queue` snapshot observed for THAT session; an id that was ' +
      'never observed is refused without being sent, because the Host has no idempotency key for this ' +
      'call and a guessed id would be a destructive guess. Turn cancellation is a separate operation ' +
      '(`dsh_session_cancel`) and never removes pending work.',
    inputSchema: objectSchema({
      taskId: stringSchema({}),
      sessionId: stringSchema({}),
      itemIds: arraySchema(stringSchema({
        description: 'Host queue item ids to remove, as observed in this session\'s `session/queue` ' +
          'snapshot. Omit to leave the Host queue untouched.',
      })),
    }, ['taskId', 'sessionId']),
    op: (args) => ({
      op: 'queue.clear',
      taskId: args.taskId,
      sessionId: args.sessionId,
      // Forwarded only when the caller named ids, so a call that omits the field is indistinguishable
      // at the daemon from one made before this parameter existed.
      ...(args.itemIds === undefined ? {} : { itemIds: args.itemIds }),
    }),
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

/**
 * @param name tool name from the call
 * @returns the tool, or null when no advertised tool has that name
 */
export function toolByName(name: string): McpTool | null {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Validate tool arguments against the declared schema, then build the IPC request.
 * @param tool the advertised tool
 * @param args the raw `arguments` member of the MCP call, unvalidated
 * @returns the built request, or the schema violations
 */
export function validateToolInput(tool: McpTool, args: unknown): ToolValidation {
  const errors: string[] = [];
  const value = args === undefined || args === null ? {} : args;
  validateAgainst(tool.inputSchema, value, '', errors);
  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };
  // The check above is a runtime one against a runtime schema, so TypeScript cannot relate it to
  // the argument type `op` declares. `value` is `unknown` here, and the assertion introduces no
  // use the validator did not already authorise: every tool schema is an object schema with
  // `additionalProperties: false`, and the check just enforced it.
  return { ok: true, request: tool.op(value as Record<string, unknown>) };
}

/**
 * @param schema the schema node to check against
 * @param value the candidate, already unwrapped from the call
 * @param path dotted path of this node, for the message
 * @param errors collector, shared across the whole walk
 */
function validateAgainst(schema: ToolSchema, value: unknown, path: string, errors: string[]): void {
  const where = path || '(root)';
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${where}: expected object`);
      return;
    }
    // The guard above proved this is a string-keyed bag; TypeScript's `object` is not indexable,
    // so the same value is read through a record view. No conversion happens, and the original
    // read the properties off the value directly.
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) errors.push(`${where}.${key}: required`);
    }
    for (const [key, child] of Object.entries(record)) {
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
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${where}: expected array`); return; }
      const items = schema.items;
      if (items === undefined) {
        // An array schema with no `items` cannot check anything, so saying so beats accepting every
        // element and implying a check happened.
        errors.push(`${where}: array schema declares no items`);
        return;
      }
      // Read into a local first: a narrowing test does not survive into the closure below, and
      // asserting the type back would be a cast where a plain `const` is available.
      value.forEach((element, index) => {
        validateAgainst(items, element, `${where}[${index}]`, errors);
      });
      break;
    }
    case 'string':
      if (typeof value !== 'string') { errors.push(`${where}: expected string`); return; }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: exceeds maxLength ${schema.maxLength}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: below minLength ${schema.minLength}`);
      break;
    case 'integer':
      // `Number.isInteger` is not a type guard, so the value is narrowed to a number explicitly;
      // the message and the accepted set are unchanged (any non-number fails both checks).
      if (typeof value !== 'number' || !Number.isInteger(value)) { errors.push(`${where}: expected integer`); return; }
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
        if (!schema.enum.includes(value as string)) errors.push(`${where}: expected one of ${schema.enum.join(', ')}`);
        return;
      }
      errors.push(`${where}: unsupported schema type ${String(schema.type)}`);
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push(`${where}: expected one of ${schema.enum.join(', ')}`);
  }
}

/** Optional keywords `stringSchema` merges in, spread verbatim into the emitted schema. */
interface StringSchemaExtras {
  readonly description?: string;
  readonly maxLength?: number;
}

/** Optional keywords `integerSchema` merges in, spread verbatim into the emitted schema. */
interface IntegerSchemaExtras {
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

/**
 * @param properties the named members of the object
 * @param required the member names that must be present
 * @returns an object schema that refuses unknown members
 */
function objectSchema(properties: Record<string, ToolSchema>, required: readonly string[]): ToolSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** @param extra optional keywords merged over the defaults */
function stringSchema(extra: StringSchemaExtras = {}): ToolSchema {
  return { type: 'string', minLength: 1, ...extra };
}

/**
 * An array of values each matching `items`.
 * @param items the schema every element must satisfy
 * @returns the schema
 */
function arraySchema(items: ToolSchema): ToolSchema {
  return { type: 'array', items };
}

/** @param extra optional keywords merged over the defaults */
function integerSchema(extra: IntegerSchemaExtras = {}): ToolSchema {
  return { type: 'integer', ...extra };
}

/** @param values the accepted strings */
function enumSchema(values: readonly string[]): ToolSchema {
  return { type: 'string', enum: values };
}
