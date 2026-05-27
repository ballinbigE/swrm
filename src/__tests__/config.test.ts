import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULTS, loadConfig } from '../config';

describe('loadConfig', () => {
  let tmp: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cfg-'));
    delete process.env.LOOM_PORT;
    delete process.env.LOOM_DB_PATH;
    delete process.env.PM_WORKTREE_ROOT;
    delete process.env.LOOM_WORKTREE_ROOT;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it('returns DEFAULTS when no rc files + no env + no cli', () => {
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.port).toBe(DEFAULTS.port);
    expect(cfg.plugins).toEqual([]);
    expect(cfg.agentBinaries['claude-code']).toBe('claude');
  });

  it('reads .loomrc.json overrides', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 9999, plugins: ['@loom/preview-ios'] }));
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.port).toBe(9999);
    expect(cfg.plugins).toEqual(['@loom/preview-ios']);
  });

  it('.loomrc.local.json overrides .loomrc.json', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 9999 }));
    fs.writeFileSync(path.join(tmp, '.loomrc.local.json'), JSON.stringify({ port: 7777 }));
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.port).toBe(7777);
  });

  it('env LOOM_PORT overrides rc files', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 9999 }));
    process.env.LOOM_PORT = '5050';
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.port).toBe(5050);
  });

  it('cli overrides everything', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 9999 }));
    process.env.LOOM_PORT = '5050';
    const cfg = loadConfig({ cwd: tmp, cli: { port: 3000 } });
    expect(cfg.port).toBe(3000);
  });

  it('throws on unknown rc key in strict mode (default)', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 1234, sparkles: true }));
    expect(() => loadConfig({ cwd: tmp })).toThrow(/unknown key 'sparkles'/);
  });

  it('tolerates unknown keys with strict:false', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 1234, sparkles: true }));
    const cfg = loadConfig({ cwd: tmp, strict: false });
    expect(cfg.port).toBe(1234);
  });

  it('merges agentBinaries instead of replacing', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ agentBinaries: { custom: '/usr/local/bin/custom' } }));
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.agentBinaries['claude-code']).toBe('claude'); // default preserved
    expect(cfg.agentBinaries.custom).toBe('/usr/local/bin/custom'); // user-added kept
  });

  it('resolves relative dbPath against cwd', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ dbPath: 'data/loom.db' }));
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.dbPath).toBe(path.join(tmp, 'data/loom.db'));
  });

  it('keeps absolute dbPath as-is', () => {
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ dbPath: '/tmp/explicit.db' }));
    const cfg = loadConfig({ cwd: tmp });
    expect(cfg.dbPath).toBe('/tmp/explicit.db');
  });

  it('respects custom configPath when provided', () => {
    const custom = path.join(tmp, 'my-config.json');
    fs.writeFileSync(custom, JSON.stringify({ port: 4242 }));
    fs.writeFileSync(path.join(tmp, '.loomrc.json'), JSON.stringify({ port: 9999 }));
    const cfg = loadConfig({ cwd: tmp, configPath: custom });
    expect(cfg.port).toBe(4242); // custom file wins, .loomrc.json ignored
  });
});
