// `npm run build` → always builds. `node scripts/build.mjs --if-stale` → builds only when sources changed.
import { buildIsStale, checkInstalled, checkNodeVersion, runBuild } from './lib.mjs';

checkNodeVersion();
checkInstalled();
if (!process.argv.includes('--if-stale') || buildIsStale()) runBuild();
