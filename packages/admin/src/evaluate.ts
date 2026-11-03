import {
  DeclarativeDescriptorError,
  MAX_DECLARATIVE_DESCRIPTORS,
  normalizeAuthSchemeMap,
  parseDeclarativeToolDescriptor,
  type DeclarativeAuthSchemeMap,
  type ParsedDeclarativeTool,
} from "@chainmcp/declarative";

import {
  DeclarativeAdminError,
  descriptorPolicyPreview,
  MAX_DECLARATIVE_ADMIN_DESCRIPTORS,
  type DeclarativeAdminDescriptorDiagnostic,
  type DeclarativeAdminDescriptorSummary,
  type DeclarativeAdminEvaluation,
  type DeclarativeAdminPreview,
  type DeclarativeAdminToolPreview,
} from "./types.js";

/** Internal evaluation result: the public projection plus parsed tools. */
export interface EvaluatedDescriptorSet {
  readonly evaluation: DeclarativeAdminEvaluation;
  readonly preview: DeclarativeAdminPreview;
  readonly parsed: readonly ParsedDeclarativeTool[];
}

export interface EvaluateDescriptorSetOptions {
  readonly descriptors: readonly unknown[];
  readonly authSchemes?: DeclarativeAuthSchemeMap | undefined;
  readonly maxDescriptors?: number | undefined;
}

/**
 * Validates a descriptor collection without touching the network or the
 * gateway. Parsing uses the deployment's credential scheme map, so a reference
 * to an unconfigured scheme fails here rather than at publish time.
 */
export function evaluateDescriptorSet(
  options: EvaluateDescriptorSetOptions,
): EvaluatedDescriptorSet {
  const { descriptors } = options;
  const limit = Math.min(
    options.maxDescriptors ?? MAX_DECLARATIVE_ADMIN_DESCRIPTORS,
    MAX_DECLARATIVE_DESCRIPTORS,
  );

  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must contain a non-empty 'descriptors' array",
    );
  }
  if (descriptors.length > limit) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      `At most ${limit} descriptors may be submitted at once`,
    );
  }

  const schemes = normalizeAuthSchemeMap(options.authSchemes);
  const parsed: ParsedDeclarativeTool[] = [];
  const diagnostics: DeclarativeAdminDescriptorDiagnostic[] = [];
  const names = new Map<string, number>();

  descriptors.forEach((descriptor, index) => {
    let tool: ParsedDeclarativeTool;
    try {
      tool = parseDeclarativeToolDescriptor(descriptor, {
        authSchemes: schemes,
      });
    } catch (error) {
      if (error instanceof DeclarativeDescriptorError) {
        diagnostics.push({
          index,
          code: error.code,
          message: error.message,
          issues: error.issues,
        });
        return;
      }
      throw error;
    }

    const existing = names.get(tool.descriptor.name);
    if (existing !== undefined) {
      diagnostics.push({
        index,
        code: "NAME_DUPLICATE",
        message: `Tool '${tool.descriptor.name}' is already defined at index ${existing}`,
        issues: [{ path: "name", message: "Tool names must be unique" }],
      });
      return;
    }

    names.set(tool.descriptor.name, index);
    parsed.push(tool);
  });

  const tools: DeclarativeAdminDescriptorSummary[] = parsed.map((tool) => ({
    index: names.get(tool.descriptor.name) ?? -1,
    name: tool.descriptor.name,
    revision: tool.revision,
  }));

  const previewTools: DeclarativeAdminToolPreview[] = parsed.map((tool) => {
    const { operation, descriptor } = tool;
    return {
      index: names.get(descriptor.name) ?? -1,
      name: descriptor.name,
      description: descriptor.description,
      revision: tool.revision,
      method: operation.method.toUpperCase(),
      path: operation.path,
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required,
      })),
      ...(operation.requestBody === undefined
        ? {}
        : {
            body: {
              mediaType: operation.requestBody.mediaType,
              required: operation.requestBody.required,
            },
          }),
      authentication: {
        allowsAnonymous: operation.authentication.allowsAnonymous,
        alternatives: operation.authentication.alternatives.map((alternative) =>
          alternative.schemes.map((scheme) => scheme.name),
        ),
      },
      policy: descriptorPolicyPreview(descriptor.policy),
    };
  });

  return {
    evaluation: {
      valid: diagnostics.length === 0,
      tools,
      diagnostics,
    },
    preview: {
      valid: diagnostics.length === 0,
      tools: previewTools,
      diagnostics,
    },
    parsed,
  };
}
