/**
 * The inbound normalisation and redaction boundary.
 *
 * Why this module exists: conflict C-1 (`docs/conflicts.md`) put FR-SEC-3 ("a secret never appears
 * in state, logs, errors or tool results") against the durability model, which needs the archived
 * event payload to be faithful enough that a crash-replay reduces to the same state as the live
 * path. Redacting only ONE of those paths either leaves the secret in the other, or makes live
 * reduction and replay disagree in the very subsystem — reconciliation of uncertain outcomes — that
 * makes this bridge worth having. ADR 0002 resolves it: ONE boundary, applied ONCE as a frame
 * enters the bridge, yielding ONE payload that all three consumers share (live state reduction,
 * durable storage, replay).
 *
 * The trade this module makes visible: what is preserved is SEMANTIC fidelity — a replayed event
 * reduces to the same state and control flow — not BYTE fidelity of the archived payload. Control
 * data is numbers and enumerations (`seq`, `turn`, `outcome`, `state`, ids, event kind), and none
 * of them is a string this policy rewrites; the strings that ARE rewritten are the ones that could
 * be a credential.
 *
 * What this is NOT: recognition of every credential. It redacts credential-SHAPED text, and it
 * redacts values whose property NAME says it is a credential. A 40-character hex blob with no
 * prefix, no telling name and no recognisable shape passes through untouched, and
 * `test/security/redaction-boundary.test.mjs` asserts that it does, so the limit is stated rather
 * than implied. A generic high-entropy heuristic was considered and rejected: it cannot be
 * falsified against a corpus (there is no oracle for "is this string a secret"), and it would tear
 * legitimate ids, digests and hashes out of the control surface — including values a replay needs.
 *
 * Node-free on purpose: no `node:*`, no `Buffer`, no Node global. The contract/protocol surface is
 * compiled with the Node type surface removed (`tsconfig.contract.json`), and a boundary that
 * sanitises wire payloads is exactly the code that belongs on that side of the line. Adding this
 * file to that gate's `include` list is the follow-up that turns the property into a build failure;
 * until then the same property is asserted against this source by the security suite.
 */

/**
 * What replaces credential-shaped material. Deliberately the same spelling as `adapter.ts`'s
 * (module-private) `REDACTION`: two different markers for the same idea would make a log reader
 * guess which redactor ran, and the whole point of this change is that there is one redactor.
 */
export const REDACTION_MARKER = '[redacted:credential]';

/**
 * Inserted where a value could not be traversed at all — a hostile Proxy, an accessor that throws.
 * Named as a redaction so a reader of a log knows the material is missing rather than empty.
 */
export const UNREADABLE_MARKER = '[redacted:unreadable]';

/** Inserted at a reference back to an ancestor, so a cyclic payload becomes traversable and finite. */
export const CYCLE_MARKER = '[redacted:cycle]';

/**
 * Inserted where a payload nests deeper than `REDACTION_POLICY.maxDepth`. Observable on purpose: a
 * bound nobody can see is indistinguishable from a boundary that silently ate the payload.
 */
export const DEPTH_MARKER = '[redacted:depth-limit]';

/** Inserted where a payload exceeds `REDACTION_POLICY.maxNodes`, the denial-of-service bound. */
export const NODE_LIMIT_MARKER = '[redacted:node-limit]';

