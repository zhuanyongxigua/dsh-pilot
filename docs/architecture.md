# Architecture — Phase 0 plan (not frozen)

Status: **plan for review, not a frozen design.** Task instructions are explicit that the
final storage format, concurrency mechanism and tool surface are decided only after the
architecture handoff arrives in this session. This document therefore describes the
**skeleton that the requirements force**, marks the seams that are deliberately left open,
and records what the skeleton already forbids.

Companion documents: [`requirements.md`](requirements.md) (what must be observable),
[`test-matrix.md`](test-matrix.md) (how each property is proven),
[`host-compatibility.md`](host-compatibility.md) (the measured Host surface),
[`adr/0001-language-runtime-and-dependency-posture.md`](adr/0001-language-runtime-and-dependency-posture.md).

---

## 1. Shape

```
        MCP client (any harness; DSH's dsh-mcp-client in the target deployment)
                                  │  MCP over stdio (JSON-RPC)
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  MCP face        tools / schemas / request cancellation       │  protocol only
   ├──────────────────────────────────────────────────────────────┤
   │  Domain layer    task & session lifecycle, intent records,    │  the only place MCP
   │                  reconciliation, cancellation scopes,         │  semantics and Host
   │                  capability negotiation, wait/terminal reasons │  semantics meet
   ├──────────────────────────────────────────────────────────────┤
   │  Host client     /api envelopes, rpcId minting + echo check,  │  carrier only
   │                  HTTP POST carrier, two WS downlinks,         │
   │                  /api/respond receipts, capability probe       │
   ├──────────────────────────────────────────────────────────────┤
   │  Durable state   journal, intent records, cursors, ownership  │  not a cache
   │                  lease, schema versioning, replay             │
   └──────────────────────────────────────────────────────────────┘
                                  │  HTTP POST /api/<method>  +  WS /api/events.{mux,host}
                                  ▼
                     DSH Host (official @deepseek-ai/dsh)
```

Dependency direction is one-way: `mcp face → domain → host client → durable state`. Contract
modules carry no Node-only APIs, so they can be unit-tested and reused without a process.

---

## 2. The three faces

### 2.1 MCP face

Responsibilities: MCP handshake, tool/resource schemas, strict input validation, mapping
domain outcomes to MCP results/errors, honouring client cancellation.

Hard rules:

- It never builds an HTTP request, never mints an `rpcId`, never touches a WebSocket.
- A capability the domain layer reports as unsupported becomes a **specific MCP error**, never
  a plausible-looking default and never a silent no-op.
- Because DSH's own MCP client spawns servers over stdio and namespaces tools as
  `mcp__<server>__<tool>`, tool names must be stable and short; renaming a tool is a breaking
  change and needs a note in the changelog.

### 2.2 Domain layer

The only owner of meaning. It is responsible for:

- **Intent records.** A mutating operation becomes a durable intent (id, kind, target,
  payload digest, `requestId`) *before* the carrier is allowed to send it.
- **Reconciliation.** After a crash or an unknown outcome, decide the true state from
  observed facts (history, queue snapshot, event stream, `session.list`) rather than by
  re-sending. Only `session.create` may be retried outright, because a preallocated
  `sessionId` + identical `cwd` is idempotent by contract; a different `cwd` must surface as
  `session-conflict`, not as a silent second session.
- **Capability negotiation.** A declared support map derived from the pinned contract and
  cross-checked against what the Host actually answers. Unknown ⇒ unsupported, visibly.
- **Cancellation scopes.** Turn cancellation (`session.cancel`) and queue removal
  (`session.updateQueue` + `remove`) are separate operations with separate reports.
- **Terminal reasons.** Every wait ends in a closed-set reason (completed / failed /
  cancelled / timeout / disconnected / uncertain / host-rejected). "Nothing happened" is not
  a result.

### 2.3 Host client face

Carrier only. Owns envelope construction, `rpcId` minting and **echo verification**, the two
WebSocket downlinks, `POST /api/respond` (including its receipt semantics), the optional
session-export path, and the trust-fence authority it is configured to talk to.

It does not decide business meaning and does not retry non-idempotent calls on its own
initiative. It surfaces the receipt verbatim: `{"accepted":false,"reason":"not-pending"}` is
evidence that an approval/question was already resolved or expired, **not** a delivered answer.

### 2.4 Durable state

Not a cache. It holds: the journal, intent records, per-session cursors, ownership lease,
capability snapshot, and schema version. It never holds credentials or secrets — provider
configuration is referenced by environment-variable name only.

---

## 3. Sequence: one mutating operation, honest failure paths

