export {
  JsonNavigationError,
  JsonNavigationLimitError,
  JsonPathSyntaxError,
  DEFAULT_MAX_DEPTH,
  MAX_ALLOWED_DEPTH,
  DEFAULT_MAX_VISITED_NODES,
  DEFAULT_MAX_ARRAY_ITEMS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DANGEROUS_KEYS,
  NavigationBudget,
  type NavigationLimits,
} from "./limits.js";

export {
  inspectShape,
  type JsonType,
  type ShapeSummary,
  type InspectShapeOptions,
} from "./shape.js";

export {
  parseJsonPath,
  selectPath,
  type PathSegment,
  type CompiledPath,
} from "./path.js";

export {
  paginate,
  type PaginationOptions,
  type PaginatedResult,
} from "./paginate.js";

export {
  filterData,
  type FilterOp,
  type SimplePredicate,
  type LogicalFilter,
  type FilterExpression,
} from "./filter.js";

export { createJsonNavigationTools } from "./tools.js";
