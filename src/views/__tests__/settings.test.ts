import { renderSettingsHtml } from '../settings';

const board = (over: Partial<{ id: number; slug: string; name: string; color: string; workflow: string }> = {}) => ({
  id: 1, slug: 'personal', name: 'Personal', color: '#d97757',
  workflow: '["backlog","todo","in_progress","review","done"]', ...over,
});

describe('renderSettingsHtml', () => {
  it('renders a card per board with color input + swatch', () => {
    const html = renderSettingsHtml([board(), board({ id: 2, slug: 'work', name: 'Work', color: '#4ade80' })]);
    expect(html).toContain('data-board-id="1"');
    expect(html).toContain('data-board-id="2"');
    expect(html).toContain('type="color"');
    expect(html).toContain('#4ade80');
  });

  it('renders workflow chips with checked state matching the stored workflow', () => {
    const html = renderSettingsHtml([board({ workflow: '["todo","done"]' })]);
    // The 'todo' chip should carry a checked input; 'blocked' should exist unchecked.
    expect(html).toContain('class="wf-chip on" data-status="todo"');
    expect(html).toContain('class="wf-chip off" data-status="blocked"');
    expect(html).toContain('data-status="blocked"');
  });

  it('escapes board name (XSS)', () => {
    const html = renderSettingsHtml([board({ name: '<script>x</script>' })]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('PATCHes /api/boards/:id/prefs on save (client JS present)', () => {
    const html = renderSettingsHtml([board()]);
    expect(html).toContain("/api/boards/' + id + '/prefs'");
    expect(html).toContain("method: 'PATCH'");
  });

  it('shows empty copy when no boards', () => {
    expect(renderSettingsHtml([])).toContain('No boards yet');
  });
});
