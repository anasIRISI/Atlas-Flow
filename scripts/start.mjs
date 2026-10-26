// `npm start`: build on first run (or when sources changed), then run the compiled server in this process.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, buildIsStale, checkInstalled, checkNodeVersion, runBuild } from './lib.mjs';

checkNodeVersion();
checkInstalled();
if (process.argv.includes('--rebuild') || buildIsStale()) runBuild();
await import(pathToFileURL(join(ROOT, 'server', 'dist', 'index.js')).href);
