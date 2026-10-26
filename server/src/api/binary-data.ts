import { Router } from 'express';
import type { AppServices } from '../app.js';
import { badRequest, notFound } from '../http/errors.js';

export function binaryDataRouter(s: AppServices): Router {
  const router = Router();

  /** Streams a stored file. `?download=1` forces a download instead of an inline preview. */
  router.get('/:executionId/:fileId', async (req, res) => {
    const id = `${req.params.executionId}/${req.params.fileId}`;
    if (!/^[\w-]{1,64}\/[\w-]{1,64}$/.test(id)) throw badRequest('Invalid file id');
    if (!s.binaryStore.exists(id)) throw notFound('File not found (the execution may have been deleted)');
    const meta = await s.binaryStore.readMeta(id);
    const data = await s.binaryStore.read({ id });
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Type', meta.mimeType);
    res.set('Content-Disposition', `${disposition}; filename="${(meta.fileName ?? 'file').replace(/["\r\n]/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    // Never let an uploaded HTML/SVG file run scripts on our origin.
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(data);
  });

  return router;
}
