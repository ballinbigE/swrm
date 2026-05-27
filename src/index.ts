// loom — public package exports for programmatic use.
//
// Most users hit the CLI (`npx loom`); these exports are for embedders + for
// plugin authors who want to write a `PreviewPlugin` against typed contracts.

export { getDb, runPendingMigrations } from './db';
export type { Prd, PrdStory, PlanFromIdeaOpts } from './plan';
export { planFromIdea, MissingApiKeyError } from './plan';
export type { AttemptRow, CreateAttemptInput, UpdateAttemptInput } from './api/attempts';
export {
  createAttempt,
  listAttempts,
  getAttempt,
  updateAttempt,
  deleteAttempt,
  mergeAttempt,
} from './api/attempts';
export type { CommentRow, CreateCommentInput } from './api/attempt_comments';
export {
  createComment,
  listComments,
  bundleReprompt,
} from './api/attempt_comments';
export type { CommitInfo } from './lib/worktree';
export { addWorktree, removeWorktree, gcOrphanWorktrees, commitsBetween } from './lib/worktree';
