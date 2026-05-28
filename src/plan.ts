// scripts/pm/plan.ts — US-VCP-A AI Project Breakdown.
//
// Take a free-text "idea" + return a Ralph-loop-ready PRD JSON with
// 3-12 user stories. Hand-rolls the Anthropic Messages API over global
// fetch — no @anthropic-ai/sdk dep, per [[feedback_minimize_dependencies]].
//
// Model default: claude-sonnet-4-6 per [[feedback_default_sonnet_for_text]].
// Override via PM_PLAN_MODEL env.
//
// Cost: each call = one Anthropic request. Per-user-action only (not
// recurring), so no weekly-digest noise per [[feedback_always_call_out_costs]].

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PrdStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: false;
  notes: string;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  userStories: PrdStory[];
}

export interface PlanFromIdeaOpts {
  /** Override model (default: env PM_PLAN_MODEL or claude-sonnet-4-6). */
  model?: string;
  /** Override project name (default: 'loom'). */
  project?: string;
  /** Override branch name (default: 'main'). */
  branchName?: string;
  /** Story id prefix; default 'US-PLAN-A', 'US-PLAN-B', etc. */
  idPrefix?: string;
  /**
   * Injectable fetch for tests. Defaults to global fetch (Node 20+).
   */
  fetchImpl?: typeof fetch;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY env var is not set');
  }
}

const SYSTEM_PROMPT = `You are a senior software engineer breaking a feature idea into a Ralph-loop-executable PRD.

Output ONLY valid JSON matching this exact shape — no prose, no markdown fences:

{
  "project": "<string>",
  "branchName": "main",
  "description": "<one-paragraph summary of the feature + execution guidance>",
  "userStories": [
    {
      "id": "<US-PLAN-A | US-PLAN-B | ...>",
      "title": "<short imperative phrase>",
      "description": "<2-4 sentence scope>",
      "acceptanceCriteria": [
        "<each item should be testable + concrete>",
        "<typically 4-8 items per story>",
        "Add jest test for X",
        "All existing tests still green",
        "Typecheck clean"
      ],
      "priority": <1-based integer, smallest first>,
      "passes": false,
      "notes": ""
    }
  ]
}

Rules:
- 3 to 12 stories. Smaller is better. Each story should ship as ONE small commit.
- Each story's acceptanceCriteria MUST include at least: one concrete code/file requirement, one test requirement, "Typecheck clean".
- Priority is sequential (1, 2, 3, ...). Stories with lower priority should ship first.
- The description field at top level should give global execution guidance ("Use execFile array form", "No new npm deps", etc).
- Stories should compose: earlier stories' deliverables can be assumed available in later stories.
- NO markdown in the response. NO prose before or after the JSON. Just JSON.`;

const ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function normalizeStories(stories: unknown, idPrefix: string): PrdStory[] {
  if (!Array.isArray(stories)) throw new Error('userStories is not an array');
  const out: PrdStory[] = [];
  for (let i = 0; i < stories.length; i += 1) {
    const s = stories[i] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') continue;
    const letter = ID_LETTERS[i] ?? String(i + 1);
    out.push({
      id: typeof s.id === 'string' && s.id.length > 0 ? s.id : `${idPrefix}-${letter}`,
      title: typeof s.title === 'string' ? s.title : '',
      description: typeof s.description === 'string' ? s.description : '',
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
        ? (s.acceptanceCriteria as unknown[]).filter((c) => typeof c === 'string') as string[]
        : [],
      priority: typeof s.priority === 'number' ? s.priority : i + 1,
      passes: false,
      notes: typeof s.notes === 'string' ? s.notes : '',
    });
  }
  if (out.length === 0) throw new Error('no valid stories returned by model');
  return out;
}

function extractJson(text: string): unknown {
  // Strip markdown fences if the model wraps despite instructions.
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return JSON.parse(s);
}

export async function planFromIdea(idea: string, opts: PlanFromIdeaOpts = {}): Promise<Prd> {
  if (typeof idea !== 'string' || idea.trim().length === 0) {
    throw new Error('idea (non-empty string) is required');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const model = opts.model ?? process.env.PM_PLAN_MODEL ?? 'claude-sonnet-4-6';
  const project = opts.project ?? 'loom';
  const branchName = opts.branchName ?? 'main';
  const idPrefix = opts.idPrefix ?? 'US-PLAN';

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Idea:\n\n${idea}` }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).find((c) => c.type === 'text')?.text ?? '';
  if (text.length === 0) throw new Error('empty content from Anthropic');

  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    throw new Error(`failed to parse model response as JSON: ${(err as Error).message}\nFirst 200 chars: ${text.slice(0, 200)}`);
  }
  const p = parsed as Record<string, unknown>;
  const userStories = normalizeStories(p.userStories, idPrefix);

  return {
    project: typeof p.project === 'string' ? p.project : project,
    branchName: typeof p.branchName === 'string' ? p.branchName : branchName,
    description: typeof p.description === 'string' ? p.description : `Plan generated from idea: ${idea.slice(0, 200)}`,
    userStories,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

// CLI: `loom plan --idea "..." --out prd-foo.json`
export async function runPlanCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const idea = arg('idea') ?? (arg('idea-file') ? fs.readFileSync(arg('idea-file') as string, 'utf8') : '');
  const out = arg('out');
  if (!idea) {
    // eslint-disable-next-line no-console
    console.error('usage: loom plan --idea "<text>" [--out prd-<slug>.json]');
    process.exit(1);
  }
  try {
    const prd = await planFromIdea(idea);
    const filename = out ?? `prd-${slugify(prd.userStories[0]?.title ?? 'plan')}.json`;
    fs.writeFileSync(path.resolve(filename), JSON.stringify(prd, null, 2) + '\n');
    // eslint-disable-next-line no-console
    console.log(`[loom plan] ${prd.userStories.length} stories → ${filename}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[loom plan] ${(err as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void runPlanCli();
}