/**
 * Credential shapes as they appear in TEXT.
 *
 * `adapter.ts` is the ANTECEDENT of this set, not a second copy kept on purpose. Its
 * `CREDENTIAL_SHAPES` and `REDACTION` are module-private, so this change cannot import them, and
 * editing that file is outside this change's scope; the five shapes below are therefore carried
 * over verbatim and the unified set is exported from here, which is what a follow-up imports
 * `redactCredentials` from. Until that follow-up lands there are two copies, and the security suite
 * measures that this one is a behavioural SUPERSET of the other on a corpus rather than assuming it.
 *
 * The sixth shape is the one addition, and the reason for it: HTTP Basic is a credential form this
 * project will see (a Host log line quoting a header) and the earlier set knew only `Bearer`. Its
 * body requirement — at least 12 characters, both cases present — is load-bearing rather than
 * decorative: without it, ordinary prose ("Basic authentication failed") would be redacted into
 * uselessness. See the inline note on that pattern for the measurements behind the rule.
 *
 * Kept narrow on purpose: this redacts material that is recognisably a credential and leaves
 * diagnostic prose intact, because an error scrubbed into uselessness is a second bug.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  // Provider-style tokens, including the sentinel shape the security suite plants. The longest
  // forms are tried first so `sk-ant-...` is consumed as a whole rather than leaving its tail.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:gh[pousr]|glpat|xox[baprs])-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  // `Authorization: Basic <base64>` — the shape the five-shape set missed, and a real one: a Host
  // log line that quotes a header is where a Basic credential shows up. The two lookaheads demand
  // an at-least-12-character MIXED-CASE body, which is what a base64 encoding of any plausible
  // credential looks like and what ordinary prose after the word "Basic" does not. Both alternatives
  // were measured while writing the coverage case: an all-lowercase body ("Basic authentication
  // failed") and a seven-character one ("Basic tokens") must NOT be redacted, and a "must contain a
  // digit" rule was rejected because it also missed a real `user:pass` encoding — a leak traded for
  // nothing.
  //
  // This is the one shape without the `i` flag, and that is not an oversight: under `i`, the class
  // `[A-Z]` matches lowercase too, which would silently delete the mixed-case requirement and let
  // the pattern redact prose again. The two keyword spellings are therefore written out instead.
  /\b(?:[Aa]uthorization\s*:\s*)?[Bb]asic\s+(?=[A-Za-z0-9+/=]{12,})(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*[A-Z])[A-Za-z0-9+/=]+/g,
  // A `key=value` or `"key": "value"` pair whose NAME says it is a credential.
  /((?:api[-_]?key|auth[-_]?token|access[-_]?token|client[-_]?secret|password|passwd|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi,
  // A bare JWT: three base64url segments, the first of which decodes to a JSON header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]);

/**
 * Property names whose value is a credential whatever its shape, compared after lowercasing and
 * dropping separators (`apiKey`, `api_key` and `API_KEY` are one name).
 *
 * This is the same vocabulary `CREDENTIAL_PATTERNS`' fourth shape matches in text, applied
 * structurally instead of by regex, plus the header names a Host actually uses (`Authorization`,
 * `X-Api-Key`). The vocabulary is deliberately short and exact: a name list that grows by adding
 * every word containing "key" starts rewriting ordinary control fields, and a redactor that damages
 * control fields breaks replay.
 */
export const SENSITIVE_KEY_NAMES: readonly string[] = Object.freeze([
  'apikey', 'xapikey', 'apisecret',
  'password', 'passwd', 'secret', 'clientsecret',
  'token', 'authtoken', 'accesstoken', 'refreshtoken', 'sessiontoken', 'idtoken',
  'authorization', 'authheader', 'bearer', 'cookie', 'setcookie',
  'credential', 'credentials', 'privatekey', 'signingkey', 'signature',
]);

/**
 * Words that make a property name sensitive when they appear in it at all (`X-Auth-Token`,
 * `clientSecretV2`). This tier is why `SENSITIVE_KEY_NAMES` can stay short: a name the exact list
 * has never seen is still recognised when the peer spells it with an extra word.
 *
 * The two tiers differ in one more way, and the difference is deliberate: an EXACT name extends the
 * sensitive context into its subtree (a bag called `credentials` holds credentials whatever its
 * keys are called), while a word match redacts only a string value directly under it. Without that
 * split, a name like `tokenUsage` — a word match, and an ordinary informational field — would
 * redact the model name and every other string in the bag.
 */
export const SENSITIVE_KEY_WORDS: readonly string[] = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'credential', 'credentials', 'authorization', 'bearer', 'cookie',
]);

/**
 * Nesting depth past which the walk refuses to descend. Chosen, not measured: the deepest value the
 * bridge itself constructs is a three-level event envelope, and any real DSH event is well inside
 * an order of magnitude of that. The bound exists so a payload a peer chose to nest pathologically
 * cannot turn this recursive walk into a stack overflow.
 */
export const MAX_DEPTH = 24;

/**
 * Number of values the walk will visit before it stops. Sized against the transport rather than
 * against taste: `adapter.ts` bounds a frame at 1 MiB, and a 1 MiB frame of one-character JSON
 * values is roughly half a million nodes, so a smaller budget would truncate payloads a peer is
 * entitled to send. The bound is still finite, which is what keeps a hostile in-process value graph
 * from turning ingest into a denial of service.
 */
export const MAX_NODES = 100_000;

/**
 * The policy the boundary runs with. Exported as a value, not baked in as constants, so a test can
 * assert against the policy instead of against magic strings — and so the negative control in the
 * security suite can run the boundary with redaction turned OFF and observe the secret survive.
 */
export interface RedactionPolicy {
  /** When false, only the credential substitution is turned off; the walk and its bounds stand. */
  readonly enabled: boolean;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly patterns: readonly RegExp[];
}

/** The default policy: substitution on, both bounds in force. */
export const REDACTION_POLICY: RedactionPolicy = Object.freeze({
  enabled: true,
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  patterns: CREDENTIAL_PATTERNS,
});

