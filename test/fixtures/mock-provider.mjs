/**
 * Deterministic mock provider: a local server speaking the Anthropic Messages wire protocol.
 *
 * Why this exists: the isolated-Host layer needs a real DSH Host to actually run a turn, and a
 * real turn needs a model route. This file is that route, pointed at `127.0.0.1` only, so the
 * test never depends on — and never bills — an ambient provider.
 *
 * Two rules it follows, both from the design review:
 *   1. It emits a LEGAL protocol cycle (the SSE event sequence the Anthropic client expects), not
 *      a shortcut that hand-feeds the bridge a success. If the bridge reports a turn, it is
 *      because DSH parsed this stream, ran its agent loop, and emitted its own session events.
 *   2. It never hardcodes a model outcome. The reply text comes from a queued script the test
 *      sets, so a test can assert that ITS OWN text arrived, and a test that sets no script gets
 *      a deterministic default rather than a fabricated result.
 *
 * Every request is recorded (headers without credential values, body, and the route taken) so a
 * test can prove what was actually sent upstream.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** The model id the isolated Host is configured to use. Must match the settings we write. */
export const MOCK_MODEL_ID = 'dsh-pilot-mock-1';
/** The provider id the isolated Host is configured to use. */
export const MOCK_PROVIDER_ID = 'dsh-pilot-mock';
/** The environment variable NAME the settings reference. No value is ever committed. */
export const MOCK_API_KEY_ENV = 'DSH_PILOT_MOCK_API_KEY';

/**
 * @typedef {object} MockTurnScript
 * @property {string} [byText]      route by a substring of the LAST user message; this is what
 *                                  makes the fixture robust. DSH makes more than one model call per
 *                                  prompt (session titles are a separate call), so a positional
 *                                  queue would hand a test's script to a call it did not mean.
 * @property {string} [text]        assistant text for this turn
 * @property {Array<{name: string, input: object}>} [toolCalls]  one tool_use block each
 * @property {number} [latencyMs]   delay before the stream starts, to exercise long waits
 * @property {string} [stopReason]  override; inferred from toolCalls otherwise
 */

/**
 * One request as a route callback sees it: the parsed body plus the three facts callbacks route on.
 * The body is `unknown` because it is whatever `JSON.parse` returned — a callback that wants to
 * inspect it must say what it expects, rather than being handed an implicit `any`.
 * @typedef {{body: unknown, tools: number, userTexts: string[], messageCount: number}} MockRequestView
 */

/**
 * The other thing `#resolveScript` can return. Under the strict rule an unrouted tool-bearing call
 * has no honest answer, so it resolves to this misuse marker and `#handle` turns it into an HTTP
 * error. A test never queues one — it exists so "no script was routed" cannot be reported as a turn.
 * @typedef {{error: {status: number, message: string}}} MockScriptMisuse
 */

export class MockProvider {
  /** @type {import('node:http').Server|null} */
  #server = null;
  /** @type {MockTurnScript[]} */
  #queue = [];
  /** @type {Array<{byText: string, script: MockTurnScript, times: number}>} */
  #routes = [];
  /**
   * Assigned by the constructor, which always runs before `#resolveScript` can be reached; `null`
   * is only the pre-construction state the field needs a type for.
   * @type {MockTurnScript|null}
   */
  #defaultScript = null;
  /** @type {MockTurnScript|null} */
  #toolFreeScript = null;
  #strict = true;
  #strictViolations = [];
  /** @type {Array<{fn: (request: MockRequestView) => MockTurnScript|null, when: (request: MockRequestView) => boolean, times: number}>} */
  #callbacks = [];
  /**
   * Every request the fixture answered, with the facts a test asserts on. `body` is the raw parsed
   * payload and is `unknown` because `JSON.parse` says nothing about its shape; it is retained so a
   * diagnostic can show exactly what arrived.
   * @type {Array<{at: number, url: string, method: string, model: unknown, stream: unknown, messageCount: number, toolNames: string[], authorizationPresent: boolean, toolUseBlocks: number, toolResultBlocks: number, userTexts: string[], lastUserText: string|null, body: unknown, systemDigestPresent: boolean, parsed: boolean}>}
   */
  #requests = [];
  /** The URL and method of the request currently being handled. @type {{url: string|undefined, method: string|undefined}|null} */
  #route = null;
  /** Requests that fell through to the default script, with the text that was searched. */
  #routeMisses = [];
  #sseEventsWritten = 0;
  /** @type {{status: number, body?: string, when?: (body: any) => boolean}|null} */
  #failNext = null;

