import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // CLI entry — gets the shebang banner for direct execution
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    // prompts/ is NOT bundled — shipped as raw assets, resolved at runtime via import.meta.url
  },
  {
    // GitHub Actions entry — no shebang needed (run by node20 runner directly)
    entry: ['src/github-action.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    sourcemap: true,
  },
]);
