---
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Human-in-the-Loop (HITL) approval gates for agent proposals:

- Add proposal lifecycle (`draft` | `proposal` | `rejected` | `active` | `superseded`) to `@chainmcp/admin` with durable storage across Memory, File, and SQLite WAL drivers.
- Implement `computeProposalDiffAndSavings` to calculate deep tool-level diffs (enabled/disabled status, description, field projection, cache TTL) and estimate LLM context token savings per tool call.
- Support `requireApproval` option in `createMetaMcpTools`: when enabled (default in `chainmcp agent-server`), agent self-improvement mutations produce proposals rather than mutating active gateway runtime state.
- Expose `chainmcp_submit_proposal` and `chainmcp_list_proposals` meta-tools for explicit proposal submission and inspection.
- Add REST endpoints `/api/v1/proposals`, `/api/v1/tenants/:tenant/contracts/:contract/proposals`, `/approve`, and `/reject` with full audit trail logging (`admin_proposal_created`, `admin_proposal_approved`, `admin_proposal_rejected`).
- Add "Agent Proposals & HITL Approval Gates" section to Web Studio with live diff review, token savings estimation, and one-click "Approve & Publish" or "Reject" buttons.
- Add `chainmcp proposals` CLI command with `list`, `diff <revisionId>`, `approve <revisionId>`, and `reject <revisionId>` subcommands, terminal diff rendering, and `--json` support.
