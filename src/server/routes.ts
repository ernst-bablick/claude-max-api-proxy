/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, KNOWN_MODEL_IDS } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import { parseToolCalls } from "../adapter/tools.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliInit, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Structured request log line.
 *
 * Without this the server is silent on the happy path, so a request that hangs
 * (or dies to a service restart mid-stream) leaves no trace at all in the log.
 */
function logRequest(
  requestId: string,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const rest = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[req ${requestId}] ${event}${rest ? ` ${rest}` : ""}`);
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;
  const startedAt = Date.now();

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    logRequest(requestId, "start", {
      model: body.model,
      cli_model: cliInput.model,
      stream,
      messages: body.messages.length,
      prompt_chars: cliInput.prompt.length,
      session: cliInput.sessionId,
    });

    const outcome = stream
      ? await handleStreamingResponse(req, res, subprocess, cliInput, requestId)
      : await handleNonStreamingResponse(res, subprocess, cliInput, requestId);

    logRequest(requestId, "end", { outcome, ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);
    logRequest(requestId, "end", {
      outcome: "throw",
      ms: Date.now() - startedAt,
      error: JSON.stringify(message),
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<string> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<string>((resolve, reject) => {
    let isFirst = true;
    // Set from the CLI's init message; sub-agent turns can report a smaller
    // model, so assistant messages must not overwrite it.
    let mainModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;
    let toolCallIndex = 0;
    let inToolBlock = false;

    // When the request carries tools, the model may emit ```tool_call``` blocks
    // that must be parsed out of the FULL text and returned as `tool_calls`.
    // We can't stream token-by-token in that case (the sentinel would leak to
    // the client), so we buffer the whole reply and emit it at `result`.
    const bufferMode = !!cliInput.toolInstructions;
    let bufferedText = "";

    // A stuck request is otherwise invisible: the log shows "start" and then
    // silence forever. Tick until the stream finishes so long runs are visible.
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      logRequest(requestId, "running", {
        ms: Date.now() - startedAt,
        model: mainModel,
        emitted_text: hasEmittedText,
      });
    }, 60_000);
    heartbeat.unref?.();

    const finish = (outcome: string): void => {
      clearInterval(heartbeat);
      resolve(outcome);
    };

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
        finish("client_disconnect");
        return;
      }
      finish("closed");
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (bufferMode) {
        // Preserve the inter-block separator inside the buffer instead of
        // writing it to the wire.
        if (bufferedText) bufferedText += "\n\n";
        return;
      }
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: mainModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (!text) return;
      if (bufferMode) {
        // Hold everything back until `result`, then parse for tool calls.
        bufferedText += text;
        return;
      }
      if (!res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: mainModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: mainModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: mainModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    // The init message names the model this run was started with
    subprocess.on("init", (message: ClaudeCliInit) => {
      if (message.model) mainModel = message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        const usage = result.usage
          ? {
              prompt_tokens: result.usage.input_tokens || 0,
              completion_tokens: result.usage.output_tokens || 0,
              total_tokens:
                (result.usage.input_tokens || 0) +
                (result.usage.output_tokens || 0),
            }
          : undefined;

        if (bufferMode) {
          // Parse the buffered reply for tool-call blocks and emit either a
          // tool_calls delta (finish_reason: tool_calls) or the plain text.
          const { content, toolCalls } = parseToolCalls(bufferedText);
          if (toolCalls.length > 0) {
            const toolChunk = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: mainModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: toolCalls.map((tc, i) => ({
                      index: i,
                      id: tc.id,
                      type: "function" as const,
                      function: {
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                      },
                    })),
                  },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
          } else if (content) {
            const contentChunk = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: mainModel,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
          }

          const doneChunk = createDoneChunk(requestId, mainModel);
          if (toolCalls.length > 0) {
            doneChunk.choices[0].finish_reason = "tool_calls";
          }
          if (usage) doneChunk.usage = usage;
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        } else {
          // Send final done chunk with finish_reason and usage data
          const doneChunk = createDoneChunk(requestId, mainModel);
          if (usage) doneChunk.usage = usage;
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish("result");
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      finish("subprocess_error");
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish(isComplete ? "closed" : `exit_${code}`);
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      toolInstructions: cliInput.toolInstructions,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      clearInterval(heartbeat);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<string> {
  const bufferMode = !!cliInput.toolInstructions;

  return new Promise<string>((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    let mainModel = "";

    subprocess.on("init", (message: ClaudeCliInit) => {
      if (message.model) mainModel = message.model;
    });
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve("subprocess_error");
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        const { content, toolCalls } = bufferMode
          ? parseToolCalls(finalResult.result)
          : { content: finalResult.result, toolCalls: [] as OpenAIToolCall[] };
        res.json(
          cliResultToOpenai(finalResult, requestId, mainModel, toolCalls, content)
        );
        resolve("result");
        return;
      }
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve(`exit_${code}`);
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        toolInstructions: cliInput.toolInstructions,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve("start_error");
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: KNOWN_MODEL_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
