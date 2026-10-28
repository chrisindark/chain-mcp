import type { JsonSchema } from "@chainmcp/core";
import type {
  CompiledAuthenticationPolicy,
  CompiledOperation,
  CompiledResponse,
  CompileResult,
} from "./types.js";

export type DiffClassification =
  "breaking" | "potentially-breaking" | "non-breaking";

export interface ContractChange {
  classification: DiffClassification;
  code: string;
  message: string;
  tool?: string | undefined;
  path?: string | undefined;
}

export interface ContractDiffResult {
  schemaVersion: 1;
  hasChanges: boolean;
  hasBreakingChanges: boolean;
  hasPotentiallyBreakingChanges: boolean;
  summary: {
    breaking: number;
    potentiallyBreaking: number;
    nonBreaking: number;
  };
  addedTools: readonly string[];
  removedTools: readonly string[];
  changedTools: readonly string[];
  unchangedTools: readonly string[];
  changes: readonly ContractChange[];
  breaking: readonly ContractChange[];
  potentiallyBreaking: readonly ContractChange[];
  nonBreaking: readonly ContractChange[];
}

export interface ContractDiffTool {
  name: string;
  description?: string | undefined;
  inputSchema?: JsonSchema | undefined;
  responses?: readonly CompiledResponse[] | undefined;
  authentication?: CompiledAuthenticationPolicy | undefined;
  method?: string | undefined;
  path?: string | undefined;
}

export interface ContractDiffInputObject {
  operations?: readonly (CompiledOperation | ContractDiffTool)[] | undefined;
  tools?: readonly ContractDiffTool[] | undefined;
  baseUrl?: string | undefined;
  servers?: readonly string[] | undefined;
}

export type ContractDiffInput =
  | ContractDiffInputObject
  | readonly (CompiledOperation | ContractDiffTool)[]
  | CompileResult;

interface NormalizedDiffInput {
  tools: Map<string, ContractDiffTool>;
  baseUrl?: string | undefined;
  servers: readonly string[];
}

