// `npm run user:reset` → deletes all user accounts so the owner setup screen appears again.
// Workflows, credentials and executions are NOT touched.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, loadDotEnv } from '../config.js';
import { openDatabase } from '../db/index.js';
import { UsersRepo } from '../db/repositories/users.js';

loadDotEnv();
const config = loadConfig();
const file = join(config.dataDir, 'flowforge.db');
if (!existsSync(file)) {
  console.log(`No database found at ${file}. Nothing to reset.`);
  process.exit(0);
}

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'This deletes all FlowForge user accounts (workflows and credentials are kept).\nType RESET to continue: ',
  );
  rl.close();
  if (answer.trim() !== 'RESET') {
    console.log('Cancelled.');
    process.exit(0);
  }
}

const db = openDatabase(file);
const removed = new UsersRepo(db).deleteAll();
db.close();
console.log(`Deleted ${removed} user account(s). Open FlowForge to create a new owner account.`);
