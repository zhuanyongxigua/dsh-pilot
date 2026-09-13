#!/usr/bin/env node
/**
 * Mutation / negative-control runner.
 *
 * Why this file exists: a green test suite proves nothing on its own — it may simply be unable
 * to fail. This script introduces ONE known defect at a time into a throwaway copy of the
 * source and requires the tests that claim to protect that behaviour to go RED. A mutation that
 * survives means the corresponding test is decorative, and that is reported as a failure of
 * this runner.
 *
 * Rules it follows:
 *   - it never mutates the working tree; every mutation is applied to a copy under the OS temp
 *     root, so a crashed run cannot leave the real source modified;
 *   - each mutation declares the test target and the file it edits, and the edit is verified to
 *     have applied (a pattern that no longer matches is an error, not a silent no-op);
 *   - the report states, per mutation, which control caught it.
 *
 * Usage: node test/mutation/run.mjs [--only NAME] [--json FILE]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Per-mutation wall-clock ceiling. A mutation that hangs the suite is a detection (see below), so this
 * only needs to be long enough that an honest run finishes; every suite here is bounded and the slowest
 * is well inside it.
 */
const MUTATION_TIMEOUT_MS = 300_000;

/**
 * One negative control: a deliberate defect in a named file, plus the suite that must go red.
 * `kind` is what makes the summary honest — a control that mutates `test/fixtures/` evidences the
 * fixture, not this bridge — and `protects` names the obligation the control is supposed to guard.
 * @typedef {object} Mutation
 * @property {string} name
 * @property {'production'|'fixture'} kind
 * @property {string} protects
 * @property {string} why
 * @property {string} file
 * @property {string} find
 * @property {string} replace
 * @property {boolean} [keepTail] declared by some mutations; the runner reports the anchor verbatim
 * @property {string} target
 * @property {string} expectFailure
 */

/**
 * Each mutation pairs a deliberate defect with the negative control that must notice it.
 * @type {Mutation[]}
 */
