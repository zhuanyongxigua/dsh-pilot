# Conflicts between binding rules

`AGENTS.md` says: if a task instruction conflicts with one of its rules, stop and surface the
conflict instead of picking a side. This file is where that happens. A conflict recorded here is
**open** until it is resolved by a decision, and an open conflict is not a licence to ignore either
side — it is a statement that a test or a document had to choose, and of exactly what it chose.

Nothing here is a claim that the work is fine. Each entry names the two rules, the place they
collide, what was done in the meantime, and what resolving it would require.

---

## C-1 — FR-SEC-3 ("a secret never appears in state") versus the event archive's fidelity

**Status: RESOLVED, by decision. Resolved by ADR 0003
(`docs/adr/0003-inbound-normalisation-and-redaction-boundary.md`) and implemented in
`src/lib/redact.ts` + the two ingest sites in `src/lib/daemon.ts`.

The resolution is *not* the one this file previously recommended. It was reached by asking what
FR-SEC-3 is actually for, and the answer changed the shape of the fix: the requirement is not that
the bytes on disk match the peer's, it is that a credential never sits in state this bridge can
show. Byte fidelity was never the requirement — **semantic replay fidelity** is, and the two are
not the same thing. What follows records the decision, the reasoning that replaced the earlier
one, and the evidence.

### The decision

**One inbound normalisation/redaction boundary, applied once per event, whose output is what every
consumer sees.** The same redacted object is written to `events.payload_json` *and* folded into
live state, so the live reduction and a post-crash replay of the archive reduce the same input and
cannot diverge. The previous design kept two payloads for one event — the peer's frame in memory
and a stored copy — which is precisely the divergence this conflict was about.

Redaction is **semantic-preserving, not content-preserving**: `seq`, `type`, `turn`, session and
interaction ids, ordering, array lengths and every non-string value pass through byte-identical,
because those are what replay and reconciliation read. Only credential-shaped *text* and
credential-shaped *object keys* are replaced. Fidelity is preserved in the dimension the durability
model depends on and dropped in the dimension it does not.

### Why the earlier "redaction is the wrong fix" reasoning was not decisive

The argument recorded below assumed redaction must be lossy in a way that breaks replay. That is
true of a redaction that changes *structure*; it is not true of one that only removes
credential-shaped strings, because no part of the reconciliation path is keyed on a credential's
value. The three options this file listed all accepted the premise that the archive must hold the
peer's bytes; option 4 — normalise once, at ingress, for every consumer — does not, and it is the
one implemented. The earlier reasoning is kept below verbatim rather than deleted, because a
resolved conflict that erases its own history is indistinguishable from one that was never
examined.

### The two rules

1. `docs/requirements.md` FR-SEC-3, P0: *"Secrets never appear in state, logs, errors or tool
   results."*
2. `AGENTS.md` §6, and the durability model in `docs/architecture.md`: every state transition is
   durable before it is reported, and after a crash the bridge **reconciles against observed
   upstream events** — it replays what it saw. The event archive exists to make that possible.

### Where they collide

`Store.appendEvent` (`src/lib/store.ts`) writes the Host's event payload into
`events.payload_json`, verbatim:

```ts
'insert into events(task_id, session_id, seq, kind, payload_json, stored_at) values (?,?,?,?,?,?)',
taskId, sessionId, seq, kind, JSON.stringify(payload), Date.now(),
```

Those bytes are the peer's, not ours. A real provider tool call can carry a credential in its
`input` — `{"command": "curl -H 'Authorization: Bearer sk-…'"}` is an ordinary thing for a turn to
contain. So the archive can contain credential-shaped material, and FR-SEC-3 read literally forbids
that.

### Why redacting the archive is the wrong fix

Redaction would make the archived payload differ from the payload the peer sent. The reconciliation
path then has two different histories to reason about: one on the live path, where the frame is in
memory unredacted, and one after a crash, where it is redacted on disk. Any dedupe, cursor, or
state-derivation decision that reads a payload would be able to disagree with itself depending only
on whether a restart happened. That is a correctness bug in the exact subsystem — durable
reconciliation of uncertain outcomes — that makes this bridge worth having. Trading it for a
confidentiality improvement in a file that is already mode-restricted is not a trade this project
should make silently.

### What was actually done

The claim was made **precise instead of broad**, and each half is now measured:

