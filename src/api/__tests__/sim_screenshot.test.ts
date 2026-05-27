// Tests for sim_screenshot — focuses on the cache + fallback paths.
// The actual xcrun call is only reached when a simulator is booted; CI
// without a booted sim hits the fallback branch automatically.

import { getSimScreenshot, _resetSimScreenshotCache } from '../sim_screenshot';

describe('getSimScreenshot', () => {
  beforeEach(() => {
    _resetSimScreenshotCache();
  });

  it('returns a PNG buffer (live or fallback)', async () => {
    const { png, source } = await getSimScreenshot();
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(png.slice(0, 4).toString('hex')).toBe('89504e47');
    expect(['live', 'cache', 'fallback']).toContain(source);
  });

  it('serves from cache on repeated call within MIN_INTERVAL', async () => {
    const first = await getSimScreenshot({ now: 1_000_000 });
    const second = await getSimScreenshot({ now: 1_000_500 }); // +500ms
    if (first.source === 'live') {
      // Only assert cache hit if the first call actually populated cache.
      expect(second.source).toBe('cache');
      expect(second.png).toBe(first.png);
    }
  });

  it('refreshes after MIN_INTERVAL_MS elapses', async () => {
    const first = await getSimScreenshot({ now: 1_000_000 });
    const second = await getSimScreenshot({ now: 1_000_000 + 2000 }); // +2s
    // Either live (re-captured) or fallback (sim not booted) — never cache.
    expect(second.source).not.toBe('cache');
    // Sanity: both still produced PNG bytes.
    expect(first.png.length).toBeGreaterThan(0);
    expect(second.png.length).toBeGreaterThan(0);
  });
});
