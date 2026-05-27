// Tests for the plan.ts AI Project Breakdown helper.
// Mocks global fetch so no real Anthropic API call happens.

import { MissingApiKeyError, planFromIdea } from '../plan';

function mockFetch(responseBody: unknown, opts: { status?: number } = {}): typeof fetch {
  return jest.fn(async () => ({
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  })) as unknown as typeof fetch;
}

describe('planFromIdea', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  const validResponse = {
    content: [{
      type: 'text',
      text: JSON.stringify({
        project: 'nugget-expo',
        branchName: 'main',
        description: 'add dark mode',
        userStories: [
          {
            id: 'US-PLAN-A',
            title: 'Add theme toggle',
            description: 'add a button',
            acceptanceCriteria: ['button visible', 'jest test', 'Typecheck clean'],
            priority: 1,
            passes: false,
            notes: '',
          },
          {
            id: 'US-PLAN-B',
            title: 'Persist preference',
            description: 'localStorage',
            acceptanceCriteria: ['reload preserves', 'jest test', 'Typecheck clean'],
            priority: 2,
            passes: false,
            notes: '',
          },
        ],
      }),
    }],
  };

  it('returns a normalized PRD with at least 1 story', async () => {
    const prd = await planFromIdea('add dark mode', { fetchImpl: mockFetch(validResponse) });
    expect(prd.project).toBe('nugget-expo');
    expect(prd.branchName).toBe('main');
    expect(prd.userStories).toHaveLength(2);
    expect(prd.userStories[0].id).toBe('US-PLAN-A');
    expect(prd.userStories[0].passes).toBe(false);
    expect(prd.userStories[1].acceptanceCriteria).toContain('Typecheck clean');
  });

  it('throws MissingApiKeyError when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(planFromIdea('x', { fetchImpl: mockFetch(validResponse) })).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it('rejects empty idea', async () => {
    await expect(planFromIdea('', { fetchImpl: mockFetch(validResponse) })).rejects.toThrow(/non-empty/);
    await expect(planFromIdea('   ', { fetchImpl: mockFetch(validResponse) })).rejects.toThrow(/non-empty/);
  });

  it('rejects Anthropic API error status', async () => {
    await expect(
      planFromIdea('x', { fetchImpl: mockFetch({ error: 'rate limit' }, { status: 429 }) }),
    ).rejects.toThrow(/Anthropic API error: 429/);
  });

  it('handles model wrapping response in markdown fences', async () => {
    const fenced = {
      content: [{
        type: 'text',
        text: '```json\n' + JSON.stringify({
          project: 'x', branchName: 'main', description: 'd',
          userStories: [{ id: 'A', title: 't', description: 'd', acceptanceCriteria: ['c'], priority: 1, passes: false, notes: '' }],
        }) + '\n```',
      }],
    };
    const prd = await planFromIdea('x', { fetchImpl: mockFetch(fenced) });
    expect(prd.userStories).toHaveLength(1);
  });

  it('throws on unparseable response', async () => {
    const garbage = { content: [{ type: 'text', text: 'this is not JSON at all' }] };
    await expect(
      planFromIdea('x', { fetchImpl: mockFetch(garbage) }),
    ).rejects.toThrow(/failed to parse model response/);
  });

  it('throws on empty content array', async () => {
    await expect(
      planFromIdea('x', { fetchImpl: mockFetch({ content: [] }) }),
    ).rejects.toThrow(/empty content/);
  });

  it('throws when userStories is missing', async () => {
    const noStories = { content: [{ type: 'text', text: '{"project":"x","branchName":"main","description":"d"}' }] };
    await expect(
      planFromIdea('x', { fetchImpl: mockFetch(noStories) }),
    ).rejects.toThrow(/userStories is not an array/);
  });

  it('throws when userStories array is empty', async () => {
    const empty = { content: [{ type: 'text', text: '{"project":"x","branchName":"main","description":"d","userStories":[]}' }] };
    await expect(
      planFromIdea('x', { fetchImpl: mockFetch(empty) }),
    ).rejects.toThrow(/no valid stories/);
  });

  it('fills missing story ids with idPrefix-LETTER', async () => {
    const noIds = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          project: 'x', branchName: 'main', description: 'd',
          userStories: [
            { title: 'a', description: 'd', acceptanceCriteria: ['c'], priority: 1, passes: false },
            { title: 'b', description: 'd', acceptanceCriteria: ['c'], priority: 2, passes: false },
          ],
        }),
      }],
    };
    const prd = await planFromIdea('x', { fetchImpl: mockFetch(noIds), idPrefix: 'US-FOO' });
    expect(prd.userStories[0].id).toBe('US-FOO-A');
    expect(prd.userStories[1].id).toBe('US-FOO-B');
  });
});