const MUTATIONS = [
  {
    name: 'durable-intent-after-send',
    kind: 'production',
    protects: 'durable intent: the intent reaches disk before the network write',
    why: 'Persisting the intent AFTER the network write would make a crash mid-send invisible, so "sent, outcome unknown" would silently disappear.',
    file: 'src/lib/daemon.ts',
    find: `    if (freshRow.state === 'pending') {
      this.#store.markDispatching({
        operationId: freshRow.operation_id,
        method,
        endpoint: \`/api/\${method}\`,
        payload,
      });
    }`,
    replace: `    // MUTATION: the dispatch intent is never committed before the send.
    void freshRow;`,
    target: 'test/persistence',
    expectFailure: 'crash',
  },
  {
    name: 'scope-status-not-read-as-failure',
    kind: 'production',
    protects: 'uncertainty-not-success: a per-scope outcome is read before a tool call is called a success',
    why: ('`queue.clear` reports its outcome only at `remoteScope.status`. A success test that reads only a '
      + 'top-level result/operation wrapper marks an unconfirmed removal as a successful tool call.'),
    file: 'src/lib/gateway.ts',
    find: `  for (const scope of ['remoteScope', 'turnScope']) {`,
    replace: `  for (const scope of [] as string[]) { // MUTATION: the per-scope outcome is not read`,
    target: 'test/mcp-e2e',
    expectFailure: 'queue removal',
  },
  {
    name: 'websocket-message-budget-removed',
    kind: 'production',
    protects: 'bounded output: a message assembled from individually legal frames is still bounded',
    why: ('A per-frame bound cannot bound an assembled message: every fragment may be legal while the total is '
      + 'unbounded, so a peer that sends legal frames forever makes this process hold an unbounded message.'),
    file: 'src/lib/ws-client.ts',
    find: '      if (messageBytes > maxMessageBytes) {',
    replace: '      if (false && messageBytes > maxMessageBytes) { // MUTATION: no message budget',
    target: 'test/network',
    expectFailure: 'assembled',
  },
  {
    name: 'authority-token-path-followed',
    kind: 'production',
    protects: 'filesystem scope: a non-regular file at a path this process owns is refused, not followed',
    why: ('Following a link at the authority-token path redirects chmod, creation and reading outside the 0700 '
      + 'state directory that is the only protection the approval authority has.'),
    file: 'src/lib/ipc.ts',
    find: `  const existing = lstatOrNull(path);
  if (!existing) return null;
  if (!existing.isFile()) {
    throw new BridgeError(ERROR_CODES.UNSAFE_STATE_PATH, 'refusing to read an authority token through a non-regular file', {
      path,
      kind: existing.isSymbolicLink() ? 'symlink' : 'other',
    });
  }
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertRegularDescriptor(fd, path);
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }`,
    replace: `  const existing = lstatOrNull(path);
  void existing;
  // MUTATION: the pre-fix read, which follows links and returns whatever is there.
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();`,
    target: 'test/security',
    expectFailure: 'token',
  },
  {
    name: 'removal-crash-recovery-removed',
    kind: 'production',
    protects: 'removal once: a removal attempt that could have reached the Host is never sent again after a crash',
    why: ('The once-only guarantee is enforced by the removal ledger, but the ledger row is written only AFTER the '
      + 'Host answers. Without the startup reconciliation of orphaned attempts, a process killed in that window '
      + 'leaves no record, and a re-reported queue snapshot makes the same occurrence removable a second time.'),
    file: 'src/lib/daemon.ts',
    find: '    const removals = this.#reconcileRemovalAttempts();',
    replace: '    // MUTATION: the orphaned removal attempts are never reconciled into the ledger.\n'
      + '    const removals = { settled: 0, blocked: 0, confirmed: 0, retryable: 0, items: [] as string[] };',
    target: 'test/persistence',
    expectFailure: 'removal-crash-window',
  },
  {
    name: 'ack-loss-reported-as-success',
    kind: 'production',
    protects: 'uncertainty: an unprovable outcome is never reported as success',
    why: 'Treating a lost acknowledgement as success converts "we do not know" into a false confirmation.',
    file: 'src/lib/daemon.ts',
    find: `      this.#store.markUncertain({
        operationId: freshRow.operation_id,
        reason: result.reason ?? 'unproven-outcome',
        evidence: { method, at: Date.now() },
      });`,
    keepTail: true,
    replace: `      // MUTATION: an unprovable outcome is recorded as a success.
      this.#store.markAcknowledged({ operationId: freshRow.operation_id, ok: true, value: { assumed: true } });`,
    target: 'test/fake-host',
    expectFailure: 'uncertain',
  },
  {
    name: 'duplicate-rows-written',
    kind: 'production',
    protects: 'event identity: one native sequence becomes exactly one durable row',
    why: 'Losing the store-side sequence check lets a redelivered frame become a second row whenever the caller has not already cached that sequence, which corrupts every count and page derived from the log.',
    file: 'src/lib/store.ts',
    find: `      const before = this.get<EventPresenceRow>(
        'select 1 as present from events where task_id = ? and session_id = ? and seq = ?',
        taskId, sessionId, seq,
      );
      if (before) return false;`,
    replace: `      // MUTATION: no sequence check, so only the primary key stands between us and a
      // duplicate row — and a row id collision is silently absorbed by the ignore clause.
      const before = null;
      if (before) return false;`,
    target: 'test/unit',
    expectFailure: 'store dedupe',
  },
  {
    name: 'stale-terminal-event-closes-turn',
    kind: 'production',
    protects: 'turn boundaries: only the authoritative turn/end may close a turn',
    why: 'Closing a turn on any terminal event reports live work as finished, which is the exact failure the "authoritative turn/end" rule exists to prevent.',
    file: 'src/lib/daemon.ts',
    find: `      if (Number.isFinite(endTurn)) {
        if (!Number.isFinite(openHostTurn) || endTurn !== openHostTurn) return;`,
    replace: `      if (false) { // MUTATION: accept any terminal event
        if (!Number.isFinite(openHostTurn) || endTurn !== openHostTurn) return;`,
    target: 'test/fake-host',
    expectFailure: 'stale or foreign',
  },
  {
    name: 'approval-authority-not-checked',
    kind: 'production',
    protects: 'approval authority: a decision needs the separate authority token',
    why: 'Accepting a decision without the operator token would let any local caller — including a model-driven one — authorize its own approvals.',
    file: 'src/lib/daemon.ts',
    find: `    if (typeof authorityToken !== 'string' || createDigest(authorityToken) !== createDigest(expected)) {`,
    replace: `    if (false) { // MUTATION: authority token is not verified`,
    target: 'test/security',
    expectFailure: 'unauthenticated',
  },
  {
    name: 'gap-smoothed-over',
    kind: 'production',
    protects: 'stream completeness: a gap is never reported as a complete log',
    why: 'Reporting a stream with a hole as complete destroys the caller’s ability to tell a full log from a partial one.',
    file: 'src/lib/daemon.ts',
    find: `      completeness: hasGap ? 'incomplete' : 'complete',`,
    replace: `      completeness: 'complete', // MUTATION: gaps always reported as complete`,
    target: 'test/property',
    expectFailure: 'property',
  },
  // ---------------------------------------------------------------------------------------------
  // The five controls below are the ones that guard behaviour an operator would actually notice if
  // it broke. Each one mutates PRODUCTION code in `src/`, and the fixture-fidelity control is
  // labelled separately, because mutating our own fake Host proves something about the fixture, not
  // about the bridge. Reporting "8 of 8 caught" while the only session-identity control mutated the
  // fake Host was a real gap in how this runner described itself; the classification is now explicit
  // in every `kind` field and in the summary.
  // ---------------------------------------------------------------------------------------------
  {
    // PRODUCTION control: the bridge's own identity handling, not the fixture's.
    name: 'session-create-id-not-reused-on-retry',
    kind: 'production',
    protects: 'session identity survives a retry: one logical session is one Host session',
    why: 'Generating a FRESH host session id on every attempt makes a retry ask for a second Host session, so one logical session silently becomes two and the caller loses the original turn history.',
    file: 'src/lib/daemon.ts',
    find: `    const hostSessionId = typeof storedSessionId === 'string' ? storedSessionId : \`session-\${randomUUID()}\`;`,
    replace: `    // MUTATION: the stored preallocated id is ignored, so every attempt mints a new Host session.
    const hostSessionId = \`session-\${randomUUID()}\`;`,
    target: 'test/fake-host',
    expectFailure: 'idempotently',
  },
  {
    // PRODUCTION control for owner exclusion: two owners must never coexist.
    //
    // The mutation neuters the SECOND holder's refusal rather than the pragma. Deleting the pragma is
    // not a valid mutation: `locking_mode=EXCLUSIVE` is per-connection and SQLite still takes a write
    // lock for a committed transaction, so a second holder is refused either way — and removing the line
    // leaves a syntax error behind, which the runner now rejects instead of misreporting. The refusal is
    // the thing this control must actually depend on.
    name: 'second-owner-not-refused',
    kind: 'production',
    protects: 'owner exclusion: a second owner cannot start against a live state directory',
    why: 'If the second holder is allowed to proceed, two daemons interleave writes into one journal and one of them silently owns state the other is also mutating.',
    file: 'src/lib/owner-lock.ts',
    find: `      const busy = /busy|locked/i.test(message);
      return { acquired: false, reason: busy ? 'busy' : \`error:\${message.slice(0, 120)}\` };`,
    replace: `      // MUTATION: a refused handle is treated as acquired anyway, so exclusion does not hold.
      this.#db = db ?? null;
      this.#held = true;
      return { acquired: true };`,
    target: 'test/unit',
    expectFailure: 'owner',
  },
  {
    // PRODUCTION control for output bounds: a peer's size must not become our size.
    name: 'host-error-text-unbounded',
    kind: 'production',
    protects: 'bounded output: a peer cannot make our error surface arbitrarily large',
    why: 'Removing the bound lets a Host error message of any size flow into a tool result, an operator log and the durable operation record, which is a memory and log-growth path an untrusted peer controls (a ~200 KB message was observed in practice).',
    file: 'src/lib/adapter.ts',
    // ANCHOR RETARGETED, not a changed control. `boundText` now redacts credentials before it
    // truncates, so the returned value is `redacted` rather than `cleaned`. The defect this control
    // injects is unchanged — the bound is still what is removed — and the replacement returns
    // `redacted` so that removing the bound is still the ONLY defect under test.
    find: `  return redacted.length > max ? \`\${redacted.slice(0, max)}…[truncated \${redacted.length - max} chars]\` : redacted;`,
    replace: `  // MUTATION: no bound is applied, so a peer's size becomes our size.
  return redacted;`,
    target: 'test/security',
    expectFailure: 'bounded',
  },
  {
    // PRODUCTION control for cancellation meaning: an ack is not process evidence.
    name: 'cancel-ack-claims-subprocess-stop',
    kind: 'production',
    protects: 'cancellation honesty: a turn-level ack is never reported as proof a subprocess stopped',
    why: 'Reporting `observed: true` from a receipt that only acknowledges the turn converts "we sent a cancel" into a fabricated claim that a child process stopped, which is the single most harmful thing this bridge could tell a caller.',
    file: 'src/lib/daemon.ts',
    find: `          processEvidence: {
            observed: false,`,
    replace: `          processEvidence: {
            // MUTATION: the turn-level ack is reported as process-level evidence.
            observed: true,`,
    target: 'test/fake-host',
    expectFailure: 'process evidence',
  },
  {
    // FIXTURE control, classified as such: it guards the fake Host's own fidelity, so a run that goes
    // green when it is mutated means our NEGATIVE CONTROLS overlap the fixture's bug, not that the
    // bridge is broken.
    name: 'fake-host-ignores-preallocated-session-id',
    kind: 'fixture',
    protects: 'fixture fidelity: the fake Host honours a caller preallocated session id',
    why: 'If the fake Host discards the preallocated id, every test that relies on it to observe retry behaviour silently stops testing anything — this control proves the fixture itself would be noticed.',
    file: 'test/fixtures/fake-host.mjs',
    find: `  createSession(sessionId) {
    const id = sessionId ?? \`session-\${randomUUID()}\`;`,
    replace: `  createSession(sessionId) {
    // MUTATION: the caller preallocated id is ignored, so a retry always creates a new session.
    sessionId = undefined;
    const id = sessionId ?? \`session-\${randomUUID()}\`;`,
    target: 'test/fake-host',
    expectFailure: 'idempotently',
  },
  {
    name: 'mcp-unknown-arguments-accepted',
    kind: 'production',
    protects: 'tool schema: an unknown argument is refused, not ignored',
    why: 'Accepting unknown tool arguments turns a caller typo into a silently different operation.',
    file: 'src/lib/mcp-tools.ts',
    find: `        if (schema.additionalProperties === false) errors.push(\`\${where}.\${key}: unexpected property\`);`,
    replace: `        void 0; // MUTATION: unknown properties ignored`,
    target: 'test/mcp-e2e',
    expectFailure: 'invalid arguments',
  },
  {
    name: 'ipc-client-counts-the-delivery-not-the-frame',
    kind: 'production',
    protects: 'bounded input: the IPC client spends its per-reply budget per FRAME, not per delivery',
    why: ('A `data` event is what the kernel chose to hand over, not what the peer framed: it can carry two '
      + 'complete replies. Adding the whole chunk to the counter before splitting it on newlines refused two '
      + 'legal replies for their combined size, failed every pending caller for it, and — because the check no '
      + 'longer measured a frame at all — accepted a single frame larger than the bound when the peer '
      + 'delivered it in pieces. Both halves of that are in the cases below.'),
    file: 'src/lib/ipc.ts',
    find: `      const frames = framer.push(chunk);
      for (const frame of frames) {
        if (frame.bytes > this.#maxReplyBytes) {
          this.#refuseOversize(framer, frame.bytes);
          return;
        }
      }`,
    replace: `      const frames = framer.push(chunk);
      if (chunk.length > this.#maxReplyBytes) { // MUTATION: the delivery is treated as the frame
        this.#refuseOversize(framer, chunk.length);
        return;
      }`,
    target: 'test/network',
    expectFailure: 'reply exceeds the IPC reply limit',
  },
  {
    name: 'ipc-server-counts-the-delivery-not-the-line',
    kind: 'production',
    protects: 'bounded input: the daemon spends its per-request-line budget per LINE, not per delivery',
    why: ('Same defect, server side: two pipelined requests batched into one write were refused together, so '
      + 'a client that batched its requests had its connection destroyed for being efficient.'),
    file: 'src/lib/ipc.ts',
    find: `      for (const frame of frames) {
        if (frame.bytes > maxRequestBytes) {
          refuseOversizeLine();
          return;
        }
      }`,
    replace: `      if (chunk.length > maxRequestBytes) { // MUTATION: the delivery is treated as the line
        refuseOversizeLine();
        return;
      }`,
    target: 'test/network',
    expectFailure: 'the server never answered both lines',
  },
  {
    name: 'ipc-client-receive-bound-removed',
    kind: 'production',
    protects: 'bounded input: the IPC client bounds the bytes it holds for one reply',
    why: ('A bound on one end of a socket is not a bound on the connection: the server capped what it '
      + 'ACCEPTED while the client capped nothing, so a peer that never sent a newline grew a gateway '
      + 'buffer without limit.'),
    file: 'src/lib/ipc.ts',
    find: `      for (const frame of frames) {
        if (frame.bytes > this.#maxReplyBytes) {
          this.#refuseOversize(framer, frame.bytes);
          return;
        }
      }
      // An unterminated frame may hold at most one frame's worth of bytes, so this is where a peer that
      // never sends a newline is refused instead of being buffered for ever.
      if (framer.pendingBytes > this.#maxReplyBytes) {
        this.#refuseOversize(framer, framer.pendingBytes);
        return;
      }`,
    replace: `      for (const frame of frames) {
        void frame; // MUTATION: no receive bound at all, per frame or on the remainder
      }
      void framer.pendingBytes;`,
    target: 'test/network',
    expectFailure: 'never sends a newline',
  },
  {
    name: 'ipc-server-per-chunk-decode',
    kind: 'production',
    protects: 'framing: a request split inside a multi-byte character arrives as it was sent',
    why: ('A chunk boundary is not a character boundary. `chunk.toString(\'utf8\')` on a chunk that ends '
      + 'mid-sequence produces a replacement character that concatenating the next chunk cannot repair, so a '
      + 'prompt containing multi-byte text could be stored corrupted. The mutation applies the same defect to '
      + 'the framer: each piece of a frame decoded on its own instead of the joined frame.'),
    file: 'src/lib/ipc.ts',
    find: `      const text = body.toString('utf8');`,
    replace: "      const text = pieces.map((part) => part.toString('utf8')).join(''); // MUTATION: per-piece decode",
    target: 'test/network',
    expectFailure: 'split mid-character',
  },
  {
    name: 'ipc-reply-cap-removed',
    kind: 'production',
    protects: 'bounded output: the daemon does not emit a reply its own gateway would refuse',
    why: ('Without this the daemon can write a frame above the bound its own client applies, and the caller '
      + 'sees a dropped connection instead of a typed refusal telling it the answer was too large.'),
    file: 'src/lib/ipc.ts',
    find: "          if (Buffer.byteLength(replyLine, 'utf8') > maxReplyBytes) {",
    replace: "          if (Buffer.byteLength(replyLine, 'utf8') > Number.MAX_SAFE_INTEGER) { // MUTATION",
    target: 'test/network',
    expectFailure: 'refuses to WRITE',
  },
  {
    name: 'session-create-value-read-too-deep',
    kind: 'production',
    protects: "host truth: the session id the Host returned is the one this bridge records",
    why: ('`call()` returns `ok({value: result.value, rpcId})` and the adapter promotes those fields, so the '
      + "Host's value is AT `result.value`. Reading `result.value['value']` is a key that never exists, so "
      + 'the Host id was discarded on every create and a locally minted UUID took its place — in every '
      + 'answer that names a session.'),
    file: 'src/lib/daemon.ts',
    find: '    const hostValue: unknown = result.value;',
    replace: '    const hostValue: unknown = this.#isParsedObject(result.value) ? result.value.value : undefined; // MUTATION',
    target: 'test/fake-host',
    expectFailure: 'Host session id from session.create',
  },
  {
    name: 'record-session-returns-minted-id',
    kind: 'production',
    protects: 'session identity: a (task, host session) pair resolves to the row that exists',
    why: ('The insert is `on conflict(task_id, host_session_id) do update`, which keeps the ORIGINAL bridge '
      + 'session id, and the method then returned `getSession(sessionId)` — the id it had just minted and '
      + 'the conflict had just declined to use. Two client keys resolving to one Host session made the '
      + 'daemon read a null row and report a TypeError as its error text.'),
    file: 'src/lib/store.ts',
    find: `    const byMintedId = this.getSession(sessionId);
    if (byMintedId) return byMintedId;`,
    replace: `    const byMintedId = this.getSession(sessionId); // MUTATION
    if (byMintedId) return byMintedId;
    if (sessionId) return null;`,
    target: 'test/fake-host',
    expectFailure: 'two client keys',
  },
  {
    name: 'adapter-counts-characters-not-bytes',
    kind: 'production',
    protects: 'bounded input: the response cap counts received BYTES',
    why: ('`text.length` after `setEncoding(\'utf8\')` counts UTF-16 code units, so a body of 3-byte '
      + 'characters could be three times the promised cap before anything refused it, and the reported '
      + 'number described a quantity nothing measured.'),
    file: 'src/lib/adapter.ts',
    find: '      receivedBytes += chunk.length;',
    replace: "      receivedBytes += chunk.toString('utf8').length; // MUTATION: characters, not bytes",
    target: 'test/fake-host',
    expectFailure: 'over the cap in bytes',
  },
  {
    name: 'oversize-event-policy-removed',
    kind: 'production',
    protects: 'cursor progress: an event too large to deliver is refused BY SEQ, not silently lost',
    why: ('The page budget exempts one oversized event so the cursor can advance. When that one event '
      + 'crosses the IPC reply bound the page cannot be delivered, and without this refusal the caller '
      + 'learns only that something failed, with no way to say which event to page past.'),
    file: 'src/lib/daemon.ts',
    find: '    if (rows.length === 1 && bytes > this.#limits.ipcReplyMaxBytes) {',
    replace: '    if (false) { // MUTATION: the page is built even when it cannot be delivered',
    target: 'test/persistence',
    expectFailure: 'its seq named',
  },
  {
    name: 'websocket-control-frame-length-rule-removed',
    kind: 'production',
    protects: 'websocket conformance: a control frame above 125 bytes is refused, not answered',
    why: ('Answering it wrote `payload.length` into the 7-bit length field, where 126/127 mean "read the '
      + 'length from the following bytes" — so our own reply was a malformed frame that would '
      + 'desynchronise a conforming peer.'),
    file: 'src/lib/ws-client.ts',
    find: '      if (isControlOpcode(opcode) && length > 125) {',
    replace: '      if (isControlOpcode(opcode) && length > 125 && false) { // MUTATION',
    target: 'test/network',
    expectFailure: 'more than 125',
  },
  {
    name: 'task-label-dropped',
    kind: 'production',
    protects: 'tool contract: an argument the tool schema advertises is not ignored',
    why: ("`label` is advertised by the `dsh_task_ensure` schema, forwarded by the handler, and was ignored: "
      + 'a client that set one got the INTERNAL lookup key back as the task label.'),
    file: 'src/lib/daemon.ts',
    find: "    const displayLabel: string | null = typeof label === 'string' && label.trim() !== '' ? label : null;",
    replace: `    const displayLabel: string | null = null; // MUTATION: the caller label is dropped
    void label;`,
    target: 'test/fake-host',
    expectFailure: 'comes back on the task',
  },
  {
    name: 'store-migration-removed',
    kind: 'production',
    protects: 'state evolution: a state file from an older bridge is brought up to shape',
    why: ('`create table if not exists` does nothing to a table that already exists, so a column added to '
      + 'the DDL is absent from every database already in use and the code reading it fails in the middle '
      + 'of an operation, on exactly the machines that have been running the bridge.'),
    file: 'src/lib/store.ts',
    find: '      applyMigrations(db);',
    replace: '      void applyMigrations; // MUTATION: no migration on open',
    target: 'test/unit',
    expectFailure: 'brought up to shape',
  },
];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let only = null;
  let jsonPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--json') jsonPath = argv[++i];
  }
  return { only, jsonPath };
}

