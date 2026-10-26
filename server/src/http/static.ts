import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type RequestHandler, Router } from 'express';
import { SERVER_ROUTE_PREFIXES } from '@flowforge/shared';

function isServerRoute(path: string): boolean {
  return SERVER_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const NOT_BUILT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FlowForge</title></head>
<body style="background:#121216;color:#ececf1;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px"><h1 style="color:#ff6d3a">FlowForge</h1>
<p>The web interface has not been built yet.</p>
<p>Run <code>npm start</code> (it builds automatically) or <code>npm run build</code>.</p>
<p>In development use <code>npm run dev</code> and open <a style="color:#ff8757" href="http://localhost:5173">http://localhost:5173</a>.</p>
</div></body></html>`;

/** Serves the built React app and falls back to index.html for client-side routes. */
export function staticFrontend(webDistDir: string): Router {
  const router = Router();
  const indexFile = join(webDistDir, 'index.html');

  const spaFallback: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isServerRoute(req.path)) return next();
    if (!existsSync(indexFile)) {
      res.status(503).type('html').send(NOT_BUILT_PAGE);
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  };

  // Hashed assets can be cached forever; everything else is revalidated.
  router.use(
    '/assets',
    express.static(join(webDistDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: true }),
  );
  router.use(express.static(webDistDir, { index: false, maxAge: 0 }));
  router.use(spaFallback);
  return router;
}
