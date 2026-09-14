# ADR 0003: Inbound normalisation and redaction boundary (resolves conflict C-1)

- Status: **Accepted.** The decision is implemented as `src/lib/redact.ts` and pinned by
  `test/security/redaction-boundary.test.mjs`. The boundary is delivered as a pure module and is
  **not yet wired into event ingest** — that wiring, and the test update it forces, are named in
  [Consequences](#consequences) rather than claimed here.
- Date: 2026-09-13
- Scope: dsh-pilot — the event-ingest path, and everything that reads an archived event payload
- Related: `docs/conflicts.md` **C-1** (the OPEN conflict this record resolves); `docs/requirements.md`
  FR-SEC-3 (P0); `AGENTS.md` §4 (Node-free contract surface, narrowing casts), §6 (durability and
  replay), §7 (an oracle per claim), §9 (secrets); [ADR 0001](0001-language-runtime-and-dependency-posture.md)
- Numbering: this record was first written as `0002`, which `0002-owner-exclusion-primitive.md`
  already held; it was renumbered to `0003` in the same commit that wired the boundary. Recorded
  because the collision was real — two records sharing a number makes a citation ambiguous.
- Superseded note (kept for the history, no longer current): the record was
  created under the filename the task named, so two records now share it; renumbering one of them is
  housekeeping, recorded here because a silent duplicate number is the kind of thing nobody notices.

## Context

Two binding rules collide, and `docs/conflicts.md` C-1 records the collision rather than hiding it:

1. **FR-SEC-3 (P0):** *"Secrets never appear in state, logs, errors or tool results; provider
   credentials are referenced by env var name only and never read or printed."* The event archive is
   state.
2. **The durability model (`AGENTS.md` §6, `docs/architecture.md`):** every state transition is
   durable before it is reported, and after a crash the bridge reconciles against observed upstream
   events — it replays what it saw. The archive exists to make that possible.

Read literally, (1) forbids (2) from being faithful. The material at issue is real and ordinary: a
provider tool call whose `input` names a shell command that quotes an authorization header is an
unremarkable thing for a turn to contain, and that is exactly what `Store.appendEvent` writes into
`events.payload_json` — the peer's bytes, verbatim (`JSON.stringify(payload)`).

The measured shape of the problem, before this change, is worse than "one leak":

| Observation | Where |
| --- | --- |
| One event reaches durable state as `{nativeType, raw}` (mux) or `{nativeType, raw, source:'history-refetch'}` (history refetch) | `src/lib/daemon.ts` ingest sites |
| The same event reaches live state reduction as the raw event object, from a second call | `#applyEventToState(session.session_id, frame['event'])` |
| Replay reads what was stored; live reduction reads what arrived | `Store.pageEvents` / `safeJson` |

So the bridge already keeps **two payloads for one event**, and any redaction applied to one of them
would make the disagreement between live reduction and replay permanent and silent — a correctness
bug in the one subsystem (durable reconciliation of uncertain outcomes) that this bridge exists to
provide. C-1's own text reaches the same conclusion: redacting the archive alone "is not a trade this
project should make silently".

## What was actually built

Measured on this machine, `node v24.15.0`:

| Fact | Value | How it is checked |
| --- | --- | --- |
| The boundary | `src/lib/redact.ts`, 395 lines, **no imports at all** (no `node:*`, no `Buffer`, no Node global) | `npm run build` — 0 errors; security/redaction-boundary case 12 |
| Credential shapes | 6 (`adapter.ts`'s 5, carried over, plus one added) | security/redaction-boundary cases 1 and 11 |
| Sensitive property NAMES | 23 exact names + 9 words | security/redaction-boundary case 1 |
| Bounds | depth `24`, nodes `100_000`, cycles broken, traversal failure marked | security/redaction-boundary case 9 |
| Oracle | `test/security/redaction-boundary.test.mjs`, 12 cases | `node test/run.mjs test/security --filter=redaction-boundary` → `passed=12 failed=0 skipped=0 timedOut=0` |
| Behavioural superset of `adapter.ts`'s set | asserted on a 6-entry corpus, with exactly one measured place where this set is strictly stronger | security/redaction-boundary case 11 |
| Wiring into ingest | **not done**: no file under `src/` calls `redactInbound` yet | `grep -rn redactInbound src/` |

Every value in the oracle is synthetic, assembled at runtime from parts; no credential, hostname or
session log appears in the module, the test or this record.

## Decision

### 1. One boundary, applied once, one payload

There is exactly **one** inbound normalisation/redaction boundary: `redactInbound(value, policy)`.
It is applied ONCE, as a frame enters the bridge, and its result is the payload that all three
consumers share:

- live state reduction (`#applyEventToState`),
- durable storage (`Store.appendEvent` → `events.payload_json`),
- replay after a crash (whatever is read back out of `events`).

No consumer may redact, normalise, or re-derive the payload for itself, because two payloads for one
event is precisely the failure C-1 describes. The boundary is a pure function, so "the payload the
live path reduced" and "the payload a replay reduces" can be compared with `JSON.stringify` rather
than argued about.

### 2. Semantic fidelity, not byte fidelity — stated as the trade

This decision deliberately gives up **byte** fidelity of the archived payload and keeps **semantic**
fidelity of replay:

- **Preserved exactly:** every non-string value (numbers, booleans, `null`) as it arrived; object key
  ORDER; array order and length; event kind/type; session, task and event ids; sequence numbers;
  turn numbers; outcome and state strings; the count of fields in every object.
- **Replaced:** credential-shaped runs of text, and values whose property NAME says it is a
  credential. Object keys are replaced when the key itself is credential-shaped, and the key SLOT
  survives so the object's shape and field count are intact.

The claim this buys is narrow and checkable: *a replayed event reduces to the same state and control
flow as the live one.* It is not "the file on disk is the bytes the peer sent", and no document in
this repository may present it as such. An operator diffing an archived payload against a Host log
will see differences, and that is the intended, recorded cost.

### 3. The policy, in full

| Rule | Applies to | Why |
| --- | --- | --- |
| The six exported shapes (`CREDENTIAL_PATTERNS`) | every string, and every property name | the recognisable credential forms; the name-based rules cannot see a bare credential embedded in prose |
| An exact sensitive name (`SENSITIVE_KEY_NAMES`) | a string value under that name, replaced wholesale; and its subtree inherits the sensitive context | a field called `apiKey`, `password`, `Authorization` or `credentials` is a credential whatever its shape — including a nested bag whose inner keys the peer invented |
| A sensitive WORD in a name (`SENSITIVE_KEY_WORDS`) | a string value directly under that name | catches names the exact list has never seen (`X-Auth-Token`, `clientSecretV2`) without letting a name like `tokenUsage` redact the model name inside its bag |
| Nothing else | all other values | an ordinary diagnostic must survive; a redactor that destroys the diagnosis is a second bug |

Two tiers exist rather than one because the exact list must stay short (a list that grows by adding
every name containing "key" starts rewriting control fields) while the word list must not inherit
into subtrees (informational names like `tokenUsage` merely contain a sensitive word).

### 4. Bounds and totality

The walk is bounded in depth and in visited nodes, breaks cycles with a marker, and is total: it
never throws, and a value it cannot traverse at all (a hostile `Proxy`, an accessor that throws on
read) collapses to a marker instead of propagating. On the ingest path, an exception would take the
daemon down; a redaction boundary may lose information and may not lose the process. Every bound is
**visible** in its output as a named marker, so a truncated payload cannot be mistaken for a quiet
one. The bounds are sized against the transport's own 1 MiB frame bound rather than against taste: a
smaller node budget would truncate payloads a peer is entitled to send.

### 5. Two modes, and why they are not the same policy

`redactInbound` walks a value; `redactText` scans a string. Text mode is **shape-only**, because a
scan over prose cannot tell a field name from a sentence. This asymmetry is a measured limit of the
policy, not an oversight, and it is stated in the module.

## Consequences

### What this fixes

- FR-SEC-3 can be satisfied for the archive **as well as** for the surfaces the bridge authors, with
  no divergence between live reduction and replay caused by redaction.
- The two-payloads-for-one-event shape is removed by construction: one function, one call site per
  ingest path, one object feeding storage and reduction.
- The limit of the mitigation is asserted rather than implied, so a future reader cannot mistake the
  boundary for credential recognition.

### What it costs

- The archived payload is not the peer's payload. Byte diffing against a Host log will differ.
- A debug session that needs the literal header text cannot get it from the archive. That is the
  point, and it is a real loss of debuggability.
- The added Basic-auth shape over-redacts a mixed-case word after the word "Basic" (measured:
  `Basic AuthRetryExceeded` → the marker). A destroyed diagnostic is a price, recorded, not a
  feature.
- Two copies of the shape list exist until follow-up 3 below lands.

### Named follow-ups (not done in this change, and deliberately so)

1. **Wire the boundary** at both ingest sites in `src/lib/daemon.ts` (the mux frame path and the
   history-refetch path), so the SAME redacted object is passed to `Store.appendEvent` and to
   `#applyEventToState`. Those two files are owned by another change in flight, and this ADR does not
   pretend the wiring exists.
2. **Update the existing archive assertion.** `test/security/secret-leakage.test.mjs` currently
   asserts *positively* that the archive holds the peer payload verbatim, with a failure message that
   says C-1 needs revisiting if that changes. Once (1) lands, that case must assert the redacted
   behaviour instead. This is an assertion narrowed to the claim the requirement makes after the
   decision, which `docs/conflicts.md` C-2 permits when the decision — not the test — changed; it is
   **not** a weakened assertion, and it must land in the same commit as (1). Until then, the
   repository is consistent: nothing calls the boundary, so the verbatim behaviour is still what runs.
3. **Unify the shape list** in `src/lib/adapter.ts`: it should import `CREDENTIAL_PATTERNS`,
   `REDACTION_MARKER` and `redactCredentials` from `src/lib/redact.ts` instead of keeping the
   antecedent copy. `adapter.ts` keeps its list private today, which is why this change carries a
   copy rather than importing one, and why the oracle measures a behavioural *superset* on a corpus
   instead of asserting identity of two lists it cannot both read.
4. **Add `src/lib/redact.ts` to `tsconfig.contract.json`'s include list**, which turns its
   Node-freeness from a test assertion into a build failure.
5. **Close C-1** in `docs/conflicts.md`: OPEN → resolved by this decision, with the verbatim-archive
   entry replaced by "redacted at the boundary, semantically faithful". Not edited here (file outside
   this change's scope).
6. ~~Renumber one of the two `0002` records.~~ Done: this record is now `0003`.

## Alternatives considered

### Redact only the persisted copy (leave live reduction on the raw frame)

Rejected: it produces two histories for one event, and the disagreement is invisible — dedupe,
cursor and state derivation would depend only on whether a restart happened, which is
indistinguishable from a Host behaviour change in a bug report. It is also the alternative C-1
already rejected on correctness grounds before this ADR existed.

### Redact only the live copy (store verbatim, as today)

Rejected: it leaves the credential in the one place that survives a crash and is named by the
requirement ("state"). It also fails the requirement twice over, because the archive is read back
into a tool result by `session.events` and into exported evidence, so the leak does not stay in a
file.

### Store the payload encrypted, or under a reversible transform keyed by the daemon

Rejected for this change, though it is the strongest of the rejected options and remains available:

- It requires key management and a new configuration surface. `AGENTS.md` §3 and ADR 0001 fix a
  posture of zero runtime dependencies and no auth/TLS story; a daemon-held key protects against a
  reader of the file *only*, and the file already lives in a `0700` state directory, so the marginal
  protection is the same boundary that is already asserted.
- It adds a new catastrophic failure mode: a lost, rotated or mis-supplied key makes the event
  archive unreadable, i.e. an unreplayable crash history. Trading a confidentiality gap in a `0700`
  directory for "the durable state may be unopenable" is the wrong direction for a durability-first
  component.
- It does not remove the credential from the surfaces the bridge authors (`session.export` produces a
  real session log by definition, and is uncommitted and never published by policy).
- This ADR does not foreclose it: the boundary is exactly the hook a reversible transform would plug
  into, and adopting one later would cost one function, not one architecture.

### Mark every string, or every value under a plausible name

Rejected: a Host error redacted into `[redacted:credential]` is useless to a caller, and the archive
would stop being informative about anything. `adapter.ts` already records this reasoning for its
narrow shapes, and this decision keeps that stance rather than reversing it.

### Recognise credentials by entropy/“this looks random” heuristics

Rejected: the claim cannot be falsified — there is no oracle for "this string is a secret" — so it
could never carry a test. In practice it would also tear legitimate digests, ids and hashes out of
tool results and control data. A stated, tested limit is more useful than an unfalsifiable guarantee,
and the limit is asserted in case 10 of the oracle.

### Do nothing, and name the file permissions as the control (C-1's option 3, the previous default)

Rejected as the end state: it leaves FR-SEC-3 unsatisfied for state. It remains the honest description
of the *current* running system only until follow-up 1 lands.

## Limits (explicit, and asserted where it matters)

This boundary is a mitigation, not a guarantee. Everything below is a known, deliberate gap:

1. **Credential forms outside the policy pass through.** Asserted concretely: a bare 40-character hex
   blob survives in a flat string, in an array and under a benign key. Also missing: a bare password
   in a sentence, an unprefixed opaque token, a credential written in a language whose field names are
   not in the exported lists, and a numeric secret (numbers are never rewritten, by design — see
   decision 2).
2. **Text mode cannot see names.** A `name=value` pair is caught; the same value alone in prose is
   not.
3. **The Basic shape over-redacts** a mixed-case word after "Basic" (a recorded cost), and it requires
   a body of at least 12 characters, so a short one is missed.
4. **Bounds are losses.** A payload deeper than `maxDepth`, wider than `maxNodes`, or cyclic is
   truncated or marked. The marker makes the loss visible; it does not make it free.
5. **Exotic containers** (`Map`, `Set`, `Date`, class instances) are walked as ordinary objects and
   therefore copy as empty objects, because they have no enumerable own string-keyed properties. The
   boundary is defined over JSON-shaped data; a caller holding something else must serialise it first.
6. **Total traversal failure collapses the whole payload** to a single marker. `JSON.parse` output
   cannot trigger this; a hostile `Proxy` can. The alternative — propagating — is worse on the ingest
   path.
7. **Nothing here is a defence against a peer that wants to exfiltrate a secret** by encoding it into
   a value shape the policy does not recognise, or by splitting it across fields. The boundary
   reduces accidental exposure; it is not a data-loss-prevention product.

## Revision history

- **Revision 1 (2026-09-13):** initial decision, resolving `docs/conflicts.md` C-1. Delivered as
  `src/lib/redact.ts` plus `test/security/redaction-boundary.test.mjs` (12 cases). Wiring into
  `src/lib/daemon.ts`, the paired update to `test/security/secret-leakage.test.mjs`, the unification
  of `adapter.ts`'s shape list, and the contract-gate inclusion are named follow-ups, not claims.
