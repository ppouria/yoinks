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
    // ffmpeg-static resolves a binary path at runtime, so it stays external.
    // teleproto is bundled: it is a 6MB tree of CJS files that the deployed
    // app would otherwise have to install (and keep updated) on the server.
    external: ['ffmpeg-static'],
    noExternal: ['teleproto'],
    // teleproto (and the CJS it pulls in) calls require('buffer') at runtime.
    // In an ESM bundle that becomes a shim that throws; give the chunk a
    // working require so those calls resolve to Node's builtin.
    esbuildOptions(options, context) {
      if (context.format === 'esm') {
        options.banner = {
          // Some bundled CJS also reads __filename/__dirname, which ESM lacks.
          js: [
            "import{createRequire as __cr}from'node:module';",
            "import{fileURLToPath as __ftp}from'node:url';",
            "import{dirname as __dn}from'node:path';",
            "const require=__cr(import.meta.url);",
            "const __filename=__ftp(import.meta.url);",
            "const __dirname=__dn(__filename);",
          ].join(''),
        }
      }
    },
  },
])