| Surface | Rule | Test |
| --- | --- | --- |
| Text the bridge **authors** into its own error surface (`BoundText`, `sanitizeDetails`, the outbox `errorMessage`) | Redacted. A credential is replaced with `[redacted:credential]` before bounding, and redaction happens **before** truncation because half a credential is still a leak of the half that survived. | `security/secret-leakage::a secret in a host error never reaches a caller, a log, or durable state` |
| Text the bridge **copies** into its own interaction payload (the approval `reason`) | Redacted, with the pre-existing 500-character bound preserved. | `security/secret-leakage::a secret in an approval reason never reaches durable state or a caller` |
| Ambient provider credentials in the daemon's environment | Never read, and asserted absent from the Host's request log, from durable state and from the daemon's output. | `security/secret-leakage::the bridge never reads a provider credential value, only the variable name` |
| The **upstream event archive** | **Normalised at ingress, once.** The stored payload is the boundary's output, so a credential in a tool input, a command string, an error bag or an object key is replaced before storage while the replay-critical fields are asserted byte-identical. | `security/secret-leakage::the upstream event archive holds the NORMALISED payload, keeps every replay-critical field, and the secret is gone` |
| Text arriving from the Host through any other ingest path (the history refetch) | The same single boundary, so a row written by a refetch is indistinguishable from the same row written live. | `security/redaction-boundary::the sentinel is absent from a deeply nested object, an array element and an error-detail bag` |

So FR-SEC-3 is satisfied for every surface the bridge **authors**, and is **not** satisfied for the
archive of upstream bytes. That distinction is in the test names, not just in this file.

### What the resolution does NOT cover, stated as a limit

`src/lib/redact.ts` recognises credential-shaped material by pattern and by key name. It is
therefore **not a guarantee that every credential is stripped**, and no test claims otherwise: a
form nobody has written a pattern for is not recognised. This is recorded as an explicit LIMIT case
in `security/redaction-boundary` (a 40-character hex blob is *not* redacted, asserted as a known
limit rather than left to be discovered), and the false positive of the `Basic` header shape is
asserted too. What is claimed is bounded and checkable: the credential shapes this project knows
about, in the places it looked, including object keys, nested tool input, error details, cycles and
inputs deep enough to exhaust the depth or node budget.

### Mitigations that remain in place for the archive

- The state directory is created `0700` and the IPC socket `0600`; `security/filesystem-scope`
  asserts the daemon writes nothing outside the root it was given.
- No state artifact is ever committed, attached to a PR, or published (`AGENTS.md` §9, §10), and
  `session.export` output is treated as a session log by definition and never published.
- The daemon's own logging does not print event payloads; the log assertion above measures that.

### Options that were considered and rejected

1. **Restrict FR-SEC-3's scope in `docs/requirements.md`** to text the bridge authors, and add a
   separate P0 for archive confidentiality (for example at-rest encryption of `events.payload_json`
   keyed by an operator-provided key, which would keep replay parity because the redaction would be
   reversible by the same process). Rejected as a *narrowing*: it would have closed this conflict by
   editing the requirement to match the implementation, which is exactly what the task's instructions
   forbid. It also would have added key management, which this project explicitly does not carry.
2. **Archive a reversible transform** — store the payload under a key the daemon holds, so the
   bytes on disk are not the credential while the reconciliation path still sees the original
   exactly. Rejected: it protects the archive from a reader who lacks the key while leaving the
   credential fully present in state the daemon can show, and it buys that at the cost of a key
   management story and a new failure mode (a lost key makes history unreplayable — the durability
   model, traded for confidentiality, again).
3. **Accept the exposure explicitly**, with the file-permission boundary named as the control.
   Rejected once the alternative above existed: "the directory is 0700" is a weaker control than
   "the credential is not there", and this option also required asserting the exposure positively in
   a test, i.e. writing a test whose passing state documented a leak.
4. **One boundary at ingress, shared by every consumer** — implemented. It keeps the commit-time
   guarantee that motivated the original position (the live path and the replay path see the same
   payload, so they cannot disagree) while removing the credential, and it requires no key, no
   configuration, and no new failure mode.

---

## C-2 — "do not weaken an assertion" versus "do not assert a false claim"

**Status: RESOLVED in this repository's practice; recorded because it recurred.**

While writing the secret-leakage suite, the first version of the archive case asserted that the
sentinel appeared **nowhere** in durable state. That assertion failed. Two possible responses were
available: change the code so the assertion passes, or change the assertion.

