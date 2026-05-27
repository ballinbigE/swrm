// scripts/pm/llm.ts — pluggable LLM driver for the Personal AI PM System.
// Per US-023 of tasks/prd-personal-ai-pm-system.md (FR-12: all LLM calls go
// through one driver; default Claude API; key in env).
//
// Default driver wraps @anthropic-ai/sdk (already in repo via
// firebase/functions/) using ANTHROPIC_API_KEY. Pure function — no module-
// level singletons; the API key + SDK are read at call-time so tests can
// inject env + jest.mock the SDK without import-time side effects.
//
// Shape mirrors what the chat-panel route (US-021) and auto-categorize
// (US-023 AC), prioritize-backlog (US-024), bug-fix suggestions (US-026),
// perf-fix suggestions (US-029), and self-audit (US-036) will all call.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatResult {
  reply: string;
  usage: ChatUsage;
}

// Single source of truth for model + budget defaults on the PM chat path.
// Matches firebase/functions/src/lib/anthropic_client.ts MODEL_TEXT_GEN per
// feedback_default_sonnet_for_text.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_MAX_TOKENS = 1024;

// Anthropic's messages.create requires a single top-level `system` string +
// a messages[] of user/assistant turns only. Split a flat ChatMessage[]
// into that shape so callers can pass an intuitive linear transcript.
function splitSystemAndTurns(messages: ChatMessage[]): {
  system: string | undefined;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else turns.push({ role: m.role, content: m.content });
  }
  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    turns,
  };
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const max_tokens = opts.max_tokens ?? DEFAULT_MAX_TOKENS;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY missing — set the env var before calling chat()',
    );
  }
  if (!opts.messages || opts.messages.length === 0) {
    throw new Error('chat() requires at least one message');
  }

  // Dynamic require so jest.mock('@anthropic-ai/sdk') intercepts cleanly and
  // so this module can be imported in environments where the SDK isn't
  // installed yet (chat just throws "missing key" or fails at call-time
  // rather than at import-time).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AnthropicMod = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicMod.default ?? AnthropicMod;
  const client = new Anthropic({ apiKey });

  const { system, turns } = splitSystemAndTurns(opts.messages);
  const resp = await client.messages.create({
    model,
    max_tokens,
    ...(system ? { system } : {}),
    messages: turns,
  });

  return {
    reply: extractText(resp.content ?? []),
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };
}
