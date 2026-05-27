// Tests for /api/plan HTTP handler.

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { planApiHandler } from '../plan';

function fetchJson(port: number, path: string, body: unknown, method = 'POST'): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
        res.on('end', () => {
          let parsed: unknown = undefined;
          try { parsed = buf ? JSON.parse(buf) : undefined; } catch { parsed = buf; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('planApiHandler', () => {
  let server: http.Server;
  let port: number;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeAll((done) => {
    server = http.createServer(async (req, res) => {
      if (await planApiHandler(req, res)) return;
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('400 on empty idea', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const r = await fetchJson(port, '/api/plan', { idea: '' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/non-empty/);
  });

  it('400 on missing body', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const r = await fetchJson(port, '/api/plan', {});
    expect(r.status).toBe(400);
  });

  it('503 when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await fetchJson(port, '/api/plan', { idea: 'add dark mode' });
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('405 on GET', async () => {
    const r = await fetchJson(port, '/api/plan', undefined, 'GET');
    expect(r.status).toBe(405);
  });

  it('returns false (404 from outer handler) on non-matching path', async () => {
    const r = await fetchJson(port, '/api/something-else', {}, 'GET');
    expect(r.status).toBe(404);
  });
});
