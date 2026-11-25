import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

type R = { type: string; title: string; url: string | null; snippet: string };

describe("global search", () => {
  it("validates query length", async () => {
    const t = await setup();
    const a = await t.as("lerato");
    await a.get("/api/search?q=a").expect(400);
    await a.get(`/api/search?q=${"x".repeat(201)}`).expect(400);
  });

  it("covers multiple entity types with snippets and urls", async () => {
    const t = await setup();
    const r = (await (await t.as("lerato")).get("/api/search?q=pilot").expect(200)).body;
    const types = new Set((r.results as R[]).map((x) => x.type));
    for (const ty of ["task", "meeting", "milestone", "project"]) expect(types.has(ty)).toBe(true);
    const sup = (await (await t.as("lerato")).get("/api/search?q=supplier").expect(200)).body.results as R[];
    expect(sup.find((x) => x.type === "procedure")?.url).toMatch(/^\/knowledge\//);
    const people = (await (await t.as("lerato")).get("/api/search?q=naledi&types=person").expect(200)).body.results as R[];
    expect(people[0].title).toBe("Naledi Mokoena");
    expect(JSON.stringify(people)).not.toContain("@");
  });

  it("ranks title matches above body matches", async () => {
    const t = await setup();
    const r = (await (await t.as("lerato")).get("/api/search?q=call%20report&types=knowledge,procedure").expect(200)).body.results as R[];
    expect(r[0].title).toBe("How to prepare a call report");
  });

  it("never returns others' personal tasks, confidential meetings, restricted projects or management knowledge", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const q = async (s: string) => ((await lerato.get(`/api/search?q=${encodeURIComponent(s)}`).expect(200)).body.results as R[]).map((x) => x.title).join("|");
    expect(await q("Q-plan")).not.toContain("Q-plan"); // Naledi's personal task
    expect(await q("Management meeting")).not.toContain("Management meeting"); // confidential, not participant
    expect(await q("retreat")).not.toMatch(/Leadership Retreat|retreat venues/i); // restricted project + its tasks
    expect(await q("funding scenarios")).not.toContain("funding scenarios");
    // But owners do see their own
    const naledi = await t.as("naledi");
    const nq = ((await naledi.get("/api/search?q=Q-plan").expect(200)).body.results as R[]).map((x) => x.title).join("|");
    expect(nq).toContain("Q-plan");
  });

  it("makes published Fakawe reports searchable to all staff", async () => {
    const t = await setup();
    const r = (await (await t.as("pieter")).get("/api/search?q=Fakawe%20digest&types=report").expect(200)).body.results as R[];
    expect(r.length).toBe(1);
  });
});

describe("knowledge assistant", () => {
  it("without AI returns rule-based ranked permitted sources", async () => {
    const t = await setup();
    const r = (await (await t.as("pieter")).post("/api/assistant/ask", { question: "Where can I find the supplier onboarding process?" }).expect(200)).body;
    expect(r.engine).toBe("rules");
    expect(r.answer).toBeNull();
    expect(r.results[0].title).toBe("How to onboard a supplier");
    expect(r.note).toMatch(/not configured/);
  });

  it("never draws sources the user cannot access", async () => {
    const t = await setup();
    const pieter = (await (await t.as("pieter")).post("/api/assistant/ask", { question: "funding scenarios" }).expect(200)).body;
    expect(JSON.stringify(pieter)).not.toContain("funding scenarios (restricted)");
    expect(pieter.insufficient).toBe(true);
    const naledi = (await (await t.as("naledi")).post("/api/assistant/ask", { question: "funding scenarios" }).expect(200)).body;
    expect(naledi.results.map((x: { title: string }) => x.title)).toContain("Management: funding scenarios (restricted)");
  });

  it("validates question", async () => {
    const t = await setup();
    await (await t.as("pieter")).post("/api/assistant/ask", { question: "x" }).expect(400);
  });
});
