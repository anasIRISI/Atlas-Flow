import { Router } from 'express';
import type { TemplateDetail, TemplateInfo } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { notFound } from '../http/errors.js';
import { importTemplate, loadAllTemplates, matchesQuery } from '../templates/index.js';

const info = ({ nodes: _n, connections: _c, ...rest }: TemplateDetail): TemplateInfo => rest;

/** /api/templates — gallery of examples, templates/ and built-in templates. Contract: docs/phase7-contracts.md (W5) */
export function templatesRouter(s: AppServices): Router {
  const router = Router({ mergeParams: true });
  let cache: TemplateDetail[] | undefined;
  const all = () => (cache ??= loadAllTemplates(s.registry));

  router.get('/', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : '';
    res.json(
      all()
        .filter((t) => (!q || matchesQuery(t, q)) && (!category || t.categories.some((c) => c.toLowerCase() === category)))
        .map(info),
    );
  });

  router.get('/:id', (req, res) => {
    const t = all().find((x) => x.id === req.params.id);
    if (!t) throw notFound('Template not found');
    res.json(t);
  });

  router.post('/:id/import', (req, res) => {
    const t = all().find((x) => x.id === req.params.id);
    if (!t) throw notFound('Template not found');
    res.status(201).json(importTemplate(s, t));
  });

  return router;
}
