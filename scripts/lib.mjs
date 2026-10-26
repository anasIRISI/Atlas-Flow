// Helpers shared by start.mjs and build.mjs. Plain Node (no dependencies) so they run before anything is built.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIN_NODE = [20, 11];
const STAMP = join(ROOT, 'node_modules', '.cache', 'flowforge-build-stamp');

// Everything that influences the build output.
const BUILD_INPUTS = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'shared/package.json',
  'shared/tsconfig.json',
  'shared/src',
  'server/package.json',
  'server/tsconfig.build.json',
  'server/src',
  'web/package.json',
  'web/tsconfig.json',
  'web/vite.config.ts',
  'web/index.html',
  'web/public',
  'web/src',
];
const BUILD_OUTPUTS = ['shared/dist/index.js', 'server/dist/index.js', 'web/dist/index.html'];

export function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error(
      `\n✖ FlowForge needs Node.js ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}).\n` +
        '  Install the current LTS from https://nodejs.org and run `npm install` again.\n',
    );
    process.exit(1);
  }
}

export function checkInstalled() {
  if (!existsSync(join(ROOT, 'node_modules', 'express')) || !existsSync(join(ROOT, 'node_modules', 'vite'))) {
    console.error('\n✖ Dependencies are not installed. Run `npm install` first.\n');
    process.exit(1);
  }
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

export function buildIsStale() {
  if (BUILD_OUTPUTS.some((p) => !existsSync(join(ROOT, p)))) return true;
  if (!existsSync(STAMP)) return true;
  const built = statSync(STAMP).mtimeMs;
  return BUILD_INPUTS.some((p) => newestMtime(join(ROOT, p)) > built);
}

function run(args) {
  const isWin = process.platform === 'win32';
  const result = spawnSync(isWin ? 'npm.cmd' : 'npm', args, { cwd: ROOT, stdio: 'inherit', shell: isWin });
  if (result.status !== 0) {
    console.error(`\n✖ Build step failed: npm ${args.join(' ')}\n`);
    process.exit(result.status ?? 1);
  }
}

export function runBuild() {
  const started = Date.now();
  console.log('▸ Building FlowForge (shared → server → web)…');
  run(['run', 'build', '-w', 'shared']);
  run(['run', 'build', '-w', 'server']);
  run(['run', 'build', '-w', 'web']);
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, new Date().toISOString());
  console.log(`✔ Build finished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}
