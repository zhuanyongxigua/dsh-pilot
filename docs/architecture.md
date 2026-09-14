# Architecture — the delivered design

Status: **delivered**. This document describes the code that exists in `src/` today, by filename —
TypeScript sources that `tsc` compiles to `dist/`, which is what the suites and the shipped binaries
run — and the behaviour those files have been measured to have. It is not a plan: where a
mechanism was designed but not built, §11 says so with the reason, and nothing in §1–§10 is
described here that a reader cannot find in a named module.

Measured environment: macOS (`darwin/arm64`), Node `v24.15.0`, SQLite `3.51.3` through
`node:sqlite`, zero runtime dependencies (`package.json` `dependencies` is empty, and CI fails if
one appears). The test layers, their counts and the exact commands are in
[`test-matrix.md`](test-matrix.md).

Companion documents: [`requirements.md`](requirements.md) (what must be observable),
[`test-matrix.md`](test-matrix.md) (which test proves which requirement),
[`host-compatibility.md`](host-compatibility.md) (the measured Host surface),
[`adr/0001-language-runtime-and-dependency-posture.md`](adr/0001-language-runtime-and-dependency-posture.md)
and [`adr/0002-owner-exclusion-primitive.md`](adr/0002-owner-exclusion-primitive.md).

---

## 1. Shape

```
   MCP client (any harness; DSH's dsh-mcp-client in the target deployment)
        │  MCP over stdio (newline-delimited JSON-RPC 2.0)
        ▼
   src/bin/dsh-pilot-mcp.ts      thin gateway process, one per caller
        │  src/lib/gateway.ts    MCP face: initialize / tools/list / tools/call
        │  src/lib/mcp-tools.ts  tool schemas (strict)  ·  src/lib/mcp-protocol.ts  constants + error map
        ▼
   <stateDir>/daemon.sock       local IPC, newline-delimited JSON, mode 0600 (src/lib/ipc.ts)
        ▼
   src/bin/dsh-pilot-daemon.ts   THE single owner process
        │  src/lib/daemon.ts     domain: lifecycle, queue, cancellation, recovery, approvals
        │  src/lib/store.ts      durable state: SQLite, WAL, synchronous=FULL
        │  src/lib/owner-lock.ts kernel-enforced single-owner exclusion (owner.lock.sqlite)
        │  src/lib/adapter.ts    Host client: envelopes, rpcId echo, error mapping, capability probe
        │  src/lib/ws-client.ts   RFC 6455 client for the two event downlinks
        ▼
   DSH Host (official @deepseek-ai/dsh)
        POST /api/<method>   +   WS /api/events.mux   +   WS /api/events.host

   src/bin/dsh-pilot-ops.ts      operator CLI — the human authority channel (reads authority.token)
```

Every path in that diagram is a TypeScript source under `src/` (`src/lib/*.ts`, `src/bin/*.ts`).
`tsc` emits the runnable copy of each at the same relative path under `dist/`: `src/bin/dsh-pilot-mcp.ts`
becomes `dist/bin/dsh-pilot-mcp.js`, which is the path `package.json`'s `bin` map points at and the
path the suites spawn. `dist/` is gitignored, rebuilt, never committed and never edited.

N thin gateways, one owner. The gateway is disposable: an MCP client may spawn and kill it freely.
The daemon is not, and it is the only process that writes durable state or talks to the Host.

Dependency direction is one-way — `mcp face → domain → host client → durable state` — and §4
describes the build gate that enforces the Node-free part of it.

---

## 2. Module map