const { only, jsonPath } = parseArgs(process.argv.slice(2));
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (!selected.length) {
  process.stderr.write(`no mutation matches ${only}\n`);
  process.exit(2);
}

/** Copy the source tree without VCS metadata into a scratch root. */
function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'dshpilot-mutation-'));
  // `src` holds the authored sources, which is what a mutation edits. `dist` is NOT copied: it is
  // rebuilt inside the sandbox from the mutated sources, so what the suites execute is provably the
  // mutated code and not a stale artifact left over from before the mutation.
  for (const entry of ['src', 'test', 'docs', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.contract.json', 'tsconfig.test.json', 'README.md', 'LICENSE']) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(sandbox, entry), { recursive: true });
  }
  // `npm ci` is unnecessary and slow here; the toolchain is symlinked from the real tree so the
  // sandbox has `tsc` without a network round trip or a second copy of `node_modules`.
  const modules = join(ROOT, 'node_modules');
  if (existsSync(modules)) cpSync(modules, join(sandbox, 'node_modules'), { recursive: true, dereference: false });
  return sandbox;
}

/**
 * One control's outcome. `kind`, `protects`, `invalid` and `notApplied` are genuinely absent on most
 * outcomes, so a reader may treat absence as false rather than as a missing entry. The one control's outcome. `kind`, `protects` and `invalid` are genuinely absent on the "the mutation
 * did not apply" case, which is reported before any suite runs — so the summary reads their absence
 * as it reads `false` rather than an entry being invented for them.
 * @type {{name: string, caught: boolean, failed: number, passed: number, timedOut: number, skipped: number, detail: string, kind?: 'production'|'fixture', protects?: string|null, invalid?: boolean, notApplied?: boolean}[]}
 */
