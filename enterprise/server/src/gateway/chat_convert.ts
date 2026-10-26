import { Buffer } from "node:buffer";
import { readUsage, type TokenUsage, ZERO_USAGE } from "./usage.ts";

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Converts a Codex Responses API request body to an OpenAI Chat Completions payload.
 */
export function convertResponsesToChatRequest(
  body: unknown,
  model: string,
): Record<string, unknown> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const messages: ChatMessage[] = [];

  // 1. Instructions -> system message
  if (typeof b.instructions === "string" && b.instructions.trim()) {
    messages.push({
      role: "system",
      content: b.instructions.trim(),
    });
  }

  // 2. Parse input items
  if (typeof b.input === "string" && b.input.trim()) {
    messages.push({ role: "user", content: b.input.trim() });
  } else if (Array.isArray(b.input)) {
    for (const item of b.input) {
      if (typeof item === "string" && item.trim()) {
        messages.push({ role: "user", content: item.trim() });
      } else if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const role =
          typeof obj.role === "string"
            ? obj.role === "developer"
              ? "system"
              : obj.role
            : "user";

        let content = "";
        if (typeof obj.content === "string") {
          content = obj.content;
        } else if (Array.isArray(obj.content)) {
          const parts: string[] = [];
          for (const part of obj.content) {
            if (typeof part === "object" && part !== null) {
              const p = part as Record<string, unknown>;
              if (typeof p.text === "string") {
                parts.push(p.text);
              } else if (typeof p.input_text === "string") {
                parts.push(p.input_text);
              }
            } else if (typeof part === "string") {
              parts.push(part);
            }
          }
          content = parts.join("\n");
        }

        if (content) {
          messages.push({ role, content });
        }
      }
    }
  }

  // Fallback if no messages were parsed
  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const isStream = b.stream !== false;
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: isStream,
    ...(isStream ? { stream_options: { include_usage: true } } : {}),
  };

  if (typeof b.temperature === "number") payload.temperature = b.temperature;
  if (typeof b.top_p === "number") payload.top_p = b.top_p;
  if (typeof b.max_output_tokens === "number") {
    payload.max_tokens = b.max_output_tokens;
  } else if (typeof b.max_tokens === "number") {
    payload.max_tokens = b.max_tokens;
  }

  return payload;
}

/**
 * Transforms incoming SSE from OpenAI Chat Completions into OpenAI Responses API SSE.
 */
export class ChatToResponsesTransformer {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private createdEmitted = false;
  private responseId =
    `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private accumulatedText = "";
  private completedEmitted = false;

  usage: TokenUsage = { ...ZERO_USAGE };

  push(chunk: Uint8Array): Uint8Array[] {
    const text = this.decoder.decode(chunk, { stream: true });
    return this.processText(text);
  }

  end(): Uint8Array[] {
    const text = this.decoder.decode();
    const out = this.processText(text);
    if (this.pending.trim()) {
      out.push(...this.processLine(this.pending.trim()));
      this.pending = "";
    }
    if (!this.completedEmitted) {
      out.push(Buffer.from(this.buildCompletedEvent()));
      this.completedEmitted = true;
    }
    return out;
  }

  private processText(text: string): Uint8Array[] {
    if (!text) return [];
    const buf = this.pending + text;
    const lines = buf.split(/\r\n|\r|\n/);
    // Last element is either empty (if ended with newline) or incomplete line
    this.pending = lines.pop() ?? "";

    const out: Uint8Array[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        out.push(...this.processLine(trimmed));
      }
    }
    return out;
  }

  private processLine(line: string): Uint8Array[] {
    if (!line.startsWith("data:")) return [];
    const dataStr = line.slice(5).trim();
    if (!dataStr) return [];

    if (dataStr === "[DONE]") {
      if (!this.completedEmitted) {
        this.completedEmitted = true;
        return [Buffer.from(this.buildCompletedEvent())];
      }
      return [];
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return [];
    }

    const out: Uint8Array[] = [];

    // 1. Emit created event on first chunk
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      this.usage.model = parsed.model.trim();
    }
    if (!this.createdEmitted) {
      this.createdEmitted = true;
      if (typeof parsed.id === "string") {
        this.responseId = `resp_${parsed.id.replace(/^chatcmpl-/, "")}`;
      }
      const createdEvent =
        `event: response.created\n` +
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: this.responseId,
            status: "in_progress",
          },
        })}\n\n`;
      out.push(Buffer.from(createdEvent));
    }

    // 2. Extract usage if present
    if (typeof parsed.usage === "object" && parsed.usage !== null) {
      const usage = readUsage(parsed.usage, parsed.model ?? this.usage.model);
      if (usage) {
        const raw = parsed.usage as Record<string, unknown>;
        this.usage = {
          ...usage,
          inputTokens:
            typeof (raw.prompt_tokens ?? raw.input_tokens) === "number"
              ? usage.inputTokens
              : this.usage.inputTokens,
          outputTokens:
            typeof (raw.completion_tokens ?? raw.output_tokens) === "number"
              ? usage.outputTokens
              : this.usage.outputTokens,
        };
      }
    }

    // 3. Extract text delta
    const choices = parsed.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0] as Record<string, unknown>;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string" && delta.content) {
        this.accumulatedText += delta.content;
        const deltaEvent =
          `event: response.output_text.delta\n` +
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: delta.content,
          })}\n\n`;
        out.push(Buffer.from(deltaEvent));
      }

      // Check finish reason
      if (
        choice.finish_reason &&
        choice.finish_reason !== null &&
        !this.completedEmitted
      ) {
        this.completedEmitted = true;
        out.push(Buffer.from(this.buildCompletedEvent()));
      }
    }

    return out;
  }

  private buildCompletedEvent(): string {
    // If upstream did not provide tokens, estimate roughly
    if (this.usage.outputTokens === 0 && this.accumulatedText.length > 0) {
      this.usage.outputTokens = Math.max(
        1,
        Math.ceil(this.accumulatedText.length / 4),
      );
    }

    return (
      `event: response.completed\n` +
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: this.responseId,
          ...(this.usage.model ? { model: this.usage.model } : {}),
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: this.accumulatedText,
                },
              ],
            },
          ],
          usage: {
            input_tokens: this.usage.inputTokens,
            input_tokens_details: {
              cached_tokens: this.usage.cachedTokens,
              cache_write_tokens: this.usage.cacheCreationTokens,
            },
            output_tokens: this.usage.outputTokens,
            total_tokens: this.usage.inputTokens + this.usage.outputTokens,
          },
        },
      })}\n\n`
    );
  }
}

/**
 * Converts non-streaming Chat Completions JSON to Responses API JSON.
 */
export function convertChatJsonToResponsesJson(
  chatJson: Record<string, unknown>,
): Record<string, unknown> {
  const choices = Array.isArray(chatJson.choices) ? chatJson.choices : [];
  const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
  const msg = (firstChoice.message ?? {}) as Record<string, unknown>;
  const content = typeof msg.content === "string" ? msg.content : "";

  const usage = readUsage(chatJson.usage, chatJson.model) ?? ZERO_USAGE;
  const { inputTokens, outputTokens, cachedTokens, cacheCreationTokens } =
    usage;

  const id =
    typeof chatJson.id === "string"
      ? `resp_${chatJson.id.replace(/^chatcmpl-/, "")}`
      : `resp_${Date.now()}`;

  return {
    id,
    ...(usage.model ? { model: usage.model } : {}),
    object: "response",
    status: "completed",
    output: [
      {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: content,
          },
        ],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: {
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheCreationTokens,
      },
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