`AGENTS.md` §7 forbids softening an assertion to make it pass. It does **not** require asserting
something known to be false, and the two are distinguished by whether the claim being tested is the
one the requirement makes. Here the assertion was conflating two different claims (see C-1), so the
fix was to split the claim and assert each half — including asserting positively that the archive is
verbatim, which is a *stronger* assertion than the original about the behaviour that actually
matters.

The rule this repository applies, written down so it is not re-litigated:

- An assertion may be **narrowed to the claim a requirement actually makes**, with the narrowing
  visible in the test name and in this file.
- An assertion may never be weakened to accommodate a behaviour that contradicts the requirement.
- When in doubt, add a test that asserts the existing behaviour **positively** alongside the
  requirement's test, so the divergence is measured rather than hidden.

---

## C-3: "a test must fail honestly" vs "a test may not widen its own permissions to pass"

**Status: RESOLVED by removal. The forbidden path no longer exists in this repository.**

The isolated tool-effect oracle needs an OS sandbox to prove that a confined tool execution was
actually confined. On this machine that sandbox is unavailable: the supervisor refuses with
`sandbox-exec: sandbox_apply: Operation not permitted`. An earlier revision of
`test/isolated-host/turns.test.mjs` responded to the resulting `SANDBOX_UNAVAILABLE` by re-running
itself with a **broader** permission level (`danger-full-access`).

That is not a test. It is a test that changed the conditions until it passed, and it made the
strongest possible claim ("a tool ran confined") on the weakest possible evidence. It also had a
worse consequence than a false green: on the escalation path the harness would have been entitled to
restart or reconfigure a Host the operator was using. The review that found it was correct to call it
unacceptable, and the response is removal, not a comment:

- The test now **refuses** on `SANDBOX_UNAVAILABLE`, and the refusal is reported as a **failed** case
  with `SANDBOX_UNAVAILABLE` in its name and message. It is not skipped, not timed out, and not
  retried. §7.1 of the test matrix records it as a failure.
- No test may escalate its own sandbox permissions, restart a Host it did not start, or change a
  shared DSH setting. A capability the environment does not grant is a `blocked`/failed result, and
  the honest non-pass is the deliverable.
- Because CI's two platform jobs skip the isolated layer entirely, the resulting claim is narrower
  than it may look: **no confined tool execution has been observed in any environment**, and no
  document in this repository claims one.

The general rule, since this is the kind of thing that gets re-litigated: **the test environment is
part of the claim.** Widening the environment until the assertion holds produces a claim about an
environment nobody runs in.

---

## C-4: a state name that records two facts, where two requirements each name one

**Status: RESOLVED by an explicit third state, with the reasoning recorded.**

FR-APPR-3 asks that a Host carrier receipt of `{accepted:false, reason:'not-pending'}` be surfaced as
a receipt, and that such an interaction **never be counted as answered by us**. FR-APPR-2 asks that
an operator's decision, once made, be durably recorded.

Both are true at once in this case: the operator *did* answer, and the Host had nothing pending to
apply that answer to. Writing `allowed-once` would claim the answer was used (false). Writing a bare
`resolved-by-host` would hide that a decision was made and lost (also a loss of information a caller
needs). So the interaction lands on `answer-not-pending`, which says both, and the test asserts the
state by name *and* asserts it is neither `answered` nor `allowed-once`.

The implementation detail worth recording, because the obvious approach silently fails: the receipt
path cannot reuse `Store.decideInteraction`. That method is a compare-and-set that only moves a row
out of `pending`, and the answer we just sent has already moved it — measured, the second call
returns `applied: false` and the row would keep `allowed-once` with no trace of the receipt. The
compare-and-set is correct and was **not** weakened; instead the receipt got its own narrow
transition, `Store.markAnswerNotPending`, which moves a row only *out of* the states this bridge
writes as an answer. The first attempt at reading the receipt was also wrong in an instructive way:
`Result` carries `receipt` at the top level for this call (it does not go through `#dispatch`'s
`ok({value})` wrapper), and reading only the nested slot made every receipt look like `accepted` —
the single most dangerous misreading on this surface. All observed shapes are now read, and a shape
that matches none of them is reported as `unclassified` rather than defaulted to an acceptance.

## C-5: two bounds that a per-frame limit cannot express, and a frame that is illegal rather than large

