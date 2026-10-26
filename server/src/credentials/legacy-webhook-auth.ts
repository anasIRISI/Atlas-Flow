import type { WorkflowNode } from '@flowforge/shared';
import type { DB } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { CredentialsService } from './service.js';

const DONE_KEY = 'migration.webhookAuthToCredentials';
const LEGACY = ['basicAuthUser', 'basicAuthPassword', 'headerAuthName', 'headerAuthValue'] as const;
const MARKERS = LEGACY.map((k) => `%"${k}"%`);
const LIKE = (column: string) => MARKERS.map(() => `${column} LIKE ?`).join(' OR ');

const has = (node: WorkflowNode) => node.type === 'flowforge.webhook' && LEGACY.some((k) => k in (node.parameters ?? {}));

function strip(node: WorkflowNode): WorkflowNode {
  const parameters = { ...node.parameters };
  for (const k of LEGACY) delete parameters[k];
  return { ...node, parameters };
}

/**
 * One-time upgrade (Phase 3 → 3B): Webhook nodes used to keep their Basic / Header Auth password in the
 * node parameters. Those values move to encrypted credentials referenced by the node, and are removed from
 * the stored workflows, from the workflow copies kept with old executions and from version snapshots.
 */
export function migrateLegacyWebhookAuth(db: DB, credentials: CredentialsService, logger: Logger): { workflows: number; executions: number } {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(DONE_KEY)) return { workflows: 0, executions: 0 };
  let workflows = 0;
  let executions = 0;

  const rows = db.prepare(`SELECT id, name, nodes FROM workflows WHERE ${LIKE('nodes')}`).all(...MARKERS) as { id: string; name: string; nodes: string }[];
  for (const row of rows) {
    const nodes = JSON.parse(row.nodes) as WorkflowNode[];
    if (!nodes.some(has)) continue;
    const next = nodes.map((node) => {
      if (!has(node)) return node;
      const p = node.parameters as Record<string, unknown>;
      const refs = { ...(node.credentials ?? {}) };
      const name = `${row.name} · ${node.name}`.slice(0, 128);
      try {
        if (p.authentication === 'basicAuth' && !refs.httpBasicAuth && p.basicAuthUser && p.basicAuthPassword) {
          const created = credentials.create({ name, type: 'httpBasicAuth', data: { user: String(p.basicAuthUser), password: String(p.basicAuthPassword) } });
          refs.httpBasicAuth = { id: created.id, name: created.name };
        }
        if (p.authentication === 'headerAuth' && !refs.httpHeaderAuth && p.headerAuthValue) {
          const created = credentials.create({ name, type: 'httpHeaderAuth', data: { name: String(p.headerAuthName || 'X-API-Key'), value: String(p.headerAuthValue) } });
          refs.httpHeaderAuth = { id: created.id, name: created.name };
        }
      } catch (err) {
        logger.warn(`Could not move the Webhook authentication of "${name}" to a credential: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ...strip(node), ...(Object.keys(refs).length ? { credentials: refs } : {}) };
    });
    db.prepare('UPDATE workflows SET nodes = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    workflows++;
  }

  // Old executions keep a copy of the workflow: remove the passwords there too.
  const snapshots = db.prepare(`SELECT execution_id, workflow FROM execution_data WHERE ${LIKE('workflow')}`).all(...MARKERS) as { execution_id: number; workflow: string }[];
  for (const snapshot of snapshots) {
    const workflow = JSON.parse(snapshot.workflow) as { nodes?: WorkflowNode[] };
    if (!workflow.nodes?.some(has)) continue;
    workflow.nodes = workflow.nodes.map((node) => (has(node) ? strip(node) : node));
    db.prepare('UPDATE execution_data SET workflow = ? WHERE execution_id = ?').run(JSON.stringify(workflow), snapshot.execution_id);
    executions++;
  }

  // Version history (Phase 7) keeps snapshots too: strip them the same way.
  const versions = db.prepare(`SELECT id, nodes FROM workflow_versions WHERE ${LIKE('nodes')}`).all(...MARKERS) as { id: number; nodes: string }[];
  for (const version of versions) {
    const nodes = JSON.parse(version.nodes) as WorkflowNode[];
    if (!nodes.some(has)) continue;
    db.prepare('UPDATE workflow_versions SET nodes = ? WHERE id = ?').run(JSON.stringify(nodes.map((node) => (has(node) ? strip(node) : node))), version.id);
    executions++;
  }

  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(DONE_KEY, JSON.stringify({ workflows, executions }), new Date().toISOString());
  if (workflows || executions) {
    // SQLite keeps replaced rows in free pages: rebuild the file so the old plaintext is really gone.
    try {
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.warn(`Could not compact the database after the migration: ${err instanceof Error ? err.message : String(err)}`);
    }
    logger.info(`Webhook passwords moved to encrypted credentials (${workflows} workflow(s), ${executions} old execution(s) cleaned)`);
  }
  return { workflows, executions };
}
