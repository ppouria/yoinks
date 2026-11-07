import {defineConfig} from 'tsup'

// Two artifacts: the original TUI (dist/cli.js) and the HTTP server that fronts
// it (dist/web/server.js). The server resolves its static files relative to
// itself, so the publicDir copy below is what makes `node dist/web/server.js`
// work from any working directory.
export default defineConfig([
  {
    entry: ['src/cli.tsx'],
    format: 'esm',
    target: 'node18',
    clean: true,
    banner: {js: '#!/usr/bin/env node'},
  },
  {
    entry: ['src/web/server.ts'],
    format: 'esm',
    target: 'node20',
    outDir: 'dist/web',
    // tsup's publicDir flattens files into the output root, and server.ts
    // serves ./public next to itself — copy it explicitly instead.
    onSuccess: 'node -e "const f=require(\'node:fs\');f.cpSync(\'src/web/public\',\'dist/web/public\',{recursive:true});f.cpSync(\'src/web/deezer_bridge.py\',\'dist/web/deezer_bridge.py\')"',
    external: ['ffmpeg-static'],
  },
])
