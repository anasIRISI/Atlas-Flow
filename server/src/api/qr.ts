import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';

const QuerySchema = z.object({
  text: z.string().min(1, 'Nothing to encode').max(2000, 'The text is too long for a QR code'),
  size: z.coerce.number().int().min(64).max(2048).default(512),
  download: z.string().max(100).optional(),
});

/** GET /api/qr?text=…&size=…&download=name.png — QR code PNG generated locally (no external service). */
export function qrRouter(): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const q = QuerySchema.parse(req.query);
    const png = await QRCode.toBuffer(q.text, { type: 'png', width: q.size, margin: 2, errorCorrectionLevel: 'M' });
    res.type('image/png');
    res.set('Cache-Control', 'private, max-age=300');
    if (q.download !== undefined) {
      const name = q.download.replace(/[^\w.-]+/g, '_') || 'qr-code.png';
      res.attachment(name.endsWith('.png') ? name : `${name}.png`);
    }
    res.send(png);
  });
  return router;
}
