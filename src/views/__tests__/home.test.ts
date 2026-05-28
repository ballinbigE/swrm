import { renderHomeHtml } from '../home';

describe('renderHomeHtml', () => {
  it('renders the idea-input textarea and Generate button', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    expect(html).toContain('id="idea-input"');
    expect(html).toContain('Describe what you want to build…');
    expect(html).toContain('Generate &amp; Execute');
  });

  it('enables the textarea + button when hasApiKey is true', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    // the textarea tag carries no `disabled` attribute
    expect(html).toMatch(/<textarea id="idea-input"[^>]*><\/textarea>/);
    const textareaTag = html.slice(html.indexOf('<textarea id="idea-input"'), html.indexOf('</textarea>'));
    expect(textareaTag).not.toContain('disabled');
    expect(html).not.toContain('Set <code>ANTHROPIC_API_KEY</code>');
  });

  it('disables the textarea + shows the helper line when hasApiKey is false', () => {
    const html = renderHomeHtml({ hasApiKey: false });
    const textareaTag = html.slice(html.indexOf('<textarea id="idea-input"'), html.indexOf('</textarea>'));
    expect(textareaTag).toContain('disabled');
    expect(html).toContain('Set <code>ANTHROPIC_API_KEY</code> to use AI Breakdown');
    expect(html).toContain('or go to <a href="/tasks">Tasks</a> to start manually');
    // generate button is also disabled
    expect(html).toMatch(/id="generate-btn"[^>]*disabled/);
  });

  it('defaults hasApiKey to false when no opts passed', () => {
    const html = renderHomeHtml();
    expect(html).toContain('Set <code>ANTHROPIC_API_KEY</code> to use AI Breakdown');
  });

  it('includes nav links to /tasks and /board', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/board"');
  });

  it('wires the plan + execute endpoints in the inline script', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    expect(html).toContain("fetch('/api/plan'");
    expect(html).toContain("fetch('/api/plan/execute'");
    expect(html).toContain('auto_spawn: true');
    // redirect to the workspace of the first returned task
    expect(html).toContain("window.location.href = '/workspace/'");
  });

  it('handles 503 / 400 inline (no alert)', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    expect(html).toContain('r.status === 503');
    expect(html).toContain('r.status === 400');
    expect(html).not.toMatch(/\balert\(/);
  });

  it('is structurally well-formed HTML (no raw template holes)', () => {
    // The page takes no user input at render time, so XSS surface is the
    // static structure only. Assert the doctype + closing tags are intact
    // and the only `<script>` is the intentional inline one.
    const html = renderHomeHtml({ hasApiKey: true });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</body></html>')).toBe(true);
    expect(html).toContain('<title>Loom — describe what you want to build</title>');
    // exactly one opening <script> tag (the inline behaviour block)
    expect((html.match(/<script>/g) || []).length).toBe(1);
  });

  it('escapes client-side dynamic values through escText (textContent)', () => {
    const html = renderHomeHtml({ hasApiKey: true });
    // the runtime escaper exists and is used for story id/title/tech
    expect(html).toContain('function escText(s)');
    expect(html).toContain('d.textContent');
  });
});
