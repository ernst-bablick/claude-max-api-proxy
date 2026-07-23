/**
 * Prompt-based function-calling shim.
 *
 * The Claude Code CLI (`claude --print`) has no native way to *emit* an
 * OpenAI-style `tool_calls` object for the host to execute — it only runs its
 * own internal tools (Read/Bash/Edit). Clients like Hermes, however, define
 * tools (e.g. `kanban_complete`) that THEY execute, and expect the model to
 * return a `tool_calls` object plus `finish_reason: "tool_calls"`.
 *
 * We bridge that gap entirely in the text channel:
 *   1. `buildToolInstructions` renders the client's `tools` into the system
 *      prompt with a strict emission protocol.
 *   2. Claude does its real work with native tools, then emits a fenced
 *      ```tool_call``` JSON block instead of trying to run the host tool.
 *   3. `parseToolCalls` extracts those blocks from the final text and turns
 *      them into OpenAI `tool_calls`.
 *
 * This is the only design that survives the stateless `--print` + HTTP
 * boundary: an MCP server would make `claude` block awaiting a return value
 * that can only arrive in a separate follow-up HTTP request.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "../types/openai.js";

/** Fence tag that marks a tool-call block in the model's output. */
export const TOOL_CALL_FENCE = "tool_call";

/**
 * Build the system-prompt section that teaches the model how to call
 * host-provided tools. Returns `undefined` when there is nothing to inject
 * (no tools, or `tool_choice: "none"`).
 */
export function buildToolInstructions(
  tools: OpenAITool[] | undefined,
  toolChoice: OpenAIToolChoice | undefined
): string | undefined {
  if (!tools || tools.length === 0) return undefined;
  if (toolChoice === "none") return undefined;

  const lines: string[] = [
    "## Host-Provided Tools (function calling)",
    "",
    "The host application has provided the callable tools listed below. They",
    "ARE available to you — the HOST executes them, not you. Use your normal",
    "Claude Code tools (Read, Bash, Edit, ...) to do the actual work, then call",
    "a host tool to report a result or take an action only the host can perform.",
    "",
    "IMPORTANT: These host tools are real and callable. Do NOT say a tool is",
    "unavailable, and do NOT substitute Bash or any other Claude Code tool for",
    "them — the tool-name mapping guidance above does NOT apply to these host",
    "tools. The ONLY way to invoke one is to emit the fenced block described",
    "below; that is what reaches the host.",
    "",
    "To call a host tool, output a fenced code block tagged `" +
      TOOL_CALL_FENCE +
      "` containing a single JSON object with `name` and `arguments`:",
    "",
    "```" + TOOL_CALL_FENCE,
    '{"name": "<tool_name>", "arguments": { ... }}',
    "```",
    "",
    "Rules:",
    "- Put the block(s) at the very end of your reply. A short sentence of",
    "  context before them is fine.",
    '- `arguments` must be a JSON object matching the tool\'s parameters. Use',
    "  `{}` if the tool takes no arguments.",
    "- To call multiple tools, emit multiple `" + TOOL_CALL_FENCE + "` blocks.",
    "- Do NOT try to run these tools via Bash or any other mechanism — only the",
    "  fenced block reaches the host.",
    "- Only call tools that appear in the list below.",
  ];

  const forced = forcedToolName(toolChoice);
  if (toolChoice === "required") {
    lines.push(
      "- You MUST call at least one of these tools in this reply."
    );
  } else if (forced) {
    lines.push(
      `- You MUST call the \`${forced}\` tool in this reply.`
    );
  }

  lines.push("", "Available tools:");
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    const fn = tool.function;
    lines.push("", `### ${fn.name}`);
    if (fn.description) lines.push(fn.description);
    if (fn.parameters) {
      lines.push(
        "Parameters (JSON Schema): " + JSON.stringify(fn.parameters)
      );
    } else {
      lines.push("Parameters: none");
    }
  }

  return lines.join("\n");
}

function forcedToolName(
  toolChoice: OpenAIToolChoice | undefined
): string | undefined {
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function"
  ) {
    return toolChoice.function?.name;
  }
  return undefined;
}

// Capture the JSON body of every ```tool_call ... ``` fenced block.
const TOOL_CALL_BLOCK = /```tool_call[^\n]*\n([\s\S]*?)```/g;

export interface ParsedToolCalls {
  /** The assistant text with all tool-call blocks removed (may be empty). */
  content: string;
  toolCalls: OpenAIToolCall[];
}

/**
 * Extract tool-call blocks from a model response.
 *
 * Lenient by design: malformed blocks are skipped rather than throwing, and
 * whatever prose surrounds the blocks is returned as `content`.
 */
export function parseToolCalls(text: string): ParsedToolCalls {
  const toolCalls: OpenAIToolCall[] = [];
  if (!text) return { content: "", toolCalls };

  TOOL_CALL_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_BLOCK.exec(text)) !== null) {
    const parsed = parseOneBlock(match[1]);
    if (parsed) toolCalls.push(parsed);
  }

  const content = text.replace(TOOL_CALL_BLOCK, "").trim();
  return { content, toolCalls };
}

function parseOneBlock(body: string): OpenAIToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) return null;

  // `arguments` may be an object (normal) or a pre-stringified JSON string.
  const rawArgs = record.arguments ?? {};
  const argString =
    typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);

  return {
    id: `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: argString },
  };
}