| File | Layer | Owns | Does not |
| --- | --- | --- | --- |
| `src/bin/dsh-pilot-mcp.ts` | entry point | argument parsing, and supplying `{input, output, pid, onSignal}` to the gateway; keeping stdout JSON-RPC-clean | speak to the Host |
| `src/lib/gateway.ts` | MCP face (stdio transport) | framing, `initialize`/`tools/list`/`tools/call`, `notifications/cancelled` bookkeeping, mapping a daemon refusal to a JSON-RPC error, `isError` on non-success | build HTTP requests, mint an `rpcId`, decide anything |
| `src/lib/mcp-tools.ts` | MCP face (contract) | the 11 tool schemas and the JSON-Schema-subset validator (`additionalProperties: false` everywhere) | import anything Node-only |
| `src/lib/mcp-protocol.ts` | MCP face (contract) | `MCP_PROTOCOL_VERSION`, `SERVER_INFO`, and the bridge-code → JSON-RPC-code mapping | import anything Node-only |
| `src/lib/ipc.ts` | transport | the local socket server/client, line framing, the shared reply bound, the authority-token file and the two rights that go with it | decide business meaning |
| `src/bin/dsh-pilot-daemon.ts` | entry point | starting the owner: scratch-root guard, `Daemon.start()`, `startEventIngest()`, ready file, signal shutdown | expose a network listener |
| `src/lib/daemon.ts` | domain | mutation scheduling (per-session FIFO, cross-session concurrent), the durable-intent protocol, event ingest and completeness, interaction authority, restart recovery, the IPC op surface | speak MCP, or read the Host's wire format itself |
| `src/lib/store.ts` | durable state | SQLite schema and every state transition, idempotency keys, the outbox, the event log and cursors, interactions, audit rows, integrity/version checks | wrap a network call in a transaction |
| `src/lib/owner-lock.ts` | durable state (coordination) | the exclusive lock on `owner.lock.sqlite`, `describe()`, `probeLocking()` | be a security boundary |
| `src/lib/adapter.ts` | host client | `/api` envelopes, `rpcId` minting and echo verification, the pinned method/error inventory, capability probing, `ok`/`refused`/`uncertain` classification, detail sanitisation | retry a non-idempotent call, decide meaning |
| `src/lib/ws-client.ts` | host client | the WebSocket handshake, frame parsing, bounded frame size, close/ping handling | interpret a frame |
| `src/lib/ids.ts` | shared | the eight id namespaces, their prefixes and validators, canonical payload digests | mint an id it cannot validate |
| `src/lib/config.ts` | shared | environment-first configuration (state dir, Host base/scope, limits) and the scratch-root guard | hold a credential or an endpoint literal |
| `src/lib/errors.ts` | shared | the closed error-code set, `BridgeError`, and the `ok`/`refused`/`uncertain` result constructors | carry policy, or depend on any layer — it is the shared vocabulary |
| `src/bin/dsh-pilot-ops.ts` | operator channel | `status`, `interactions`, `operations`, `events`, `decide` — the only path that may decide an approval | be reachable from an MCP tool |

---

## 3. The faces

### 3.1 MCP face — `src/lib/gateway.ts`, `src/lib/mcp-tools.ts`, `src/lib/mcp-protocol.ts`

`runMcpGateway({ socketPath, io })` runs the stdio loop. It receives every process facility it
needs as a value (`{input, output, pid, onSignal}`) rather than reading `process` itself; the real
entry point passes `process.stdin`/`process.stdout`/`process.pid`/`process.on`, and a test can pass
in-memory streams. That indirection is not tidiness — it is what lets the protocol surface stay
free of Node-only APIs (§4).

Eleven tools, each mapping onto exactly one daemon IPC op:

| Tool | Daemon op |
| --- | --- |
| `dsh_daemon_status` | `health` |
| `dsh_task_start` | `task.ensure` |
| `dsh_session_start` | `session.start` |
| `dsh_session_prompt` | `session.prompt` |
| `dsh_session_state` | `session.state` |
| `dsh_session_events` | `session.events` |
| `dsh_session_wait` | `session.wait` |
| `dsh_session_cancel` | `session.cancel` |
| `dsh_queue_clear` | `queue.clear` |
| `dsh_operation_get` | `ops.get` |
| `dsh_interaction_list` | `interaction.list` |

Hard rules the code holds to:

