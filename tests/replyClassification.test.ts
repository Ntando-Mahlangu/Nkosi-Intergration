import { afterEach, describe, expect, it } from "vitest";
import { classifyReply, classifyReplyByKeyword } from "../src/reply/classify.js";

describe("classifyReplyByKeyword", () => {
  it("recognizes STOP-style opt-outs", () => {
    expect(classifyReplyByKeyword("STOP")).toBe("stop");
    expect(classifyReplyByKeyword("please unsubscribe me")).toBe("stop");
    expect(classifyReplyByKeyword("cancel")).toBe("stop");
  });

  it("recognizes questions", () => {
    expect(classifyReplyByKeyword("how much would that cost?")).toBe("question");
  });

  it("recognizes negative replies", () => {
    expect(classifyReplyByKeyword("no thanks, not interested")).toBe("not_interested");
  });

  it("recognizes positive replies", () => {
    expect(classifyReplyByKeyword("yes please, sounds good")).toBe("interested");
  });

  it("falls back to unknown for ambiguous text", () => {
    expect(classifyReplyByKeyword("ok")).toBe("unknown");
  });
});

describe("classifyReply", () => {
  const originalFlag = process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION;
    else process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION = originalFlag;
  });

  it("never calls the LLM path for an explicit stop, regardless of the LLM flag", async () => {
    process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION = "true";
    // No ANTHROPIC_API_KEY is set in the test environment; if classifyReply tried to call
    // the API for a "stop" message this would throw/hang instead of resolving immediately.
    await expect(classifyReply("STOP")).resolves.toBe("stop");
  });

  it("stays fully offline (keyword-only) when the LLM flag is unset", async () => {
    delete process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION;
    await expect(classifyReply("yes please")).resolves.toBe("interested");
    await expect(classifyReply("not interested")).resolves.toBe("not_interested");
  });
});
