# Requirements — durable-session MCP bridge

Task: `DSH-PILOT-20260912`. Status: **Phase 0 (specification)** — no implementation yet.
Every row below is a requirement with an **observable oracle**: a statement that a test can
decide as true or false from outside the code. Requirements without an oracle are not
requirements, they are wishes, and none are recorded here.

Companion documents: [`docs/host-compatibility.md`](host-compatibility.md) (what the Host
actually offers), [`docs/test-matrix.md`](test-matrix.md) (which test proves which row),
[`docs/architecture.md`](architecture.md) (layering), [`docs/adr/`](adr/) (decisions).

---

## 1. Purpose and product boundary

**Purpose.** Let an MCP client (any MCP-speaking agent harness) drive *durable* DSH sessions
through a small, understandable bridge: start and own sessions, send follow-ups, watch
events, answer approvals, cancel work, and survive its own crashes — without the caller
having to understand DSH internals and without ever lying about what happened.

**In scope.** An MCP server (stdio; streamable-HTTP only if a later ADR justifies it), a
typed client for the DSH Host `/api` surface, and durable local state with an explicit
ownership protocol.

**Out of scope.** Reimplementing DSH; depending on any pre-existing internal project at
runtime; acting as an authorization layer; OS-level sandboxing of agent worktrees;
multi-tenant scheduling; procurement or production-environment concerns.

**Non-negotiable stance.** When the bridge does not know what happened, it says
`uncertain` and keeps the evidence. It never converts an unknown into a success, and never
converts a skipped test into a pass.

---

## 2. Vocabulary (fixed)

| Term | Meaning in this document |
|---|---|
| **Task** | The bridge's own durable unit a caller references; owns sessions, survives restarts. |
| **Session** | A DSH session (`SessionId`), i.e. the Host's unit of conversation and workspace. |
| **Turn** | One DSH turn inside a session (`turn/start` … `turn/end`). |
| **Operation** | One bridge-initiated mutating intent toward the Host (create/prompt/cancel/respond/…), with its own id. |
| **Interaction** | One answerable host request (approval or question) the bridge must resolve or refuse. |
| **Request id** | The `rpcId` the bridge minted for one upstream call; echoed by the Host. |
| **Journal** | The append-only durable record of intents, outcomes and observations. |
| **Connection state** | Whether the bridge currently has a usable carrier to the Host. |
| **Execution state** | Whether work is actually running in a session, per direct observation. |
| **Oracle** | An externally observable signal that decides a requirement. |

---

## 3. Requirement catalogue

Priority: **P0** = needed for a usable bridge; **P1** = needed for a trustworthy bridge;
**P2** = hardening/operability. A Phase-0 checkpoint may leave P2 unimplemented, but the
checkpoint must say so explicitly rather than implying the whole scope is done.

### 3.1 Identity and durability (`FR-ID`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-ID-1 | P0 | A caller can create a task and receive stable `taskId`, `sessionId`, `turnId`, `operationId`, `interactionId` values that never change across restarts. | New process, same state dir: `task.get` returns byte-identical ids; the ids also appear in the journal before any dispatch. |
| FR-ID-2 | P0 | The bridge never invents a `sessionId` it will not own: a session id is either preallocated by the bridge (via `session.create {sessionId}`) or recorded from the Host response, never guessed. | Fake Host rejects preallocation-collision cases; journal shows the id written before the create call is sent. |
| FR-ID-3 | P1 | Ids are unique under concurrent creation across processes on the same state dir. | N≥8 concurrent creators, single state dir: all ids distinct, no create races produce duplicate ids. |
| FR-ID-4 | P2 | Ids are greppable and self-describing (prefix conveys kind) without encoding secrets or absolute host paths. | Secret scanner + inspection of a state dir produced by the live suite: no path/key fragments inside ids. |

