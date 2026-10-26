// Starts the built server on a dedicated port with a fresh, throw-away data directory (used by Playwright).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const dataDir = join(ROOT, '.e2e-data');
rmSync(dataDir, { recursive: true, force: true });
process.env.PORT = process.env.E2E_PORT ?? '5699';
process.env.HOST = '127.0.0.1';
process.env.FLOWFORGE_DATA_DIR = dataDir;
process.env.PUBLIC_URL = '';
await import(pathToFileURL(join(ROOT, 'server', 'dist', 'index.js')).href);