**The tension.** "Refuse anything over the bound" and "never drop an event" look like the same rule
until a frame is legal on its own and the message is not. A WebSocket message may be split across any
number of frames, each of which passes a per-frame check, so a per-frame bound cannot bound the
assembled result — and a fragmented message is exactly how a peer imposes memory on a reader that
tries to enforce one. The same shape appears one layer up: a page of events can be legal by count and
enormous by bytes.

**Decision.** The bound is stated in the unit the risk is measured in, and it is checked from the
declared length before the payload is buffered:

- `maxFrameBytes` bounds one frame; `maxMessageBytes` bounds the message assembled from the frames
  between an initial data frame and its FIN, cumulatively, against the DECLARED length — so a peer
  cannot make this process hold the bytes it is trying to make it hold;
- `maxQueueBytes` bounds frames parsed but not yet consumed. The alternative to a queue bound is
  dropping frames to stay inside it, which is the silent loss this file refuses: a caller would keep
  reading a stream it believes is complete while an event is missing. So an over-budget frame is a
  typed error and the connection ends, which the consumer cannot miss;
- `eventPageMaxBytes` bounds a reply by its serialised UTF-8 size, and a single event over the whole
  budget is DELIVERED and named in `oversize`. Skipping it loses an event; returning an empty page for
  that cursor makes the caller loop forever on the same `beforeSeq`. Naming it puts the fact in the
  reply instead of in a comment.
- `hasMore` is asked of the database ("is there an event older than the oldest one returned") rather
  than inferred from the page length, because after a byte bound those two questions stop agreeing: a
  byte-limited page is short while older events remain, and a page that filled the count limit exactly
  may be the whole history.

**The illegal cases are separate from the size cases, and are refused rather than skipped.** A
continuation that starts no message, a data frame inside an open fragmented message, a reserved
opcode, and a binary frame on a text-only downlink are protocol violations. Skipping any of them would
drop data while the stream still reported itself complete, and a caller reading "complete" has no way
to learn that an event is missing. Under the pre-fix code the first was stored as an orphan fragment,
the second was delivered as its own message AND left the partial message held forever, and the third
was ignored. The binary case is a deliberate limit on this bridge rather than a fact about DSH: both
downlinks are JSON text, so a binary frame is refused as an unknown protocol shape instead of being
decoded on a guess. If a future Host sends binary frames, this is the decision to revisit, and the
error says so.

**What is still not claimed.** No test drives a peer that sends a message spanning millions of frames
to observe where the process actually runs out: the bounds are asserted through the client's own
counters and through which frames it delivered, which is a statement about the bound rather than about
this machine's memory. And the queue bound is enforced per connection, so N connections may each hold
up to the budget; the aggregate across the two downlinks is bounded by the number of downlinks, not by
a single global ceiling.

## C-6: a symlink at a path this process owns — resolve it safely, or refuse it

**The tension.** "Follow the path the operator configured" and "never write outside the state
directory" conflict as soon as the path is a symlink, and the two candidate answers are "resolve it
and check where it went" and "refuse anything that is not a regular file".

**Decision: refuse, with one typed error.** Resolving and checking is racy — the target can be swapped
between the check and the use — and the object being protected is the *approval authority*: the token
file's protection is that it lives inside a 0700 directory. A resolved-and-checked path would also
have to decide which targets are acceptable, which is a policy this project has no basis for. Refusing
means: `lstat` first and a non-regular file is `UNSAFE_STATE_PATH`; creation is `O_CREAT|O_EXCL|O_NOFOLLOW`
so a DANGLING link — the case `existsSync` reports as absent — can never be written through; the mode is
set with `fchmod` on a descriptor opened with `O_NOFOLLOW`; and `fstat` on that descriptor confirms a
regular file, which no path-based check can do against a later rename.

**Measured, against the pre-fix code, with real links in this task's own temp directory.** A resolving
link made `ensureAuthorityToken` chmod a file it does not own, outside the state directory (0644 →
0600, contents unchanged); a dangling link made it CREATE the approval token at the link's target,
outside the state directory. Both are asserted against sentinels whose bytes and mode are compared
before and after, because "the bridge refused" is not the claim — the claim is that the file outside is
untouched. The positive control is that an ordinary state directory still creates a 0600 token, reads
it back, reuses it without rotating it, and tightens a drifted mode.

