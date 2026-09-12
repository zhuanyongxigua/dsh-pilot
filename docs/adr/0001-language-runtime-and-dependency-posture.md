# ADR 0001: Language, runtime, and dependency posture

- Status: Accepted
- Date: 2026-09-12
- Scope: dsh-pilot (the MCP-to-DSH bridge), all packages in this repository
- Related: `AGENTS.md` sections 4 and 5; `docs/host-compatibility.md`

## Context

dsh-pilot is an independently implemented MCP server/bridge that exposes durable sessions on a
DSH Host ("DeepSeek Harness", npm package `@deepseek-ai/dsh`, MIT) to any MCP client. Its
downstream consumer is DSH's own MCP client plugin, `@deepseek-ai/dsh-mcp-client`, which spawns
MCP servers over `stdio` or `streamable-http` and surfaces their tools to a model under
`mcp__<serverName>__<toolName>`.

The bridge sits between two contracts it does not own:

1. **The MCP contract**, client-facing, defined by the Model Context Protocol and implemented by
   the official SDK.
2. **The DSH `/api` contract**, host-facing, distributed as TypeScript declaration files plus zod
   schemas. Upstream describes this layer as "the authoritative contract", with HTTP, WebSocket,
   and in-process SSE as "merely physical channels". That same contract layer documents itself as
   having "zero Node dependencies, importable from the browser".

Three observations from the resolved dependency trees forced this decision to be written down
rather than assumed:

- The `/api` method surface is not stable across published versions. Comparing the `0.0.1-rc.1`
  and `0.1.1-rc.2` resolved trees: `command.execute` and `command.list` are present in the former
  and absent from the latter's method map, while `workspace.insertBefore` is absent from the
  former's method map and present in the latter.
- The host exposes no protocol-version negotiation field for this purpose. The host domain
  contract states that it carries "no protocol version: client and host ship together"; a
  protocol version is deferred upstream until an independently released client appears. This
  bridge is exactly such an independent client, but the field it would need does not exist yet.
- The version string that does exist is unusable as a pin. On the live host, `host.describe.version`
  reported `0.0.1` while the installed `@deepseek-ai/dsh` package was `0.1.1-rc.2`. The field is
  documented as the host app's own package version, and the cause of the observed discrepancy has
  not been established; whatever the cause, the field demonstrably cannot be used to decide whether
  a given method exists.

A control bridge is a low-throughput, high-consequence component: it sends few requests, and each
request can mutate durable session state. Correctness, debuggability, and compile-time contract
checking matter far more here than throughput or memory footprint.

## Decision

### 1. TypeScript on Node.js (>= 20 LTS), ESM

Implement the bridge in TypeScript targeting Node.js 20 LTS or newer, as ESM, with strict compiler
settings.

Justification:

- **The host contract is TypeScript.** The `/api` surface is distributed as `.d.ts` files with
  companion zod schemas. Consuming those types directly gives compile-time checking of payloads and
  return values against the real contract, including the discriminated `RpcResult` union.
- **The MCP SDK is TypeScript-first.** `@modelcontextprotocol/sdk` is the official implementation
  and the natural way to be a real MCP server rather than an imitation of one.
- **The consumer is a Node package.** `dsh-mcp-client` spawns servers over `stdio`; staying in the
  same runtime removes an entire class of packaging, transport, and lifecycle mismatches.
- **Single-process debuggability.** One process, one stack trace, one attach point, for both the
  MCP face and the Host client face. For a control bridge, the ability to debug a stuck or
  uncertain call is the dominant engineering cost.

ESM is not optional: both the host contract packages and the MCP SDK are ESM, and mixing module
systems across the bridge would add resolution hazards for no benefit.

### 2. Implement against official public interfaces only

- **MCP face**: `@modelcontextprotocol/sdk`, used as the official library, with the built binary
  behaving as a real MCP server over `stdio` (and `streamable-http` where configured).
- **Host client face**: a **locally implemented** HTTP + WebSocket client for the DSH `/api`
  surface. We own envelope construction, `rpcId` minting, capability negotiation, retry and
  reconciliation policy, and downlink handling.
