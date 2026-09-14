import type { Request } from "express";

export interface PageParams {
  limit?: number;
  offset: number;
}

/** Optional ?limit=&offset= — omitted (the default) means "no pagination", so existing callers see no behavior change. */
export function parsePageParams(req: Request): PageParams {
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

export function paginate<T>(items: T[], { limit, offset }: PageParams): T[] {
  if (limit === undefined && offset === 0) return items; // default: unchanged behavior, no params given
  return items.slice(offset, limit === undefined ? undefined : offset + limit);
}
