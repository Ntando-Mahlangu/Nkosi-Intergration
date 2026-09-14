import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock };
    },
  };
});

// Imported after the mock so classifyReplyWithClaude/classifyReply pick up the mocked SDK.
const { classifyReply, classifyReplyWithClaude } = await import("../src/reply/classify.js");

function mockTextResponse(text: string) {
  createMock.mockResolvedValueOnce({ content: [{ type: "text", text }] });
}

describe("classifyReplyWithClaude (mocked Anthropic SDK)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("parses a valid classification word from the model's response", async () => {
    mockTextResponse("interested");
    await expect(classifyReplyWithClaude("sure, tell me more")).resolves.toBe("interested");
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-5");
  });

  it("is case/whitespace tolerant", async () => {
    mockTextResponse("  NOT_INTERESTED  ");
    await expect(classifyReplyWithClaude("nah")).resolves.toBe("not_interested");
  });

  it("falls back to keyword classification when the model returns an unrecognized word", async () => {
    mockTextResponse("banana");
    await expect(classifyReplyWithClaude("yes please, sounds good")).resolves.toBe("interested");
  });
});

describe("classifyReply with LLM enhancement enabled", () => {
  const originalFlag = process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION;

  beforeEach(() => {
    createMock.mockReset();
    process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION = "true";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION;
    else process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION = originalFlag;
  });

  it("uses the LLM result for an ambiguous reply", async () => {
    mockTextResponse("question");
    await expect(classifyReply("hmm what did you have in mind")).resolves.toBe("question");
  });

  it("falls back to the keyword result if the API call throws", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));
    await expect(classifyReply("yes please")).resolves.toBe("interested");
  });

  it("still never calls the API for an explicit stop", async () => {
    await expect(classifyReply("STOP")).resolves.toBe("stop");
    expect(createMock).not.toHaveBeenCalled();
  });
});
