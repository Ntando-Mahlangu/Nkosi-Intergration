import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type { ReplyClassification } from "../types.js";

// Escapes a keyword for use inside a RegExp — every keyword here is a fixed
// string literal, not user input, but this stays correct if that changes.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches a keyword only on a word boundary, not as a substring of a larger
// word — plain String.includes() would match "cancel" inside "cancellation"
// or "stop" inside "nonstop", misclassifying a routine question or an
// unrelated word as an opt-out/negative signal. \b doesn't work at the edges
// of a multi-word keyword like "opt out" (no word-boundary before/after the
// inner space), so this checks the character immediately outside the match
// instead of relying on \b there. Precompiled once per keyword (rather than
// rebuilding a RegExp on every classifyReplyByKeyword call, which runs once
// per inbound SMS/WhatsApp reply) since none of these keyword lists change
// at runtime.
function keywordPattern(keyword: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(keyword)}(?![a-z0-9])`);
}

const STOP_KEYWORDS = ["stop", "unsubscribe", "cancel", "quit", "remove me", "opt out", "optout"].map(keywordPattern);
const NEGATIVE_KEYWORDS = ["not interested", "no thanks", "not now", "already sorted", "nah"].map(keywordPattern);
const POSITIVE_KEYWORDS = ["yes", "yeah", "yep", "sure", "interested", "please", "book", "sounds good"].map(
  keywordPattern
);

function normalize(body: string): string {
  return body.trim().toLowerCase();
}

/**
 * Deterministic, offline keyword classifier. This is the safety baseline:
 * STOP/opt-out detection must never depend on a network call, and this
 * function is always consulted first (see classifyReply) so an LLM outage
 * or slow response can never delay honoring an opt-out.
 */
export function classifyReplyByKeyword(body: string): ReplyClassification {
  const text = normalize(body);
  if (STOP_KEYWORDS.some((re) => re.test(text))) return "stop";
  // Negative keywords take priority over the bare "?" catch-all below: a
  // reply like "not interested, but is there a cheaper option?" must stop
  // follow-ups (see SYSTEM_PROMPT.md's "stop on any negative signal" rule),
  // not get treated as a "question" just because it also contains one.
  if (NEGATIVE_KEYWORDS.some((re) => re.test(text))) return "not_interested";
  if (text.includes("?")) return "question";
  if (POSITIVE_KEYWORDS.some((re) => re.test(text))) return "interested";
  return "unknown";
}

const VALID_CLASSIFICATIONS: ReplyClassification[] = ["stop", "interested", "not_interested", "question", "unknown"];

/**
 * Optional LLM-based enhancement for replies the keyword classifier can't
 * confidently place. Never called for anything the keyword pass already
 * recognized as "stop" (see classifyReply). Falls back to the keyword
 * result on any API error so a provider outage never blocks the workflow.
 */
export async function classifyReplyWithClaude(body: string): Promise<ReplyClassification> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content:
          `Classify this SMS/WhatsApp reply from a sales lead as exactly one of: ` +
          `stop, interested, not_interested, question, unknown. ` +
          `Reply with only that single word, nothing else.\n\nReply: "${body}"`,
      },
    ],
  });

  const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
  const word = textBlock?.text.trim().toLowerCase();
  return (VALID_CLASSIFICATIONS as string[]).includes(word ?? "")
    ? (word as ReplyClassification)
    : classifyReplyByKeyword(body);
}

/**
 * Main entry point used by the inbound webhooks. Keyword-based by default
 * (fast, free, offline); optionally enhanced with an LLM pass for anything
 * ambiguous, gated behind LEADRECOVERY_USE_LLM_CLASSIFICATION=true so tests
 * and environments without an Anthropic API key stay fully offline.
 */
export async function classifyReply(body: string): Promise<ReplyClassification> {
  const keywordResult = classifyReplyByKeyword(body);
  if (keywordResult === "stop") return "stop"; // never let an enhancement override an explicit opt-out

  if (process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION !== "true") {
    return keywordResult;
  }

  try {
    return await classifyReplyWithClaude(body);
  } catch (err) {
    logger.warn("llm_classification_failed", { error: (err as Error).message });
    return keywordResult;
  }
}