  /** @param {{defaultText?: string, toolFreeText?: string}} [options] */
  constructor(options = {}) {
    this.#defaultScript = { text: options.defaultText ?? 'mock provider default reply' };
    // Calls that carry no tools are not turns. DSH uses them for session titles and similar
    // side work, so they get an empty reply by default: a title derived from a text fixture is
    // worthless, and — more importantly — a non-empty reply here would record an assistant
    // message in a session whose real turn FAILED, which is exactly the kind of phantom success
    // these tests exist to rule out.
    this.#toolFreeScript = options.toolFreeText !== undefined ? { text: options.toolFreeText } : { text: '' };
  }

  async start() {
    // Held in a local as well as the field: inside the promise callbacks below TypeScript cannot
    // see that `#server` was just assigned, and `server` is what the listeners bind to.
    const server = createServer((request, response) => {
      // Everything is captured before any body handling so a malformed request is still evidence.
      this.#route = { url: request.url, method: request.method };
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        this.#handle(request, response, raw);
      });
      request.on('error', () => { /* the client went away; nothing to do */ });
    });
    this.#server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // Port 0: the OS picks a free port. Nothing here can collide with the operator's Host.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(undefined);
      });
    });
    // Binding to a TCP port 0 means `address()` is an `AddressInfo` here, never the string form
    // (that belongs to a unix-socket server) and never null (it is listening by this point).
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { port: address.port, baseUrl: this.baseUrl };
  }

  get baseUrl() {
    const address = /** @type {import('node:net').AddressInfo} */ (this.#server?.address());
    return `http://127.0.0.1:${address.port}`;
  }

  /** The Anthropic client appends `/v1/messages` to the configured base URL. */
  get messagesEndpoint() {
    return `${this.baseUrl}/v1/messages`;
  }

  /**
   * Queue a callback script for the next turn. Use this when the answer depends on what the
   * request contains rather than on position or text — for example a turn that should call a tool
   * ONCE and then produce text on the continuation that still carries the same prompt.
   *
   * The callback may return a `MockTurnScript` or `null` to decline, in which case the remaining
   * routes and then the queue are tried.
   * @param {(request: MockRequestView) => MockTurnScript|null} fn
   * @param {{when?: (request: MockRequestView) => boolean, times?: number}} [options]
   */
  pushCallback(fn, options = {}) {
    // `times` defaults to 1, mirroring routeByText. A conversation-level script needs
    // `{times: Infinity}`: the continuation calls of one turn keep arriving, and a consumed callback
    // would leave them unrouted.
    this.#callbacks.push({ fn, when: options.when ?? (() => true), times: options.times ?? 1 });
  }

  /** Queue the script for the next turn. @param {MockTurnScript} script */
  pushScript(script) {
    this.#queue.push(script);
  }

  /**
   * Register a script routed by request text. Preferred over `pushScript` whenever more than one
   * model call may occur, because DSH issues a separate call for session titles.
   *
   * `times` controls reuse and defaults to 1 (consumed on match). Reuse matters because a route
   * matches ANY user message in the request, and a continuation call still carries the original
   * prompt as its first user message — so a single-use route for a prompt is consumed by the first
   * tool-bearing call and the continuation finds nothing. Pass `{times: Infinity}` for a script
   * that should answer every call matching it.
   *
   * @param {string} byText substring that must appear in any user message
   * @param {MockTurnScript} script
   * @param {{times?: number}} [options]
   */
  routeByText(byText, script, options = {}) {
    this.#routes.push({ byText, script, times: options.times ?? 1 });
  }

  /**
   * Make the next request fail, so a test can prove the bridge does not report a turn that never
   * completed. `status` is the HTTP status; 500 is an upstream failure the client must surface.
   *
   * `when` narrows WHICH request fails. Without it, DSH's separate title-generation call could
   * absorb the failure and the test would prove nothing about the turn.
   * @param {{status: number, body?: string, when?: (body: any) => boolean}} failure
   */
  failNextRequest(failure) {
    this.#failNext = failure;
  }

  get requests() {
    return [...this.#requests];
  }

  get sseEventsWritten() {
    return this.#sseEventsWritten;
  }

  /** Requests answered by the default script, with the route table at the time. */
  get routeMisses() {
    return [...this.#routeMisses];
  }

  /**
   * Routed tool-bearing calls that had no script. Under the default strict setting these become
   * HTTP errors, so their presence means a test under-specified its fixture rather than that a
   * turn quietly produced invented text.
   */
  get strictViolations() {
    return [...this.#strictViolations];
  }

  /** Turn the strict rule off for a test that deliberately exercises the default reply. */
  allowDefaultForTurns() {
    this.#strict = false;
  }

  requestsFor(path) {
    return this.#requests.filter((entry) => entry.url.startsWith(path));
  }

  reset() {
    this.#requests = [];
    this.#queue = [];
    this.#routes = [];
    this.#sseEventsWritten = 0;
    this.#failNext = null;
    this.#routeMisses = [];
    this.#strictViolations = [];
    this.#callbacks = [];
  }

  async stop() {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} raw
   */
  #handle(request, response, raw) {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded as unparsed below */ }

    const authorization = request.headers.authorization ?? request.headers['x-api-key'];
    this.#requests.push({
      at: Date.now(),
      url: request.url ?? '',
      method: request.method ?? '',
      // The credential VALUE is never recorded; only whether the header was present, which is the
      // fact a test needs (the authenticated client must send something).
      authorizationPresent: Boolean(authorization),
      model: body?.model ?? null,
      stream: body?.stream ?? null,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      toolNames: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : [],
      // How many assistant tool_use blocks this request already contains conversationally. This is
      // the load-bearing counter for a multi-call turn: it is derived from the protocol's own
      // block taxonomy rather than from a substring of the serialized body.
      toolUseBlocks: countToolUseBlocks(body),
      toolResultBlocks: countToolResultBlocks(body),
      userTexts: userTexts(body),
      lastUserText: userTexts(body).at(-1) ?? null,
      // Retained so a diagnostic can show exactly what arrived; the fixture is loopback-only and
      // single-use, so holding the body costs nothing.
      body,
      systemDigestPresent: Boolean(body?.system),
      parsed: body !== null,
    });

    if (this.#failNext && (this.#failNext.when?.(body) ?? true)) {
      const failure = this.#failNext;
      this.#failNext = null;
      response.writeHead(failure.status, { 'content-type': 'application/json' });
      response.end(failure.body ?? JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock provider forced failure' } }));
      return;
    }

    // A non-streaming request is answered as a single JSON message; the client may send either,
    // and pretending only one works would make this fixture narrower than the real route.
    const script = this.#resolveScript(body);
    // A misuse marker is not a script: it carries the reason no honest answer existed.
    if ('error' in script) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'mock_provider_misuse', message: script.error.message } }));
      return;
    }
    if (body?.stream !== true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(this.#messageBody(script, body?.model)));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const write = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      this.#sseEventsWritten += 1;
    };

    const emit = () => {
      const messageId = `msg_mock_${randomUUID()}`;
      write('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body?.model ?? MOCK_MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // A legal usage block: the client reads these fields and computes a total from them.
          usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });

      let index = 0;
      // An empty text is NOT a content block. Emitting `text: ''` made DSH record an assistant
      // message with empty content for a call that was supposed to produce nothing, which then
      // looked like turn output to any test counting assistant messages.
      if (script.text !== undefined && script.text !== '') {
        write('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        // Chunked on purpose: a single delta would not exercise incremental assembly.
        for (const piece of chunkText(script.text)) {
          write('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: piece },
          });
        }
        write('content_block_stop', { type: 'content_block_stop', index });
        index += 1;
      }

      for (const toolCall of script.toolCalls ?? []) {
        write('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: `toolu_mock_${randomUUID()}`, name: toolCall.name, input: {} },
        });
        // Arguments arrive as raw JSON fragments, exactly as the real API sends them.
        for (const fragment of chunkJson(JSON.stringify(toolCall.input ?? {}))) {
          write('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: fragment },
          });
        }
        write('content_block_stop', { type: 'content_block_stop', index });
        index += 1;
      }

      const stopReason = script.stopReason ?? ((script.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
      write('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 8, input_tokens: 12 },
      });
      write('message_stop', { type: 'message_stop' });
      response.end();
    };

    if (script.latencyMs) setTimeout(emit, script.latencyMs);
    else emit();
  }

  /**
   * Pick the script for one request. Routing by prompt text comes FIRST, because positional order
   * is not stable: DSH issues extra calls (session titles) and concurrent sessions interleave.
   * @param {any} body
   * @returns {MockTurnScript|MockScriptMisuse}
   */
  #resolveScript(body) {
    const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
    const texts = userTexts(body);
    // Matching scans EVERY user message, not just the last. Measured fact: DSH sends the human
    // prompt as the FIRST user message and appends injected context (runtime snapshot, skill
    // catalogue) as later user messages, so a last-message match would never see the prompt.
    for (let i = 0; i < this.#routes.length; i += 1) {
      const route = this.#routes[i];
      if (!texts.some((text) => text.includes(route.byText))) continue;
      route.times -= 1;
      // A route with uses left stays registered, so a continuation call carrying the same prompt
      // can still match it; a spent route is removed so a genuinely new prompt cannot silently
      // reuse an old script.
      if (route.times <= 0) this.#routes.splice(i, 1);
      return route.script;
    }
    const request = {
      body,
      tools,
      userTexts: texts,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    };
    for (let i = 0; i < this.#callbacks.length; i += 1) {
      const entry = this.#callbacks[i];
      if (!entry.when(request)) continue;
      const decided = entry.fn(request);
      if (decided === null || decided === undefined) continue;
      entry.times -= 1;
      if (entry.times <= 0) this.#callbacks.splice(i, 1);
      return decided;
    }
    const queued = this.#queue.shift();
    if (queued) return queued;
    // Both fallbacks are assigned by the constructor, so neither can be null once a request is
    // being resolved; the assertions say that rather than making the caller handle an impossible case.
    if (tools === 0) return /** @type {MockTurnScript} */ (this.#toolFreeScript);
    // A miss is recorded rather than guessed at: a test that expects its script to apply needs to
    // see WHY it did not, instead of silently receiving the default reply.
    const miss = {
      searched: texts.map((text) => text.slice(0, 120)),
      registered: this.#routes.map((route) => `${route.byText}${route.times === Infinity ? '*' : `x${route.times}`}`),
      tools,
    };
    this.#routeMisses.push(miss);
    if (this.#strict) {
      // STRICT by default: an unrouted tool-bearing call is a TURN, and answering it with the
      // default text would fabricate model output for a turn no test asked for. That is precisely
      // the phantom success this fixture must not be capable of producing, so it fails loudly and
      // the answer is an HTTP error rather than invented content.
      this.#strictViolations.push(miss);
      return { error: { status: 599, message: `mock provider: no script routed for this tool-bearing call; registered=[${miss.registered.join(', ')}] searched=${JSON.stringify(miss.searched.map((t) => t.slice(0, 60)))}` } };
    }
    return /** @type {MockTurnScript} */ (this.#defaultScript);
  }

  /**
   * @param {MockTurnScript} script
   * @param {unknown} model
   */
  #messageBody(script, model) {
    const content = [];
    if (script.text !== undefined && script.text !== '') content.push({ type: 'text', text: script.text });
    for (const toolCall of script.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: `toolu_mock_${randomUUID()}`, name: toolCall.name, input: toolCall.input ?? {} });
    }
    return {
      id: `msg_mock_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: model ?? MOCK_MODEL_ID,
      content,
      stop_reason: script.stopReason ?? ((script.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 8 },
    };
  }
}

/**
 * Count assistant `tool_use` blocks in the conversation. This is how a script knows which call it
 * is answering: the first call of a turn has none, the call after a tool result has one.
 * @param {any} body
 * @returns {number}
 */
export function countToolUseBlocks(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    // The content shape varies by client: sometimes real blocks, sometimes a JSON string.
    const blocks = asBlocks(message?.content);
    for (const block of blocks) if (block?.type === 'tool_use') count += 1;
  }
  return count;
}

/**
 * Count `tool_result` blocks in the conversation, by the same rule.
 * @param {any} body
 * @returns {number}
 */
export function countToolResultBlocks(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    const blocks = asBlocks(message?.content);
    for (const block of blocks) if (block?.type === 'tool_result') count += 1;
  }
  return count;
}

/**
 * Normalise a message `content` to an array of blocks, parsing a JSON string when that is the shape.
 * @param {unknown} content
 * @returns {any[]}
 */
function asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Every user-message text in the request, in order. A script routes on this list rather than on
 * one message, because DSH splits a prompt across several user messages whose order is not the
 * order a reader would guess.
 *
 * Note the content shape: a user message's `content` is a JSON STRING in this protocol, not an
 * array of blocks, so it is returned verbatim. The fixture deliberately does not try to parse it —
 * the whole string is what the route matches against, which also means a route can match on
 * injected context if a test wants to.
 * @param {any} body
 * @returns {string[]}
 */
function userTexts(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') { out.push(message.content); continue; }
    if (Array.isArray(message.content)) {
      const joined = message.content
        .map((block) => (typeof block === 'string' ? block : block?.text))
        .filter((value) => typeof value === 'string')
        .join('\n');
      if (joined) out.push(joined);
    }
  }
  return out;
}

/**
 * Split text into a few pieces at word boundaries. Deterministic (no randomness), because a
 * flaky provider fixture would make every downstream test flaky.
 * @param {string} text
 */
function chunkText(text) {
  if (text.length <= 4) return [text];
  const pieces = [];
  const size = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

/**
 * Split a JSON string into fragments. Deliberately NOT at syntactic boundaries: the client is
 * required to buffer partial JSON and parse only when the block closes.
 * @param {string} json
 */
function chunkJson(json) {
  if (json.length <= 2) return [json];
  const pieces = [];
  const size = Math.max(1, Math.floor(json.length / 4));
  for (let i = 0; i < json.length; i += size) pieces.push(json.slice(i, i + size));
  return pieces;
}

/**
 * Settings YAML that routes the isolated Host at this mock, with no other provider reachable.
 *
 * The provider block intentionally names a credential by environment variable only; the value is
 * supplied by the test process. `models[].id` must match what the mirror returns, because the
 * route is resolved from the written settings rather than discovered.
 * @param {{messagesBaseUrl: string, modelId?: string, providerId?: string, apiKeyEnv?: string}} options
 */
export function mockProviderSettings({ messagesBaseUrl, modelId = MOCK_MODEL_ID, providerId = MOCK_PROVIDER_ID, apiKeyEnv = MOCK_API_KEY_ENV }) {
  return [
    'llm-pi-ai:',
    '  providers:',
    `    ${providerId}:`,
    '      api: anthropic-messages',
    `      baseURL: ${messagesBaseUrl}`,
    `      apiKeyEnv: ${apiKeyEnv}`,
    '      models:',
    `        - id: ${modelId}`,
    '          contextWindow: 200000',
    '          maxTokens: 8192',
    '          input:',
    '            - text',
    '          reasoningEfforts: false',
    'agent-default-model:',
    `  provider: ${providerId}`,
    `  model: ${modelId}`,
    '',
  ].join('\n');
}

/**
 * Full settings for an isolated Host.
 *
 * `permission` is separate from the model route because it is the operator's choice about how much
 * freedom the agent gets, not something the bridge decides. It is exposed here so a test can be
 * explicit about the mode it runs in — and so the reason is visible in the test that needs it.
 *
 * @param {{messagesBaseUrl: string, modelId?: string, providerId?: string, apiKeyEnv?: string, llmRetries?: number}} options
 */
/** The confinement mode every isolated Host boots with: the posture a real operator runs. */
export const OPERATOR_SANDBOX_MODE = 'workspace-write';

export function isolatedHostSettings(options) {
  const base = mockProviderSettings(options);
  const blocks = [base];
  // The confinement policy is ALWAYS stated, never left to the Host's own default.
  //
  // Two reasons, and both were learned by getting them wrong. First, a test that asserts it ran under
  // the operator posture needs the posture to be a readable fact rather than an implicit default that
  // a DSH upgrade could change underneath it. Second, the previous revision used this option to widen
  // the policy to `danger-full-access` when the strict policy refused a tool — escalation-after-refusal,
  // which the review rejected. Making the mode an explicit constant rather than a free parameter is
  // what stops that particular mistake from being expressible: the caller cannot ask for a wider one.
  // Not configurable. See the note above: a parameter here is exactly the footgun the review found.
  const mode = OPERATOR_SANDBOX_MODE;
  blocks.push([
    'sandbox-policy:',
    `  mode: ${mode}`,
    'permission:',
    `  defaultPreset: ${mode}`,
    '',
  ].join('\n'));
  if (options.llmRetries !== undefined) {
    // Measured fact: DSH retries a failed model call by default, so one prompt can produce several
    // tool-bearing requests. A test that wants to count real turns sets this to 0 so a retry cannot
    // be mistaken for one.
    blocks.push([
      'llm-retry:',
      `  maxAttempts: ${options.llmRetries}`,
      '',
    ].join('\n'));
  }
  return blocks.join('\n');
}
