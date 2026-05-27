// Tests for the SSE workspace_stream broadcaster.

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  _activeClientsForTask,
  _resetStreamClients,
  broadcast,
  workspaceStreamHandler,
} from '../workspace_stream';

describe('workspace_stream', () => {
  let server: http.Server;
  let port: number;

  beforeEach((done) => {
    _resetStreamClients();
    server = http.createServer((req, res) => {
      if (workspaceStreamHandler(req, res)) return;
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterEach((done) => {
    _resetStreamClients();
    server.close(() => done());
  });

  it('serves text/event-stream with initial hello + counts active client', (done) => {
    const req = http.get(`http://127.0.0.1:${port}/api/workspace/42/stream`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');

      let buf = '';
      const onChunk = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (buf.includes('event: hello')) {
          expect(_activeClientsForTask(42)).toBe(1);
          res.off('data', onChunk);
          req.destroy();
          setTimeout(() => {
            expect(_activeClientsForTask(42)).toBe(0);
            done();
          }, 50);
        }
      };
      res.on('data', onChunk);
    });
  }, 5000);

  it('broadcast fans out only to matching taskId clients', (done) => {
    let aFrames = '';
    let bFrames = '';

    const aReq = http.get(`http://127.0.0.1:${port}/api/workspace/1/stream`, (res) => {
      res.on('data', (c: Buffer) => { aFrames += c.toString('utf8'); });
    });
    const bReq = http.get(`http://127.0.0.1:${port}/api/workspace/2/stream`, (res) => {
      res.on('data', (c: Buffer) => { bFrames += c.toString('utf8'); });
    });

    setTimeout(() => {
      const sent = broadcast(1, 'comment-added', { hello: 'world' });
      expect(sent).toBe(1);

      setTimeout(() => {
        expect(aFrames).toContain('event: comment-added');
        expect(aFrames).toContain('"hello":"world"');
        expect(bFrames).not.toContain('event: comment-added');

        aReq.destroy();
        bReq.destroy();
        done();
      }, 100);
    }, 100);
  }, 5000);

  it('rejects non-GET methods on stream URL', (done) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/workspace/1/stream', method: 'POST' },
      (res) => {
        expect(res.statusCode).toBe(405);
        done();
      },
    );
    req.end();
  });

  it('non-matching path returns false (404 from outer handler)', (done) => {
    http.get(`http://127.0.0.1:${port}/api/workspace/abc/stream`, (res) => {
      expect(res.statusCode).toBe(404);
      done();
    });
  });
});
