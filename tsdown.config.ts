import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: 'cjs',
  target: 'node20',
  dts: true,
  clean: true,
  shims: false,
  // Bundle for distribution; better-sqlite3 stays external (native binding).
  external: ['better-sqlite3'],
});