**The limit, stated rather than implied.** This covers the authority-token path. The `cwd`/workspace
half of FR-SEC-4 is NOT implemented: a dispatch whose `cwd` escapes the workspace through a link is
neither refused nor resolved safely, and no test attempts one. FR-SEC-4 is `partial` for that reason.

## C-7: the daemon-local queue scope — kept as an empty scope, not deleted and not faked

**The tension.** FR-CANCEL-1 requires two nested cancellation scopes, and the reply reports them
separately: `queue.local` (the `daemon` scope this bridge owns) and `queue.remote` (the Host's inbox, as
last observed). The daemon has a `#queue` map for the local scope — and NOTHING in this bridge ever
appends to it, because a prompt is dispatched to the Host and the Host's inbox is the only queue that
holds work. So the field is always an empty array, and a reader can reasonably ask whether an empty
array means "nothing is queued" or "this capability does not exist".

**Decision: keep the scope, and say in the reply why it is empty.** Deleting the field would remove a
distinction the requirement exists to preserve — a caller must be able to tell the two scopes apart —
while leaving it unexplained is the failure the review found: `queueClear`'s note said "only the
daemon-local queue scope was touched", which reads as though a local queue COULD have held something.
The note now says there is no daemon-local prompt queue to clear, and `docs/test-matrix.md`'s
cancellation row carries the same wording.

**What was removed rather than explained away.** `#localQueueMax = 64` stood beside the map and was
never compared to anything: a limit that bounds nothing invites the reader to conclude that local
queueing is a capability of this daemon. It is gone. So is the `#dispatch` parameter `retryable`, which
`session.create` passed as `true` and nothing read — retrying is decided from the contract and the
operation's durable state, not from a flag — and `sessionWait`'s `sinceSeq`, which was destructured,
never read, never sent, and never documented. All three are recorded in
`docs/test-matrix.md` §10 as withdrawn claims rather than as quiet deletions.

## C-8: two ends of one socket, one bound — and which end owns it

**The tension.** The IPC socket has a client (each gateway) and a server (the daemon). A bound on one
end is not a bound on the connection: the server capped the frames it ACCEPTED while the client capped
nothing it RECEIVED, and the client's own comment claimed it "bounds what it buffers too". A peer that
never sent a newline therefore grew a gateway's buffer without limit.

**Decision: one number, enforced on both ends, and the server refuses to emit what the client would
reject.** `MAX_IPC_REPLY_BYTES` (default 16 MiB, `DSH_PILOT_IPC_REPLY_MAX_BYTES`) is used by the client
as its receive bound and by the daemon as the cap on any reply it writes; a reply above it becomes a
typed `RESULT_TOO_LARGE` carrying the op, so the caller reads an answer instead of watching a
connection die. The value sits above every reply the daemon can construct from its own configured
limits — an event page, or one event delivered alone because it exceeded the page budget — with room for
JSON escaping, so it is a backstop against a misbehaving peer rather than a limit on normal traffic.

**Why the daemon also refuses to write one.** If the client's limit were lower than the largest reply
the daemon could legitimately produce, the daemon would emit frames its own gateway refuses, and the
symptom — a dropped connection on a call that should have worked — would look like anything but a
bound. Both ends take the number from the same module, and both are asserted to agree.

**The framing half of the same problem.** A chunk boundary is not a character boundary, and both ends
decoded per chunk: `chunk.toString('utf8')` turns a UTF-8 sequence split across two chunks into a
replacement character that concatenating the next chunk cannot repair. Both ends now use a streaming
decoder, tested by writing one byte at a time — including the daemon's request path, where a prompt
containing multi-byte text could be stored and forwarded corrupted.

**C-8a: the first fix to that budget got the UNIT right and the SUBJECT wrong, and both ends had it.**
The decoder change left the accounting alone, and the accounting was: add every byte that arrived in the
current chunk to one counter, compare THAT against a budget named per frame, and only then split the
chunk on newlines; after each completed frame, restore the counter from `Buffer.byteLength(remainder)`,
the re-encoded length of the DECODED remainder. Three consequences, and the review called the first one
correctly:

- **Two legal replies were refused together.** A `data` event is a delivery, not a protocol frame, and the
  kernel is free to hand over two complete replies at once — or the tail of one and the head of the next.
  With one counter holding both, each reply inside the bound and the pair outside it, the client refused
  the connection and failed *every* pending caller for a size the budget was not about. The daemon had the
  identical defect on request lines: a client that batched two requests into one write had its connection
  destroyed for being efficient.
