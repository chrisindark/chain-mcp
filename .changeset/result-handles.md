"@chainmcp/json-navigation": minor
"@chainmcp/config": minor
"@chainmcp/cli": minor
---

Connect JSON navigation to a tenant- and principal-scoped result-handle registry (P1-2).

- `@chainmcp/json-navigation`: new `ResultHandleRegistry` (`src/handles.ts`) — opaque `rhv1.<counter>.<tag>` handles where the tag is an HMAC of `tenantId|principalId|counter` under a per-registry secret, so tenant/principal ids are never embedded and a tampered handle fails verification. Bounded per-principal LRU, per-tenant cap, absolute cap, per-document byte cap, and total-bytes cap, with a TTL. Stable `RESULT_HANDLE_EXPIRED` for unknown, expired, evicted, tampered, cross-tenant, and cross-principal handles (no existence leak across scopes); `ResultHandleTooLargeError` for documents above the byte cap instead of silent truncation. `createJsonNavigationTools(limits?, handleRegistry?)` now registers five tools: the four existing navigation tools accept either `json` or `handle`, and a new `json_create_handle` tool stores a document once and returns `{ handle, bytes }`.
- `@chainmcp/config`: new `jsonNavigation.handles` schema (`enabled`, `maxPerPrincipal`, `maxPerTenant`, `maxTotal`, `maxBytes`, `maxTotalBytes`, `ttlMs`, `minBytes`) and `createHandleRegistryOptionsFromConfig()` wiring helper.
- `@chainmcp/cli`: `serve` (both code-first and compiled paths), `dev`, and generated server templates pass registry options from config into `createJsonNavigationTools`; tool counts updated from 4 to 5 navigation tools.
- Additive: inline-`json` callers are unaffected; the result-handle docs previously claimed no handles existed (README, product guide), and those statements are corrected.
