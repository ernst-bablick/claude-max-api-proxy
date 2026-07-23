/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";
import { buildToolInstructions } from "./tools.js";

export type ClaudeModel = "fable" | "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  /**
   * System-prompt section describing host-provided tools, when the request
   * carries `tools`. Its presence also flips the proxy into buffered
   * tool-emission mode. Undefined when no tools are in play.
   */
  toolInstructions?: string;
}

export const DEFAULT_MODEL: ClaudeModel = "opus";

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-fable-5": "fable",
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-8": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "fable": "fable",
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/**
 * Full model IDs this proxy advertises (bare aliases excluded).
 * Single source of truth for GET /v1/models.
 */
export const KNOWN_MODEL_IDS = Object.keys(MODEL_MAP).filter((id) =>
  id.startsWith("claude-")
);

/**
 * Extract Claude model alias from request model string.
 *
 * The CLI resolves bare aliases (`opus`, `sonnet`, `haiku`) to the current
 * version of each tier, so no version pinning happens here.
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Unknown model: fall back to the tier named in the string rather than
  // silently routing everything to opus.
  const tier = (["fable", "opus", "sonnet", "haiku"] as const).find((t) =>
    stripped.includes(t)
  );
  if (tier) {
    console.warn(
      `[ClaudeCodeCLI] Unknown model "${model}", routing to "${tier}"`
    );
    return tier;
  }

  console.warn(
    `[ClaudeCodeCLI] Unknown model "${model}", falling back to "${DEFAULT_MODEL}"`
  );
  return DEFAULT_MODEL;
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        // Strip OpenClaw tooling sections that conflict with Claude Code's native tools
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant": {
        // Previous assistant responses for context, including any host-tool
        // calls the model made on that turn (replayed so it keeps continuity
        // across the stateless --print boundary).
        const segments: string[] = [];
        if (text) segments.push(text);
        for (const call of msg.tool_calls ?? []) {
          segments.push(
            `[called tool ${call.function.name} with arguments ${call.function.arguments}]`
          );
        }
        parts.push(
          `<previous_response>\n${segments.join("\n")}\n</previous_response>\n`
        );
        break;
      }

      case "tool":
        // Result of a host-executed tool call, fed back to the model.
        parts.push(
          `<tool_result tool_call_id="${msg.tool_call_id ?? ""}">\n${text}\n</tool_result>\n`
        );
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    toolInstructions: buildToolInstructions(request.tools, request.tool_choice),
  };
}
