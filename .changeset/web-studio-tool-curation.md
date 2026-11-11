---
"@chainmcp/config": minor
"@chainmcp/declarative": minor
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Add visual tool curation, endpoint filtering, and bidirectional configuration sync to Web Studio (M13-2):

- `@chainmcp/declarative`: Added `enabled?: boolean` on tool descriptors, filtering out disabled tools from `DeclarativeToolSource.getTools()` while preserving descriptors in store.
- `@chainmcp/config`: Added `tools` filter configuration (`include`, `exclude`) and `filterToolsByConfig` helper to `ContractConfigSchema` and `GatewayContractConfigSchema`.
- `@chainmcp/admin`: Added `GET .../tools`, `GET .../tools/{toolName}`, `PATCH .../tools/{toolName}`, and `POST .../curate` endpoints with `admin_curate` audit logging and `onConfigSync` notification. Added visual Tools & Curation card in Web Studio UI.
- `@chainmcp/cli`: Added `syncConfigToolCuration` atomic configuration sync for both `chainmcp.config.yaml` and `gateway.config.yaml` multi-contract files, and auto-restores active revisions on Studio launch.
