# Contributing to Loom

## Local development

```sh
git clone https://github.com/ballinbigE/loom
cd loom
npm install
npm run dev    # tsx src/cli.ts — boots dashboard at :5173
```

## Tests

```sh
npm test                # jest
npm run typecheck       # tsc --noEmit
npm run build           # tsdown — outputs dist/
```

## Filing a bug

Open a [GitHub issue](https://github.com/ballinbigE/loom/issues) with:

- Loom version (`loom --version`)
- Node version (`node --version`)
- macOS / Linux / Windows
- The exact CLI command + error output
- Minimal repro if you can manage it

## Adding a preview plugin

1. Create a new npm package (scope under `@loom/` if you want it discoverable).
2. Export a default object implementing `PreviewPlugin` (see `src/plugins/preview.d.ts`):

   ```ts
   import type { PreviewPlugin } from 'loom';
   export default {
     name: 'my-preview',
     match(task) { return task.title.includes('web'); },
     async render(ctx) {
       return { contentType: 'image/png', body: someBuffer };
     },
   } satisfies PreviewPlugin;
   ```

3. User adds `"plugins": ["my-preview-pkg"]` to their `.loomrc.json` and `npm install`s.

## Non-goals

Loom is intentionally **not** going to add:

- A hosted SaaS UI (that's a future opt-in cloud-sync tier, not core)
- Team / collaboration / multi-user mode in core (it's localhost; if you want team features, that's a separate hosted offering later)
- Telemetry or phone-home (period)
- 50+ tech-stack presets baked in (use the AI Project Breakdown instead)

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess` on.
- `execFile(cmd, [args])` array form for ALL shell ops; never `exec(string)`.
- No new runtime npm deps without a clear justification in the PR description.
- One commit per logical change. Conventional commits encouraged (feat:, fix:, docs:, chore:).

## License

By contributing, you agree your changes are licensed under Apache 2.0.
