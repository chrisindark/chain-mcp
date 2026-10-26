import {
  type NavigationLimits,
  NavigationBudget,
  DANGEROUS_KEYS,
  JsonNavigationError,
} from "./limits.js";

export interface PaginationOptions extends NavigationLimits {
  /** 0-based offset. Defaults to 0. */
  offset?: number;
  /** Maximum number of items to return in the page. Defaults to 50. */
  limit?: number;
  /** 1-based page number (alternative to offset). If provided, calculates offset = (page - 1) * pageSize. */
  page?: number;
  /** Page size when using page-based pagination. Defaults to limit or 50. */
  pageSize?: number;
}

export interface PaginatedResult<T = unknown> {
  items: T[];
  totalItems: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  page?: number;
  totalPages?: number;
}

export function paginate<T = unknown>(
  data: unknown,
  options?: PaginationOptions,
): PaginatedResult<T> {
  const budget = new NavigationBudget(options);

  if (data === null || typeof data !== "object") {
    throw new JsonNavigationError("Paginate requires an array or object");
  }

  const rawLimit = options?.limit ?? options?.pageSize ?? 50;
  const effectiveLimit = Math.min(Math.max(1, rawLimit), budget.maxArrayItems);

  let effectiveOffset = 0;
  let pageNumber: number | undefined;

  if (options?.page !== undefined && options.page > 0) {
    pageNumber = Math.floor(options.page);
    effectiveOffset = (pageNumber - 1) * effectiveLimit;
  } else if (options?.offset !== undefined && options.offset >= 0) {
    effectiveOffset = Math.floor(options.offset);
    pageNumber = Math.floor(effectiveOffset / effectiveLimit) + 1;
  } else {
    effectiveOffset = 0;
    pageNumber = 1;
  }

  let items: T[] = [];
  let totalItems = 0;

  if (Array.isArray(data)) {
    totalItems = data.length;
    if (effectiveOffset < totalItems) {
      const sliceEnd = Math.min(effectiveOffset + effectiveLimit, totalItems);
      items = data.slice(effectiveOffset, sliceEnd) as T[];
    }
  } else {
    // Plain object: paginate key-value pairs
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => !DANGEROUS_KEYS.has(k));
    totalItems = keys.length;
    if (effectiveOffset < totalItems) {
      const sliceEnd = Math.min(effectiveOffset + effectiveLimit, totalItems);
      const selectedKeys = keys.slice(effectiveOffset, sliceEnd);
      items = selectedKeys.map((k) => ({ key: k, value: record[k] }) as T);
    }
  }

  const hasMore = effectiveOffset + items.length < totalItems;
  const totalPages = Math.ceil(totalItems / effectiveLimit);

  const result: PaginatedResult<T> = {
    items,
    totalItems,
    offset: effectiveOffset,
    limit: effectiveLimit,
    hasMore,
    ...(pageNumber !== undefined ? { page: pageNumber, totalPages } : {}),
  };

  budget.assertResultBytes(result);
  return result;
}