### 3.2 Session lifecycle and ownership (`FR-SESS`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-SESS-1 | P0 | The bridge supports multiple independent sessions (parallel, not just sequential) within one task. | 2/4/8 parallel sessions each complete a turn; per-session markers do not appear in any sibling session's history. |
| FR-SESS-2 | P0 | A follow-up prompt can be sent to the *same* session and is attributed to that same session. | Second prompt's events appear with the same `sessionId`; history contains both turns in order. |
| FR-SESS-3 | P0 | After a bridge restart, a caller can reconnect to the same durable task and attach to its existing session **without creating a new session or replacing its identity**. | Restart, re-attach: `sessionId` unchanged, Host `session.list` shows no additional session created by the re-attach path. |
| FR-SESS-4 | P0 | Two different caller processes can each reconnect to the same durable task and observe the same state. | Two processes, same state dir: both read identical task snapshot and identical event cursor semantics; second attach does not steal or duplicate the session. |
| FR-SESS-5 | P1 | Discovery is restricted to owned sessions: the bridge never adopts, drives or reports a session it did not create for this task. | Live suite: a pre-existing unrelated session on the Host is never prompted, never listed as owned, and never mutated; asserted by comparing host session set before/after. |
| FR-SESS-6 | P1 | `cwd`/workspace ownership is recorded and re-verified before dispatching work. | Dispatch with a recorded cwd that no longer exists or differs → refused with a typed error, no prompt sent (asserted against the fake Host's received-request log). |
| FR-SESS-7 | P2 | Session naming is a presentation concern only: setting a title never changes identity and never becomes a precondition for other operations. | Rename-then-continue: subsequent operations succeed with unchanged ids. |

### 3.3 Durable state, journal and crash behaviour (`FR-STATE`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-STATE-1 | P0 | Every mutating intent is durably recorded **before** it can reach the Host, with its `requestId`. | SIGKILL immediately after dispatch begins: the journal already contains the intent + `requestId`; no code path can send before the write is durable (write-order asserted by observing the journal file during a crash test). |
| FR-STATE-2 | P0 | No mutating upstream call is blindly repeated. After an unknown outcome the bridge records `uncertain` and reconciles instead of re-sending. | Seeded crash interleavings: the fake Host's received-request log contains exactly one dispatch per logical operation; a repeated `prompt` would appear as a second record and fail the test. |
| FR-STATE-3 | P0 | After crash+restart, committed state survives and is not double-applied: no duplicate dispatch, no cursor regression or duplication. | Kill -9 during in-flight work, restart: state hash matches expectation, cursor monotonic, event set contains no duplicates. |
| FR-STATE-4 | P0 | When the Host cannot prove an operation's resolution, the bridge reports an explicit `uncertain` execution state with the evidence that made it uncertain. | Fake Host drops the response after accepting: outcome is `uncertain` (never `ok`), and the record names the missing evidence. |
| FR-STATE-5 | P0 | Storage corruption, disk full and permission errors produce a defined, safe behaviour: refuse to dispatch, preserve the last good state, and report a typed error. | Injected corrupt journal / ENOSPC / EACCES: process exits or refuses with a typed error, no partial uncommitted mutation becomes visible, last-good state still readable. |
| FR-STATE-6 | P1 | Journal growth is bounded and observable: rotation/compaction never loses an un-resolved intent, and a compacted state can be replayed. | Long randomized run: journal size stays under the configured bound; replay from compacted state reproduces the same final snapshot. |
| FR-STATE-7 | P1 | State files carry a schema version, and an unknown future version is refused rather than misinterpreted. | Hand-crafted version+1 file → typed "unsupported state version" error, no mutation, original file untouched. |
| FR-STATE-8 | P2 | The state dir layout is human-inspectable and documented (what each file means), so an operator can answer "what happened" without the bridge. | Docs-to-reality check: the documented layout matches a real state dir produced by the live suite, field by field. |

### 3.4 Competing-owner protection (`FR-OWN`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-OWN-1 | P0 | At most one process may be the owner of a task at a time, enforced by an **atomic** mechanism — never "check a PID, then delete a lock". | Two processes race to claim: exactly one wins; the loser is refused and sends nothing (verified in the Host request log). |
| FR-OWN-2 | P0 | A second process cannot send on a task owned by a live owner. | Second process's send attempt → typed refusal, and the fake Host sees zero requests from it. |
| FR-OWN-3 | P0 | Recovery does **not** require a human to delete a stale lock: if the owner is dead, a new owner can take over automatically and safely. | SIGKILL the owner, start a new process with no manual cleanup: it becomes owner, and the required reconciliation happens before any new dispatch. |
| FR-OWN-4 | P1 | Ownership is leased with expiry semantics that cannot be satisfied by a paused-but-alive owner without a refresh; a hung owner's lease is reclaimed. | Stop-the-world the owner (SIGSTOP) past the lease: another process reclaims; on SIGCONT the old owner discovers it lost ownership and stops issuing calls. |
| FR-OWN-5 | P1 | Ownership transitions are journaled with owner identity and reason. | Journal inspection shows claim/release/reclaim records in order. |
| FR-OWN-6 | P2 | Cooperative, not OS-enforced: the design states plainly that a hostile process could ignore the protocol, and the bridge therefore never treats the lease as a security boundary. | Documented in ADR + a test asserting no security claim is made (e.g. behaviour is unchanged when a foreign process writes the state dir without the protocol — detected and reported, not silently trusted). |

### 3.5 Event ingest, cursors and paging (`FR-EV`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-EV-1 | P0 | Events are ingested from the Host mux downlink with a durable per-session cursor. | After N frames, cursor equals last persisted seq; restart resumes without re-delivering already-persisted events. |
| FR-EV-2 | P0 | Callers read events **incrementally with paging**, bounded in size, never a full unbounded dump. | Page request returns at most the requested bound; next page continues strictly after the previous cursor; no duplicates, no gaps. |
| FR-EV-3 | P0 | Gaps are detected and reported: a skipped or unparseable frame must not silently vanish. | Fake Host injects a gap/out-of-order/malformed frame: bridge reports the gap and reconciles by refetching history; the event set is complete and duplicate-free afterwards. |
| FR-EV-4 | P0 | Reconnect follows the documented protocol: reopen the stream **and** refetch history, then dedupe. | Disconnect/reconnect with frames missed while down: final state matches a control run with no disconnect. |
| FR-EV-5 | P1 | Pending approvals/questions replayed on mux open (with the reused `rpcId`) are recognized as the same interaction, not new ones. | Reconnect while an approval is pending: exactly one pending interaction exists afterwards, with the original correlation id. |
| FR-EV-6 | P1 | Duplicate, old, out-of-order and oversized events are handled without state corruption, and oversized payloads are a typed outcome rather than a memory event. | Property/fake-Host suites: shuffled + duplicated + oversize frames produce the same canonical state as the in-order run; a memory bound is asserted. |
| FR-EV-7 | P1 | Cursor retention is bounded and documented: what happens when a caller's cursor fell outside the retained window is explicit (typed outcome, not a silent gap). | Ask for events older than the retention floor → typed "cursor expired" result with the refetch path spelled out. |
| FR-EV-8 | P2 | Event/log growth is bounded (per-session caps and truncation) with counts exposed. | Long randomized run: memory and on-disk event records stay under configured caps; counters report truncation. |

### 3.6 Execution, waiting and connection semantics (`FR-EXEC`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-EXEC-1 | P0 | A program can wait for a bounded time for turn progress; the wait returns a terminal reason, never an ambiguous nothing. | Wait with a timeout: result is a typed reason (`turn-ended`, `timeout`, `disconnected`, `uncertain`, …) selected from a closed set. |
| FR-EXEC-2 | P0 | Connection state and execution state are separate facts and never conflated in reporting. | Drop the carrier while a turn is running: connection is `down`; execution is *not* reported as failed/stopped merely because the socket died. Reconnect then resolves the true execution state. |
| FR-EXEC-3 | P0 | Every current-turn terminal reason is explicit and distinguishable (completed / failed / cancelled / uncertain / host-rejected). | Table-driven test: each termination path yields its own reason, asserted from a real (fake or isolated) Host run. |
| FR-EXEC-4 | P1 | "Uncertain" is a first-class result: no API path can render it as success. | Negative-control: mutating the code to treat uncertain as success makes the suite fail (mutation test). |
| FR-EXEC-5 | P1 | Host models/providers are configurable references — never committed values; the bridge works against whatever route the Host advertises and reports an unroutable route as a typed error. | Config with an env-var-referenced route performs a real turn on the opted-in live suite; an unroutable route yields a typed error and no partial dispatch. |
| FR-EXEC-6 | P2 | Attached-session counts or other host-level aggregates are never used as proof that *our* session is running. | Fake Host reports a misleading `attachedSessions`: the bridge's own execution state remains per-session and unaffected. |

### 3.7 Approval and interaction safety (`FR-APPR`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-APPR-1 | P0 | An approval request stays pending until a human intent is expressed; the bridge never auto-approves — not on timeout, not on reconnect, not on a malformed payload. | Auto-approval hunt: timeouts, reconnects, malformed frames and "urgent" text in tool args all leave the interaction pending; fake Host records zero `respond` calls. |
| FR-APPR-2 | P0 | An answer is bound to the exact task + turn + `rpcId` (+ approvalId) it answers; stale, replayed or wrong-turn answers are refused. | Replay an already-answered request and an answer for a different turn: both refused with a typed error, and the fake Host's `/api/respond` log shows no delivery for them. |
| FR-APPR-3 | P0 | The carrier receipt `{accepted:false, reason:"not-pending"}` is surfaced, not swallowed: `not-pending` marks the interaction as already-resolved/expired rather than "answered". | Fake Host returns `not-pending`: interaction state becomes resolved-by-host/expired, never `answered-by-us`. |
| FR-APPR-4 | P0 | Malicious or untrusted text (document content, event payloads, tool output) cannot authorize anything: only an authenticated caller intent channel can. | Adversarial fixtures inject approval-looking instructions into event/document text → no approval is ever emitted; asserted on the Host request log. |
| FR-APPR-5 | P1 | Rejected and expired interactions are terminal and distinguishable from accepted-by-human. | Table test across allowed-once / rejected / expired / replayed with distinct reasons. |
| FR-APPR-6 | P2 | Interaction history is auditable: who answered, when, on which correlation id, with what outcome. | Journal inspection for a scripted interaction sequence. |

### 3.8 Cancellation semantics (`FR-CANCEL`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-CANCEL-1 | P0 | Turn cancellation and queue cancellation are separate operations with separate effects and separate reports. | Cancel turn with items queued: turn stops, queued items remain (per Host semantics) and are reported as remaining; cancel/remove the queue item separately and observe it disappear from the queue snapshot. |
| FR-CANCEL-2 | P0 | The bridge never claims a tool subprocess stopped without process-level evidence. | Real process oracle: with a long-running child process, the report either carries observed evidence (pid/exit/reaped) or explicitly says the subprocess outcome was not observed. |
| FR-CANCEL-3 | P1 | Cancel is idempotent from the caller's perspective and its repeated call cannot corrupt state or produce duplicate effects. | Double cancel: one effect, stable journal, no error escalation beyond a typed already-cancelled/unknown outcome. |
| FR-CANCEL-4 | P1 | Cancellation during a disconnect produces an explicit uncertain/queued outcome rather than a false success. | Drop carrier, then cancel: result is typed (`uncertain`/`refused`), never `cancelled` without evidence. |
| FR-CANCEL-5 | P2 | Race between cancel and turn completion is resolved deterministically and reported. | Randomized interleavings (seeded): each run ends in exactly one declared terminal reason consistent with observed events. |

### 3.9 MCP surface, protocol discipline and compatibility (`FR-MCP`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-MCP-1 | P0 | The product face is a real MCP server over stdio, exercised by a real MCP client spawning the built binary. | E2E: a real MCP client process spawns the built entry point, lists tools, calls them, and observes results — no in-process shortcut. |
| FR-MCP-2 | P0 | Tool schemas are strict: invalid input is rejected by schema validation with a machine-readable error, and no dispatch occurs. | Invalid-input table: each bad payload rejected before any Host request (asserted on the fake Host log). |
| FR-MCP-3 | P0 | Unsupported Host capabilities are reported as unsupported/failed, never simulated as success. | With an unsupported operation requested, the acceptance item fails/blocks visibly; no fabricated success value is produced. |
| FR-MCP-4 | P1 | The bridge pins the Host contract at a measured version and detects contract drift. | Compatibility test diffs the resolved dependency tree + `RpcMethodMap` keys/frames against the checked-in pin and fails on add/remove/rename. |
| FR-MCP-5 | P1 | Startup validates the environment (Host reachability, trust-fence authority, state-dir writability) and fails closed with an actionable message. | Boot with unreachable Host / unwritable state dir: typed startup error, no partial state left behind. |
| FR-MCP-6 | P2 | Long-running tool calls report progress and honour caller cancellation via MCP cancellation. | Real-client test cancels a wait call: bridge stops waiting, Host request log shows no new mutating call. |

### 3.10 Security, privacy and resource bounds (`FR-SEC`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-SEC-1 | P0 | Cross-session isolation: no session can observe or affect another task's session through the bridge. | Parallel live suite with unique per-session memory markers: no marker leaks across sessions; fake-Host run with interleaved traffic agrees. |
| FR-SEC-2 | P0 | Filesystem scope: the bridge and its tests write only inside their documented state dir and task-created isolated temp dirs; never a user's real DSH home, another repository, or the live UI's port. | Test-suite audit: paths recorded by the suite stay within the allowed roots (asserted), and the live suite runs with its own `DSH_HOME`. |
| FR-SEC-3 | P0 | Secrets never appear in state, logs, errors or tool results; provider credentials are referenced by env var name only and never read or printed. | A synthetic sentinel is planted at ingress — in a flat string, a log line, nested tool input, error details, an array element and an object KEY — and traced: zero hits in the durable event archive, in logs, in errors and in every MCP-visible surface, with the replay-critical fields (`seq`, `type`, `turn`, ids, ordering, values) asserted unchanged across the boundary. Recognised credential *forms* only: the set of shapes the boundary knows is stated as a limit and a shape outside it is asserted NOT to be redacted, so no absolute claim is made about forms nobody has written a pattern for. CI's package-shape job additionally fails on any credential-shaped literal in a tracked file. |
| FR-SEC-4 | P1 | Symlink/cwd boundaries: a path that escapes the owned workspace through a symlink is refused. | Symlinked workspace fixtures: dispatch refused or resolved safely, with a typed error; no write outside the workspace. |
| FR-SEC-5 | P1 | Resource bounds: bounded memory, bounded page size, bounded per-session event retention, bounded concurrent upstream calls. | Long randomized run with counters: each bound respected and reported. |
| FR-SEC-6 | P2 | The bridge makes no security claim it cannot support (no "sandbox", no "authenticated to the Host"). | Documentation review item plus a test asserting the untrusted-directory case is reported, not blocked. |

### 3.11 Evidence, CI and reproducibility (`FR-EV2`)

| ID | Pri | Requirement | Observable oracle |
|---|---|---|---|
| FR-EV2-1 | P0 | Every reliability claim in the README/docs maps to a runnable test id in the matrix. | Requirements-to-test matrix audit: zero unmapped P0/P1 rows, zero matrix rows with no requirement. |
| FR-EV2-2 | P0 | Randomness is seeded and replayable; a failure report includes the seed and the exact command to reproduce. | Failing run's printed command reproduces the same failure deterministically. |
| FR-EV2-3 | P0 | CI runs deterministically on Linux and macOS without secrets, installs from the lockfile, and counts failed / skipped / timed-out distinctly. | CI job output shows the three counters separately; a skipped live suite cannot produce an overall pass claim. |
| FR-EV2-4 | P0 | Untrusted PR workflows cannot reach credentials. | Workflow inspection + a run from a fork-like context showing no secret is available. |
| FR-EV2-5 | P1 | Results are machine-readable per layer (JSON report) and published as artifacts. | Artifact fetch shows per-layer JSON with test ids, status and durations. |
| FR-EV2-6 | P1 | Coverage is reported for critical modules and justified by behaviour, not by a single percentage. | Coverage artifact names critical modules and the matrix's oracle for each; a bare number is treated as insufficient. |
| FR-EV2-7 | P2 | A resumable soak runner records real wall time, continuity, counts, gaps and restart checkpoints. | Runner output over a short window today; the multi-day figure stays a later measured milestone and is never claimed now. |

---

## 4. Explicit non-claims (Phase 0)

Stated so no reader can mistake this document for a status report:

- Nothing here is implemented. No test in the matrix has run except the two Phase-0
  feasibility observations recorded in `docs/host-compatibility.md` §6.
- The bridge has **not** been proven against the official Host for any turn-level behaviour.
- No reliability property is claimed for any requirement; each is a specification with a
  planned oracle.
- Mock-provider feasibility and subprocess-stop evidence are **open questions**
  (`docs/host-compatibility.md` §7), not solved problems.
- The final storage format, concurrency mechanism and MCP tool surface are **deliberately
  undecided** pending the design handoff; this document fixes *what must be observable*,
  not how it will be built.

---

## 5. Traceability rule

A requirement is "done" only when: its oracle-bearing test exists, runs in a named layer,
passes on the pinned environment, and its evidence is linked. Partial implementations are
reported as partial. Any row without a passing test is reported as unsupported or
unverified — never as working.
