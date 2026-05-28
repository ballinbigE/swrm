import { renderBoardHtml, parseLabels } from '../board';

interface Row {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  attempt_count: number;
  open_comment_count: number;
  labels_raw?: string | null;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  title: 'wire MCP',
  status: 'backlog',
  priority: null,
  attempt_count: 0,
  open_comment_count: 0,
  labels_raw: null,
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

  it('renders a colored label chip per label so features are visible', () => {
    const html = renderBoardHtml([row({ labels_raw: 'feature:#60a5fa|bug:#ef5350' })]);
    expect(html).toContain('label-chip');
    expect(html).toContain('feature');
    expect(html).toContain('bug');
    // chip uses the label's own color
    expect(html).toMatch(/label-chip[^>]*#60a5fa/);
  });

  it('applies a priority stripe class to the card so priority reads at a glance', () => {
    const html = renderBoardHtml([row({ priority: 'high' })]);
    expect(html).toMatch(/class="card card-pri-high"/);
  });
});

describe('parseLabels', () => {
  it('parses pipe-joined name:color pairs', () => {
    expect(parseLabels('feature:#60a5fa|bug:#ef5350')).toEqual([
      { name: 'feature', color: '#60a5fa' },
      { name: 'bug', color: '#ef5350' },
    ]);
  });

  it('returns [] for null/empty', () => {
    expect(parseLabels(null)).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
  });

  it('tolerates a label name containing a colon by splitting on the last one', () => {
    expect(parseLabels('build:ci:#34d399')).toEqual([{ name: 'build:ci', color: '#34d399' }]);
  });

  it('skips malformed fragments with no color', () => {
    expect(parseLabels('feature|bug:#ef5350')).toEqual([{ name: 'bug', color: '#ef5350' }]);
  });
});