- **`@deepseek-ai/dsh-host-apiproxy` is consumed for TYPES ONLY**, via `import type`. It is the
  source of truth for payload and value types, error codes, and capability shape, and it is
  listed as a dependency for that purpose.

The types-only rule is a policy, not a property of the package: `dsh-host-apiproxy` also ships
runtime JavaScript. The rule must therefore be enforced mechanically (lint and compiler settings)
and by review, per `AGENTS.md` section 4.

### 3. Pinning policy

Because `host.describe.version` cannot be used as a compatibility check, pinning is done from
artifacts we control:

1. **Exact versions** in the package manifest - no caret or tilde ranges for the DSH packages and
   the MCP SDK.
2. **A committed lockfile**, so the resolved tree is reproducible.
3. **A checked-in inventory of the resolved dependency tree**, generated from the lockfile and
   committed, so a diff of that inventory is visible in review and a test can assert that the
   installed tree still matches it.
4. **A documented re-pin procedure**: update the exact versions, regenerate the lockfile and the
   inventory, re-run the compatibility test layer, and record the newly observed contract
   differences (added, removed, and changed methods) in `docs/host-compatibility.md` in the same
   change.

Capability negotiation stays mandatory regardless of pinning, because pinning tells us which
version we resolved and not which methods a running host actually serves.

### 4. Contract drift is caught by a test, not by hope

The consequence of 1-3 is a hard requirement: a compatibility test compares our negotiated
capability set and our compiled-against contract against the pinned and inventoried tree, and
fails on drift. Removing a method we depend on, or changing a payload shape, must break the build
loudly rather than degrade into a runtime error on a user's host.

## Consequences

Positive:

- Payload and return types are checked against the real published contract at compile time.
- The MCP face is genuinely MCP, because it is built on the official SDK.
- One runtime and one debugger for the whole bridge.
- The pinning artifacts make an upstream contract change a reviewable diff instead of a surprise.
- Missing methods produce explicit unsupported-operation errors, which is the only honest behavior
  when the method set can shrink between versions.

Negative and accepted:

- Node.js 20 LTS is the floor; older runtimes are unsupported.
- ESM-only output means no CommonJS consumers of our internal modules.
- The types-only dependency means we hand-write the transport for `/api`. That is deliberate: it
  is exactly the seam where our durability, idempotency, and reconciliation policy lives, and
  reusing a host-side carrier would hide that seam rather than expose it.
- We carry a generated inventory file that must be regenerated on every re-pin; forgetting it is a
  test failure, by design.
- Type-level fidelity to the contract does not establish runtime behavior. Behavior claims are
  proven separately by the fake-Host contract layer and the opt-in live suite.

## Alternatives considered

### Import the host-side implementation (`dsh-host-apiproxy` runtime, host composition packages)

Rejected. Importing the implementation drags in the whole Host composition and its plugin and
runtime assumptions: service registration, plugin loading, persistence backends, and the host's
own process lifecycle. A bridge that depends on the host's internals is no longer a client of the
public contract; it becomes a resident of the host process, breaks the moment that composition
changes, and cannot be spawned by `dsh-mcp-client` as an ordinary stdio server. Types-only keeps
the compile-time guarantee without any of the coupling.

### Rust or Go

Rejected. The work is a thin HTTP plus WebSocket client in front of an MCP server with no
performance need: request volume is low and latency is dominated by the host's own turn execution,
not by our process. Choosing Rust or Go would mean hand-duplicating the TypeScript type contract,
losing compile-time contract checking, and owning a second toolchain and release pipeline, all to
optimize a component whose throughput is not on any critical path. It would also make the MCP face
depend on a non-official SDK implementation, weakening the strongest guarantee we have that we
speak real MCP.

### Python

Rejected on the same grounds as Rust and Go, with the additional cost that the DSH contract and
the consumer plugin are both TypeScript packages, so every contract type would need a hand-written
mirror that no compiler checks against the source of truth.

### Pin to `host.describe.version` and refuse to talk to mismatched hosts

Rejected because the field does not carry the information required: it reported `0.0.1` against an
installed `0.1.1-rc.2`, so a version-equality gate would either refuse valid hosts or admit invalid
ones. Capability negotiation plus a checked-in inventory is the mechanism that actually works.
