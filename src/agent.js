// Bridge between the Claude Agent SDK and the UI.
//
// The SDK is driven in "streaming input" mode: we hand query() an async
// generator that yields user messages whenever send() is called, so one
// long-lived query serves the whole conversation (and gives us interrupt(),
// setModel() and setPermissionMode()).
//
// Everything the SDK emits is normalised into flat events the UI can render
// without knowing anything about the SDK's message shapes.
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildPersona } from './persona.js';

// Tools listed in config.allowedTools never prompt. This is checked inside our
// own permission callback rather than handed to the SDK's `allowedTools`,
// because a bare name there auto-approves the tool *before* the callback runs —
// which would leave the UI unable to see, or ever override, those decisions.
// One definition of the counter shape, shared with the UI's initial state so
// the two can't drift apart and render NaN.
export const emptyTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
});

export function isPreApproved(config, toolName) {
  return (config.allowedTools ?? []).includes(toolName);
}

export class JarvisSession extends EventEmitter {
  #inbox = [];
  #notify = null;
  #closed = false;
  #query = null;

  constructor({ config, mcpServers = {}, canUseTool, resume }) {
    super();
    this.config = config;
    this.mcpServers = mcpServers;
    this.canUseTool = canUseTool;
    this.resume = resume;
    this.sessionId = null;
    this.busy = false;
    this.totals = emptyTotals();
  }

  // ── input side ────────────────────────────────────────────────────────────
  async *#input() {
    while (!this.#closed) {
      if (this.#inbox.length === 0) {
        await new Promise((resolve) => {
          this.#notify = resolve;
        });
        if (this.#closed) return;
      }
      yield this.#inbox.shift();
    }
  }

  send(text) {
    this.#inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    });
    this.busy = true;
    this.emit('event', { kind: 'submitted', text });
    this.#notify?.();
    this.#notify = null;
  }

  async interrupt() {
    if (!this.#query) return;
    try {
      await this.#query.interrupt();
      this.emit('event', { kind: 'note', text: 'interrupted' });
    } catch {
      // The CLI rejects interrupt() when no turn is in flight — not an error here.
    }
  }

  async setModel(model) {
    await this.#query?.setModel(model);
    this.config.model = model;
  }

  async setPermissionMode(mode) {
    await this.#query?.setPermissionMode(mode);
    this.config.permissionMode = mode;
  }

  close() {
    this.#closed = true;
    this.#notify?.();
    this.#notify = null;
  }

  // ── output side ───────────────────────────────────────────────────────────
  options() {
    const config = this.config;
    return {
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildPersona(config),
      },
      settingSources: config.settingSources,
      disallowedTools: config.disallowedTools,
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions',
      mcpServers: this.mcpServers,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      resume: this.resume,
      thinking: { type: 'adaptive', display: config.ui.showThinking ? 'summarized' : 'omitted' },
    };
  }

  start() {
    this.#query = query({ prompt: this.#input(), options: this.options() });
    this.#consume();
    return this;
  }

  async #consume() {
    try {
      for await (const message of this.#query) this.#handle(message);
    } catch (error) {
      if (!this.#closed) this.emit('event', { kind: 'error', text: String(error?.message ?? error) });
    } finally {
      this.busy = false;
      this.emit('event', { kind: 'closed' });
    }
  }

  #handle(message) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.emit('event', {
            kind: 'init',
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            mcpServers: message.mcp_servers,
          });
        }
        return;

      // Token-level deltas, used only for the live "typing" area. The complete
      // assistant message below is what actually lands in the transcript.
      case 'stream_event': {
        const event = message.event;
        if (event.type !== 'content_block_delta') return;
        if (event.delta?.type === 'text_delta') {
          this.emit('event', { kind: 'delta', text: event.delta.text });
        } else if (event.delta?.type === 'thinking_delta') {
          this.emit('event', { kind: 'thinking-delta', text: event.delta.thinking ?? '' });
        }
        return;
      }

      case 'assistant': {
        if (message.parent_tool_use_id) return; // subagent chatter stays out of the log
        const text = [];
        for (const block of message.message.content ?? []) {
          if (block.type === 'text') text.push(block.text);
          else if (block.type === 'thinking' && block.thinking) {
            this.emit('event', { kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.emit('event', {
              kind: 'tool-start',
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            });
          }
        }
        if (text.length) this.emit('event', { kind: 'assistant', text: text.join('\n').trim() });
        return;
      }

      case 'user': {
        if (message.parent_tool_use_id) return;
        const content = message.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.emit('event', {
            kind: 'tool-end',
            id: block.tool_use_id,
            isError: Boolean(block.is_error),
            preview: previewToolResult(block.content),
          });
        }
        return;
      }

      case 'result': {
        this.busy = false;
        this.totals.inputTokens += message.usage?.input_tokens ?? 0;
        this.totals.outputTokens += message.usage?.output_tokens ?? 0;
        // Most of the spend on a first turn is writing the system prompt into
        // the cache, so counting only input/output badly understates the run.
        this.totals.cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0;
        this.totals.cacheWriteTokens += message.usage?.cache_creation_input_tokens ?? 0;
        this.totals.turns += message.num_turns ?? 0;
        this.emit('event', {
          kind: 'result',
          isError: message.is_error,
          subtype: message.subtype,
          text: message.subtype === 'success' ? message.result : (message.result ?? ''),
          durationMs: message.duration_ms,
          totals: { ...this.totals },
        });
        return;
      }

      default:
        return;
    }
  }
}

function previewToolResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
