# Migration and Rollback Guide

This guide describes upgrade paths, version migrations, and rollback procedures for both standalone generated servers and dynamic gateway instances.

## 1. Upgrading Generated Servers

Standalone servers generated via `chainmcp export` depend on shared `@chainmcp/*` runtime packages and pin their contract in `spec/openapi.yaml` with a cryptographic `chainmcp.manifest.json`.

### Upgrading Shared Packages

To upgrade an exported server's dependencies:

1. Update `@chainmcp/*` package versions in `package.json`:
   ```bash
   pnpm update "@chainmcp/*"
   ```
2. Verify TypeScript build and test suite:
   ```bash
   pnpm build && pnpm test
   ```

### Re-exporting on Contract Updates

When the upstream OpenAPI contract changes:

1. Run `chainmcp export` targeting the new specification:
   ```bash
   chainmcp export --config chainmcp.config.yaml --spec spec/openapi.yaml --output ./dist-server --force
   ```
2. Validate manifest reproducibility:
   ```bash
   chainmcp build --check
   ```
   The build command compares generated tool hashes against `chainmcp.manifest.json` to verify integrity.

---

## 2. Dynamic Gateway Rollback & Disabling

The dynamic gateway (`@chainmcp/gateway`) manages versioned contract revisions atomically in memory without service downtime.

### Disabling a Faulty Revision

If an active contract revision produces unexpected upstream errors or requires immediate revocation:

```ts
// Immediately hides the contract's tools from discovery and execution
const disabled = await gateway.disableContract("tenant-acme", "billing-api");
console.log(`Contract disabled: ${disabled.revisionId}`);
```

- Tools from this contract will immediately return empty in `tools/list` and fail with `TOOL_NOT_FOUND` in `tools/call`.
- A `contract_disabled` audit event is recorded.

### Rolling Back to a Previous Revision

To restore a previously compiled revision:

```ts
// List historical revisions for this contract
const history = gateway
  .getRegistry()
  .listRevisions("tenant-acme", "billing-api");

// Rollback to the desired revision ID
const previousRevId = "rev_9a8b7c6d5e4f3a2b";
const reactivated = await gateway.rollbackContract(
  "tenant-acme",
  "billing-api",
  previousRevId,
);
console.log(`Reactivated revision: ${reactivated.revisionId}`);
```

- The active runtime snapshot is atomically swapped (`this.activeRuntime = nextRuntime`).
- In-flight requests currently executing against the faulty revision finish cleanly.
- Subsequent requests immediately resolve against the restored revision.
- A `contract_rolled_back` audit event is emitted.

---

## 3. Cache Migration & Invalidation

ChainMcp implements strict cache key versioning ([ADR 0005](file:///Users/christopherpaul/projects/chain-mcp/docs/adr/0005-versioned-hashed-cache-keys.md)):

1. **Automatic Revision Partitioning:**
   - Every cache key hashes `contractRevision`, `tenantId`, `principalId`, and the authorization partition.
   - Deploying a new contract revision automatically produces misses for old cache entries without requiring a manual cache flush.
2. **Explicit Key Invalidation:**
   - Operators can invalidate a specific cached result using exact invocation arguments:
     ```ts
     await runtime.invalidateCachedResult("getPet", { petId: "123" }, context);
     ```
3. **Cache Engine Migration:**
   - When switching from memory to Redis (`@chainmcp/cache-redis`), configure the Redis connection string in `chainmcp.config.yaml` (`cache.provider: redis`).
   - Redis commands are isolated under key prefixes, preventing collisions with other application data.

---

## 4. Container Deployment Rollback

For containerized deployments generated using `chainmcp export`'s Docker templates:

1. **Immutable Image Tagging:**
   - Tag container images using the Git commit hash and generation manifest toolset hash:
     ```bash
     docker build -t chainmcp-server:git-<commit>-toolset-<hash> .
     ```
2. **Instant Rollback:**
   - Revert the container tag in your orchestrator (Kubernetes deployment or Docker Compose) to the previous image tag.
   - Because generated servers are stateless, rollbacks require zero database schema rollbacks or data migration.
