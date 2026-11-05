import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Tokenizer } from "@chainmcp/core";

/**
 * Tokenizer selection as it appears in `tokenMetrics`. Kept structural so this
 * module does not need to import the Zod schema (which imports this module).
 */
export interface TokenizerSelectionConfig {
  readonly enabled: boolean;
  readonly tokenizer: "approximate" | "exact" | "none";
  readonly modelId: string;
  readonly charactersPerToken: number;
  readonly module?: string | undefined;
}

/**
 * Creates a tokenizer for an exact measurement. The factory receives the
 * `tokenMetrics` section and may be asynchronous because importing a tokenizer
 * module is asynchronous.
 */
export type TokenizerFactory = (
  config: TokenizerSelectionConfig,
) => Tokenizer | Promise<Tokenizer>;

export type TokenizerConfigErrorCode =
  | "TOKENIZER_SOURCE_REQUIRED"
  | "TOKENIZER_FACTORY_FAILED"
  | "TOKENIZER_MODULE_INVALID"
  | "TOKENIZER_INVALID";

/**
 * Stable startup error for exact token measurement. The message names the
 * configuration key to change; `code` is stable for tests and operators.
 */
export class TokenizerConfigError extends Error {
  constructor(
    public readonly code: TokenizerConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TokenizerConfigError";
  }
}

const tokenizerFactories = new Map<string, TokenizerFactory>();

/**
 * Registers an in-process tokenizer factory for `tokenMetrics.tokenizer:
 * exact`. The registry key is `tokenMetrics.modelId`. A configured module takes
 * precedence over a registered factory with the same id.
 */
export function registerTokenizerFactory(
  modelId: string,
  factory: TokenizerFactory,
): void {
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    throw new TypeError("Tokenizer factory id must be a non-empty string");
  }
  if (typeof factory !== "function") {
    throw new TypeError("Tokenizer factory must be a function");
  }
  tokenizerFactories.set(modelId, factory);
}

/** Removes a registered tokenizer factory. Returns whether one was removed. */
export function unregisterTokenizerFactory(modelId: string): boolean {
  return tokenizerFactories.delete(modelId);
}

/** Returns the registered factory for `modelId`, if any. */
export function getTokenizerFactory(
  modelId: string,
): TokenizerFactory | undefined {
  return tokenizerFactories.get(modelId);
}

/**
 * Creates the built-in character-ratio tokenizer. Counts are always labeled
 * `estimate`; a heuristic is never presented as an exact count.
 */
export function createApproximateTokenizer(
  config: TokenizerSelectionConfig,
): Tokenizer {
  const ratio = config.charactersPerToken || 4;
  return {
    id: config.modelId,
    measurement: "estimate",
    count(text: string): number {
      if (!text) return 0;
      return Math.ceil(text.length / ratio);
    },
  };
}

/**
 * Synchronous tokenizer construction for code that cannot await. Exact
 * tokenization needs a module import or an asynchronous factory, so callers
 * must use {@link loadTokenizerFromConfig} (or pass the tokenizer through
 * `RuntimeOptions.tokenizer`) instead.
 */
export function createTokenizerFromConfig(
  config: TokenizerSelectionConfig,
): Tokenizer | undefined {
  if (!config.enabled || config.tokenizer === "none") {
    return undefined;
  }
  if (config.tokenizer === "exact") {
    throw new TokenizerConfigError(
      "TOKENIZER_SOURCE_REQUIRED",
      "tokenMetrics.tokenizer is 'exact', which requires a tokenizer module or registered factory. Use loadTokenizerFromConfig() during startup, or pass an exact Tokenizer through RuntimeOptions.tokenizer.",
    );
  }
  return createApproximateTokenizer(config);
}