- **A frame could pass while its bytes exceeded the bound.** Because the comparison stopped being about a
  frame at all: one frame of `cap + 1` bytes delivered as two chunks of `cap - 1` and `2` never tripped
  it. The bound's promise — "at most this many bytes per reply" — was not kept in either direction.
- **The reset undercounted.** The bytes a streaming decoder holds for an incomplete trailing sequence do
  not appear in the decoded string, so re-encoding the remainder was short by up to three bytes per
  frame transition.

**Decision: frame on the raw bytes and measure the frame.** `LineFramer` accumulates `Buffer`s, finds
newline BYTES, and hands back each frame with the exact distance between its newlines; the bytes still
waiting for a newline are reported as their own number, which is what an unterminated frame may legally
hold. There is no decoder in the accounting path, so there is nothing to lose bytes in, and every frame's
size is exact by construction rather than by re-encoding.

**Why decoding per frame is exact, not a compromise.** A newline byte can never occur inside a UTF-8
sequence — continuation bytes are all `>= 0x80` — so a frame boundary is always a character boundary and a
frame's bytes always decode to its text in full. That is why the fix is *per frame* rather than a
streaming decoder: the decoder stays only where the bytes are not yet known to be a complete unit, which
is now nowhere on this socket.

**The test's split had to be made real before it could be evidence.** The first boundary case placed its
delivery split at a constant offset from the end of the frame. A JSON frame ends with `"}` and a newline, so
that offset cut quoted ASCII, and the case would have kept passing — with an `endsWith` assertion that cannot
distinguish the two — while never splitting a character at all. It now locates the byte offset of the last
three-byte character and asserts the split's structure: leading byte before the cut (`>= 0xc0`), continuation
byte after it (`0x80-0xbf`), the halves rejoining into the sent bytes, and the frame sizes exactly `cap` and
`cap + 1`. A case whose own construction silently rounds its padding is a case that cannot fail.

**The server's request-line bound became configurable, for the same reason the reply bound is.**
`startIpcServer` takes `maxRequestBytes` (default `MAX_IPC_LINE_BYTES`): the property under test is
"the budget is spent per frame, not per delivery", and a property whose only test must run at 4 MiB is a
property nobody tests. Two controls hold it — `ipc-client-counts-the-delivery-not-the-frame` and
`ipc-server-counts-the-delivery-not-the-line` — and each fails the cases that assert frames *and* the
case that asserts the boundary, which is how the delivery-shaped comparison was caught accepting an
over-bound frame in pieces.

## C-9: a control frame's own rules, which are not a size limit

**The tension.** "Accept what a peer sends and answer it" conflicts with RFC 6455 §5.5 as soon as a
peer is wrong: a control frame's payload MUST be 125 bytes or less, and a control frame MUST NOT be
fragmented. This client accepted a 126-byte ping and answered it — and the answer was itself invalid,
because the pong's length byte held `payload.length` and in the 7-bit length field 126 and 127 are not
lengths but the markers that mean "read the length from the following bytes". The peer would then read
a frame length out of bytes that were never written, so a client's malformed REPLY would desynchronise
a conforming peer.

**Decision: refuse the frame and fail the connection (a `1002`-class protocol error).** There is no
middle path: a frame that violates the section cannot be both rejected and acted on. A fragmented ping
is refused for the same reason and a worse consequence — it was read as the START of a fragmented
message, so the ping was never answered AND the peer's next legal data frame was then reported as the
peer's violation, blaming the wrong side. The positive control is a 125-byte ping, which must still be
answered with the connection left open: the rule is a bound, not a ban on keepalives.

**Fixture fidelity is part of this.** Our own fake Host's WebSocket peer (`acceptWebSocket`, used only
by `test/fixtures/fake-host.mjs`) had the same defect and answered an illegal ping with a malformed
pong. A fixture that produces frames a correct client must reject hides parser bugs instead of finding
them, so it now refuses the same frames. It remains a TEST helper: nothing in this section is evidence
about the official Host, and the production parser's rules are asserted against a raw peer, not against
this fixture.

## C-10: the workspace boundary — resolve and record, or refuse

**The tension.** `cwd` is the one caller-supplied value this bridge hands to a component that runs tools
inside it, and it is a path. A path is a name, not a directory: between the moment a session is created and
the moment work is dispatched, the name can be deleted, replaced by a file, or replaced by a symlink
pointing somewhere else. The bridge cannot confine what a turn does on the Host's filesystem — that
authority is the Host's — so the question is what it can enforce, and there are two candidate answers.

