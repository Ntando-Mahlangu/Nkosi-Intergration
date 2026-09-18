import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { paginate, parsePageParams } from "../src/pagination.js";

function buildApp() {
  const app = express();
  app.get("/items", (req, res) => {
    const items = ["a", "b", "c", "d", "e"];
    res.json(paginate(items, parsePageParams(req)));
  });
  return app;
}

describe("parsePageParams / paginate", () => {
  it("returns every item unchanged when no query params are given (default, unpaginated)", async () => {
    const res = await request(buildApp()).get("/items");
    expect(res.body).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("slices by limit and offset", async () => {
    const res = await request(buildApp()).get("/items").query({ limit: 2, offset: 1 });
    expect(res.body).toEqual(["b", "c"]);
  });

  it("limit alone (offset defaults to 0) returns the first N items", async () => {
    const res = await request(buildApp()).get("/items").query({ limit: 3 });
    expect(res.body).toEqual(["a", "b", "c"]);
  });

  it("offset alone (no limit) returns everything from that offset to the end", async () => {
    const res = await request(buildApp()).get("/items").query({ offset: 3 });
    expect(res.body).toEqual(["d", "e"]);
  });

  it("limit=0 returns an empty page, not the entire unpaginated list", async () => {
    // Regression test: parsePageParams used to require limitRaw > 0, so
    // limit=0 fell into the same "invalid" bucket as NaN/negative and
    // collapsed to `undefined` ("no limit"). Combined with an offset > 0,
    // paginate()'s early-return guard (limit === undefined && offset === 0)
    // doesn't fire, so items.slice(offset, undefined) returned everything
    // from that offset onward instead of []  — a real semantic surprise for
    // a caller intentionally using limit=0 (e.g. to cheaply read just
    // X-Total-Count without paying for the body).
    const res = await request(buildApp()).get("/items").query({ limit: 0, offset: 2 });
    expect(res.body).toEqual([]);
  });

  it("limit=0 with no offset also returns an empty page, not the full list", async () => {
    const res = await request(buildApp()).get("/items").query({ limit: 0 });
    expect(res.body).toEqual([]);
  });

  it("a negative or non-numeric limit falls back to unpaginated (existing lenient behavior, unchanged)", async () => {
    const negative = await request(buildApp()).get("/items").query({ limit: -5 });
    expect(negative.body).toEqual(["a", "b", "c", "d", "e"]);

    const garbage = await request(buildApp()).get("/items").query({ limit: "not-a-number" });
    expect(garbage.body).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a negative or non-numeric offset falls back to 0 (existing lenient behavior, unchanged)", async () => {
    const res = await request(buildApp()).get("/items").query({ limit: 2, offset: -1 });
    expect(res.body).toEqual(["a", "b"]);
  });

  it("limit= (present but blank) is treated as omitted, not as limit=0", async () => {
    // Regression test: Number("") is 0, not NaN — so a blank ?limit= value
    // (e.g. a cleared numeric form field serialized as an empty string)
    // would otherwise be indistinguishable from an explicit limit=0 and
    // silently return [] instead of "no pagination" for a param that isn't
    // really requesting zero items.
    const res = await request(buildApp()).get("/items?limit=&offset=2");
    expect(res.body).toEqual(["c", "d", "e"]);
  });
});
