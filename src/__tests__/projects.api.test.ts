// Projects API tests — createProject, listProjects, getProjectBySlug, updateProject.
// Uses temp-file DB pattern (matching boards.api.test.ts / seed.test.ts).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runPendingMigrations } from '../db';
import {
  createProject,
  getProjectBySlug,
  listProjects,
  updateProject,
  ProjectError,
} from '../api/projects';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-projects-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  return db;
}

// A real directory on disk to use as root_path in tests.
const REAL_DIR = os.tmpdir();

describe('migration — default project', () => {
  test('fresh migrated DB has a default project', () => {
    const db = freshDb();
    try {
      const all = listProjects(db);
      expect(all).toHaveLength(1);
      expect(all[0].slug).toBe('default');
      expect(all[0].name).toBe('Default');
    } finally {
      db.close();
    }
  });

  test('boards from seed carry project_id pointing to default project', () => {
    const db = freshDb();
    try {
      // Import seedDefaults here to avoid circular import at module level
      const { seedDefaults } = require('../seed');
      seedDefaults(db);
      const defaultProject = listProjects(db)[0];
      const boards = db
        .prepare(`SELECT slug, project_id FROM boards ORDER BY position`)
        .all() as Array<{ slug: string; project_id: number | null }>;
      expect(boards).toHaveLength(3);
      for (const b of boards) {
        expect(b.project_id).toBe(defaultProject.id);
      }
    } finally {
      db.close();
    }
  });
});

describe('createProject', () => {
  test('happy path — creates and returns project row', () => {
    const db = freshDb();
    try {
      const project = createProject(db, {
        slug: 'my-project',
        name: 'My Project',
        root_path: REAL_DIR,
      });
      expect(project.slug).toBe('my-project');
      expect(project.name).toBe('My Project');
      expect(project.root_path).toBe(REAL_DIR);
      expect(project.color).toBe('#d97757');
      expect(typeof project.id).toBe('number');
      expect(typeof project.created_at).toBe('string');
    } finally {
      db.close();
    }
  });

  test('custom color is stored', () => {
    const db = freshDb();
    try {
      const project = createProject(db, {
        slug: 'colored',
        name: 'Colored',
        root_path: REAL_DIR,
        color: '#aabbcc',
      });
      expect(project.color).toBe('#aabbcc');
    } finally {
      db.close();
    }
  });

  test('position increments from max existing', () => {
    const db = freshDb();
    try {
      // default project has position 0
      const p1 = createProject(db, { slug: 'p1', name: 'P1', root_path: REAL_DIR });
      const p2 = createProject(db, { slug: 'p2', name: 'P2', root_path: REAL_DIR });
      expect(p1.position).toBe(1);
      expect(p2.position).toBe(2);
    } finally {
      db.close();
    }
  });

  test('rejects bad slug — too short / bad chars', () => {
    const db = freshDb();
    try {
      // starts with digit
      expect(() => createProject(db, { slug: '1bad', name: 'Bad', root_path: REAL_DIR }))
        .toThrow(ProjectError);

      // uppercase
      expect(() => createProject(db, { slug: 'Bad-Slug', name: 'Bad', root_path: REAL_DIR }))
        .toThrow(ProjectError);

      // empty
      expect(() => createProject(db, { slug: '', name: 'Bad', root_path: REAL_DIR }))
        .toThrow(ProjectError);

      // too long (> 40 chars)
      expect(() =>
        createProject(db, { slug: 'a' + 'b'.repeat(40), name: 'Bad', root_path: REAL_DIR }),
      ).toThrow(ProjectError);
    } finally {
      db.close();
    }
  });

  test('rejects bad slug with status 400', () => {
    const db = freshDb();
    try {
      let threw: ProjectError | null = null;
      try {
        createProject(db, { slug: '1bad', name: 'Bad', root_path: REAL_DIR });
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(400);
    } finally {
      db.close();
    }
  });

  test('rejects non-existent root_path', () => {
    const db = freshDb();
    try {
      let threw: ProjectError | null = null;
      try {
        createProject(db, {
          slug: 'no-path',
          name: 'No Path',
          root_path: '/tmp/__does_not_exist_swrm_test__',
        });
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(400);
    } finally {
      db.close();
    }
  });

  test('rejects root_path that is a file, not a directory', () => {
    const tmpFile = path.join(os.tmpdir(), `swrm-test-file-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'hello');
    const db = freshDb();
    try {
      let threw: ProjectError | null = null;
      try {
        createProject(db, { slug: 'bad-path', name: 'Bad', root_path: tmpFile });
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(400);
    } finally {
      db.close();
      fs.unlinkSync(tmpFile);
    }
  });

  test('rejects duplicate slug with status 409', () => {
    const db = freshDb();
    try {
      createProject(db, { slug: 'dup', name: 'First', root_path: REAL_DIR });
      let threw: ProjectError | null = null;
      try {
        createProject(db, { slug: 'dup', name: 'Second', root_path: REAL_DIR });
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(409);
    } finally {
      db.close();
    }
  });
});

describe('listProjects', () => {
  test('returns projects ordered by position, id', () => {
    const db = freshDb();
    try {
      createProject(db, { slug: 'beta', name: 'Beta', root_path: REAL_DIR });
      createProject(db, { slug: 'alpha', name: 'Alpha', root_path: REAL_DIR });

      const projects = listProjects(db);
      // default is at position 0; beta position 1; alpha position 2
      expect(projects[0].slug).toBe('default');
      expect(projects[1].slug).toBe('beta');
      expect(projects[2].slug).toBe('alpha');
    } finally {
      db.close();
    }
  });
});

describe('getProjectBySlug', () => {
  test('returns the matching project', () => {
    const db = freshDb();
    try {
      createProject(db, { slug: 'find-me', name: 'Find Me', root_path: REAL_DIR });
      const found = getProjectBySlug(db, 'find-me');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Find Me');
    } finally {
      db.close();
    }
  });

  test('returns undefined for unknown slug', () => {
    const db = freshDb();
    try {
      const result = getProjectBySlug(db, 'ghost');
      expect(result).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('updateProject', () => {
  test('can update name, color, root_path', () => {
    const db = freshDb();
    try {
      const created = createProject(db, { slug: 'update-me', name: 'Old Name', root_path: REAL_DIR });
      const updated = updateProject(db, created.id, {
        name: 'New Name',
        color: '#112233',
        root_path: REAL_DIR,
      });
      expect(updated.name).toBe('New Name');
      expect(updated.color).toBe('#112233');
      expect(updated.root_path).toBe(REAL_DIR);
    } finally {
      db.close();
    }
  });

  test('throws 404 for unknown id', () => {
    const db = freshDb();
    try {
      let threw: ProjectError | null = null;
      try {
        updateProject(db, 99999, { name: 'X' });
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test('throws 400 for empty patch', () => {
    const db = freshDb();
    try {
      const created = createProject(db, { slug: 'empty-patch', name: 'EP', root_path: REAL_DIR });
      let threw: ProjectError | null = null;
      try {
        updateProject(db, created.id, {});
      } catch (e) {
        threw = e as ProjectError;
      }
      expect(threw).not.toBeNull();
      expect(threw!.status).toBe(400);
    } finally {
      db.close();
    }
  });
});
