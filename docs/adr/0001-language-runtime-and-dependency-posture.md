# ADR 0001: Language, runtime, and dependency posture

- Status: **Accepted, revised** — the original language/dependency decision was superseded by what
  was actually built. The earlier decision is preserved, not deleted: see [Revision history](#revision-history).
- Date: 2026-09-12 (original decision); revised 2026-09-12 (revision 2), 2026-09-12 (revision 3)
- Scope: dsh-pilot (the MCP-to-DSH bridge), all packages in this repository
- Related: `AGENTS.md` sections 4 and 5; [`docs/host-compatibility.md`](../host-compatibility.md); ADR 0002

## Context

dsh-pilot is an independently implemented MCP server/bridge that exposes durable sessions on a
DSH Host ("DeepSeek Harness", npm package `@deepseek-ai/dsh`, MIT) to any MCP client. Its
downstream consumer is DSH's own MCP client plugin, `@deepseek-ai/dsh-mcp-client`, which spawns
MCP servers over `stdio` or `streamable-http` and surfaces their tools to a model under
`mcp__<serverName>__<toolName>`.

The bridge sits between two contracts it does not own:

1. **The MCP contract**, client-facing, defined by the Model Context Protocol.
2. **The DSH `/api` contract**, host-facing, distributed as TypeScript declaration files plus zod
   schemas. Upstream describes this layer as "the authoritative contract", with HTTP, WebSocket,
   and in-process SSE as "merely physical channels". That contract layer documents itself as having
   "zero Node dependencies, importable from the browser".

Three observations from the resolved dependency trees forced this decision to be written down
rather than assumed:

- The `/api` method surface is not stable across published versions. Comparing the `0.0.1-rc.1`
  and `0.1.1-rc.2` resolved trees: `command.execute` and `command.list` are present in the former
  and absent from the latter's method map, while `workspace.insertBefore` is absent from the
  former's method map and present in the latter. Measured on a real Host afterwards:
  `command.execute` is answered `HTTP 404 not found` and is not reported as `ok:true`.
- The host exposes no protocol-version negotiation field for this purpose. The host domain
  contract states that it carries "no protocol version: client and host ship together"; a
  protocol version is deferred upstream until an independently released client appears. This
  bridge is exactly such an independent client, but the field it would need does not exist yet.
- The version string that does exist is unusable as a pin. On the live host, and on a freshly booted
  isolated Host, `host.describe.version` reported `0.0.1` while the installed `@deepseek-ai/dsh`
  package was `0.1.1-rc.2`. The field is documented as the host app's own package version, and the
  cause of the observed discrepancy has not been established; whatever the cause, the field
  demonstrably cannot be used to decide whether a given method exists.

A control bridge is a low-throughput, high-consequence component: it sends few requests, and each
request can mutate durable session state. Correctness, debuggability, and compile-time contract
checking matter far more here than throughput or memory footprint. It is also a component that a
stranger's agent harness spawns into its own process tree, which is where the dependency posture
below comes from.

## What was actually built

The decision must be read against the built artifact, not against a plan. Measured on this machine:

| Fact | Value | How it is checked |
|---|---|---|
| Language | **TypeScript** (`.ts`), `"type": "module"`, compiled to `dist/` | `src/lib/*.ts`, `src/bin/*.ts` — 15 files, 5824 lines; `npm run build` |
| Types | real annotations, `strict: true` **and `noImplicitAny: true`** | `npm run typecheck` (3 configs) — 0 errors |
| Runtime dependencies | **none** (`"dependencies": {}`) | `package.json`, plus a CI step that fails if the object is non-empty |
| Dev dependencies | `typescript` (resolved 5.9.3), `@types/node` (resolved 24.13.4) | committed `package-lock.json` |
| Node floor | `engines.node >= 24.0.0` | `package.json`; the storage engine is `node:sqlite`, which is why the floor is this high |
| `@deepseek-ai/dsh-host-apiproxy` | **not a dependency, in any form** | `package.json`, `package-lock.json`, no reference in `src/` or `test/` |
| `@modelcontextprotocol/sdk` | **not a dependency** | same |
| The DSH package itself | not installed by this project; an installed Host is resolved at runtime (`node_modules`, then `npm root -g`, override `DSH_PILOT_DSH_BIN`) | `test/isolated-host/rig.mjs` |

The language row is a **revision**, and it was forced by review rather than chosen freely. The first
delivered revision of this project was plain ESM JavaScript with JSDoc types checked by `tsc`
(`allowJs` + `checkJs`, `noImplicitAny: false`). A reviewer rejected that as *not* the posture the
design hand-off adopted — "adopt Pro's TypeScript / Node 24" — and specifically rejected the
suggestion that the ADR could be edited to ratify the JavaScript implementation instead. The
revision below records the adopted posture and the migration that produced it. See
[Revision history](#revision-history) for what the superseded text said.

## Decision

### 1. TypeScript sources compiled to `dist/`, on Node 24

Implement the bridge in TypeScript under `src/`, compile it with `tsc` to `dist/`, and run and test
the compiled output. Node 24 is the floor.

This reverses the original decision, so the justification has to be about what the build step buys
here rather than about taste:

- **The type surface is an artifact other code is checked against, not a comment.** With
  `checkJs`+JSDoc the compiler checks annotations *inside* the same file the runtime executes; the
  annotations are invisible to importers, so a consumer (including this project's own test layer)
  inherits nothing and must re-state shapes by hand. Emitting `.d.ts` files makes the types a real
  interface: `test/**/*.mjs` is now checked **against the emitted declarations**, which is how the
  migration immediately surfaced 37 real type errors in the test layer — the class of defect the
  JSDoc posture structurally could not find.
- **`noImplicitAny` can be `true`, which is the whole difference between "typed" and "typed where
  someone remembered".** The superseded config had `noImplicitAny: false`, so an unannotated
  parameter was silently `any`; the gate caught *wrong* types but never *absent* ones. TypeScript
  source makes absent types an error, and the source now compiles under `strict` **with**
  `noImplicitAny` on, with zero `any`, zero `as` casts and zero suppressions outside one documented
  test-boundary cast.
- **The contract gate got teeth it did not have before.** `tsconfig.contract.json` compiles the
  protocol modules with the Node type surface removed (`types: []`). Under the old config that gate
  had never once succeeded — it was misconfigured to include `lib/*.js` while `allowJs` was off, so
  it failed with `TS18003: No inputs were found` and enforced nothing. It now compiles
  `src/lib/{errors,mcp-tools,mcp-protocol}.ts` and was verified by injecting a `process.pid`
  reference into `src/lib/mcp-protocol.ts` and watching it fail with `TS2591`.
- **The cost the original decision named is real and is paid down, not argued away.** A build step
  does put generated bytes between review and runtime, and a test path *can* silently run stale
  output. That is mitigated structurally rather than by discipline: every suite runs the compiled
  entry points (`dist/bin/dsh-pilot-*.js`, `dist/lib/*.js`) so there is no second implementation to
  drift; `test/run.mjs` refuses to start without `dist/lib/ids.js` and prints the build hint; the
  mutation runner **deletes and rebuilds `dist/` inside each sandbox from the mutated sources**, so a
  surviving control cannot be an artifact of stale output; and CI runs `npm run build` before both
  the typechecks and the suites.
- **What was given up:** the file under test is no longer byte-identical to the file a reviewer
  reads. It is byte-identical to the file the compiler produced from it, which is why `dist/` is
  gitignored and rebuilt everywhere rather than committed — a committed build output is the stale
  artifact this concern is actually about.
- **Node 24 is not arbitrary.** The storage engine and the owner-exclusion primitive both come from
  `node:sqlite`, which is why the runtime can have zero dependencies at all (ADR 0002).

The entry points stay compatible with the original interface: `dist/bin/dsh-pilot-daemon.js`,
`dist/bin/dsh-pilot-mcp.js` and `dist/bin/dsh-pilot-ops.js` are the `bin` targets, so an MCP client
still spawns a plain Node script over stdio. `node dist/bin/dsh-pilot-mcp.js` is the whole
deployment story — plus `npm run build` once, which `npm pack` users get from the published `dist/`.

### 2. Real typechecking is part of the design, and all three gates are CI steps

Three configs, three gates, runnable by hand and run in CI:

| Gate | Command | Configuration | Measured |
|---|---|---|---|
| Build | `npm run build` | `tsconfig.json`: `strict`, `noImplicitAny`, `target ES2023`, `module`/`moduleResolution NodeNext`, `rootDir src`, `outDir dist`, `declaration`, `sourceMap`, `verbatimModuleSyntax`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` | **0 errors** |
| Contract surface is Node-free | `npm run typecheck:contract` | `tsconfig.contract.json`: extends the build config, adds `types: []` and `lib: ["ES2023"]`, compiles only `src/lib/errors.ts`, `src/lib/mcp-tools.ts`, `src/lib/mcp-protocol.ts` with the Node type surface **removed** | **0 errors** |
| Test layer against the emitted types | `npm run typecheck:tests` | `tsconfig.test.json`: `allowJs` + `checkJs` over `test/**/*.mjs`, `noEmit`, `strict: true` | **0 errors** |

- The second gate is the mechanical form of `AGENTS.md` section 4 ("contract and protocol code stays
  free of Node-only APIs"): a `node:*` import, `process`, `Buffer` or socket reference added to a
  protocol module becomes a **build failure** rather than something a reviewer has to notice. It has
  a second consequence that shaped the code: `src/lib/mcp-protocol.ts` was extracted from
  `src/lib/gateway.ts` because the stdio transport legitimately needs streams, a pid and signal
  wiring, and a module that needs those cannot be gated.
- The third gate is why `test/helpers.mjs` contains exactly **one** cast, and why it is documented at
  the site: `IpcClient.request()` is honestly typed `Promise<unknown>` because the reply is a JSON
  frame from another process, and an oracle that must be told the answer is not an oracle. The
  untyped view is admitted once where the test layer meets the wire, instead of as ~270 unchecked
  property reads, and `src/` stays fully narrowed.
- `noImplicitAny` is **`false` in the test config only**, and the consequence is stated plainly: a
  test may have an unannotated local. Nullability and `unknown` narrowing are still enforced there,
  which is what caught the 37 errors. In `src/`, `noImplicitAny` is `true`.
- CI runs all three gates, and installs the dev tooling with `npm ci` from the committed lockfile.


### 3. Zero runtime dependencies — Node 24 built-ins only

`"dependencies": {}`. The load-bearing built-ins, and what each one carries:

| Built-in | Carries |
|---|---|
| `node:sqlite` | the durable state store (`src/lib/store.ts`) and the owner-exclusion lock (`src/lib/owner-lock.ts`) |
| `node:net` | the daemon's local IPC over a unix socket (`src/lib/ipc.ts`) and the WebSocket transport's TCP connect (`src/lib/ws-client.ts`) |
| `node:http` | the Host control carrier (`src/lib/adapter.ts`) |
| `node:crypto` | identity minting and hashing (`src/lib/ids.ts`, `src/lib/ipc.ts`, `src/lib/adapter.ts`, `src/lib/ws-client.ts`, `src/lib/daemon.ts`) |

The full measured set also includes `node:fs`, `node:path` and `node:os`. Nothing else is imported
from outside the repository.

Why:

- An MCP server is spawned into someone else's agent process tree. A dependency tree is install
  surface and supply-chain surface in the one component whose job is to be trustworthy about durable
  state.
- The parts usually taken from packages — SQLite, an HTTP client, a WebSocket client, JSON-RPC
  framing — are reachable either from Node built-ins or from a few hundred lines we own and test.
- Cost is paid where it is visible: we own the WebSocket client, the MCP framing and the settings
  reader the opt-in live layer needs (a deliberately small hand-rolled reader instead of a YAML
  dependency). Their correctness rests on tests — `test/fake-host`, `test/mcp-e2e`,
  `test/isolated-host` — not on a vendor's reputation.

### 4. Implement against the official interfaces with our own client — `dsh-host-apiproxy` is not used

- **Host client face**: locally implemented (`src/lib/adapter.ts`, `src/lib/ws-client.ts`) — envelope
  construction, `rpcId` minting and echo verification, capability negotiation, retry and
  reconciliation policy, both WebSocket downlinks, `/api/respond` receipt handling.
- **`@deepseek-ai/dsh-host-apiproxy` is not a dependency, in any form.** Not runtime, not
  types-only. The bridge installs no DSH package; it finds an installed Host at runtime.
- **MCP face**: the protocol is implemented directly — newline-delimited JSON-RPC 2.0 over stdio,
  protocol revision `2024-11-05` — and `@modelcontextprotocol/sdk` is not a dependency either.

Why the types-only dependency was dropped, having originally been the plan:

- A types-only dependency on a package that *also* ships runtime JavaScript is enforceable only by
  convention (lint, compiler settings, review). Depending on it would also make the bridge's own
  install depend on a DSH-internal package layout.
- More importantly, the measurement that opened this ADR makes compile-time contract pinning weaker
  than it looks: the method map demonstrably changed between two published versions of the very
  contract we would be compiling against. A pin tells you what you resolved, not what a running Host
  serves. What actually protects a user is **runtime capability negotiation plus explicit
  unsupported-operation reporting**, and that is what the client implements.

What replaces the imported types, and what each is worth:

| Replacement | What it gives |
|---|---|
| Pinned method list and error-code set in `src/lib/adapter.ts` (52 methods, 39 error codes at this pin) | a declared support set that is reported as *unverified* until probed, instead of an assumed one |
| `npm run typecheck:contract` | the protocol surface stays free of Node-only APIs |
| `test/isolated-host` (opt-in) | measurement of the **real** Host, not a declaration file: 10 cases, 10 passed |
| `docs/host-compatibility.md` | every Host claim carries how it was verified (real Host / fake Host / contract read / tree probe / unknown) |
| `test/fake-host` + `test/persistence` + `test/property` | behaviour and failure-path coverage that no type declaration can provide |

The honest cost, accepted: a payload-shape error in a method the bridge never exercises against a
real Host is a runtime error rather than a compile error. That is why the compatibility report's rows
now carry a verification class, and why a method absent from the Host's map is required to produce a
specific failure (measured: HTTP 404 for `command.execute`, never a fabricated `ok:true`).

One guarantee is weaker than the original text implied and is stated plainly here: the bridge is no
longer "MCP because the official SDK says so". It is MCP because the E2E layer spawns the built
binary as a real child process and drives it with a client that speaks only newline-delimited
JSON-RPC 2.0 over real pipes — `initialize`, `tools/list`, `tools/call`, error mapping, cancellation,
malformed framing. That is wire-level evidence; it is not a claim of SDK conformance.

### 5. Pinning policy

Because `host.describe.version` cannot be used as a compatibility check, pinning is done from
artifacts we control:

1. **Exact versions** in the package manifest for anything the runtime or the tests execute. There
   are no runtime dependencies to range; `engines.node` states the runtime floor.
2. **A committed lockfile** (`package-lock.json`, lockfileVersion 3), so the dev tooling is
   reproducible; CI installs with `npm ci` rather than `npm install`.
3. **A checked-in inventory of the resolved Host tree** in `docs/host-compatibility.md`, with a
   documented re-pin procedure: re-walk the tree, diff `RpcMethodMap` keys and frame unions against
   the previous pin, re-run the isolated-Host layer, and record added/removed/changed methods in the
   same change.
4. **`host.describe.version` is never a pin** — it is a diagnostic string.

Capability negotiation stays mandatory regardless of pinning, because pinning tells us which version
we resolved, not which methods a running host actually serves.

**Environment history, recorded because it shaped what is committed.** The first `npm install`
failed with **`EPERM`**: npm's default cache and prefix were not writable for the process that ran
it. It was resolved by installing into a **task-owned cache and prefix**
(`HOME=... npm install --cache <dir>`), which is what produced the committed `package-lock.json`.
`typescript` resolved to **5.9.3** and `@types/node` to 24.13.4, both devDependencies, and CI runs
`npm ci` against that lockfile. The failure could not affect the shipped posture — there is no
runtime dependency to install — but it is the reason the lockfile is an artifact of a real install
rather than a hand-written file.

### 6. Contract drift is caught by capability reporting, explicit refusals and a documented re-pin — not by hope

The `/api` surface has already changed between published versions, so the project assumes it will
change again. What exists today, and what does not:

| Mechanism | State |
|---|---|
| Runtime capability reporting: the bridge reports its declared method set and which methods the Host has actually answered for (`declared` / `probed` / `unverified`) | implemented; measured on a real Host as `pinned methods=52 unverified=52` at attach |
| Explicit refusal instead of a fabricated value: a method the Host does not serve is surfaced as a failure with the observed reason (measured: HTTP 404 for `command.execute`, never `ok:true`); an error code outside the pinned set is reported as unknown rather than defaulted; a business refusal reaches the MCP client as a tool error, not a fake result | implemented; measured at the fake-Host, MCP-E2E and real-Host layers |
| Pinned method and error-code declarations in `src/lib/adapter.ts`, with a unit test asserting they are internally consistent (unique keys, key methods present, everything unverified before probing) | implemented |
| A documented re-pin procedure (re-walk the tree, diff `RpcMethodMap` keys and frame unions, re-run the isolated-Host layer, record the diff) | documented in [`docs/host-compatibility.md`](../host-compatibility.md) §2.2 — **manual** |
| An automated test that diffs the pinned declaration against the installed contract files and fails on add/remove/rename | **not built.** A method disappearing upstream would be noticed by the re-pin procedure and by a real-Host run, not by a unit test |

That last row is the honest gap. The earlier revision of this ADR promised a compatibility contract
test that fails loudly on drift: the runtime half of that promise is real — capabilities are
negotiated and reported, and nothing is faked — while the automated-drift half is **not** built and
is not claimed here.

## Consequences

Positive:

- The artifact under test is the artifact that ships; there is no build step to forget, and no
  generated file to drift.
- Type errors fail the build, and so does a Node-only API reaching the protocol surface.
- The bridge installs and runs with zero runtime dependencies, which is the posture a bridge spawned
  into someone else's process tree should have.
- The pinning artifacts make an upstream contract change a reviewable diff — when the documented
  re-pin procedure is followed — instead of a surprise, and runtime negotiation covers what no pin
  can.
- A method the Host does not serve produces a specific failure rather than a fabricated value, which
  is the only honest behaviour when the method set can shrink between versions.

Negative and accepted:

- Node.js 24 is the floor; older runtimes are unsupported, because `node:sqlite` is load-bearing.
- JSDoc annotation is a real maintenance cost on public boundaries, and the gate is only as good as
  the annotations: with `noImplicitAny` off, absent annotations pass.
- Contract drift is caught by a **manual** re-pin procedure and by a real-Host run, not by an
  automated diff against the installed declaration files (§6).
- We hand-write the `/api` transport, the WebSocket client and the MCP framing. That is deliberate:
  the transport is exactly the seam where durability, idempotency and reconciliation policy live,
  and reusing a host-side carrier would hide that seam rather than expose it.
- Giving up the SDK and the types-only contract import means two guarantees now rest on tests rather
  than on a dependency: MCP wire behaviour (`test/mcp-e2e`) and payload-shape fidelity for methods we
  do not exercise against a real Host (unverified by construction, and labelled as such).
- The typecheck gates have not yet run in CI on a runner; until they do, "it is a gate" means the
  configuration and the local result, not a green CI history.

## Alternatives considered

### Emitted TypeScript with a build step

**Originally rejected, then adopted — this is the superseded alternative that became the decision.**
See [§1](#1-typescript-sources-compiled-to-dist-on-node-24). The original reasoning is preserved
here because it named a real cost that has to be managed rather than a mistake: a `dist/` tree is a
second artifact to keep honest, and a test path can silently run stale output. What the original
entry got wrong was the tradeoff, not the risk. It claimed "the typechecking benefit is fully
retained by `checkJs`", which is false for the reason that decided the question: `checkJs` checks
annotations *inside* a file and exports nothing, so no consumer — including this project's own test
layer — is ever checked against the implementation's shapes. Emitted `.d.ts` files are what turned
the test suites into a typechecked consumer, and doing so surfaced 37 real defects in them.

The stale-output risk is now answered structurally rather than by argument: suites run the compiled
entry points so there is no second implementation; `test/run.mjs` hard-fails without a build; the
mutation runner deletes and rebuilds `dist/` inside each sandbox from the mutated sources, so a
surviving control cannot be an artifact of a stale build; and `dist/` is gitignored and rebuilt in
CI. A committed `dist/` — the version of this alternative that would actually be dangerous — was
never adopted.

### Plain ESM JavaScript with JSDoc types (`allowJs` + `checkJs`)

**This is what revision 1 of this project actually shipped, and review superseded it.** It was
rejected on the grounds that it is not the posture the design hand-off adopted ("TypeScript / Node
24"), and that its `noImplicitAny: false` setting makes the gate catch wrong types but never absent
ones. Two further concrete costs were measured rather than asserted: the contract gate in this
configuration had never succeeded once (`TS18003: No inputs were found`, because it included
`lib/*.js` while `allowJs` was off, so it enforced nothing), and no consumer could be typechecked
against the implementation's types. `docs/architecture.md` and `AGENTS.md` described this posture as
the design; both were corrected with the migration rather than left to contradict the code.

### No typechecking at all (plain JavaScript, no `tsc`)

Rejected outright. Typechecking is a design requirement here, not a nicety: the payloads are wire
contracts, the failure mode is a wrong mutation on a durable session, and the whole point of the
contract gate is that "no Node APIs in protocol code" should be a build failure. A version of this
project with no `tsc` in CI would be a different, weaker design.

### Types-only dependency on `@deepseek-ai/dsh-host-apiproxy` (the original plan)

Superseded and now rejected. It was the right instinct — check payloads against the real published
contract — but it depends on a package that ships runtime JS (so the rule is convention, not
structure), it couples the bridge's install to a DSH-internal layout, and the contract it pins has
already changed method membership between two published versions. Runtime capability negotiation,
a pinned declaration of our own, and measurement against a real Host cover most of the same ground
without the coupling — the automated drift diff is the one part they do not replace, and §6 records
it as not built. See [Revision history](#revision-history).

### Import the host-side implementation (`dsh-host-apiproxy` runtime, host composition packages)

Rejected. Importing the implementation drags in the whole Host composition and its plugin and
runtime assumptions: service registration, plugin loading, persistence backends, and the host's
own process lifecycle. A bridge that depends on the host's internals is no longer a client of the
public contract; it becomes a resident of the host process, breaks the moment that composition
changes, and cannot be spawned by `dsh-mcp-client` as an ordinary stdio server.

### Rust or Go

Rejected. The work is a thin HTTP plus WebSocket client in front of an MCP server with no
performance need: request volume is low and latency is dominated by the host's own turn execution,
not by our process. Choosing Rust or Go would mean owning a second toolchain and release pipeline
for a component whose throughput is on no critical path, and it would give up the JSDoc-checked
shapes for our own wire types while re-deriving the MCP surface by hand anyway.

### Python

Rejected on the same grounds as Rust and Go, with the additional cost that the DSH contract and the
consumer plugin are both JavaScript/TypeScript packages, so every contract shape would need a
hand-written mirror with no compiler shared with the source of truth.

### Pin to `host.describe.version` and refuse to talk to mismatched hosts

Rejected because the field does not carry the information required: it reported `0.0.1` against an
installed `0.1.1-rc.2`, so a version-equality gate would either refuse valid hosts or admit invalid
ones. Capability negotiation plus a checked-in inventory is the mechanism that actually works.

## Revision history

This ADR has been revised three times, and the sequence matters: the language decision moved away
from the original plan, was moved back by review, and then had to be *completed* by a third revision
because the second one declared the posture without migrating every module. Every step is recorded
rather than collapsed, because a reader who sees only the final state cannot tell which parts of the
design were chosen and which were enforced.

### Revision 3 (2026-09-12, this revision): the daemon is TypeScript too, and the third gate runs in CI

Revision 2 moved the *declared* posture to TypeScript, but the largest module was not actually
migrated: `src/lib/daemon.ts` did not exist and the daemon still ran from `lib/daemon.js`. A stage
review rejected that as well, and deliberately rejected the escape hatch of relaxing `tsconfig.json`
(`allowJs`/`checkJs` with `noImplicitAny: false`) to legitimise it — the migration was to be completed,
not the checker to be weakened. The gap that review found is worth naming precisely, because the
per-file detail matters:

| Layer | Revision 2 state | Revision 3 state |
|---|---|---|
| `src/lib/*.ts` except the daemon | converted, `noImplicitAny` on | unchanged |
| `src/lib/daemon.ts` | **absent** — the file was still `lib/daemon.js`, loaded by nothing but the old `bin/*.mjs` entry points | **converted**: 29 class members and 7 module-level functions, `tsc -p tsconfig.json` at 0 errors |
| Legacy `lib/*.js` and `bin/*.mjs` | still present and tracked | **deleted**; the entry points are `dist/bin/dsh-pilot-*.js` from `src/bin/*.ts` |
| CI | `build`, `typecheck`, `typecheck:contract` | plus `typecheck:tests`, so all three gates named above are CI steps and the claim in §2 is now true rather than aspirational |

Two facts about this revision are recorded because they cost time and would otherwise be re-learned.
First, the daemon was migrated by concatenating fragments converted in parallel from overlapping
source ranges, which produced duplicate members and, while those were being reconciled by text
slicing, a corrupted fragment — the assembler that now refuses to emit an unbalanced file is the
result, and the overlapping members are resolved ONCE in the fragments rather than by the assembler
(see `.local/assemble-daemon.py`, scratch and uncommitted). Second, and the reason the migration is
not accepted on "it compiles": a hand conversion dropped one expression —
`const frame = envelope?.payload ?? envelope` in `#ingestFrame` — which compiles perfectly and broke
every event-carrying test. It was found by running the suite, not by review, and the deterministic
suite now reports **`passed=64 failed=0 skipped=10 timedOut=0`**, identical to the pre-migration
measurement, which is what makes the port a port rather than a rewrite.

### Revision 2 (2026-09-12): back to TypeScript, `noImplicitAny` on

A stage review rejected revision 1's language posture as **not the adopted design**, and rejected the
suggestion that this ADR could instead be edited to ratify the JavaScript implementation — an ADR
records a decision, so editing it to match whatever was built converts it into a description and
destroys its purpose. (An earlier revision of this very section had proposed exactly that
ratification; it was withdrawn, and the alternatives section now records the JavaScript posture as
superseded rather than as a decision.) The migration to `src/**/*.ts` compiled to `dist/`, with
`strict` and `noImplicitAny` both on, is in [§1](#1-typescript-sources-compiled-to-dist-on-node-24).

### Revision 1 (2026-09-12): the JavaScript posture, now superseded

Revision 1 decided three things that the original plan had not, and the first of them is reversed
above:

| Original (pre-revision-1) decision | Revision 1 replaced it with | Revision 3 (current) |
|---|---|---|
| Implement in TypeScript targeting Node 20 LTS, compiled with strict settings | plain ESM JavaScript with JSDoc types checked by `tsc` (`allowJs`, `checkJs`, `noImplicitAny: false`), Node 24 floor | **TypeScript under `src/`, compiled to `dist/`, `strict` and `noImplicitAny` on, Node 24 floor** — the original language decision restored, with Node 24 kept because `node:sqlite` requires it |
| MCP face built on `@modelcontextprotocol/sdk` "as the official library" | MCP implemented directly over stdio; the SDK is not a dependency | unchanged |
| `@deepseek-ai/dsh-host-apiproxy` consumed for **types only**, via `import type` | no `apiproxy` dependency at all | unchanged |

What was **kept** across all revisions, unchanged in substance: implement against official public
interfaces only; the Host client face is ours; pinning comes from artifacts we control; capability
negotiation stays mandatory; zero runtime dependencies. Contract drift "must be caught by a test, not
by hope" was kept as the intent, but only in part: capability reporting and explicit refusals are
implemented, while the automated drift diff is not built (§6). Typechecking was strengthened rather
than weakened across revision 2 and completed in revision 3 — it is now three gates, one of them the Node-free contract
gate that revision 1 had configured incorrectly and which therefore ran nothing. Revision 3 also moved
the daemon itself into `src/` and deleted the JavaScript it had been running from.

### Stale rules in `AGENTS.md` (recorded, not edited here)

`AGENTS.md` section 2 described the MCP face as "a real MCP server (official SDK)" and section 4
required that `@deepseek-ai/dsh-host-apiproxy` "is consumed for types only, via `import type`".
Neither matched the code or the design: neither the SDK nor `apiproxy` is a dependency. A third stale
rule was added to that list by revision 1 — section 4 described the code as "plain ESM JavaScript
with JSDoc types" — and revision 2's migration made that rule stale in the opposite direction.

All three have been **corrected in `AGENTS.md` itself** as part of the revision-2 work, because the
repair for a stale rule that contradicts the code is to fix the rule, and because leaving them would
have meant the project's own binding engineering rules describing an implementation that does not
exist. The rest of section 4 — the one-way dependency direction, the layer separation, no deep
cross-layer imports — was unaffected throughout and is enforced by the typecheck configs and review.


### Unchanged cross-references

ADR 0002 relies on this ADR's "zero-dependency posture" when it rejects `flock(2)` through a native
addon or an external helper, and when it selects SQLite's exclusive locking mode via `node:sqlite`.
That reasoning is unchanged and is now literally true rather than aspirational: the runtime has zero
dependencies.
