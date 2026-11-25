import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ruleBasedMeeting, extractDeadline, analyseMeeting, answerFromSources, draftFromFacts } from "../server/ai/service";
import { setup } from "./helpers";

const people = [{ id: "u1", name: "Lerato Khumalo" }, { id: "u2", name: "Sipho Dlamini" }];

describe("rule-based meeting extraction", () => {
  it("extracts explicit actions, decisions, risks and owners — and nothing else", () => {
    const a = ruleBasedMeeting({
      title: "Test", date: "2026-11-25", participants: people,
      notes: [
        "Discussion:",
        "- We talked about the venue",
        "Decision: Use the online platform",
        "Action: Lerato to send the invite by Friday",
        "Sipho will confirm the budget by 10 December",
        "Risk: Partner may not sign in time",
        "Maybe we could try a podcast one day",
        "What about translation?",
      ].join("\n"),
    });
    expect(a.decisions.map((d) => d.title)).toEqual(["Use the online platform"]);
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0]).toMatchObject({ owner_name: "Lerato Khumalo", due_date: "2026-11-27" });
    expect(a.actions[1]).toMatchObject({ owner_name: "Sipho Dlamini", due_date: "2026-12-10" });
    expect(a.risks[0].kind).toBe("risk");
    expect(a.follow_up_questions).toEqual(["What about translation?"]);
    // speculation is not turned into a task
    expect(a.actions.some((x) => /podcast/i.test(x.title))).toBe(false);
  });

  it("never invents owners or deadlines", () => {
    const a = ruleBasedMeeting({ title: "T", date: "2026-11-25", participants: people, notes: "Action: Prepare the agenda" });
    expect(a.actions[0].owner_name).toBe("");
    expect(a.actions[0].due_date).toBe("");
  });

  it("parses explicit deadline formats only", () => {
    expect(extractDeadline("send by 2026-12-01", "2026-11-25")?.date).toBe("2026-12-01");
    expect(extractDeadline("due 3 January", "2026-11-25")?.date).toBe("2027-01-03");
    expect(extractDeadline("by next Monday", "2026-11-25")?.date).toBe("2026-12-07");
    expect(extractDeadline("soon-ish", "2026-11-25")).toBeNull();
  });
});

describe("Claude integration (against a local mock of the Messages API)", () => {
  let server: http.Server | null = null;
  afterEach(() => server?.close());

  async function mock(reply: (body: Record<string, unknown>) => Record<string, unknown>) {
    const seen: Record<string, unknown>[] = [];
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        seen.push(body);
        const msg = { id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 }, ...reply(body) };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const content = msg.content as { type: string; text: string }[];
          const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
          ev("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null } });
          content.forEach((b, i) => {
            ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
            ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
            ev("content_block_stop", { type: "content_block_stop", index: i });
          });
          ev("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
          ev("message_stop", { type: "message_stop" });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(msg));
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return seen;
  }

  it("sends structured-output requests and validates the reply", async () => {
    const analysis = { summary: "S", key_topics: ["a"], decisions: [], actions: [{ title: "Send invite", detail: "", owner_name: "Lerato Khumalo", due_date: "", due_date_basis: "", evidence: "Lerato to send invite", confidence: "high" }], risks: [], follow_up_questions: [], project_update: "", knowledge_items: [] };
    const seen = await mock(() => ({ content: [{ type: "text", text: JSON.stringify(analysis) }] }));
    const t = await setup({ seed: false, env: { ANTHROPIC_API_KEY: "test-key", AI_MODEL: "claude-opus-5-5" } });
    const out = await analyseMeeting({ db: t.db, config: t.config }, null, { title: "T", date: "2026-11-25", participants: people, notes: "Lerato to send invite" });
    expect(out.engine).toBe("anthropic:claude-opus-5-5");
    expect(out.analysis.actions[0].title).toBe("Send invite");
    const req = seen[0] as { model: string; output_config: { format: { type: string; schema: { required: string[]; additionalProperties: boolean } } } };
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema.additionalProperties).toBe(false);
    expect(req.output_config.format.schema.required).toContain("actions");
    expect(t.db.get("SELECT engine, ok FROM ai_usage")).toMatchObject({ engine: "anthropic:claude-opus-5-5", ok: 1 });
  });

  it("falls back to the labelled rule engine when the model output is invalid", async () => {
    await mock(() => ({ content: [{ type: "text", text: "not json" }] }));
    const t = await setup({ seed: false, env: { ANTHROPIC_API_KEY: "test-key" } });
    const out = await analyseMeeting({ db: t.db, config: t.config }, null, { title: "T", date: "2026-11-25", participants: people, notes: "Action: Lerato to send invite" });
    expect(out.engine).toBe("rules");
    expect(out.analysis.actions).toHaveLength(1);
  });

  it("knowledge answers only cite supplied source ids", async () => {
    await mock(() => ({ content: [{ type: "text", text: JSON.stringify({ answer: "See procedure.", cited_source_ids: ["kno_a", "kno_fake"], insufficient_information: false }) }] }));
    const t = await setup({ seed: false, env: { ANTHROPIC_API_KEY: "test-key" } });
    const r = await answerFromSources({ db: t.db, config: t.config }, null, "How?", [{ id: "kno_a", title: "A", category: "Procedures", summary: "s", body: "b", link: "/knowledge/kno_a" }]);
    expect(r?.cited).toEqual(["kno_a"]);
  });

  it("returns null (no fake draft) when AI is disabled by the admin setting", async () => {
    const t = await setup({ seed: false, env: { ANTHROPIC_API_KEY: "test-key" } });
    t.db.run("UPDATE settings SET value = 'false' WHERE key = 'ai.enabled'");
    expect(await draftFromFacts({ db: t.db, config: t.config }, null, "x", "Summarise", "facts")).toBeNull();
  });
});
