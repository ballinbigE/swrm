// swrm/lib/prd_md_render.ts — render a parsed PRD into human-readable
// markdown. Pure function (no IO), so it's trivially unit-testable and
// reusable both for the prd-<slug>.md file write and any future preview UI.
//
// Companion to src/plan.ts (the Prd shape) — kept here rather than in plan.ts
// so plan.ts stays focused on the Anthropic call. No new npm deps per
// [[feedback_minimize_dependencies]]: hand-rolled string building.

import type { Prd } from '../plan';

/**
 * Render a PRD as markdown.
 *
 * Layout:
 *   # <title>                       (first story title, else prd.project)
 *   **Tech stack:** <tech_stack>    (only when (prd as any).tech_stack is set)
 *
 *   <prd.description>
 *
 *   ## Stories
 *   ### <id> — <title>
 *   <story.description>
 *   - [ ] <acceptance criterion>
 *   ...
 *
 * `tech_stack` is read off the Prd via `(prd as any)` because the canonical
 * Prd type in src/plan.ts does not (yet) declare it. Treating it as an
 * optional field keeps this renderer forward-compatible without forcing a
 * type change in plan.ts (owned by the planner).
 */
export function renderPrdMd(prd: Prd): string {
  const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
  const title = stories[0]?.title?.trim() || prd.project || 'PRD';

  const lines: string[] = [];
  lines.push(`# ${title}`);

  const techStack = (prd as { tech_stack?: unknown }).tech_stack;
  if (typeof techStack === 'string' && techStack.trim().length > 0) {
    lines.push('');
    lines.push(`**Tech stack:** ${techStack.trim()}`);
  }

  if (prd.description && prd.description.trim().length > 0) {
    lines.push('');
    lines.push(prd.description.trim());
  }

  lines.push('');
  lines.push('## Stories');

  for (const story of stories) {
    lines.push('');
    lines.push(`### ${story.id} — ${story.title}`);
    if (story.description && story.description.trim().length > 0) {
      lines.push('');
      lines.push(story.description.trim());
    }
    const criteria = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];
    if (criteria.length > 0) {
      lines.push('');
      for (const c of criteria) {
        lines.push(`- [ ] ${c}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
