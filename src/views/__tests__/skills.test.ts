import { renderSkillsHtml } from '../skills';
import type { Skill } from '../../skills/types';

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: 1,
  name: 'contact-listener',
  project: 'nugget-expo',
  type: 'agent',
  enabled: true,
  frequency: '@daily 07:00',
  side_effects: 'read-only',
  timeout: 600,
  agent: 'claude',
  needs_worktree: false,
  mcp: ['Gmail'],
  command: null,
  prompt_ref: null,
  on_findings: 'append',
  last_run: '2026-05-27T07:00:00Z',
  next_due: '2026-05-28T07:00:00Z',
  last_status: 'ok',
  file_path: '/x/contact.skill.md',
  body_hash: 'abc',
  updated_at: '2026-05-27T07:00:00Z',
  ...over,
});

describe('renderSkillsHtml (US-009)', () => {
  it('renders skill name, project, type, side-effects and status', () => {
    const html = renderSkillsHtml([skill()]);
    expect(html).toContain('contact-listener');
    expect(html).toContain('nugget-expo');
    expect(html).toContain('read-only');
    expect(html).toMatch(/status-ok|ok</);
    expect(html).toContain('@daily 07:00');
  });

  it('shows an empty state when there are no skills', () => {
    expect(renderSkillsHtml([])).toMatch(/no skills/i);
  });

  it('has a Run now control and an enable/pause toggle per skill', () => {
    const html = renderSkillsHtml([skill({ id: 42 })]);
    expect(html).toMatch(/data-skill-id="42"/);
    expect(html).toContain('Run now');
    expect(html).toMatch(/toggle|pause|enable/i);
  });

  it('renders a per-skill run-history detail with a Runs control', () => {
    const runs = new Map([
      [
        1,
        [
          {
            id: 9,
            status: 'ok',
            notes: 'scanned 3 inboxes',
            findings_count: 3,
            created_at: '2026-05-28T16:00:00Z',
            finished_at: '2026-05-28T16:00:30Z',
          },
        ],
      ],
    ]);
    const html = renderSkillsHtml([skill({ id: 1 })], runs);
    expect(html).toContain('Runs (1)');
    expect(html).toContain('id="runs-1"');
    expect(html).toContain('scanned 3 inboxes');
    expect(html).toMatch(/3 findings/);
  });

  it('shows "No runs yet" when a skill has no history', () => {
    const html = renderSkillsHtml([skill({ id: 1 })], new Map([[1, []]]));
    expect(html).toContain('Runs (0)');
    expect(html).toMatch(/no runs yet/i);
  });

  it('reflects paused state for a disabled skill', () => {
    const html = renderSkillsHtml([skill({ enabled: false })]);
    expect(html).toMatch(/paused|disabled/i);
  });

  it('includes topbar nav', () => {
    const html = renderSkillsHtml([]);
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/board"');
  });

  it('escapes skill name (XSS)', () => {
    const html = renderSkillsHtml([skill({ name: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('client JS posts to the run + toggle endpoints', () => {
    const html = renderSkillsHtml([skill()]);
    expect(html).toContain('/api/skills/');
    expect(html).toContain('/run');
  });
});
