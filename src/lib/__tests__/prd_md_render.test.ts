// Tests for renderPrdMd — pure markdown rendering of a PRD.

import type { Prd } from '../../plan';
import { renderPrdMd } from '../prd_md_render';

function basePrd(): Prd {
  return {
    project: 'loom',
    branchName: 'main',
    description: 'A demo feature broken into stories.',
    userStories: [
      {
        id: 'US-PLAN-A',
        title: 'Add the widget',
        description: 'Wire up the widget component.',
        acceptanceCriteria: ['Render the widget', 'Add jest test for widget', 'Typecheck clean'],
        priority: 1,
        passes: false,
        notes: '',
      },
      {
        id: 'US-PLAN-B',
        title: 'Persist the widget',
        description: 'Save widget state to sqlite.',
        acceptanceCriteria: ['Insert row on save', 'Typecheck clean'],
        priority: 2,
        passes: false,
        notes: '',
      },
    ],
  };
}

describe('renderPrdMd', () => {
  it('uses the first story title as the H1 header', () => {
    const md = renderPrdMd(basePrd());
    expect(md.startsWith('# Add the widget\n')).toBe(true);
  });

  it('falls back to project name when there are no stories', () => {
    const prd = { ...basePrd(), userStories: [] };
    const md = renderPrdMd(prd);
    expect(md.startsWith('# loom\n')).toBe(true);
  });

  it('includes the top-level description', () => {
    const md = renderPrdMd(basePrd());
    expect(md).toContain('A demo feature broken into stories.');
  });

  it('renders a Stories section with one H3 per story', () => {
    const md = renderPrdMd(basePrd());
    expect(md).toContain('## Stories');
    expect(md).toContain('### US-PLAN-A — Add the widget');
    expect(md).toContain('### US-PLAN-B — Persist the widget');
  });

  it('renders acceptanceCriteria as an unchecked checklist', () => {
    const md = renderPrdMd(basePrd());
    expect(md).toContain('- [ ] Render the widget');
    expect(md).toContain('- [ ] Add jest test for widget');
    expect(md).toContain('- [ ] Typecheck clean');
    expect(md).toContain('- [ ] Insert row on save');
  });

  it('includes the per-story description text', () => {
    const md = renderPrdMd(basePrd());
    expect(md).toContain('Wire up the widget component.');
    expect(md).toContain('Save widget state to sqlite.');
  });

  it('emits the Tech stack line when tech_stack is set', () => {
    const prd = { ...basePrd(), tech_stack: 'Node 20 + TypeScript + better-sqlite3' } as Prd;
    const md = renderPrdMd(prd);
    expect(md).toContain('**Tech stack:** Node 20 + TypeScript + better-sqlite3');
  });

  it('omits the Tech stack line when tech_stack is absent', () => {
    const md = renderPrdMd(basePrd());
    expect(md).not.toContain('**Tech stack:**');
  });

  it('omits the Tech stack line when tech_stack is blank', () => {
    const prd = { ...basePrd(), tech_stack: '   ' } as Prd;
    const md = renderPrdMd(prd);
    expect(md).not.toContain('**Tech stack:**');
  });

  it('ends with a trailing newline', () => {
    const md = renderPrdMd(basePrd());
    expect(md.endsWith('\n')).toBe(true);
  });
});
