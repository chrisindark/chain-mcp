---
"@chainmcp/config": minor
"@chainmcp/cli": minor
---

Allow exact token measurement from configuration.

- `@chainmcp/config`: `tokenMetrics.tokenizer` accepts `exact`. Exact measurement requires `tokenMetrics.module` or a factory registered with `registerTokenizerFactory(modelId, factory)`. `loadTokenizerFromConfig()` resolves modules relative to the configuration directory, validates that the adapter id matches `modelId` and that it declares `measurement: "exact"`, and fails startup rather than relabeling an estimate. `TokenizerConfigError` exposes stable `TOKENIZER_SOURCE_REQUIRED`, `TOKENIZER_FACTORY_FAILED`, `TOKENIZER_MODULE_INVALID`, and `TOKENIZER_INVALID` codes. `buildRuntimeOptions()` stays synchronous and requires an injected tokenizer for exact configurations.
- `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates load the configured tokenizer once at startup and pass the same instance to the runtime, so `output.maxTokens` enforcement and `tokenUsage` use one counter.
- Additive: existing `approximate` and `none` configurations behave as before.
