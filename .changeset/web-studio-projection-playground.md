---
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Add interactive projection playground with live upstream test-firing and token savings metrics to Web Studio (M13-3):

- `@chainmcp/admin`: Added `POST /api/v1/tenants/{tenant}/contracts/{contract}/tools/{toolName}/test` endpoint for direct upstream test-firing with sandboxed execution, non-cached mode, and SSRF enforcement. Evaluates field projections (`include`/`exclude`), measures execution latency, counts raw vs. projected tokens using tokenizer, and reports token savings and percentage reduction with `admin_test_tool` audit records.
- `@chainmcp/admin`: Added Interactive Projection Playground section in Web Studio UI with tool selector, argument JSON editor, include/exclude field filters, side-by-side Raw vs. Projected diff view, and live token savings metrics badge.
- `@chainmcp/cli`: Added Web Studio playground integration tests.
