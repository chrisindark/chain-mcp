# ChainMcp Documentation Map

Welcome to the ChainMcp documentation. Use the guide below based on what you want to achieve:

---

## 🌟 Start Here

- **[Project Priorities (`PRIORITIES.md`)](../PRIORITIES.md):** Active, ordered work queue for the local-first 1.0.
- **[Product & Architecture Guide](./product-guide.md):** The complete plain-English guide covering what ChainMcp is, why it exists, visual architecture diagrams, limitations, observability, caching, and quick adoption.
- **[Limitations](./limitations.md):** The consolidated catalog of what ChainMcp does not do, with each boundary marked by design, deferred, or a known gap.
- **[Getting Started](./getting-started.md):** End-to-end tutorial using the runnable example and the Model Context Protocol Inspector CLI.
- **[Concepts & Core Model](./concepts.md):** High-level explanation of tools, contracts, execution stages, and tenant models.

---

## 🚀 Building & Authoring Tools

- **[OpenAPI Contract Support](./openapi-support.md):** Supported OpenAPI 3.0/3.1 subset, schema constraints, and linear-time regex audits.
- **[Generated Servers](./generated-servers.md):** Exporting portable, self-contained TypeScript server projects.
- **[Code-First Authoring (`@chainmcp/authoring`)](./getting-started.md#code-first-authoring-workflow):** Authoring tools in TypeScript using Zod schemas (`defineTool`).
- **[Declarative HTTP Tools (`@chainmcp/declarative`)](./declarative-tools.md):** Versioned JSON descriptors for HTTP tools, executed through the bounded executor.
- **[Declarative Admin (`@chainmcp/admin`)](./declarative-admin.md):** Self-hosted API and console for validating, previewing, and publishing descriptors with tenant scoping.
- **[Field Projection & Token Budgets](./field-projection.md):** Trimming large API responses so LLMs don't burn tokens or exceed context windows.
- **[JSON Navigation & Search Tools](./json-navigation.md):** Helper tools that allow LLMs to paginate, slice, and inspect large JSON payloads.

---

## 🛡️ Security, Auth & Protection

- **[Security Architecture (`SECURITY.md`)](../SECURITY.md):** Outbound SSRF defense, DNS pinning, private range blocking, and credential isolation.
- **[Authentication & Credentials](./authentication.md):** Inbound MCP caller authorization vs upstream API credentials (OAuth 2.0 Client Credentials, API keys, Bearer tokens).
- **[Rate Limiting & Concurrency Quotas](./rate-limiting.md):** In-memory and Redis-backed rate limiting to stop runaway agent loops.
- **[Risk Register & Threat Model](./risk-register.md):** Verified statuses of all Phase 1–3 security risks.

---

## ⚡ Performance, Caching & Observability

- **[Smart Caching & Isolation](./caching.md):** Hashed, authorization-partitioned caching with in-memory and Redis stores.
- **[Token Accounting](./token-accounting.md):** Measuring and estimating LLM token usage.
- **[Analytics, Logging & Tracing](./analytics.md):** Structured JSON logs with automatic secret redaction and OpenTelemetry metrics.

---

## 🚢 Production Operations & Delivery

- **[Deployment Guide](./deployment.md):** Docker containerization, standalone servers, and environment configuration.
- **[Dynamic Gateway Architecture](./dynamic-gateway.md):** Dynamic multi-tenant contract loading, live reloads, and instant rollbacks.
- **[Supported Versions & Compatibility](./supported-versions.md):** Runtime matrix (Node.js, OpenAPI, MCP SDK, Redis).
- **[Migration & Rollback Procedures](./migration-and-rollback.md):** Safe upgrade and rollback steps for servers and gateways.
- **[Troubleshooting & Operational Runbook](./troubleshooting.md):** Diagnosing runtime error codes, SSRF blocks, and safe log inspection.
- **[Architecture Decision Records (ADR)](./adr/README.md):** Architectural decision records (ADR 0001–0030).
