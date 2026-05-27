// US-009 tests — attachments save/get/delete.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { deleteAttachment, getAttachment, saveAttachment } from '../api/attachments';
import { createTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-attach-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('saveAttachment', () => {
  test('PRD round-trip: upload + retrieve + delete a small text file', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'parent' });
      const bytes = Buffer.from('hello pm dashboard\n', 'utf8');
      const row = saveAttachment(db, {
        task_id: t.id,
        filename: 'hello.txt',
        mime_type: 'text/plain',
        bytes,
      });
      expect(row.original_filename).toBe('hello.txt');
      expect(row.mime_type).toBe('text/plain');
      expect(row.size_bytes).toBe(bytes.length);
      expect(fs.existsSync(row.stored_path)).toBe(true);

      // retrieve
      const fetched = getAttachment(db, row.id);
      expect(fetched).not.toBeNull();
      expect(fs.readFileSync(fetched!.stored_path, 'utf8')).toBe('hello pm dashboard\n');

      // delete
      expect(deleteAttachment(db, row.id)).toBe(true);
      expect(fs.existsSync(row.stored_path)).toBe(false);
      expect(getAttachment(db, row.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('TOO_LARGE: 25MB+1 byte rejected', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const tooBig = Buffer.alloc(25 * 1024 * 1024 + 1);
      try {
        saveAttachment(db, { task_id: t.id, filename: 'big.bin', mime_type: 'application/octet-stream', bytes: tooBig });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('TOO_LARGE');
      }
    } finally {
      db.close();
    }
  });

  test('NOT_FOUND: unknown task_id', () => {
    const db = freshDb();
    try {
      try {
        saveAttachment(db, { task_id: 99999, filename: 'x.txt', mime_type: 'text/plain', bytes: Buffer.from('x') });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    } finally {
      db.close();
    }
  });

  test('VALIDATION: missing filename', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      try {
        saveAttachment(db, { task_id: t.id, filename: '', mime_type: 'text/plain', bytes: Buffer.from('x') });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });

  test('sanitizes filename: strips path separators + control chars', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const row = saveAttachment(db, {
        task_id: t.id,
        filename: '../../etc/passwd\x00',
        mime_type: 'text/plain',
        bytes: Buffer.from('ok'),
      });
      expect(row.original_filename).not.toContain('/');
      expect(row.original_filename).not.toContain('\x00');
    } finally {
      db.close();
    }
  });

  test('rejects suspect mime type → falls back to octet-stream', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const row = saveAttachment(db, {
        task_id: t.id,
        filename: 'x.bin',
        mime_type: '<<malicious>>',
        bytes: Buffer.from('x'),
      });
      expect(row.mime_type).toBe('application/octet-stream');
    } finally {
      db.close();
    }
  });
});

describe('deleteAttachment', () => {
  test('returns false for unknown id', () => {
    const db = freshDb();
    try {
      expect(deleteAttachment(db, 99999)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('survives missing file on disk (ENOENT tolerated)', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const row = saveAttachment(db, { task_id: t.id, filename: 'x.txt', mime_type: 'text/plain', bytes: Buffer.from('x') });
      fs.unlinkSync(row.stored_path); // disk gone but DB row still exists
      expect(deleteAttachment(db, row.id)).toBe(true);
      expect(getAttachment(db, row.id)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('cascade: archive parent task does NOT delete attachments', () => {
  test('attachment + file survive parent task soft-delete', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const row = saveAttachment(db, { task_id: t.id, filename: 'x.txt', mime_type: 'text/plain', bytes: Buffer.from('x') });
      db.prepare(`UPDATE tasks SET archived_at = datetime('now') WHERE id = ?`).run(t.id);
      expect(getAttachment(db, row.id)).not.toBeNull();
      expect(fs.existsSync(row.stored_path)).toBe(true);
    } finally {
      db.close();
    }
  });
});