/**
 * The same policy with substitution disabled.
 *
 * Why this exists as a supported value rather than as a test-only hack: the security suite's claim
 * is "this boundary removes the sentinel". A claim like that is only observable if the same call
 * with redaction off shows the sentinel PRESENT; otherwise a redactor that quietly rewrote nothing
 * would look identical to one that worked. Shipping the switch next to the policy keeps that
 * control honest and keeps it out of the test's imagination.
 */
export const REDACTION_DISABLED_POLICY: RedactionPolicy = Object.freeze({
  ...REDACTION_POLICY,
  enabled: false,
});

/**
 * Redact credential-shaped material from peer-supplied TEXT (a log line, an error message).
 *
 * Why a text mode at all: display text has no structure to walk. A frame's `message` field is one
 * opaque string that can quote a token, so the name-based rules below cannot apply to it and only
 * the shape rules can. That asymmetry is a measured limit of this policy, not an oversight: a text
 * scan cannot tell a field name from prose.
 *
 * `String.prototype.replace` is used rather than `test`/`exec` on the shared pattern objects, and
 * that is deliberate: these regexes carry `g`, so `test`/`exec` advance `lastIndex` and a second
 * call would start scanning mid-string. `replace` always starts at the beginning and resets the
 * index, which is what makes this function deterministic across calls.
 * @param text the peer's text
 * @param policy the policy to apply
 * @returns the text with credential-shaped runs replaced
 */
export function redactText(text: string, policy: RedactionPolicy = REDACTION_POLICY): string {
  if (!policy.enabled) return text;
  let out = text;
  for (const pattern of policy.patterns) out = out.replace(pattern, REDACTION_MARKER);
  return out;
}

/**
 * True when a property name says its value is a credential — either an exact name from
 * `SENSITIVE_KEY_NAMES` or any name containing a word from `SENSITIVE_KEY_WORDS`.
 * @param key the peer's property name
 * @returns whether the value under this name is treated as credential-bearing
 */
export function isSensitiveKeyName(key: string): boolean {
  return isExactSensitiveKeyName(key) || splitNameWords(key).some((word) => NAME_WORD_SET.has(word));
}

/**
 * True when a property name is one of the exact names. This is the tier that extends the sensitive
 * context into a nested container, so it is exported separately rather than folded into
 * `isSensitiveKeyName`: the difference between the two tiers is part of the policy.
 * @param key the peer's property name
 * @returns whether the name is an exact sensitive name
 */
export function isExactSensitiveKeyName(key: string): boolean {
  return EXACT_NAME_SET.has(normalizeName(key));
}

/**
 * THE BOUNDARY. Takes an arbitrary value as it arrives from a peer — a parsed event payload, a tool
 * input object, an error detail bag, or a bare log line — and returns a redacted copy of the same
 * shape. Every consumer of that event (live reduction, durable storage, replay) must read THIS
 * value, so that no two payloads for one event exist.
 *
 * Total by construction: the walk is bounded in depth and in nodes, breaks cycles, and any failure
 * to traverse at all (a hostile Proxy, an accessor that throws) collapses to a marker rather than
 * propagating. An exception here would be raised on the event-ingest path, where it would take the
 * daemon down; a redaction boundary may lose information, and it may not lose the process.
 *
 * Deterministic: no clock, no randomness, no dependence on iteration order that is not the input's
 * own. Same input, same output, every time — which is the property that lets live reduction and
 * replay be compared at all.
 *
 * Structural facts preserved: key order, array order and length, and every non-string value
 * (number, boolean, null) exactly as it arrived. Object KEYS are preserved as structure, but a key
 * that is itself credential-shaped is replaced with the marker — the test plants a sentinel in a
 * key precisely because a redactor that walks only values would leave it there.
 * @param value the peer's value, of any type
 * @param policy the policy to apply
 * @returns a redacted copy of the same shape
 */
export function redactInbound(value: unknown, policy: RedactionPolicy = REDACTION_POLICY): unknown {
  try {
    return walk(value, 0, false, { policy, visits: 0, ancestors: new WeakSet<object>() });
  } catch {
    return UNREADABLE_MARKER;
  }
}

/** Walk bookkeeping. `ancestors` holds the objects on the CURRENT path, which is what a cycle is. */
interface WalkState {
  readonly policy: RedactionPolicy;
  visits: number;
  readonly ancestors: WeakSet<object>;
}

/** Cached lookups: the exported lists are the policy, these are how the walk reads them cheaply. */
const EXACT_NAME_SET: ReadonlySet<string> = new Set(SENSITIVE_KEY_NAMES);
const NAME_WORD_SET: ReadonlySet<string> = new Set(SENSITIVE_KEY_WORDS);

