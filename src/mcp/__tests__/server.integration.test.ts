// Integration test for the MCP stdio server.
// Spawns scripts/pm/mcp/server.ts as a real subprocess, pipes
// JSON-RPC requests on stdin, parses responses off stdout. Catches
// stdio-framing bugs that the pure dispatch unit tests can't see.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('mcp/server.ts (real subprocess)', () => {
  // Each test gets its own throwaway DB so we don't depend on the live one.
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mcp-int-'));
    dbPath = path.join(tmpDir, 'pm.db');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function spawnServer() {
    // loom: __dirname = src/mcp/__tests__ → repo root is 3 levels up.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    return spawn(
      'npx',
      ['tsx', path.join('src', 'mcp', 'server.ts')],
      {
        cwd: repoRoot,
        env: { ...process.env, PM_DB_PATH: dbPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }

  it('responds to initialize + tools/list over stdio', (done) => {
    const child = spawnServer();
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });

    // Wait for the 'ready' banner on stderr before sending requests.
    const waitForReady = setInterval(() => {
      if (stderr.includes('[loom-mcp] ready')) {
        clearInterval(waitForReady);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

        // Give the server a moment to flush both responses, then close stdin.
        setTimeout(() => {
          child.stdin.end();
        }, 250);
      }
    }, 50);

    child.on('exit', (code) => {
      clearInterval(waitForReady);
      try {
        expect(code).toBe(0);

        const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(2);

        const init = JSON.parse(lines[0]);
        expect(init.id).toBe(1);
        expect(init.result.serverInfo.name).toBe('loom');

        const tools = JSON.parse(lines[1]);
        expect(tools.id).toBe(2);
        expect(Array.isArray(tools.result.tools)).toBe(true);
        const names = tools.result.tools.map((t: { name: string }) => t.name);
        expect(names).toContain('loom__list_boards');
        expect(names).toContain('loom__create_attempt');
        done();
      } catch (e) {
        done(e);
      }
    });
  }, 20000);
});
