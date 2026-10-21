# ChainMcp Concepts

## Contract

An API specification that defines operations, schemas, parameters, responses, and security schemes.

## Tool

An MCP-callable operation compiled from a contract or registered programmatically. Every tool has a stable name, description, input schema, and execution policy.

## Tool source

A producer of tool definitions. OpenAPI compilation is one source; application
code registered through the authoring facade is another. Every source feeds the
same runtime and policy pipeline, and none may bypass registration audits.

## Contract revision

An immutable, validated version of an API contract. A revision has a source hash and compiler version.

## Generated server

A standalone MCP server project created from a specific contract revision. It uses the shared runtime and can be deployed independently.

## Code-first server

A standalone MCP server whose tools are defined in application code rather than
compiled from an API contract. It uses the same runtime, transports, and policy
as a generated server; its tools are not described by a contract manifest.

## Dynamic gateway

A server that loads multiple validated contract revisions and exposes their tools without requiring a separate deployment per contract.

## Principal

The authenticated identity making a request. It must be resolved by trusted authentication middleware.

## Tenant

The security and resource-isolation boundary for a customer or deployment. Tenant identity must be established by trusted server-side configuration or verified identity claims.

## Upstream credentials

Credentials used by ChainMcp to call the original API. These are distinct from the credentials used to authenticate an MCP client.

## Response projection

A policy-controlled transformation that selects approved fields from an upstream result before returning it to the model.

## Token accounting

Measurement or estimation of tokens in a serialized tool result using a named tokenizer or documented estimation method.

## Safe caching

Caching that respects operation semantics, tenant identity, principal permissions, contract revision, and response-varying inputs.

## Runtime policy

A collection of authorization, cache, rate-limit, timeout, and response-processing rules applied consistently during tool invocation.
