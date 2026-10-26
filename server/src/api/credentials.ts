import { Router } from 'express';
import { z } from 'zod';
import type { CredentialInput, CredentialTestRequest, WorkflowNode } from '@flowforge/shared';
import { activeCredentialTypes } from '../credentials/check.js';
import { MissingCredentialError } from '../engine/errors.js';
import type { AppServices } from '../app.js';
import { notFound } from '../http/errors.js';

const Value = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
const CreateSchema = z.object({
  name: z.string().max(128).default(''),
  type: z.string().min(1, 'Choose a credential type'),
  data: z.record(z.string(), Value).default({}),
  isDefault: z.boolean().optional(),
});
const UpdateSchema = z.object({
  name: z.string().max(128).optional(),
  type: z.string().optional(),
  data: z.record(z.string(), Value).optional(),
  isDefault: z.boolean().optional(),
});
const MissingSchema = z.object({
  nodes: z
    .array(z.object({ name: z.string(), type: z.string(), parameters: z.record(z.string(), z.unknown()).optional(), credentials: z.record(z.string(), z.unknown()).optional(), disabled: z.boolean().optional() }))
    .max(500),
});
const TestSchema = z.object({
  type: z.string().min(1),
  data: z.record(z.string(), Value).default({}),
  id: z.string().optional(),
});

/** /api/credentials — secrets go in, never come out (summaries only list which secrets are set). */
export function credentialsRouter(s: AppServices): Router {
  const router = Router();
  const service = s.credentials;

  router.get('/', (req, res) => {
    res.json(service.list(typeof req.query.type === 'string' ? req.query.type : undefined));
  });

  router.post('/', (req, res) => {
    const body = CreateSchema.parse(req.body ?? {});
    res.status(201).json(service.create(body as CredentialInput));
  });

  // Declared before "/:id" routes.
  // Which nodes of a workflow still need a credential (warning badges in the editor). Returns names only.
  router.post('/missing', (req, res) => {
    const { nodes } = MissingSchema.parse(req.body ?? {});
    const missing: { node: string; credentialType: string; displayName: string }[] = [];
    for (const raw of nodes) {
      const node = raw as unknown as WorkflowNode;
      const type = s.registry.get(node.type);
      if (!type || node.disabled) continue;
      for (const credentialType of activeCredentialTypes(node, type)) {
        try {
          service.resolve(node, credentialType);
        } catch (err) {
          if (err instanceof MissingCredentialError) missing.push({ node: node.name, credentialType, displayName: service.types().find((t) => t.name === credentialType)?.displayName ?? credentialType });
        }
      }
    }
    res.json({ missing });
  });

  router.post('/test', async (req, res) => {
    const body = TestSchema.parse(req.body ?? {});
    res.json(await service.test(body as CredentialTestRequest));
  });

  router.get('/:id', (req, res) => {
    const credential = service.get(req.params.id);
    if (!credential) throw notFound('Credential not found. It may have been deleted.');
    res.json(credential);
  });

  router.patch('/:id', (req, res) => {
    const body = UpdateSchema.parse(req.body ?? {});
    res.json(service.update(req.params.id, body as Partial<CredentialInput>));
  });

  router.delete('/:id', (req, res) => {
    if (!service.delete(req.params.id)) throw notFound('Credential not found. It may have been deleted.');
    res.status(204).end();
  });

  /** Tests a saved credential; `/env/test?type=smtp` tests the .env fallback. */
  router.post('/:id/test', async (req, res) => {
    res.json(await service.testSaved(req.params.id, typeof req.query.type === 'string' ? req.query.type : undefined));
  });

  return router;
}

export function credentialTypesRouter(s: AppServices): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(s.credentials.types());
  });
  return router;
}
