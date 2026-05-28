// Tests for @loom/preview-ios — focuses on the PreviewPlugin contract.
// Cache + fallback paths are covered via the public render() method.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import plugin, { _resetSimScreenshotCache } from '../index';

const PNG_MAGIC = '89504e47';

function fakeCtx(repoRoot: string) {
  return {
    task: { id: 1, title: 't', description: null, status: 'in_progress' },
    repoRoot,
  };
}

describe('@loom/preview-ios PreviewPlugin', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ios-test-'));
    _resetSimScreenshotCache();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('match() returns true when repoRoot/ios exists', () => {
    fs.mkdirSync(path.join(tmp, 'ios'));
    expect(plugin.match(fakeCtx(tmp))).toBe(true);
  });

  it('match() returns false when no ios/ dir', () => {
    expect(plugin.match(fakeCtx(tmp))).toBe(false);
  });

  it('render() returns a PNG buffer with image/png content type', async () => {
    const result = await plugin.render(fakeCtx(tmp));
    expect(result.contentType).toBe('image/png');
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body.slice(0, 4).toString('hex')).toBe(PNG_MAGIC);
    expect(['live', 'cache', 'fallback']).toContain(result.headers?.['X-Source']);
  });

  it('exports a name field', () => {
    expect(plugin.name).toBe('preview-ios');
  });
});