const results = [];

for (const mutation of selected) {
  const sandbox = makeSandbox();
  try {
    const path = join(sandbox, mutation.file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(mutation.find)) {
      // NOT a survivor, and it must not be reported as one. A survivor means "the suite failed to notice
      // this defect"; an anchor that no longer exists means the defect was never introduced and no test
      // was given the chance to notice anything. Reported as NOT-APPLIED and counted separately, because
      // collapsing the two makes a dead control look like a weak suite — the opposite of the truth, and
      // exactly the reading that let two stale anchors in this file go unnoticed once already.
      results.push({
        name: mutation.name, caught: false, notApplied: true, failed: 0, passed: 0, timedOut: 0, skipped: 0,
        detail: `mutation did not apply: the expected anchor is gone from ${mutation.file} (the code changed; update the mutation)`,
      });
      continue;
    }
    const mutated = original.replace(mutation.find, mutation.replace);
    writeFileSync(path, mutated);

    // A mutation that does not even PARSE cannot be reported as "SURVIVED": a source file with a syntax
    // error often makes a suite produce nothing at all, which would otherwise read as a missing control.
    // This check is why the runner no longer confuses "the mutation broke the build" with "the tests
    // cannot see this defect".
    // The implementation is TypeScript, so the gate is the compiler, not `node --check`. A mutation
    // that does not compile is INVALID rather than a survivor: a source file with a type error often
    // makes a run produce nothing at all, which would otherwise read as a missing control. The same
    // compile is also what produces `dist/` for the suites to execute, so a passing gate means the
    // suites really do run the mutated code.
    const build = spawnSync(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
      cwd: sandbox, encoding: 'utf8', timeout: 180_000,
    });
    if (build.status !== 0) {
      results.push({
        name: mutation.name, caught: false, invalid: true, failed: 0, passed: 0, timedOut: 0, skipped: 0,
        kind: mutation.kind ?? 'production',
        protects: mutation.protects ?? null,
        detail: `INVALID: the mutation does not compile, so any test result would be meaningless: ${String(build.stdout ?? '').split('\n').filter((l) => l.includes('error TS')).slice(0, 3).join(' | ').slice(0, 300)}`,
      });
      continue;
    }

    const run = spawnSync(process.execPath, ['test/run.mjs', mutation.target], {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: MUTATION_TIMEOUT_MS,
      env: { ...process.env, DSH_PILOT_PROPERTY_ROUNDS: '4' },
    });
    const stdout = `${run.stdout ?? ''}`;
    // Kept for the diagnostic below: a run that produced nothing must describe WHY, or the report is
    // as uninformative as the result it is trying to explain.
    const runDiagnostic = run.error
      ? `spawn error: ${run.error.message}`
      : `status=${run.status} signal=${run.signal} stderr=${String(run.stderr ?? '').split('\n').filter((line) => line.trim() !== '').slice(0, 3).join(' | ').slice(0, 300)}`;
    const summary = stdout.match(/passed=(\d+) failed=(\d+) skipped=(\d+) timedOut=(\d+)/);
    const counts = summary
      ? { passed: Number(summary[1]), failed: Number(summary[2]), skipped: Number(summary[3]), timedOut: Number(summary[4]) }
      : { passed: 0, failed: 0, skipped: 0, timedOut: 0 };
    const caughtWith = stdout.split('\n').filter((line) => /^(FAIL|TIME) /.test(line)).map((line) => line.trim()).slice(0, 3);
    // A mutation that makes the suite HANG has been detected, and must not be reported as a missing
    // control. `spawnSync` returns ETIMEDOUT with no summary in that case, and the first version of this
    // runner described that as "ran 0 tests", which is the same wrong conclusion in a different costume.
    // `code` is set on the error by `spawnSync` itself; it is not part of the `Error` type.
    const exhausted = run.error !== undefined && 'code' in run.error && run.error.code === 'ETIMEDOUT';
    if (exhausted) counts.timedOut = 1;
    const detections = counts.failed + counts.timedOut;
    const ranNothing = detections === 0 && counts.passed === 0;
    results.push({
      name: mutation.name,
      caught: detections > 0,
      ...counts,
      kind: mutation.kind ?? 'production',
      protects: mutation.protects ?? null,
      // A run in which NOT ONE test executed cannot be evidence of anything. Reporting that as
      // "SURVIVED ... stayed green" would describe a build that broke before the first assertion as a
      // missing control. `owner-lock-not-exclusive` first slipped through exactly this way.
      invalid: ranNothing,
      detail: exhausted
        ? `caught by a HANG: the suite never finished within ${MUTATION_TIMEOUT_MS / 1000}s with the mutation applied, so the defect is observable as non-termination (a refusal path that no longer refuses blocks its caller rather than failing it)`
        : detections > 0
        ? `caught by ${detections} test(s): ${caughtWith.join(' | ')}`
        : ranNothing
          ? `INVALID: ${mutation.target} ran 0 tests with the mutation applied — this is evidence about a broken run, not about a missing control. Output: ${stdout.split('\n').filter((line) => line.trim() !== '').slice(0, 4).join(' | ').slice(0, 400)} [${runDiagnostic}]`
          : `SURVIVED: ${mutation.target} stayed green with the mutation applied (${counts.passed} passed, ${counts.skipped} skipped) — the control for this behaviour is not real`,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

process.stdout.write('\nmutation / negative controls\n');
for (const result of results) {
  process.stdout.write(`${result.caught ? 'caught  ' : result.invalid ? 'INVALID ' : result.notApplied ? 'NOT-APPLIED ' : 'SURVIVED'} ${result.name}\n`);
  process.stdout.write(`    ${result.detail}\n`);
}
const notApplied = results.filter((result) => result.notApplied).length;
const survived = results.filter((result) => !result.caught && !result.invalid && !result.notApplied).length;
const invalid = results.filter((result) => result.invalid).length;
const byKind = {};
for (const result of results) {
  const kind = result.kind ?? 'production';
  byKind[kind] ??= { total: 0, caught: 0 };
  byKind[kind].total += 1;
  if (result.caught) byKind[kind].caught += 1;
}
process.stdout.write(`\nmutations=${results.length} caught=${results.length - invalid - survived - notApplied} survived=${survived} invalid=${invalid} notApplied=${notApplied}\n`);
// Reported by kind ON PURPOSE. A fixture control proves the fake Host is a faithful stand-in; only a
// production control is evidence that this bridge notices its own defect. Collapsing the two into one
// number would overstate what the suite has demonstrated.
for (const [kind, counts] of Object.entries(byKind)) {
  const scope = kind === 'fixture'
    ? 'fixture fidelity (evidences the FAKE HOST, not this bridge)'
    : 'production code in src/ (evidences this bridge)';
  process.stdout.write(`  ${kind}: ${counts.caught}/${counts.total} caught — ${scope}\n`);
}
// The coverage obligations the design names separately. Listing them here, and checking each against a
// CAUGHT control rather than against a test's name, is what stops a summary like "9/11 caught" from being
// read as "every required negative control exists" — those are different claims, and only the second one
// matters to a reviewer.
const OBLIGATIONS = [
  { id: 'owner-exclusion', phrase: 'owner exclusion' },
  { id: 'output-bounds', phrase: 'bounded output' },
  { id: 'cancel-local-only', phrase: 'cancellation honesty' },
  { id: 'uncertainty-not-success', phrase: 'uncertainty' },
  { id: 'durable-intent-before-send', phrase: 'durable intent' },
  { id: 'turn-boundary-authority', phrase: 'turn boundaries' },
  { id: 'approval-authority', phrase: 'approval authority' },
  { id: 'event-identity', phrase: 'event identity' },
  { id: 'stream-completeness', phrase: 'stream completeness' },
  { id: 'session-identity', phrase: 'session identity' },
  { id: 'tool-schema-strictness', phrase: 'tool schema' },
  { id: 'removal-once-across-crash', phrase: 'removal once' },
  { id: 'owned-path-not-followed', phrase: 'filesystem scope' },
  { id: 'uncertainty-not-success', phrase: 'uncertainty-not-success' },
];
const obligationTable = OBLIGATIONS.map((obligation) => ({
  id: obligation.id,
  covered: results.some((result) => result.caught && String(result.protects ?? '').includes(obligation.phrase)),
}));
const uncovered = obligationTable.filter((row) => !row.covered).map((row) => row.id);
// One line, not two: the obligation table is the authoritative coverage statement, and printing the same
// list twice in different words invites a reader to treat them as two separate facts.
process.stdout.write(`  required obligations: ${obligationTable.length - uncovered.length}/${obligationTable.length} have a caught negative control${uncovered.length ? `; NOT covered: ${uncovered.join(', ')}` : ''}\n`);

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({
    at: new Date().toISOString(),
    root: ROOT,
    results,
    mutations: results.length,
    caught: results.length - survived - invalid - notApplied,
    survived,
    invalid,
    notApplied,
    byKind,
    obligations: obligationTable,
  }, null, 2)}\n`);
  process.stdout.write(`machine-readable report: ${jsonPath}\n`);
}

process.exit(survived > 0 || invalid > 0 || notApplied > 0 ? 1 : 0);
