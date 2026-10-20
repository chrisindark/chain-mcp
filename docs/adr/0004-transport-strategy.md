# ADR 0004 — MCP transport strategy

- Status: accepted
- Recorded: 2026-10-20 (accepted after Milestone 2 implementation and verification)

## Context and problem

ChainMcp must expose tools through the Model Context Protocol without inventing
protocol behavior. Local development and generated-server use cases benefit from
a simple stdio transport, while hosted and gateway deployments need a remote
transport with explicit authentication. Remote endpoints are a distinct security
boundary: an unauthenticated or accidentally exposed HTTP endpoint must not
serve tools or upstream credentials.

The project targets the official TypeScript MCP SDK and keeps policy logic
independent of transport. Milestone 2 implements the local stdio adapter and
transport lifecycle. It has been verified with the SDK client over a linked
in-memory transport pair and deterministic lifecycle tests. Remote serving and
inbound HTTP authentication remain unimplemented.

## Decision

Use the official TypeScript MCP SDK and treat transports as replaceable
adapters.

- Implement local stdio first for generated servers, CLI use, and local
  development.
- Add Streamable HTTP as a separate transport adapter rather than extending the
  stdio path with remote-specific behavior.
- Require an explicit authentication policy for every remote transport. Remote
  MCP endpoints fail closed when inbound identity or authorization cannot be
  verified.
- Keep tool registration, invocation, error mapping, and policy in the shared
  runtime; transports only adapt protocol and lifecycle concerns.
- Implement transport lifecycle and graceful shutdown, including cancellation
  propagation to in-flight work.
- Do not invent MCP protocol behavior; follow the current SDK APIs.

## Alternatives considered

- **Stdio only.** Rejected as a long-term strategy: it cannot support hosted
  gateways or remote clients.
- **HTTP first.** Rejected: it adds authentication and network exposure before
  the local path and shared runtime are proven.
- **A custom protocol or hand-written MCP framing.** Rejected: it would diverge
  from the ecosystem and duplicate SDK behavior.
- **Unauthenticated HTTP for convenience.** Rejected: remote endpoints are
  explicitly in the threat model and must fail closed.
- **Put transport-specific authorization in each adapter.** Rejected: policy
  belongs in the shared runtime; adapters establish trusted context only.

## Consequences and trade-offs

- Local stdio remains simple and avoids network exposure.
- Remote support requires additional authentication, configuration, and
  operational documentation.
- Two transport adapters increase test and lifecycle coverage.
- Keeping policy transport-independent prevents behavior differences between
  generated servers and the gateway.
- The local transport strategy is accepted based on the verified Milestone 2
  adapter. This does not approve unauthenticated remote serving or claim that
  remote transports exist.

## Security implications

- Remote transports must not be exposed without an authentication decision.
- Inbound MCP identity remains separate from upstream API credentials.
- Transport adapters must not bypass runtime authorization, rate limits, or
  cache partitioning.
- Cancellation and shutdown must reach in-flight upstream operations.
- Network controls, TLS termination, and endpoint exposure remain deployment
  responsibilities that must be documented.

## Follow-up actions

- Define Streamable HTTP authentication and configuration in
  `CONFIGURATION.md` before implementation.
- Revisit this ADR if remote transport requirements change the accepted
  transport-independent policy boundary.