**Option A: refuse every `cwd` that is a symlink (or is not under some configured root).** Attractive
because it is a flat "no", and wrong for this bridge: the Host's own workspace handling legitimately accepts
resolved paths, real deployments put their workspaces behind links, and a rule this bridge invents about
which directories are allowed would refuse working configurations for a security property it does not
actually control. It also cannot be enforced well from here — the check would be a prefix comparison on
strings, which `..` and a nested link both defeat, i.e. a defence that looks like one and is not.

**Option B (chosen): resolve at create, record the directory, re-verify before dispatch.** A `cwd` is
resolved with `realpath` at `session.create`; the RESOLVED directory is what the session records and what
the Host is told; a path that is relative, missing, or not a directory is refused with `WORKSPACE_UNSAFE`
before anything is reserved or sent. Before `session.prompt` dispatches, the recorded directory is
re-resolved and compared against itself: because the record holds a resolved path, "still the same
directory" is exactly "this path still resolves to itself and is still a directory". A swap to a symlink
resolves elsewhere, a deletion does not resolve at all, and a file is not a directory — all three are
`WORKSPACE_CHANGED`, thrown BEFORE the operation is reserved, so no prompt can reach the Host and no durable
intent is left behind for a later replay to send.

**Why this is the honest shape.** It enforces the part this process owns — the value it hands over — and
claims nothing about the part it does not. It is also checkable: "no prompt reached the Host" is asserted
against the fake Host's received-request log rather than against our own reply, so a refusal that still
dispatched could not pass.

**The trades, stated rather than implied.**

1. **A symlinked workspace is accepted and resolved, not refused.** A caller who passes a link gets a
   session whose workspace is the directory the link pointed at when the session was created. If the link
   is later re-pointed, the session is unaffected — which is the point — and a caller wanting the new target
   creates a session for it.
2. **The operation's identity carries the resolved path.** A retry with the same name and the same target
   resolves identically and finds the same operation; a retry whose name now resolves elsewhere is refused
   by the workspace check rather than quietly creating a second session in a directory the first caller
   never chose.
3. **A same-key retry after a workspace change is refused instead of returning the earlier outcome.** Both
   answers are defensible; the refusal is the more useful one, because the caller's intent was to run work
   in a directory that no longer exists. It is a real behavioural choice, so it is recorded here rather
   than left for a reader to discover from a test.
4. **The check runs on every dispatch, not once.** It costs two filesystem calls per prompt, which is
   affordable for this surface and is the only way the property holds for a session that lives for days.
5. **A workspace must already exist when the session is created.** This is the one part callers will
   notice, so it is stated plainly here rather than discovered from an error: a missing path is refused
   with `WORKSPACE_UNSAFE`, and the caller creates the directory first. The alternative was to record a
   canonical path for a directory that does not exist yet, on the theory that the Host creates it — and it
   was tried, because it would have been less disruptive. It was withdrawn: the Host's behaviour for a
   missing `cwd` is not something this project has measured, `workspace-invalid-path` is a Host-side code
   this fixture cannot produce, and a recorded path whose target is chosen by whoever creates it later is
   exactly the state the requirement is about. Refusing is the answer that is verifiable from here.

**The cost of that, paid in fixtures rather than in the contract.** Applying this to the suite failed eight
cases at once, and it was worth being clear about why before changing anything: `fake-host/contract` named
`/workspace/one`, `mcp-e2e/multi-caller` named a fixed `/tmp/multi-caller-workspace`, and `mcp-e2e/stdio`
named a fixed `/tmp/fixture-workspace`. None of those directories was ever created — the fixtures had been
relying on a Host-side tolerance this bridge never documented, and the failures were missing fixture setup,
not eight daemon defects. Each rig now creates its OWN real workspace inside the scratch directory it
already owned, canonicalised with `realpath` because that is what the bridge records and re-verifies;
`multi-caller` shares one workspace across every caller and across the daemon restart within a single test,
which is what its "one durable session" assertions are about; the `cwd`-conflict case uses a second, real,
distinct directory so the conflict is between two workspaces that exist; and every cleanup removes only the
directory the rig created. No fixed path under the OS temp root is created or depended on, and the
production contract was not relaxed to make a fixture pass.
