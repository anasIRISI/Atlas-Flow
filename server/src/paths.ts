import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file sits directly in src/ (or dist/ once compiled), so the repo root is two levels up.
const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(here, '..', '..');
export const WEB_DIST_DIR = resolve(ROOT_DIR, 'web', 'dist');
