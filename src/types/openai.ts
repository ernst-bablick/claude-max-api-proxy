/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIContentBlock {
  type: "text" | "input_text";
  text: string;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentBlock[];
  /** Present on assistant turns that called host tools (replayed for context). */
  tool_calls?: OpenAIToolCall[];
  /** Present on `tool`-role messages: the id of the call this result answers. */
  tool_call_id?: string;
  /** Optional tool name on `tool`-role messages. */
  name?: string;
}

/** A function tool definition supplied by the client (OpenAI function-calling). */
export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDef;
}

/**
 * How the client wants tool selection handled.
 *   "auto"     — model decides (default when tools are present)
 *   "none"     — model must not call a tool
 *   "required" — model must call some tool
 *   {function} — model must call this specific tool
 */
export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: OpenAIToolCallChunk[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
