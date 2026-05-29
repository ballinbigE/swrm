import { appVersion, WHATS_NEW } from '../version';

describe('appVersion', () => {
  it('returns a non-empty semver string from package.json', () => {
    const v = appVersion();
    expect(v).toBeTruthy();
    // Semver shape: digits.digits.digits (with optional pre-release suffix)
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('matches the version in package.json directly', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    expect(appVersion()).toBe(pkg.version);
  });
});

describe('WHATS_NEW', () => {
  it('has exactly 4 notes', () => {
    expect(WHATS_NEW.notes).toHaveLength(4);
  });

  it('version is 0.2.0', () => {
    expect(WHATS_NEW.version).toBe('0.2.0');
  });

  it('title matches canonical copy', () => {
    expect(WHATS_NEW.title).toBe('swrm v0.2.0 — Native + Multi-Project');
  });

  it('each note is a non-empty string', () => {
    for (const note of WHATS_NEW.notes) {
      expect(typeof note).toBe('string');
      expect(note.length).toBeGreaterThan(0);
    }
  });
});
