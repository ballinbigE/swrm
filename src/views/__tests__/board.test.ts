import { renderBoardHtml } from '../board';

interface Row {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  attempt_count: number;
  open_comment_count: number;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  title: 'wire MCP',
  status: 'backlog',
  priority: null,
  attempt_count: 0,
  open_comment_count: 0,
  ...over,
});

describe('renderBoardHtml', () => {
  it('renders all five status columns', () => {
    const html = renderBoardHtml([]);
    for (const label of ['Backlog', 'Todo', 'In Progress', 'Review', 'Done']) {
      expect(html).toContain(`>${label}</h2>`);
    }
  });

  it('cards are draggable with data-task-id + data-status', () => {
    const html = renderBoardHtml([row({ id: 42, status: 'todo' })]);
    expect(html).toMatch(/draggable="true"[^>]*data-task-id="42"/);
    expect(html).toContain('data-status="todo"');
  });

  it('places a card in its status column + counts it', () => {
    const html = renderBoardHtml([row({ id: 7, status: 'in_progress', title: 'hot task' })]);
    // the in_progress column header count should be 1
    expect(html).toMatch(/In Progress<\/h2><span class="n">1<\/span>/);
    expect(html).toContain('hot task');
  });

  it('renders priority + attempt + open-comment badges', () => {
    const html = renderBoardHtml([row({ priority: 'high', attempt_count: 2, open_comment_count: 3 })]);
    expect(html).toContain('badge pri-high');
    expect(html).toContain('2 att');
    expect(html).toContain('3 open');
  });

  it('escapes task title (XSS)', () => {
    const html = renderBoardHtml([row({ title: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links each card to its workspace', () => {
    const html = renderBoardHtml([row({ id: 99 })]);
    expect(html).toContain('/workspace/99');
  });

  it('shows empty-state in columns with no cards', () => {
    const html = renderBoardHtml([]);
    expect(html).toContain('— empty —');
  });

  it('client JS confirms before spawning on In Progress drop', () => {
    const html = renderBoardHtml([]);
    expect(html).toContain("toStatus === 'in_progress'");
    expect(html).toContain('Spawn an agent attempt');
    expect(html).toContain('auto_run: true');
  });

  it('disables drag on touch devices', () => {
    const html = renderBoardHtml([]);
    expect(html).toContain("matchMedia('(hover: none)')");
    expect(html).toContain('Drag-to-execute is disabled on touch');
  });
});
