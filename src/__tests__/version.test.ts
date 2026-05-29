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
  it('has at least one note, each a non-empty string', () => {
    expect(WHATS_NEW.notes.length).toBeGreaterThan(0);
    for (const note of WHATS_NEW.notes) {
      expect(typeof note).toBe('string');
      expect(note.length).toBeGreaterThan(0);
    }
  });

  it('version matches the package version (no drift between notes + package.json)', () => {
    expect(WHATS_NEW.version).toBe(appVersion());
  });

  it('has a non-empty title', () => {
    expect(WHATS_NEW.title.length).toBeGreaterThan(0);
  });
});
