/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIToolCall } from "../types/openai.js";
import { KNOWN_MODEL_IDS } from "./openai-to-cli.js";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  mainModel?: string,
  toolCalls?: OpenAIToolCall[],
  contentOverride?: string
): OpenAIChatResponse {
  const modelName = mainModel || pickMainModel(result.modelUsage);
  const hasToolCalls = !!(toolCalls && toolCalls.length > 0);

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: contentOverride ?? result.result,
  };

  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Pick the model that actually answered from the CLI's per-model usage map.
 *
 * The CLI charges side work (e.g. the system-prompt preflight) to a small
 * model, so `modelUsage` often holds several entries and insertion order does
 * not track the main model. The one that produced the most output tokens does.
 */
function pickMainModel(
  modelUsage: ClaudeCliResult["modelUsage"] | undefined
): string {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return "claude-sonnet-4";

  return entries.reduce((best, entry) =>
    entry[1].outputTokens > best[1].outputTokens ? entry : best
  )[0];
}

/**
 * Normalize Claude model names reported by the CLI.
 *
 * Strips dated snapshot suffixes but otherwise preserves the version the CLI
 * actually served, so callers see e.g. "claude-opus-4-8" rather than a
 * flattened tier name.
 *   "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
 *   "claude-opus-4-8"            -> "claude-opus-4-8"
 */
function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  const undated = model.replace(/-\d{8}$/, "");
  if (KNOWN_MODEL_IDS.includes(undated)) return undated;

  // Unrecognized (e.g. a model newer than this proxy): keep the CLI's own
  // name if it looks like a Claude id, otherwise fall back to the tier.
  if (undated.startsWith("claude-")) return undated;
  if (undated.includes("fable")) return "claude-fable-5";
  if (undated.includes("opus")) return "claude-opus-4";
  if (undated.includes("sonnet")) return "claude-sonnet-4";
  if (undated.includes("haiku")) return "claude-haiku-4";
  return undated;
}