/**
 * @param key @returns the name lowercased with separators removed, so `apiKey` == `api_key`
 */
function normalizeName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @param key @returns the name's words, split on separators AND on camelCase boundaries
 */
function splitNameWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Give a rebuilt object a key that does not collide with one already used.
 *
 * Why this is needed: two different credential-shaped keys in one object collapse to the same
 * marker, and rebuilding the object would then drop one of them. Dropping a sibling silently is
 * exactly the structural damage this boundary exists to avoid, so the second occurrence is
 * disambiguated positionally — nothing about the original name is revealed, and the result is
 * still a deterministic function of the input.
 * @param desired the key the walk wants
 * @param used the keys already assigned in this object
 * @returns a key unique within that object
 */
function uniqueKey(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  let suffix = 2;
  while (used.has(`${desired}#${suffix}`)) suffix += 1;
  const key = `${desired}#${suffix}`;
  used.add(key);
  return key;
}

/**
 * @param value @param depth @param sensitiveContext true when an ancestor NAME said this subtree
 *   holds a credential, which is what makes a nested bag under `credentials` redact its leaves
 * @param state @returns the redacted copy
 */
function walk(value: unknown, depth: number, sensitiveContext: boolean, state: WalkState): unknown {
  // The budget is checked before the visit is counted, so the marker appears where work stopped
  // rather than one node late, and so a caller can see the bound in the output.
  if (state.visits >= state.policy.maxNodes) return NODE_LIMIT_MARKER;
  state.visits += 1;

  if (typeof value === 'string') {
    if (!state.policy.enabled) return value;
    return sensitiveContext ? REDACTION_MARKER : redactText(value, state.policy);
  }

  // Everything that is neither a string nor an object — number, boolean, null, undefined, bigint,
  // symbol, function — is copied EXACTLY. This is where the replay guarantee lives: `seq`, `turn`
  // and the ids are numbers and strings the policy never rewrites, so "a replayed event reduces to
  // the same state" is a structural property of this walk rather than a special case for a list of
  // field names that a future Host could rename.
  if (value === null || typeof value !== 'object') return value;

  if (depth >= state.policy.maxDepth) return DEPTH_MARKER;
  // A reference to something already on this path is a cycle, not a shared value: returning the
  // marker keeps the output finite and JSON-serialisable, which matters because the very next thing
  // that happens to a parsed payload is `JSON.stringify` into the event archive.
  if (state.ancestors.has(value)) return CYCLE_MARKER;
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // `Array.isArray` narrows to `any[]`; viewing it as `readonly unknown[]` restores honest
      // element types so each element is narrowed by the walk instead of silently accepted.
      const items = value as readonly unknown[];
      const out: unknown[] = [];
      for (let index = 0; index < items.length; index += 1) {
        if (state.visits >= state.policy.maxNodes) {
          out.push(NODE_LIMIT_MARKER);
          break;
        }
        out.push(walk(items[index], depth + 1, sensitiveContext, state));
      }
      return out;
    }

    // The dynamic boundary. `value` is an arbitrary parsed payload, so its own properties are
    // honestly `unknown`; viewing the object as a record of unknowns is what makes the type system
    // demand that each one be narrowed, and it casts nothing away that was ever checked.
    const bag = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const usedKeys = new Set<string>();
    for (const key of Object.keys(bag)) {
      if (state.visits >= state.policy.maxNodes) {
        out[uniqueKey(NODE_LIMIT_MARKER, usedKeys)] = NODE_LIMIT_MARKER;
        break;
      }
      let entryValue: unknown;
      try {
        entryValue = bag[key];
      } catch {
        // An accessor that throws on read must not take down ingest. The field is marked missing
        // and its siblings are still walked, so one poisoned property cannot erase an event.
        entryValue = UNREADABLE_MARKER;
      }
      // A key that is itself credential-shaped is replaced; the key SLOT survives, so the shape of
      // the object (how many fields, in what order) is preserved even though the name is not.
      const redactedName = state.policy.enabled && redactText(key, state.policy) !== key;
      const outKey = uniqueKey(redactedName ? REDACTION_MARKER : key, usedKeys);
      const exact = isExactSensitiveKeyName(key);
      const sensitiveName = exact || isSensitiveKeyName(key);
      // The word tier redacts a string value directly under it and does not extend into a subtree;
      // the exact tier does. See the note on SENSITIVE_KEY_WORDS for why the split exists.
      const childContext = typeof entryValue === 'string' ? (sensitiveName || sensitiveContext) : (sensitiveContext || exact);
      out[outKey] = walk(entryValue, depth + 1, childContext, state);
    }
    return out;
  } finally {
    state.ancestors.delete(value);
  }
}
