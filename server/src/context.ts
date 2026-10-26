import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { CredentialCipher, loadEncryptionKey } from './credentials/cipher.js';
import { CredentialTypeRegistry } from './credentials/registry.js';
import { CredentialsService } from './credentials/service.js';
import type { DB } from './db/index.js';
import { CredentialsRepo } from './db/repositories/credentials.js';
import { ChatMemoryRepo } from './db/repositories/chat-memory.js';
import { SettingsRepo } from './db/repositories/settings.js';
import { ExecutionsRepo } from './db/repositories/executions.js';
import { SessionsRepo } from './db/repositories/sessions.js';
import { UsersRepo } from './db/repositories/users.js';
import { WorkflowsRepo } from './db/repositories/workflows.js';
import { TagsRepo } from './db/repositories/tags.js';
import { VersionsRepo } from './db/repositories/versions.js';
import { VariablesRepo } from './db/repositories/variables.js';
import { BinaryStore } from './engine/binary-store.js';
import type { Logger } from './logger.js';
import type { NodeRegistry } from './nodes/registry.js';
import { InstanceSettingsService } from './settings/instance-settings.js';

/** Everything a route or service needs, created once at startup and passed explicitly (easy to test). */
export interface AppContext {
  config: AppConfig;
  db: DB;
  logger: Logger;
  startedAt: Date;
  users: UsersRepo;
  sessions: SessionsRepo;
  executionsRepo: ExecutionsRepo;
  workflowsRepo: WorkflowsRepo;
  registry: NodeRegistry;
  binaryStore: BinaryStore;
  credentials: CredentialsService;
  settings: InstanceSettingsService;
  chatMemory: ChatMemoryRepo;
  tagsRepo: TagsRepo;
  versionsRepo: VersionsRepo;
  variablesRepo: VariablesRepo;
}

export function createContext(config: AppConfig, db: DB, logger: Logger, registry: NodeRegistry, options: { env?: NodeJS.ProcessEnv } = {}): AppContext {
  return {
    config,
    db,
    logger,
    startedAt: new Date(),
    users: new UsersRepo(db),
    sessions: new SessionsRepo(db),
    executionsRepo: new ExecutionsRepo(db),
    workflowsRepo: new WorkflowsRepo(db),
    registry,
    binaryStore: new BinaryStore(join(config.dataDir, 'binary')),
    credentials: new CredentialsService({
      repo: new CredentialsRepo(db),
      cipher: new CredentialCipher(loadEncryptionKey(config.dataDir, config.encryptionKey)),
      types: new CredentialTypeRegistry(),
      logger,
      env: options.env,
    }),
    settings: new InstanceSettingsService(new SettingsRepo(db)),
    chatMemory: new ChatMemoryRepo(db),
    tagsRepo: new TagsRepo(db),
    versionsRepo: new VersionsRepo(db),
    variablesRepo: new VariablesRepo(db),
  };
}
