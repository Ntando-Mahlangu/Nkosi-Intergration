import type { Request } from "express";

export interface PageParams {
  limit?: number;
  offset: number;
}

/**
 * Optional ?limit=&offset= — omitted (the default) means "no pagination",
 * so existing callers see no behavior change. `limit=0` is a valid,
 * explicit request for zero items (e.g. a caller that only wants
 * X-Total-Count) and is kept as 0 here, not folded into the same
 * "missing/invalid" bucket as NaN/negative — paginate() below relies on
 * that distinction to return `[]` rather than the entire unpaginated list.
 * `limit=` (present but blank — e.g. a cleared numeric form field) is
 * treated the same as omitted, not as `limit=0`: `Number("")` is 0, not
 * NaN, so without this explicit check a blank value would silently become
 * an empty-page request instead of the "no pagination" a blanked-out field
 * actually means.
 */
export function parsePageParams(req: Request): PageParams {
  const limitParam = req.query.limit;
  const limitRaw = typeof limitParam === "string" && limitParam !== "" ? Number(limitParam) : NaN;
  const offsetRaw = Number(req.query.offset);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 0 ? limitRaw : undefined;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

export function paginate<T>(items: T[], { limit, offset }: PageParams): T[] {
  if (limit === undefined && offset === 0) return items; // default: unchanged behavior, no params given
  return items.slice(offset, limit === undefined ? undefined : offset + limit);
}
