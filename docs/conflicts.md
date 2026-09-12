# Conflicts between binding rules

`AGENTS.md` says: if a task instruction conflicts with one of its rules, stop and surface the
conflict instead of picking a side. This file is where that happens. A conflict recorded here is
**open** until it is resolved by a decision, and an open conflict is not a licence to ignore either
side — it is a statement that a test or a document had to choose, and of exactly what it chose.

Nothing here is a claim that the work is fine. Each entry names the two rules, the place they
collide, what was done in the meantime, and what resolving it would require.

---

## C-1 — FR-SEC-3 ("a secret never appears in state") versus the event archive's fidelity

**Status: OPEN. Decision needed from the task owner.**

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
| The **upstream event archive** | **Verbatim, deliberately.** Asserted to be verbatim, so a future reader cannot mistake the omission for an oversight. | `security/secret-leakage::the upstream event archive keeps payload bytes verbatim, and that is a documented conflict` |

So FR-SEC-3 is satisfied for every surface the bridge **authors**, and is **not** satisfied for the
archive of upstream bytes. That distinction is in the test names, not just in this file.

### Mitigations currently in place for the archive

- The state directory is created `0700` and the IPC socket `0600`; `security/filesystem-scope`
  asserts the daemon writes nothing outside the root it was given.
- No state artifact is ever committed, attached to a PR, or published (`AGENTS.md` §9, §10), and
  `session.export` output is treated as a session log by definition and never published.
- The daemon's own logging does not print event payloads; the log assertion above measures that.

### What resolving it would require

One of the following, as a decision rather than an implementation detail:

1. **Restrict FR-SEC-3's scope in `docs/requirements.md`** to text the bridge authors, and add a
   separate P0 for archive confidentiality (for example at-rest encryption of `events.payload_json`
   keyed by an operator-provided key, which would keep replay parity because the redaction would be
   reversible by the same process).
2. **Archive a reversible transform** — store the payload under a key the daemon holds, so the
   bytes on disk are not the credential while the reconciliation path still sees the original
   exactly.
3. **Accept the exposure explicitly**, with the file-permission boundary named as the control.

Option 3 is the current de facto position, and it is recorded here rather than assumed.

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