export interface LoadTokenizerOptions {
  /**
   * Directory used to resolve a relative `tokenMetrics.module` specifier.
   * Defaults to the process working directory; callers should pass the
   * directory containing the configuration file.
   */
  baseDir?: string;
  /** Test seam for loading a tokenizer module. Defaults to `import()`. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * Loads the configured tokenizer, resolving a module or registered factory for
 * `tokenizer: exact`. Fails fast when exact measurement has no source, when the
 * module cannot be loaded, or when the adapter's declaration does not match the
 * configuration. Approximate counts remain labeled `estimate`.
 */
export async function loadTokenizerFromConfig(
  config: TokenizerSelectionConfig,
  options: LoadTokenizerOptions = {},
): Promise<Tokenizer | undefined> {
  if (!config.enabled || config.tokenizer === "none") {
    return undefined;
  }
  if (config.tokenizer === "approximate") {
    return createApproximateTokenizer(config);
  }

  const candidate =
    config.module !== undefined
      ? await loadTokenizerModule(config, options)
      : await loadTokenizerFactory(config);

  return validateExactTokenizer(candidate, config);
}

async function loadTokenizerFactory(
  config: TokenizerSelectionConfig,
): Promise<unknown> {
  const factory = getTokenizerFactory(config.modelId);
  if (!factory) {
    throw new TokenizerConfigError(
      "TOKENIZER_SOURCE_REQUIRED",
      `tokenMetrics.tokenizer is 'exact' but no tokenizer source is configured for modelId '${config.modelId}'. Set tokenMetrics.module to a module that exports createTokenizer(config), or call registerTokenizerFactory('${config.modelId}', factory) before startup.`,
    );
  }
  try {
    return await factory(config);
  } catch (error) {
    if (error instanceof TokenizerConfigError) throw error;
    throw new TokenizerConfigError(
      "TOKENIZER_FACTORY_FAILED",
      `Tokenizer factory '${config.modelId}' failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function loadTokenizerModule(
  config: TokenizerSelectionConfig,
  options: LoadTokenizerOptions,
): Promise<unknown> {
  const specifier = config.module as string;
  const resolved = resolveModuleSpecifier(specifier, options.baseDir);
  const importModule =
    options.importModule ?? ((value: string) => import(value));

  let namespace: unknown;
  try {
    namespace = await importModule(resolved);
  } catch (error) {
    throw new TokenizerConfigError(
      "TOKENIZER_MODULE_INVALID",
      `Failed to load tokenizer module '${specifier}': ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const create = tokenizerModuleFactory(namespace);
  if (create === undefined) {
    throw new TokenizerConfigError(
      "TOKENIZER_MODULE_INVALID",
      `Tokenizer module '${specifier}' must export a createTokenizer(config) function (named or default export).`,
    );
  }

  try {
    return await create(config);
  } catch (error) {
    if (error instanceof TokenizerConfigError) throw error;
    throw new TokenizerConfigError(
      "TOKENIZER_MODULE_INVALID",
      `Tokenizer factory from '${specifier}' failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function resolveModuleSpecifier(
  specifier: string,
  baseDir: string | undefined,
): string {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
    return specifier;
  }
  return pathToFileURL(resolve(baseDir ?? process.cwd(), specifier)).href;
}

function tokenizerModuleFactory(
  namespace: unknown,
): ((config: TokenizerSelectionConfig) => unknown) | undefined {
  if (namespace === null || typeof namespace !== "object") return undefined;
  const named = (namespace as Record<string, unknown>).createTokenizer;
  if (typeof named === "function") {
    return named as (config: TokenizerSelectionConfig) => unknown;
  }
  const fallback = (namespace as Record<string, unknown>).default;
  if (typeof fallback === "function") {
    return fallback as (config: TokenizerSelectionConfig) => unknown;
  }
  return undefined;
}

function validateExactTokenizer(
  candidate: unknown,
  config: TokenizerSelectionConfig,
): Tokenizer {
  if (candidate === null || typeof candidate !== "object") {
    throw new TokenizerConfigError(
      "TOKENIZER_INVALID",
      `Exact tokenizer for modelId '${config.modelId}' must be an object implementing Tokenizer.`,
    );
  }
  const tokenizer = candidate as Partial<Tokenizer>;
  if (typeof tokenizer.id !== "string" || tokenizer.id.trim().length === 0) {
    throw new TokenizerConfigError(
      "TOKENIZER_INVALID",
      `Exact tokenizer for modelId '${config.modelId}' must declare a non-empty id.`,
    );
  }
  if (tokenizer.id !== config.modelId) {
    throw new TokenizerConfigError(
      "TOKENIZER_INVALID",
      `Exact tokenizer id '${tokenizer.id}' does not match tokenMetrics.modelId '${config.modelId}'.`,
    );
  }
  if (tokenizer.measurement !== "exact") {
    throw new TokenizerConfigError(
      "TOKENIZER_INVALID",
      `tokenMetrics.tokenizer is 'exact' but tokenizer '${tokenizer.id}' declares measurement '${String(tokenizer.measurement)}'. Use tokenMetrics.tokenizer: approximate for estimates, or configure an exact adapter.`,
    );
  }
  if (typeof tokenizer.count !== "function") {
    throw new TokenizerConfigError(
      "TOKENIZER_INVALID",
      `Exact tokenizer '${tokenizer.id}' must implement count(text).`,
    );
  }
  return tokenizer as Tokenizer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
