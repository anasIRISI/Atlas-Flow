import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, APP_VERSION } from '@flowforge/shared';
import { createApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './logger.js';
import { loadNodeRegistry } from './nodes/registry.js';

function fatal(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Runs a startup step; on failure prints a readable message and exits (no stack trace soup). */
function startupStep<T>(step: () => T): T {
  try {
    return step();
  } catch (err) {
    fatal(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
  }
}

loadDotEnv();
const config = startupStep(() => loadConfig());
const logger = createLogger(config.logLevel);

// Reliability first: log unexpected errors loudly but keep serving.
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => logger.error('Uncaught exception', err));

startupStep(() => mkdirSync(config.dataDir, { recursive: true }));
const db = startupStep(() => openDatabase(join(config.dataDir, 'flowforge.db')));
logger.debug(`SQLite driver: ${db.driver}`);

const registry = await loadNodeRegistry().catch((err: unknown) => fatal(`Could not load the nodes: ${err instanceof Error ? err.message : String(err)}`));
logger.debug(`Loaded ${registry.size} node types`);

const ctx = createContext(config, db, logger, registry);
const removed = ctx.sessions.deleteExpired();
if (removed) logger.debug(`Removed ${removed} expired session(s)`);

const flowforge = createApp(ctx);

flowforge.server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    fatal(`Port ${config.port} is already in use. Stop the other program or set PORT=<another port> in .env.`);
  }
  if (err.code === 'EACCES') fatal(`No permission to listen on port ${config.port}. Use a port above 1024.`);
  fatal(`Server error: ${err.message}`);
});

flowforge.server.listen(config.port, config.host, () => {
  void flowforge.boot().catch((err: unknown) => logger.error('Startup tasks failed', err));
  const lines = [
    '',
    `  ${APP_NAME} v${APP_VERSION} is running`,
    '',
    `  ➜ Local:    ${config.localUrl}`,
  ];
  if (config.publicUrl !== config.localUrl) lines.push(`  ➜ Network:  ${config.publicUrl}`);
  lines.push(`  ➜ Data:     ${config.dataDir}`, '', '  Press Ctrl+C to stop.', '');
  console.log(lines.join('\n'));
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  await flowforge.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