- A tool never builds an HTTP request, never mints an `rpcId` and never touches a WebSocket.
- Input is validated before any request leaves the process: an unknown property or a wrong type is
  `-32602`, and the Host sees nothing (`mcp-e2e/stdio::invalid arguments are a JSON-RPC invalid-params
  error, and nothing is sent upstream` asserts the fake Host's mutation counter is unchanged).
- **There is no approval tool**, and `interaction.decide` is not reachable from any tool. Approving
  is human authority reached through `src/bin/dsh-pilot-ops.ts` plus the authority token; a model — or
  text inside a document the model read — cannot authorize anything.
- An `uncertain` outcome is returned with `isError: true` so a caller cannot read "we do not know"
  as "it worked".
- Anything not understood on the wire is refused with a specific JSON-RPC code: `-32700` parse
  error, `-32600` invalid request, `-32601` unknown tool/method, `-32602` invalid params, `-32800`
  a request the client already cancelled.

### 3.2 Domain layer — `src/lib/daemon.ts`

The only owner of meaning. It is responsible for:

- **Mutation scheduling.** `#serialize(sessionId, …)` keeps one FIFO per session while different
  sessions run concurrently (`fake-host/contract::concurrent sessions: 8 sessions run 3 rounds each
  with per-session isolation`).
- **The durable-intent protocol.** Commit `dispatching` before the send, record the acknowledgement
  only after a valid response, and record `uncertain` whenever the outcome cannot be proven (§8).
- **Event ingest with an explicit completeness verdict.** A per-session bound-generation cursor
  tracks `high_water`, `completed_through`, the gap range and `complete|incomplete`; an
  unresolvable cursor is reported as such rather than assumed good.
- **Turn boundaries.** A turn is closed only by the authoritative `turn/end` for the open turn; a
  foreign or unnumbered terminal event is ignored (`fake-host/contract::a stale or foreign terminal
  event does not end the current turn`).
- **Interaction authority.** Listing is open to a gateway; deciding requires the operator token.
- **Restart recovery.** `recover()` sweeps interrupted dispatches to `uncertain` and the result is
  reported through `health.recovery`.

### 3.3 Host client face — `src/lib/adapter.ts`, `src/lib/ws-client.ts`

Carrier only, and deliberately explicit about the contract. `src/lib/adapter.ts` implements
`POST /api/<method>` with `{type:'client-request', rpcId, method, payload}`, verifies the `rpcId`
echo, and classifies `result.ok:false` against `PINNED_ERROR_CODES` — the 39 host error codes this
module carries. An unknown code is still a **definite refusal** (the operation is recorded
`refused`, carrying the Host's own code), but it is also counted as a protocol deviation
(`adapterStats.protocolErrors`) instead of being accepted silently, which is how contract drift
becomes visible rather than absorbed. `POST /api/respond`'s body is treated as a **carrier receipt**
rather than an outcome. Its outcome classification is the vocabulary the rest of the system depends
on:

| Classification | Meaning |
| --- | --- |
| `ok` | a valid response carrying `ok:true` |
| `refused` | a valid response carrying `ok:false` (a definite business refusal), or a deterministic client-side rejection before a byte was written |
| `uncertain` | the request may have been applied: timeout or transport failure **after** the bytes were handed to the socket. Never auto-retried |

`src/lib/ws-client.ts` is a real RFC 6455 client (handshake, frame parser, ping/pong/close, text frames
only) because the Host's event streams are WebSocket-only. Frames above `frameMaxBytes` are refused
as a typed oversize rather than buffered, which is why the real `426` behaviour and the oversize
path are both testable against the fixture.

Capability negotiation starts from the pinned inventory (`PINNED_METHODS`, 52 methods, and
`PINNED_ERROR_CODES`, 39 codes) and reports three lists: `declared`, `probed`, `unverified`.
Unknown stays unverified, visibly, and a method outside the set produces a specific error instead
of a plausible default. The inventory is what the bridge pins itself to; the compatibility report in
[`host-compatibility.md`](host-compatibility.md) describes the same surface, and the delivered code
is the authority for the counts.

### 3.4 Durable state — `src/lib/store.ts`

Not a cache. SQLite with WAL, `synchronous=FULL`, foreign keys and uniqueness, holding: `tasks`,
`sessions`, `turns`, `operations`, the `outbox`, `events`, per-session cursors, `interactions`,
`audit`, and `meta` (including the schema version). Invariants the schema and the transition
methods enforce:

- one row per `(task, idempotencyKey)`; the same key with a different payload digest is a
  **conflict**, never a silent second operation;
- a transaction never spans a network call — commit, then send;
- operation transitions are checked: acknowledging a `pending` operation, or resolving a
  non-`uncertain` one, is refused rather than coerced;
- one native `(task, session, seq)` becomes exactly one event row, and the writer returns whether
  it inserted;
- an unknown **future** schema version is refused (`STATE_VERSION_UNSUPPORTED`), and corruption is
  reported with the database and WAL left in place;
- a state file from an **older** bridge is migrated at open time rather than misread. `create table if
  not exists` does nothing to a table that already exists, so a column added to the schema is absent
  from every database already in use, and the code reading it would fail in the middle of an operation
  on exactly the machines that have been running the bridge. `applyMigrations` checks for the column,
  adds it, and updates the recorded version to the shape now on disk. The task table's `display_label`
  is the first column to arrive this way: it holds the label `dsh_task_ensure` advertises, kept in its
  own column because `label` is the idempotency key derived from the client key — storing the caller's
  label there would have made the second `task.ensure` create a second task instead of finding the
  first.

It never holds credentials or secrets.

### 3.5 Event ingest, cursors and bounds

Two downlinks are consumed (`/api/events.mux`, `/api/events.host`). Dedupe is by native sequence and
gap detection is **ours**, because the upstream contract has no resume point (`since` is documented
unimplemented and ignored if passed) and the bridge may not assume it saw every frame. Reconnect
means **reopen the stream and refetch history**, then converge. Completeness is a first-class field
on the cursor and on every page: a page with a hole says `completeness: 'incomplete'` and carries
the gap range.

Bounds are configured, not hoped for, and each bound is enforced on a path that runs — a limit that
is only declared is a claim, not a bound. `src/lib/config.ts` reads these from the environment:
`eventPageMax` 200, `eventPageMaxBytes` 256 KiB, `eventMessageMaxBytes` 4 MiB,
`eventBufferMaxBytes` 32 MiB, `frameMaxBytes` 1 MiB, `waitDefaultMs` 30 s, `waitMaxMs` 120 s,
`compactResultBytes` 64 KiB. `DEFAULT_LIMITS` in `src/lib/daemon.ts` carries the same defaults plus
`logMaxBytes` 100 MiB, and `src/lib/ipc.ts` fixes `MAX_IPC_LINE_BYTES` 4 MiB and
`MAX_IPC_CONNECTIONS` 32. `maxResponseBytes` (8 MiB, `DSH_PILOT_HOST_RESPONSE_MAX_BYTES`) caps a Host
response body on BOTH unary paths, counted in **received bytes** while the body streams, and
`ipcReplyMaxBytes` (16 MiB, `DSH_PILOT_IPC_REPLY_MAX_BYTES`) caps one IPC reply frame on both ends of
the socket — see C-8 in [`conflicts.md`](conflicts.md) for why one end cannot own that number.

One more bound is deliberately NOT here: the daemon-local queue scope has no limit because it holds
nothing. `queue.local` is always empty — a prompt goes to the Host, whose inbox is the only queue with
work in it — and the reply's note says so, because an unexplained empty array reads as "nothing queued
right now" (C-7).

**Framing is a streaming decode on both ends, and the daemon will not write a frame its own gateway
would refuse.** A chunk boundary is not a character boundary: decoding each chunk on its own turns a
UTF-8 sequence split across two chunks into a replacement character that no later concatenation
repairs, so a reply containing multi-byte text was corrupted in proportion to how the kernel happened to
split it, and a request containing multi-byte text could be stored corrupted. Both ends now hold a
streaming decoder, and both measure their budgets in the bytes that actually arrive or are about to be
written. The reply bound is the same number on both ends: the client refuses to buffer more, and the
daemon refuses to emit a reply above it, answering with a typed `RESULT_TOO_LARGE` instead — because a
client limit below the daemon's legitimate maximum would surface as a dropped connection on a call that
should have worked.

The four event bounds are distinct quantities, and the reason they are not one number is that each
answers a different question. A page is capped by **count** (`eventPageMax`) and by **serialised
UTF-8 bytes** (`eventPageMaxBytes`): the byte cap is applied walking the window newest-first, so the
returned page stays a contiguous run and a paging loop sees every event exactly once. A single event
larger than the whole page budget is delivered anyway and named in the page's `oversize` list —
skipping it would lose an event silently, and returning an empty page would make the caller loop on
the same cursor forever. `hasMore` is answered by the database ("is there an event older than the
oldest one returned"), not inferred from the page length, because a byte-limited page is short while
older events remain and a full page may be the entire history.

A single downlink **message** is capped by `eventMessageMaxBytes` and the parsed-but-unconsumed
**queue** by `eventBufferMaxBytes`, both enforced by the WebSocket connection itself
(`src/lib/ws-client.ts`) and both passed in from this configuration rather than duplicated as
constants there. `frameMaxBytes` alone is not enough for either: a fragmented message is assembled
from frames that are each individually legal, so a per-frame cap cannot bound the assembled total;
and a fast peer with a slow reader grows the queue without any frame being large. A frame that is
illegal rather than large — a continuation that starts no message, a data frame inside an open
fragmented message, a reserved opcode, a binary frame on a text-only downlink — is a typed protocol
error and ends the connection rather than being skipped, because skipping it would drop data while
the stream still reported itself complete.

### 3.5a `/api/respond`, and why it has a deadline of its own

Answering an approval is the one path where this bridge asks a Host to do something consequential, and
it is bounded the same way the unary method calls are: the adapter's deadline (`hostTimeoutMs`,
configured) aborts the request, and `MAX_RESPONSE_BYTES` refuses the receipt while it is still being
read. Both existed on `call()` and neither existed here, so a Host that accepted the answer and then
answered slowly, endlessly, or never could hold the call and the memory of its body indefinitely.

The classification after a failure is the part that matters. Once bytes have been written the answer may
have been applied, so a timeout, a dropped connection, an oversized receipt and an unparseable receipt
are all `uncertain` — never "not reached", which is what a caller would act on by delivering the answer
again. Only a failure BEFORE any byte is written is a `refused`. Nothing on this path retries by itself
and nothing approves by itself; both are the caller's explicit decision.

### 3.6 Operator channel — `src/bin/dsh-pilot-ops.ts`

The human authority path: `status`, `interactions`, `operations`, `events`, and `decide`. It reads
the authority token from the daemon's private state directory (mode `0600`) and presents it over
IPC. Running it is an explicit human act, which is exactly what an approval is. The token is never
returned by any IPC op, so it cannot reach a model through a tool result.

The token path is handled without following symbolic links, and a path that is not a regular file is
refused with `UNSAFE_STATE_PATH` rather than resolved. The protection this file depends on is that it
lives inside a 0700 directory, so a link planted at its path would move the authority elsewhere: the
pre-fix code `chmod`ed the link's target, created the token AT the target of a dangling link, and read
through on comparison. Creation uses `O_CREAT|O_EXCL|O_NOFOLLOW`, the mode is set with `fchmod` on a
descriptor opened with `O_NOFOLLOW`, and `fstat` on that descriptor confirms a regular file — checks
that no later rename can redirect, which a path-based check cannot promise. See C-6 in
[`conflicts.md`](conflicts.md) for the measured pre-fix behaviour and for what remains unimplemented.

---

## 4. Type checking is the layering gate

The implementation is **TypeScript source** under `src/` — `src/lib/*.ts` and `src/bin/*.ts` —
compiled by `tsc` to `dist/`, and it is the compiled output that the suites and the shipped binaries
run. The code the checker reads and the code the runtime executes therefore cannot drift apart: the
types are emitted declarations (`declaration: true`) that a consumer is checked against, rather than
a comment inside the file under test. Three gates, all runnable by hand:

| Command | Config | Scope | Result on this machine |
| --- | --- | --- | --- |
| `npm run build` | `tsconfig.json` | `src/**/*.ts` → `dist/`, `strict: true` **and** `noImplicitAny: true`, `declaration`, `sourceMap`, `rootDir: src` → `outDir: dist` | 0 errors |
| `npm run typecheck:contract` | `tsconfig.contract.json` | **only** `src/lib/errors.ts`, `src/lib/mcp-tools.ts`, `src/lib/mcp-protocol.ts`, with `"types": []` and `lib: ["ES2023"]` | 0 errors |
| `npm run typecheck:tests` | `tsconfig.test.json` | `test/**/*.mjs` checked against the emitted declarations in `dist/`: `allowJs` + `checkJs`, `noEmit`, `strict: true`, `noImplicitAny: false` | 0 errors |

The build and test-layer results are the migration's own measurements, recorded in
[`adr/0001-language-runtime-and-dependency-posture.md`](adr/0001-language-runtime-and-dependency-posture.md) §2;
the contract gate was re-run while this documentation pass was made.

The contract config is the enforcement mechanism for AGENTS.md section 4 ("contract and protocol code
stays free of Node-only APIs"). With the Node type surface removed, a `node:*` import, a `Buffer`
or a `process` reference in any of those three files is a **build failure**, not a review comment.
That gate has a history worth stating rather than smoothing over: under the superseded JSDoc
configuration it had never once succeeded — it was pointed at the JavaScript sources while `allowJs`
was off and failed with `TS18003: No inputs were found`, so it enforced nothing — and it was only
verified with teeth after the migration, by injecting a `process.pid` reference into
`src/lib/mcp-protocol.ts` and watching it fail with `TS2591` (ADR 0001 §1).

Why those three files and no more, and why `src/lib/mcp-protocol.ts` exists at all:

- `src/lib/errors.ts` and `src/lib/mcp-tools.ts` are pure protocol — error codes and shapes, and the tool
  schemas. They must never need a process, a socket or a buffer.
- `src/lib/mcp-protocol.ts` was **extracted from `src/lib/gateway.ts`** precisely so that the protocol
  constants (`MCP_PROTOCOL_VERSION`, `SERVER_INFO`) and the JSON-RPC error mapping could be gated.
  `src/lib/gateway.ts` is the stdio **transport** and legitimately needs streams, a pid and signal
  wiring, so nothing defined inside it could ever be checked by this config. Leaving the constants
  and the mapping there would have made the gate either vacuous or a lie.
- `src/lib/gateway.ts` declares the process facilities it needs as **values**
  (`{input, output, pid, onSignal}` — the `GatewayIo` interface) instead of reading the Node
  global object; `src/bin/dsh-pilot-mcp.ts` supplies `process.stdin`, `process.stdout`, `process.pid`
  and `process.on`. `src/lib/ipc.ts` is excluded from the contract config for the same reason as the
  gateway: it is a socket transport, and it is covered by the build config.

A practical consequence worth stating: the check is about **what a module may depend on**, not
about node-ness being bad. Transports are allowed to need a runtime; wire shapes, schemas and
capability tables are not.

One named limit, so the gate is not oversold: `noImplicitAny` is `false` in the **test** config only.
In `src/` it is `true`, so an absent annotation in the implementation is an error rather than a silent
`any`; in the test layer an unannotated local or `catch (error)` is ordinary JavaScript, and that
config admits it deliberately. Nullability and `unknown` narrowing are still enforced over the tests,
which is what caught 37 real errors there when the layer was first checked against the emitted
declarations. `noEmit` there means the checker consumes `dist/**/*.d.ts` rather than producing a
mirror that could drift. See
[`adr/0001-language-runtime-and-dependency-posture.md`](adr/0001-language-runtime-and-dependency-posture.md) §2.

---

## 5. Sequence: one mutating operation, honest failure paths

```
caller ──MCP──▶ domain: tools/call (task, session, clientKey, payload)
domain  ──────▶ store:  reserve operation + outbox row, commit          ← durable
store   ──────▶ domain: operation row (operationId, digest, state=pending)
domain  ──────▶ store:  mark dispatching, commit                        ← must complete first
domain  ──────▶ adapter: send(op)                    ←── may now be lost at any point
adapter ──────▶ Host: POST /api/<method>
                          │
        ┌─────────────────┼───────────────────────────────────────────┐
        ▼                 ▼                                           ▼
   ok:true value     ok:false error(code,details)              transport dies / timeout
        │                 │                                           │
        ▼                 ▼                                           ▼
   store: succeeded  store: refused                  store: uncertain (reason preserved)
   (ack after the    (host code kept verbatim)        → reported to the caller as uncertain
    valid response)                                        │
        │                                                  ▼
        └──────────────┬────────────────────────── reconcile from observed facts
                       ▼                          (history / queue snapshot / events)
                  reply to the caller             resolved → succeeded | failed
                                                  unresolvable → stays uncertain
                                                  (never re-sent blindly)
```

The load-bearing detail: the `dispatching` row is committed **before** the bytes are handed to the
socket, so a crash between send and response is a fact in the database rather than a guess. That is
what makes `uncertain` honest, and it is asserted from a separate SQLite connection in
`unit/core::durable-before-send: the dispatching row is committed before any network write`.

`rpcId` is **correlation only**. It is echoed by the Host, verified on receipt, and used to tie a
response — and a replayed approval frame — to the call that caused it. It is not an idempotency key,
and no code path treats it as one.

---

## 6. State machines

### 6.1 Operation — `OP_STATES` in `src/lib/store.ts`

```
        reserve                markDispatching              markAcknowledged
 pending ────────▶ dispatching ─────────────▶ ────────────────────────▶ succeeded  (ok:true)
    │                   │                                                └▶ refused    (ok:false)
    │                   │  lost ack / timeout / crash
    │                   └──────────▶ uncertain ◀── sweepInterruptedDispatches (on boot)
    │                                   │
    │                       resolveUncertain, which requires the state to be uncertain
    │                                   ▼
    │                        succeeded | failed | refused
    └─ illegal transitions are refused, not coerced
```

`sent` is declared in `OP_STATES` and `markAcknowledged` accepts it as a source state, but the
delivered code commits the acknowledgement directly from `dispatching`; `sent` is therefore
currently unreachable. It is recorded here rather than quietly dropped from the state set.

`uncertain` is terminal-but-unresolved: it is retained with the reason that produced it
(`after-send`, `timeout`, `crash-during-dispatch`, …), it is never auto-retried, and it can only
leave that state through an explicit `resolveUncertain` carrying evidence.

### 6.2 Connection — `CONNECTION_STATES` in `src/lib/daemon.ts`

`disconnected → connecting → reconciling → ready`, tracked as an axis of its own. Losing the
downlink says nothing about whether work is running.

### 6.3 Interaction — `INTERACTION_STATES` in `src/lib/store.ts`

`pending → answered | rejected | expired | revoked | superseded | uncertain`. The Host's receipt
(`not-pending`) marks an interaction as resolved-or-expired by the Host; it never counts as
"answered by us".

Execution state is derived from observed events per session — `running` only while an
authoritative `turn/start` is open, and closed only by the matching `turn/end`. Connection state
and execution state are separate facts, and a test asserts that killing the carrier while a turn is
open leaves execution `running`
(`fake-host/contract::execution state is not derived from connection state`).

---

## 7. Ownership — `src/lib/owner-lock.ts`

Exactly one process owns a state directory, and the mechanism is kernel-enforced.

- The lock is a dedicated database file, `<stateDir>/owner.lock.sqlite`, opened with SQLite
  `locking_mode=EXCLUSIVE` plus **one committed write**, and the connection is held for the whole
  process lifetime. The OS releases it when the process dies, for any reason.
- The file is never unlinked, so its inode is stable and a third party cannot lock a "newer" file.
  `owner.lock.sqlite.held` is a zero-byte **informational** marker: deleting it releases nothing.
- `process.binding('fs').flock` is `undefined` on Node 24.15.0 (verified on this machine), and
  `node:fs` exposes no `flock`, so flock was not reachable from the chosen runtime — this is why the
  SQLite exclusive-lock primitive was used instead. See
  [`adr/0002-owner-exclusion-primitive.md`](adr/0002-owner-exclusion-primitive.md).
- A refused claimant exits **before** it can dispatch: `Daemon.start()` takes the lock first, then
  opens the store, then reclaims any orphan socket, then binds IPC — and the daemon process exits
  `4` with `OWNER_HELD` when the lock is held.
- There is no timeout lease, deliberately. A lease would hand the directory to a second process
  while the first is still alive (paused, suspended, slow), and two writers are worse than a
  blocked one.

### 7.1 A measured detail that changes how this can be tested

`locking_mode` is **per-connection** state. A fresh connection to the same file reports `normal`
however the holder opened it, so "is exclusion actually configured?" is **not** observable from
outside the holder. Two consequences the code and the tests both encode:

- `OwnerLock.describe()` reads `locking_mode` and `journal_mode` back from the holder's **own**
  handle, which is the only place the truth exists;
- a test that probed a fresh connection measured nothing. `test/unit/owner-lock.test.mjs` says so
  in place, because that is how the per-connection nature was discovered.

Measured on this machine (macOS, Node 24.15.0, SQLite 3.51.3):

| Situation | Observed |
| --- | --- |
| holder alive, second `OwnerLock` attempts `tryAcquire()` | refused, reason `busy` — 20 consecutive attempts, 20 refusals |
| second daemon process against a held state directory | exits non-zero with `OWNER_HELD`, never serves |
| holder `SIGSTOP`ped | ownership retained; a contender is still refused |
| holder `SIGCONT`ed | unchanged — the resumed process is still the owner and its state is intact |
| holder `SIGKILL`ed | released by the kernel; the next process acquires with no manual cleanup |
| lock file across release/re-acquire | same inode; nothing unlinks it |
| uncooperative second writer (plain `DatabaseSync`, no marker, no cooperation) | refused by the kernel |

The 20-of-20 refusal figure is a **direct probe**, not a suite case: it is recorded here as a
measurement, while the suite asserts refusal, process-level exit, inode stability and the
`SIGSTOP`/`SIGKILL` behaviour by name in `test/unit/owner-lock.test.mjs` and
`test/persistence/crash.test.mjs`.

The lock is a **coordination device, not a security boundary**. A hostile process can ignore the
protocol entirely; the design says that out loud rather than implying protection it cannot provide.

---

## 8. Durability model — the spine rule

Restated because every other property leans on it:

1. persist the intent **and** its outbox row, and commit;
2. mark `dispatching`, and commit — this is the step that makes an in-flight call visible from
   outside the process;
3. only then hand the bytes to the socket;
4. record the acknowledgement **only** after a valid response;
5. only then answer the caller.

Consequences, each of which is a rule and not a preference:

- **A crash out of `dispatching` becomes `uncertain` on the next boot.** `Daemon.start()` runs the
  sweep before it binds IPC, and publishes what it found:
  `health.recovery` = `{sweptOperations, uncertainOperationIds, at}`.
- **No non-idempotent mutation is auto-retried.** The only upstream idempotency affordance measured
  is `session.create` with a caller-preallocated `sessionId`: the same id with the same `cwd`
  returns the same session, and a different `cwd` fails `session-conflict`. A stored retry reuses
  the stored id rather than minting a new one. Everything else — `session.prompt`,
  `session.cancel`, `respond` — has no host-side key beyond `rpcId`, so it is recorded and
  reconciled, never re-sent.
- **Missing history is not proof of non-execution.** Absence of evidence in the Host's log is
  reported as such; it is never converted into "it did not happen", and never into "it happened".
- **An operation is inspectable from outside.** `ops.get` exposes one operation, including an
  in-flight one — which is what lets a test know a request is genuinely on the wire before it kills
  the process (`live/live::a SIGKILL during a live turn leaves durable history and an honest,
  unresolved outcome`).
- **Recovery never invents an outcome.** A swept operation stays `uncertain` with its reason until
  evidence resolves it.

The state directory layout (§10) is part of this contract: an operator can answer "what happened"
with the database, the marker and the audit rows alone, without asking the bridge.

---

## 9. Waiting, disconnection and cancellation

- A bounded wait returns a closed-set reason — `turn-ended`, `timeout`, `no-turn-observed`,
  `disconnected` — and a deadline is reported as a timeout, not as a hang.
- Losing the carrier sets connection to down and leaves execution state as the last observed fact.
  Reconnect reopens the downlinks and refetches history, then dedupes; the fake-Host layer asserts
  convergence to the no-disconnect control state.
- **Two cancellation scopes, and both reach the Host.** `session.cancel` stops the turn
  (`target.scope` = `local-open-turn`) and freezes the next local dispatch while it checks.
  `queue.clear` clears the daemon's own pending queue *and* removes the named item from the Host's
  with `session.updateQueue` (`action: {kind: 'remove'}`), addressed to the Host session and to an
  item id read from the last observed `session/queue` snapshot; `remoteScope.cleared` is therefore
  a real result rather than a constant, and items the daemon has never observed are refused locally
  without a request.
  The removal is deliberately hard to do twice. The snapshot read, the session/item binding and the
  durable `queue_removals` ledger are all read **inside** the per-session serialization boundary,
  because a snapshot taken outside it lets two concurrent clears of one item both decide they may
  send — the boundary only serializes the sends, it cannot un-decide them. The ledger, not the
  snapshot, is the defence: `removed` on a confirmed removal, `uncertain` when the Host's answer did
  not confirm (which blocks a blind re-send until the item's absence is seen in a fresh snapshot),
  `not-pending` when the Host itself says it holds no such item, and *nothing at all* when the
  refusal happened before anything was sent — so a legitimate retry stays possible. §11 lists what
  remains open.
- **A cancel acknowledgement is not process evidence.** The cancel result carries
  `processEvidence: {observed: false, reason: 'the Host exposes no receipt for tool subprocess
  termination; only a turn-level ack is available'}`, and the note scopes the acknowledgement to the
  turn. "We sent a cancel" is reported as exactly that.

---

## 10. State directory layout

Everything the bridge writes lives under one state directory (`DSH_PILOT_STATE_DIR`, default
`$XDG_STATE_HOME/dsh-pilot`). `assertScratchStateDir` in `src/lib/config.ts` refuses a state directory
at or under `~/.dsh` or `~/.local/state` — the two places a real DSH installation lives — unless the
operator sets `DSH_PILOT_ALLOW_REAL_STATE=1`; the daemon exits `3` with the reason before it takes
ownership. A refused claimant exits `4` (`OWNER_HELD`) and storage failures exit `5`.

| Path | What it is |
| --- | --- |
| `state.sqlite` (+ `-wal`, `-shm`) | the durable state: tasks, sessions, turns, operations, outbox, events, cursors, interactions, audit, schema version |
| `owner.lock.sqlite` (+ `.held`) | the exclusive owner lock, and its zero-byte informational marker |
| `authority.token` | mode `0600`, random, read only by the operator CLI; required to decide an interaction |
| `daemon.sock` | the local IPC endpoint, mode `0600`. When the path would exceed 100 bytes it is replaced by `/tmp/dshpilot-<sha256 prefix>.sock` — the socket-path limit, not a preference |
| `daemon.ready.json` | written only when `--ready-file` is passed: pid, socket path, store generation, recovery result, token path |

Nothing else is written outside the state directory, task-created temp directories under the OS
temp root, and declared build output.

One interaction is worth stating plainly, because it surprises an operator: the guard forbids
`~/.local/state`, and the **default** state directory is `<XDG_STATE_HOME or
~/.local/state>/dsh-pilot`. A daemon started with no configuration at all therefore exits `3` and
prints `refusing to use .../dsh-pilot without DSH_PILOT_ALLOW_REAL_STATE=1` (verified on this
machine). Starting it deliberately requires `DSH_PILOT_ALLOW_REAL_STATE=1`, or pointing
`DSH_PILOT_STATE_DIR` / `XDG_STATE_HOME` somewhere else. Whether the guard and the default should be
reconciled is an open question, recorded here rather than smoothed over.

---

## 11. Deliberately not built

Named here so no reader infers them from the layer names.

| Not built | Why, and what is reported instead |
| --- | --- |
| Host-side queue removal (`session.updateQueue` with `action.kind: "remove"`) | **Implemented.** `queue.clear` accepts explicit `itemIds` (MCP tool `dsh_queue_clear`) and removes them from the Host, reporting `remoteScope` with the per-item outcome; an item the daemon has never observed is refused locally with `queue-item-not-observed` instead of being guessed at. The once-only guarantee is the durable ledger described in §9, measured in `fake-host/queue-removal-once::two concurrent callers naming one item produce at most one removal request on the wire` and its three siblings. |
| Positive process-level evidence for a subprocess stop | the Host contract has no receipt for child-process termination; the bridge reports `observed: false` rather than implying one |
| A timeout lease for ownership | rejected in ADR 0002: a paused owner must keep ownership, so a hung owner holds it until it is killed |
| `session.export` | the Host route exists (`GET`/`HEAD /api/session.export`) and the bridge does not call it; a session-log ZIP is sensitive by definition and is never produced, committed or published |
| MCP resources | the face exposes tools only. `initialize` advertises `capabilities: {tools: {listChanged: false}}` and `tools/list` returns the 11 tools |
| A `streamable-http` MCP transport | only stdio is implemented. Adding it would need its own ADR (and it is a different trust story, since it would expose a listener) |
| Cursor retention floor with a typed "cursor expired" | `CURSOR_EXPIRED` currently means one thing only: a cursor bound to a different store generation. There is no retention window and no expiry by age |
| Journal rotation/compaction | there is no rotation. A size cap is configured (`logMaxBytes`) and the WAL is checkpointed on clean shutdown, but growth is not yet bounded by a tested mechanism |
| A 48-hour soak | `test/soak/run.mjs` is a resumable runner that records wall clock, monotonic segments, gaps and checkpoints, and refuses to run without a bound; it has only been exercised as a bounded smoke run. The multi-day figure is a later milestone and is not claimed |
| Live-provider coverage of every layer | the live layer is opt-in (`--live`), reads the operator's own route, and is excluded from the default run and from CI |

---

## 12. Non-goals restated as prohibitions

- No security claims the project cannot support: no "sandbox", no "authenticated to the Host", no
  isolation story built on the Host's browser-trust fence — documented upstream as *not* an auth
  layer.
- No dependency on any pre-existing internal project, at runtime or in tests. Zero runtime
  dependencies, enforced in CI.
- No writes outside the ignored `.local/` scratch area, task-created isolated temp dirs, and
  declared build output: never a user's real DSH home, never port 3080, never another repository.
- No credential value is read, printed, stored or committed. A provider route is referenced by
  environment-variable **name** only.
- No claim that a skipped, blocked or unrun test is a pass, and no full-green statement from a run
  that skipped the live suite.
