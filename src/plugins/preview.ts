// loom/src/plugins/preview.ts — PreviewPlugin contract for the workspace
// right pane. Core ships no preview plugins; consumer adds them via
// .loomrc.json's "plugins" array.
//
// Example plugin (a static-PNG plugin):
//
//   import type { PreviewPlugin } from 'loom';
//   const plugin: PreviewPlugin = {
//     name: 'static-png',
//     match: (task) => task.title.includes('design'),
//     async render() {
//       return { contentType: 'image/png', body: Buffer.from([0x89, 0x50, ...]) };
//     },
//   };
//   export default plugin;

import type { AttemptRow } from '../api/attempts';

export interface PreviewContext {
  /** The task for which the preview is being rendered. */
  task: {
    id: number;
    title: string;
    description: string | null;
    status: string;
  };
  /** The active attempt, if any. */
  attempt?: AttemptRow;
  /** The repo root on disk (useful for plugins that inspect files). */
  repoRoot: string;
}

export interface PreviewResult {
  /** MIME type — typically image/png, text/html, or application/json. */
  contentType: string;
  /** Body to serve verbatim. */
  body: Buffer;
  /** Optional HTTP headers to merge. */
  headers?: Record<string, string>;
}

export interface PreviewPlugin {
  /** Stable identifier; used for logging + cache keying. */
  name: string;

  /**
   * Predicate run on every request. Return true if this plugin should
   * handle the preview for the given context. First match wins.
   */
  match(ctx: PreviewContext): boolean | Promise<boolean>;

  /** Produce the preview body. */
  render(ctx: PreviewContext): Promise<PreviewResult>;

  /**
   * Optional teardown hook called on server shutdown. Plugins that hold
   * background processes (Playwright browsers, simulator handles) should
   * release them here.
   */
  dispose?(): Promise<void>;
}

/**
 * Plugin registry. Populated at boot by reading .loomrc.json's "plugins"
 * array and require()-ing each one. Each module's default export must
 * implement PreviewPlugin.
 */
const REGISTRY: PreviewPlugin[] = [];

export function registerPlugin(plugin: PreviewPlugin): void {
  REGISTRY.push(plugin);
}

export function listPlugins(): readonly PreviewPlugin[] {
  return REGISTRY;
}

export async function pickPlugin(ctx: PreviewContext): Promise<PreviewPlugin | null> {
  for (const p of REGISTRY) {
    if (await p.match(ctx)) return p;
  }
  return null;
}

/** Test seam: clear the registry between test cases. */
export function _resetRegistry(): void {
  REGISTRY.length = 0;
}