function normalizeDiffInput(input: ContractDiffInput): NormalizedDiffInput {
  if (Array.isArray(input)) {
    const map = new Map<string, ContractDiffTool>();
    for (const op of input) {
      if (op && typeof op.name === "string") {
        map.set(op.name, op);
      }
    }
    return { tools: map, servers: [] };
  }

  if (typeof input === "object" && input !== null) {
    const ops =
      "operations" in input && Array.isArray(input.operations)
        ? input.operations
        : "tools" in input && Array.isArray(input.tools)
          ? input.tools
          : [];
    const map = new Map<string, ContractDiffTool>();
    for (const op of ops) {
      if (op && typeof op.name === "string") {
        map.set(op.name, op);
      }
    }
    const baseUrl =
      "baseUrl" in input && typeof input.baseUrl === "string"
        ? input.baseUrl
        : undefined;
    const servers =
      "servers" in input && Array.isArray(input.servers)
        ? (input.servers as readonly string[])
        : [];
    return { tools: map, baseUrl, servers };
  }

  return { tools: new Map(), servers: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTypes(typeVal: unknown): Set<string> {
  if (typeof typeVal === "string") {
    return new Set([typeVal]);
  }
  if (Array.isArray(typeVal)) {
    return new Set(typeVal.filter((t) => typeof t === "string"));
  }
  return new Set();
}

/**
 * Compares two OpenAPI contracts, operations sets, or tool definitions
 * according to the breaking-change taxonomy.
 */
export function diffContracts(
  previousInput: ContractDiffInput,
  nextInput: ContractDiffInput,
): ContractDiffResult {
  const previous = normalizeDiffInput(previousInput);
  const next = normalizeDiffInput(nextInput);

  const changes: ContractChange[] = [];
  const addedTools: string[] = [];
  const removedTools: string[] = [];
  const changedTools: string[] = [];
  const unchangedTools: string[] = [];

  // Check Base URL / Server changes
  if (previous.baseUrl && next.baseUrl && previous.baseUrl !== next.baseUrl) {
    try {
      const prevUrl = new URL(previous.baseUrl);
      const nextUrl = new URL(next.baseUrl);
      if (prevUrl.origin !== nextUrl.origin) {
        changes.push({
          classification: "breaking",
          code: "BASE_URL_CHANGED",
          message: `Base URL origin changed from '${prevUrl.origin}' to '${nextUrl.origin}'`,
          path: "baseUrl",
        });
      } else if (prevUrl.pathname !== nextUrl.pathname) {
        changes.push({
          classification: "potentially-breaking",
          code: "BASE_URL_PATH_CHANGED",
          message: `Base URL path changed from '${prevUrl.pathname}' to '${nextUrl.pathname}'`,
          path: "baseUrl",
        });
      }
    } catch {
      changes.push({
        classification: "breaking",
        code: "BASE_URL_CHANGED",
        message: `Base URL changed from '${previous.baseUrl}' to '${next.baseUrl}'`,
        path: "baseUrl",
      });
    }
  }

  // Detect tool renames (matching method and path)
  const removedCandidates = new Map<string, ContractDiffTool>();
  for (const [name, tool] of previous.tools) {
    if (!next.tools.has(name)) {
      removedCandidates.set(name, tool);
    }
  }

  const addedCandidates = new Map<string, ContractDiffTool>();
  for (const [name, tool] of next.tools) {
    if (!previous.tools.has(name)) {
      addedCandidates.set(name, tool);
    }
  }

  const renamedPairs = new Map<string, string>(); // prevName -> nextName
  for (const [prevName, prevTool] of removedCandidates) {
    if (prevTool.method && prevTool.path) {
      for (const [nextName, nextTool] of addedCandidates) {
        if (
          nextTool.method &&
          nextTool.path &&
          prevTool.method.toLowerCase() === nextTool.method.toLowerCase() &&
          prevTool.path === nextTool.path
        ) {
          renamedPairs.set(prevName, nextName);
          addedCandidates.delete(nextName);
          break;
        }
      }
    }
  }

  // Handle renames
  for (const [prevName, nextName] of renamedPairs) {
    removedTools.push(prevName);
    addedTools.push(nextName);
    changes.push({
      classification: "breaking",
      code: "TOOL_RENAMED",
      message: `Tool was renamed from '${prevName}' to '${nextName}'`,
      tool: prevName,
    });
    const prevTool = previous.tools.get(prevName)!;
    const nextTool = next.tools.get(nextName)!;
    diffSingleTool(prevTool, nextTool, nextName, changes);
  }

  // Remaining removed tools
  for (const [name] of removedCandidates) {
    if (renamedPairs.has(name)) continue;
    removedTools.push(name);
    changes.push({
      classification: "breaking",
      code: "TOOL_REMOVED",
      message: `Tool '${name}' was removed`,
      tool: name,
    });
  }

  // Remaining added tools
  for (const [name] of addedCandidates) {
    addedTools.push(name);
    changes.push({
      classification: "non-breaking",
      code: "TOOL_ADDED",
      message: `Tool '${name}' was added`,
      tool: name,
    });
  }

  // Common tools
  for (const [name, nextTool] of next.tools) {
    const prevTool = previous.tools.get(name);
    if (!prevTool) continue;

    const initialChangeCount = changes.length;
    diffSingleTool(prevTool, nextTool, name, changes);

    if (changes.length > initialChangeCount) {
      changedTools.push(name);
    } else {
      unchangedTools.push(name);
    }
  }

  const breaking = changes.filter((c) => c.classification === "breaking");
  const potentiallyBreaking = changes.filter(
    (c) => c.classification === "potentially-breaking",
  );
  const nonBreaking = changes.filter(
    (c) => c.classification === "non-breaking",
  );

  return {
    schemaVersion: 1,
    hasChanges: changes.length > 0,
    hasBreakingChanges: breaking.length > 0,
    hasPotentiallyBreakingChanges: potentiallyBreaking.length > 0,
    summary: {
      breaking: breaking.length,
      potentiallyBreaking: potentiallyBreaking.length,
      nonBreaking: nonBreaking.length,
    },
    addedTools: addedTools.sort(),
    removedTools: removedTools.sort(),
    changedTools: changedTools.sort(),
    unchangedTools: unchangedTools.sort(),
    changes,
    breaking,
    potentiallyBreaking,
    nonBreaking,
  };
}

function diffSingleTool(
  prevTool: ContractDiffTool,
  nextTool: ContractDiffTool,
  toolName: string,
  changes: ContractChange[],
): void {
  // Description change
  if (
    prevTool.description !== undefined &&
    nextTool.description !== undefined &&
    prevTool.description !== nextTool.description
  ) {
    changes.push({
      classification: "non-breaking",
      code: "DESCRIPTION_CHANGED",
      message: `Description of tool '${toolName}' changed`,
      tool: toolName,
      path: "description",
    });
  }

  // Authentication requirement added
  const prevAnon =
    prevTool.authentication?.allowsAnonymous ??
    prevTool.authentication?.alternatives?.length === 0;
  const nextAnon =
    nextTool.authentication?.allowsAnonymous ??
    nextTool.authentication?.alternatives?.length === 0;

  if (prevAnon === true && nextAnon === false) {
    changes.push({
      classification: "breaking",
      code: "AUTH_REQUIREMENT_ADDED",
      message: `Tool '${toolName}' now requires authentication`,
      tool: toolName,
      path: "authentication",
    });
  } else if (prevAnon === false && nextAnon === true) {
    changes.push({
      classification: "non-breaking",
      code: "AUTH_REQUIREMENT_RELAXED",
      message: `Tool '${toolName}' now allows anonymous access`,
      tool: toolName,
      path: "authentication",
    });
  }

  // Input schema diff
  if (prevTool.inputSchema || nextTool.inputSchema) {
    diffInputSchema(
      prevTool.inputSchema ?? {},
      nextTool.inputSchema ?? {},
      toolName,
      "inputSchema",
      changes,
    );
  }

  // Response schemas diff
  if (prevTool.responses || nextTool.responses) {
    diffResponses(
      prevTool.responses ?? [],
      nextTool.responses ?? [],
      toolName,
      changes,
    );
  }
}

function diffInputSchema(
  prevSchema: JsonSchema,
  nextSchema: JsonSchema,
  toolName: string,
  basePath: string,
  changes: ContractChange[],
): void {
  const prevProps = isPlainObject(prevSchema.properties)
    ? (prevSchema.properties as Record<string, JsonSchema>)
    : {};
  const nextProps = isPlainObject(nextSchema.properties)
    ? (nextSchema.properties as Record<string, JsonSchema>)
    : {};

  const prevRequired = new Set(
    Array.isArray(prevSchema.required) ? (prevSchema.required as string[]) : [],
  );
  const nextRequired = new Set(
    Array.isArray(nextSchema.required) ? (nextSchema.required as string[]) : [],
  );

  const allPropKeys = new Set([
    ...Object.keys(prevProps),
    ...Object.keys(nextProps),
  ]);

  for (const prop of allPropKeys) {
    const inPrev = Object.hasOwn(prevProps, prop);
    const inNext = Object.hasOwn(nextProps, prop);
    const propPath = `${basePath}.properties.${prop}`;

    if (!inPrev && inNext) {
      if (nextRequired.has(prop)) {
        changes.push({
          classification: "breaking",
          code: "INPUT_REQUIRED_ADDED",
          message: `New required input property '${prop}' was added to tool '${toolName}'`,
          tool: toolName,
          path: propPath,
        });
      } else {
        changes.push({
          classification: "non-breaking",
          code: "INPUT_OPTIONAL_ADDED",
          message: `New optional input property '${prop}' was added to tool '${toolName}'`,
          tool: toolName,
          path: propPath,
        });
      }
      continue;
    }

    if (inPrev && !inNext) {
      changes.push({
        classification: "breaking",
        code: "INPUT_PROPERTY_REMOVED",
        message: `Input property '${prop}' was removed from tool '${toolName}'`,
        tool: toolName,
        path: propPath,
      });
      continue;
    }

    // Property exists in both
    const wasReq = prevRequired.has(prop);
    const isReq = nextRequired.has(prop);

    if (!wasReq && isReq) {
      changes.push({
        classification: "potentially-breaking",
        code: "INPUT_BECAME_REQUIRED",
        message: `Optional input property '${prop}' became required in tool '${toolName}'`,
        tool: toolName,
        path: `${basePath}.required.${prop}`,
      });
    } else if (wasReq && !isReq) {
      changes.push({
        classification: "non-breaking",
        code: "INPUT_BECAME_OPTIONAL",
        message: `Required input property '${prop}' became optional in tool '${toolName}'`,
        tool: toolName,
        path: `${basePath}.required.${prop}`,
      });
    }

    const prevField = prevProps[prop]!;
    const nextField = nextProps[prop]!;
    diffFieldSchema(
      prevField,
      nextField,
      toolName,
      propPath,
      prop,
      changes,
      "input",
    );
  }
}

function diffFieldSchema(
  prevField: JsonSchema,
  nextField: JsonSchema,
  toolName: string,
  path: string,
  fieldName: string,
  changes: ContractChange[],
  direction: "input" | "response",
): void {
  // 1. Description change
  if (
    typeof prevField.description === "string" &&
    typeof nextField.description === "string" &&
    prevField.description !== nextField.description
  ) {
    changes.push({
      classification: "non-breaking",
      code: "DESCRIPTION_CHANGED",
      message: `Description of '${fieldName}' changed in tool '${toolName}'`,
      tool: toolName,
      path: `${path}.description`,
    });
  }

  // 2. Type diffing
  const prevTypes = extractTypes(prevField.type);
  const nextTypes = extractTypes(nextField.type);

  if (prevTypes.size > 0 && nextTypes.size > 0) {
    const removedTypes = [...prevTypes].filter((t) => !nextTypes.has(t));
    const addedTypes = [...nextTypes].filter((t) => !prevTypes.has(t));

    if (direction === "input") {
      if (removedTypes.length > 0) {
        changes.push({
          classification: "breaking",
          code: "INPUT_TYPE_NARROWED",
          message: `Input type of '${fieldName}' was narrowed from [${[...prevTypes].join(", ")}] to [${[...nextTypes].join(", ")}] in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.type`,
        });
      } else if (addedTypes.length > 0) {
        changes.push({
          classification: "non-breaking",
          code: "INPUT_TYPE_WIDENED",
          message: `Input type of '${fieldName}' was widened from [${[...prevTypes].join(", ")}] to [${[...nextTypes].join(", ")}] in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.type`,
        });
      }
    } else {
      if (removedTypes.length > 0 || addedTypes.length > 0) {
        changes.push({
          classification: "breaking",
          code: "RESPONSE_TYPE_CHANGED",
          message: `Response type of '${fieldName}' changed incompatibly from [${[...prevTypes].join(", ")}] to [${[...nextTypes].join(", ")}] in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.type`,
        });
      }
    }
  }

  // 3. Enum diffing
  const prevEnum = Array.isArray(prevField.enum) ? prevField.enum : undefined;
  const nextEnum = Array.isArray(nextField.enum) ? nextField.enum : undefined;

  if (prevEnum !== undefined && nextEnum !== undefined) {
    const prevSet = new Set(prevEnum.map(String));
    const nextSet = new Set(nextEnum.map(String));

    const removedValues = prevEnum.filter((v) => !nextSet.has(String(v)));
    const addedValues = nextEnum.filter((v) => !prevSet.has(String(v)));

    if (direction === "input") {
      if (removedValues.length > 0) {
        changes.push({
          classification: "breaking",
          code: "INPUT_ENUM_VALUE_REMOVED",
          message: `Enum values [${removedValues.map(String).join(", ")}] were removed from '${fieldName}' in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.enum`,
        });
      }
      if (addedValues.length > 0) {
        changes.push({
          classification: "non-breaking",
          code: "INPUT_ENUM_VALUE_ADDED",
          message: `Enum values [${addedValues.map(String).join(", ")}] were added to '${fieldName}' in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.enum`,
        });
      }
    } else if (addedValues.length > 0) {
      changes.push({
        classification: "potentially-breaking",
        code: "RESPONSE_ENUM_VALUE_ADDED",
        message: `New enum values [${addedValues.map(String).join(", ")}] may be returned for '${fieldName}' in tool '${toolName}'`,
        tool: toolName,
        path: `${path}.enum`,
      });
    }
  } else if (
    prevEnum === undefined &&
    nextEnum !== undefined &&
    direction === "input"
  ) {
    // Enum restriction added where there was none before
    changes.push({
      classification: "breaking",
      code: "INPUT_ENUM_VALUE_REMOVED",
      message: `Enum restriction was added to previously unconstrained '${fieldName}' in tool '${toolName}'`,
      tool: toolName,
      path: `${path}.enum`,
    });
  }

  // 4. Default changed
  if (
    Object.hasOwn(prevField, "default") &&
    Object.hasOwn(nextField, "default")
  ) {
    if (
      JSON.stringify(prevField.default) !== JSON.stringify(nextField.default)
    ) {
      changes.push({
        classification: "potentially-breaking",
        code: "INPUT_DEFAULT_CHANGED",
        message: `Default value of '${fieldName}' changed from ${JSON.stringify(prevField.default)} to ${JSON.stringify(nextField.default)} in tool '${toolName}'`,
        tool: toolName,
        path: `${path}.default`,
      });
    }
  }

  // 5. Constraints
  if (direction === "input") {
    if (typeof nextField.minLength === "number") {
      if (typeof prevField.minLength !== "number") {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'minLength' of '${fieldName}' was added (${nextField.minLength}) in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.minLength`,
        });
      } else if (nextField.minLength > prevField.minLength) {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'minLength' of '${fieldName}' increased from ${prevField.minLength} to ${nextField.minLength} in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.minLength`,
        });
      }
    }

    if (typeof nextField.maxLength === "number") {
      if (typeof prevField.maxLength !== "number") {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'maxLength' of '${fieldName}' was added (${nextField.maxLength}) in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.maxLength`,
        });
      } else if (nextField.maxLength < prevField.maxLength) {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'maxLength' of '${fieldName}' decreased from ${prevField.maxLength} to ${nextField.maxLength} in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.maxLength`,
        });
      }
    }

    if (typeof nextField.minimum === "number") {
      if (typeof prevField.minimum !== "number") {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'minimum' of '${fieldName}' was added (${nextField.minimum}) in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.minimum`,
        });
      } else if (nextField.minimum > prevField.minimum) {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'minimum' of '${fieldName}' increased from ${prevField.minimum} to ${nextField.minimum} in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.minimum`,
        });
      }
    }

    if (typeof nextField.maximum === "number") {
      if (typeof prevField.maximum !== "number") {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'maximum' of '${fieldName}' was added (${nextField.maximum}) in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.maximum`,
        });
      } else if (nextField.maximum < prevField.maximum) {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Constraint 'maximum' of '${fieldName}' decreased from ${prevField.maximum} to ${nextField.maximum} in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.maximum`,
        });
      }
    }

    if (typeof nextField.pattern === "string") {
      if (typeof prevField.pattern !== "string") {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Pattern constraint '${nextField.pattern}' was added to '${fieldName}' in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.pattern`,
        });
      } else if (nextField.pattern !== prevField.pattern) {
        changes.push({
          classification: "breaking",
          code: "INPUT_CONSTRAINT_TIGHTENED",
          message: `Pattern constraint of '${fieldName}' changed from '${prevField.pattern}' to '${nextField.pattern}' in tool '${toolName}'`,
          tool: toolName,
          path: `${path}.pattern`,
        });
      }
    }
  }

  // 6. Nested object properties
  if (
    isPlainObject(prevField.properties) ||
    isPlainObject(nextField.properties)
  ) {
    diffInputSchema(prevField, nextField, toolName, path, changes);
  }

  // 7. Array items
  if (isPlainObject(prevField.items) && isPlainObject(nextField.items)) {
    diffFieldSchema(
      prevField.items as JsonSchema,
      nextField.items as JsonSchema,
      toolName,
      `${path}.items`,
      `${fieldName}[]`,
      changes,
      direction,
    );
  }
}

function diffResponses(
  prevResponses: readonly CompiledResponse[],
  nextResponses: readonly CompiledResponse[],
  toolName: string,
  changes: ContractChange[],
): void {
  const prevMap = new Map(prevResponses.map((r) => [r.status, r]));
  const nextMap = new Map(nextResponses.map((r) => [r.status, r]));

  for (const [status, prevResp] of prevMap) {
    const nextResp = nextMap.get(status);
    if (!nextResp || !prevResp.schema || !nextResp.schema) continue;

    const prevRequired = new Set(
      Array.isArray(prevResp.schema.required)
        ? (prevResp.schema.required as string[])
        : [],
    );
    const nextRequired = new Set(
      Array.isArray(nextResp.schema.required)
        ? (nextResp.schema.required as string[])
        : [],
    );

    const prevProps = isPlainObject(prevResp.schema.properties)
      ? (prevResp.schema.properties as Record<string, JsonSchema>)
      : {};
    const nextProps = isPlainObject(nextResp.schema.properties)
      ? (nextResp.schema.properties as Record<string, JsonSchema>)
      : {};

    for (const field of prevRequired) {
      if (!nextRequired.has(field) || !Object.hasOwn(nextProps, field)) {
        changes.push({
          classification: "breaking",
          code: "RESPONSE_FIELD_REMOVED",
          message: `Required response field '${field}' was removed from response (${status}) in tool '${toolName}'`,
          tool: toolName,
          path: `responses[${status}].schema.properties.${field}`,
        });
      }
    }

    for (const [field, prevFieldSchema] of Object.entries(prevProps)) {
      const nextFieldSchema = nextProps[field];
      if (!nextFieldSchema) continue;
      diffFieldSchema(
        prevFieldSchema,
        nextFieldSchema,
        toolName,
        `responses[${status}].schema.properties.${field}`,
        field,
        changes,
        "response",
      );
    }
  }
}
