/**
 * Unit tests for the prompt-based function-calling shim.
 * Pure string logic — no Claude CLI, no tokens.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolInstructions,
  parseToolCalls,
  TOOL_CALL_FENCE,
} from "./tools.js";
import { openaiToCli, messagesToPrompt } from "./openai-to-cli.js";
import type { OpenAITool } from "../types/openai.js";

const KANBAN_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "kanban_complete",
      description: "Mark the current task done.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: { name: "kanban_block", description: "Block the task." },
  },
];

describe("buildToolInstructions", () => {
  it("returns undefined when there are no tools", () => {
    assert.equal(buildToolInstructions(undefined, undefined), undefined);
    assert.equal(buildToolInstructions([], "auto"), undefined);
  });

  it("returns undefined for tool_choice 'none'", () => {
    assert.equal(buildToolInstructions(KANBAN_TOOLS, "none"), undefined);
  });

  it("describes every tool and the emission protocol", () => {
    const text = buildToolInstructions(KANBAN_TOOLS, "auto")!;
    assert.ok(text.includes("kanban_complete"));
    assert.ok(text.includes("kanban_block"));
    assert.ok(text.includes("Mark the current task done."));
    assert.ok(text.includes("```" + TOOL_CALL_FENCE));
    // JSON Schema for parameters is inlined
    assert.ok(text.includes('"summary"'));
    // Tool with no parameters is labeled
    assert.ok(text.includes("Parameters: none"));
  });

  it("adds a mandate for tool_choice 'required'", () => {
    const text = buildToolInstructions(KANBAN_TOOLS, "required")!;
    assert.ok(/MUST call at least one/.test(text));
  });

  it("names the forced tool for a specific tool_choice", () => {
    const text = buildToolInstructions(KANBAN_TOOLS, {
      type: "function",
      function: { name: "kanban_block" },
    })!;
    assert.ok(text.includes("MUST call the `kanban_block` tool"));
  });
});

describe("parseToolCalls", () => {
  it("returns plain content when there is no tool block", () => {
    const { content, toolCalls } = parseToolCalls("just a normal answer");
    assert.equal(content, "just a normal answer");
    assert.equal(toolCalls.length, 0);
  });

  it("extracts a single tool call and strips it from content", () => {
    const text =
      "Work is done.\n\n```tool_call\n" +
      '{"name": "kanban_complete", "arguments": {"summary": "fixed B1-B4"}}\n' +
      "```";
    const { content, toolCalls } = parseToolCalls(text);
    assert.equal(content, "Work is done.");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].type, "function");
    assert.equal(toolCalls[0].function.name, "kanban_complete");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      summary: "fixed B1-B4",
    });
    assert.ok(toolCalls[0].id.startsWith("call_"));
  });

  it("extracts multiple tool calls", () => {
    const text =
      "```tool_call\n{\"name\": \"a\", \"arguments\": {}}\n```\n" +
      "```tool_call\n{\"name\": \"b\", \"arguments\": {\"x\": 1}}\n```";
    const { toolCalls } = parseToolCalls(text);
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].function.name, "a");
    assert.equal(toolCalls[1].function.name, "b");
  });

  it("gives distinct ids to each call", () => {
    const text =
      "```tool_call\n{\"name\": \"a\", \"arguments\": {}}\n```\n" +
      "```tool_call\n{\"name\": \"a\", \"arguments\": {}}\n```";
    const { toolCalls } = parseToolCalls(text);
    assert.notEqual(toolCalls[0].id, toolCalls[1].id);
  });

  it("accepts a pre-stringified arguments field", () => {
    const text =
      '```tool_call\n{"name": "a", "arguments": "{\\"x\\":1}"}\n```';
    const { toolCalls } = parseToolCalls(text);
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { x: 1 });
  });

  it("defaults arguments to {} when omitted", () => {
    const { toolCalls } = parseToolCalls(
      '```tool_call\n{"name": "ping"}\n```'
    );
    assert.equal(toolCalls[0].function.arguments, "{}");
  });

  it("skips malformed blocks without throwing", () => {
    const text =
      "```tool_call\nnot json at all\n```\n" +
      '```tool_call\n{"name": "ok", "arguments": {}}\n```';
    const { toolCalls } = parseToolCalls(text);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].function.name, "ok");
  });

  it("skips blocks with no name", () => {
    const { toolCalls } = parseToolCalls(
      '```tool_call\n{"arguments": {}}\n```'
    );
    assert.equal(toolCalls.length, 0);
  });
});

describe("openaiToCli tool wiring", () => {
  it("attaches tool instructions when tools are present", () => {
    const input = openaiToCli({
      model: "opus",
      messages: [{ role: "user", content: "do it" }],
      tools: KANBAN_TOOLS,
    });
    assert.ok(input.toolInstructions);
    assert.ok(input.toolInstructions!.includes("kanban_complete"));
  });

  it("leaves tool instructions undefined without tools", () => {
    const input = openaiToCli({
      model: "opus",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(input.toolInstructions, undefined);
  });
});

describe("messagesToPrompt tool history", () => {
  it("renders assistant tool_calls and tool results back into the prompt", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: "finish the task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "kanban_complete",
              arguments: '{"summary":"done"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"ok": true}',
      },
    ]);
    assert.ok(prompt.includes("called tool kanban_complete"));
    assert.ok(prompt.includes('tool_call_id="call_1"'));
    assert.ok(prompt.includes('{"ok": true}'));
  });
});
