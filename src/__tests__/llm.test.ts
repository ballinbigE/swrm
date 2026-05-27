// US-023 tests — pluggable LLM driver.
// Mocks @anthropic-ai/sdk so the suite stays offline + zero-cost.

const mockMessagesCreate = jest.fn();

// `virtual: true` because @anthropic-ai/sdk lives in firebase/functions/, not
// the repo root — jest's root-context resolver can't see it here, but the
// driver only `require`s it lazily at call-time so the mock fully suffices.
jest.mock(
  '@anthropic-ai/sdk',
  () => {
    // The driver does `new Anthropic({ apiKey })` then `client.messages.create(...)`.
    // Return a class whose instances expose the mocked messages.create.
    return class MockAnthropic {
      public messages = { create: mockMessagesCreate };
      constructor(_opts: { apiKey: string }) {
        // no-op
      }
    };
  },
  { virtual: true },
);

import { chat, DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from '../llm';

describe('chat()', () => {
  const ORIGINAL_ENV = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key-xxx';
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV;
  });

  test('returns {reply, usage} from a successful call', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'hi rep' }],
      usage: { input_tokens: 11, output_tokens: 5 },
    });

    const out = await chat({
      messages: [{ role: 'user', content: 'say hi' }],
    });

    expect(out.reply).toBe('hi rep');
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 5 });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.model).toBe(DEFAULT_MODEL);
    expect(call.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(call.messages).toEqual([{ role: 'user', content: 'say hi' }]);
    // No system message provided → field omitted entirely.
    expect(call.system).toBeUndefined();
  });

  test('splits system message into the top-level `system` field', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 4, output_tokens: 1 },
    });

    await chat({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hello' },
      ],
    });

    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('You are terse.');
    expect(call.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('honors model + max_tokens overrides', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await chat({
      messages: [{ role: 'user', content: 'q' }],
      model: 'claude-haiku-4-5',
      max_tokens: 64,
    });

    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.max_tokens).toBe(64);
  });

  test('concatenates multi-block text content', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'part-one ' },
        { type: 'tool_use', id: 't1' }, // ignored — non-text
        { type: 'text', text: 'part-two' },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
    });

    const out = await chat({
      messages: [{ role: 'user', content: 'merge' }],
    });
    expect(out.reply).toBe('part-one part-two');
  });

  test('defaults usage to zeros when SDK omits the field', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      // no `usage` key at all
    });

    const out = await chat({
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('throws clearly when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY missing/);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test('throws when messages[] is empty', async () => {
    await expect(chat({ messages: [] })).rejects.toThrow(
      /at least one message/,
    );
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