```
caller ──MCP──▶ domain: start operation (task, kind, payload)
domain  ──────▶ state:  append intent + requestId, fsync        ← must complete first
state   ──────▶ domain: intent durable (sequence, digest)
domain  ──────▶ host client: send(op)             ←─── may now be lost at any point
host    ──────▶ Host: POST /api/<method>
                          │
        ┌─────────────────┼───────────────────────────────────────────┐
        ▼                 ▼                                           ▼
   ok:true value     ok:false error(code,details)              transport dies / timeout
        │                 │                                           │
        ▼                 ▼                                           ▼
   journal           journal: refused with              journal: outcome OUTCOME_UNKNOWN
   succeeded         the mapped reason                  → state reported as `uncertain`
        │                 │                                           │
        └─────────┬───────┘                                           ▼
                  ▼                                    reconcile from observed facts
             reply to caller                           (history / queue snapshot / events)
                                                   resolved → succeeded | failed
                                                   unresolvable → stays `uncertain`
                                                   (never re-sent blindly)
```

The load-bearing detail: **`uncertain` is a first-class, externally visible state**, and the
journal entry that made it possible was written before the send. A bridge that only records
outcomes cannot survive a crash between send and response.

---

## 4. State machine (Phase 0 skeleton)

```
                       task.create
                            │
                            ▼
                        ATTACHED ──── owner lost (lease expired) ──▶ UNOWNED
                            │                                       │
              prompt/cancel │                                       │ atomic claim
                            ▼                                       │ + reconcile
                    DISPATCHING ◀───────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                       ▼
   CONFIRMED           REFUSED                  UNCERTAIN ── reconcile ──▶ CONFIRMED | REFUSED
   (ok:true)           (typed error)            (explicit, retained)      | stays UNCERTAIN
```

Operation states are per-operation; session/turn state is derived from observed events, and
connection state is tracked as an independent axis. **No transition into a "success" state is
reachable without either a host-confirmed value or a reconciliation that produced one.**

### 4.1 Ownership (the mechanism is open; the guarantees are not)

Requirements fix these, and any candidate mechanism must satisfy all of them — this is the
part where "check for a PID, then delete the lock" is explicitly disallowed:

1. at most one owner at any instant, enforced by an atomic primitive;
2. a refused claimant performs zero dispatches;
3. a dead owner's state is reclaimable **without a human deleting anything**;
4. a paused-but-alive owner eventually loses ownership, and when it resumes it must notice;
5. ownership changes are journaled with identity and reason;
6. the lease is a coordination device, **not** a security boundary — the design says so out
   loud rather than implying protection it cannot provide.

### 4.2 Waiting and connection

- A bounded wait returns a terminal reason; it never blocks forever and never returns nothing.
- Losing the carrier sets connection = down and leaves execution state **unknown**, not
  failed. Reconnect then resolves it (reopen the downlink, refetch history, dedupe).
- Pending approvals/questions replayed on reconnect (with the original `rpcId`) are
  recognized as the *same* interaction.

---

## 5. Deliberately open seams (design handoff decides these)

| Seam | What Phase 0 fixes | What stays open |
|---|---|---|
| Storage format | durability-before-acceptance, replay, schema versioning, corruption behaviour, bounded growth | file layout, single-file vs segment, on-disk encoding, compaction algorithm |
| Ownership mechanism | the six guarantees in §4.1 | the atomic primitive (file lock, directory rename, `flock`, lease file, …) |
| MCP tool surface | names/verbs invented by the bridge, stable, and never a fabricated capability; every tool maps to a requirement | exact tool list, resource vs tool split, pagination ergonomics |
| Transport(s) | stdio is required by the target deployment | whether streamable-HTTP is offered at all (needs an ADR if it is) |
| Event retention | gap detection + documented floor + typed outcome | window sizes, compaction policy, retention defaults |
| Wait/progress model | bounded, closed-set reasons, no busy loop | notification vs polling shape toward the MCP client |

Open **questions** (as opposed to decisions) are tracked in
[`host-compatibility.md`](host-compatibility.md) §7: mock-provider feasibility, zero-paid-call
isolated turns, and subprocess-stop evidence. Each blocks a specific test-matrix row and is
named there.

---

## 6. Durable-before-accepted — the spine rule

Restated because every other property leans on it:

1. persist the intent and flush;
2. only then allow the carrier to send;
3. record the outcome (or the *absence* of one) as evidence;
4. only then answer the caller.

An accepted call that cannot be replayed after a crash is a bug, not a performance tradeoff.
This ordering is what makes duplicate dispatch detectable and what makes `uncertain` honest.

---

## 7. Non-goals restated as prohibitions

- No security claims the project cannot support: no "sandbox", no "authenticated to the
  Host", no isolation story built on the trust fence (which is documented, upstream, as not an
  auth layer).
- No dependency on any pre-existing internal project at runtime or in tests.
- No writes outside the ignored `.local/` scratch area, task-created isolated temp dirs, and
  declared build output: never a user's real DSH home, never port 3080, never another
  repository.
- No claim that a skipped or blocked test is a pass, and no full-green statement from a run
  that skipped the live suite.
