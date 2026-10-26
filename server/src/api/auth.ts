import { Router } from 'express';
import { z } from 'zod';
import { isValidEmail, passwordProblems, type AuthStatus } from '@flowforge/shared';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from '../auth/password.js';
import { clientKey, endSession, requireAuth, startSession } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { toPublicUser } from '../db/repositories/users.js';
import { badRequest, conflict, HttpError } from '../http/errors.js';
import { FailureLimiter } from '../http/rate-limit.js';

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .min(1, 'Email is required')
  .max(254)
  .refine(isValidEmail, 'Enter a valid email address');

const SetupSchema = z.object({
  email,
  firstName: z.string({ error: 'First name is required' }).trim().min(1, 'First name is required').max(64),
  lastName: z.string().trim().max(64).default(''),
  password: z.string({ error: 'Password is required' }),
});

const LoginSchema = z.object({
  email: z.string({ error: 'Email is required' }).trim().min(1, 'Email is required').max(254),
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(256),
});

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const limiter = new FailureLimiter(10, 15 * 60_000);

  router.get('/status', (req, res) => {
    const status: AuthStatus = { setupRequired: ctx.users.count() === 0, user: req.user ?? null };
    res.json(status);
  });

  router.post('/setup', async (req, res) => {
    if (ctx.users.count() > 0) throw conflict('The owner account already exists.', 'Sign in instead.');
    const body = SetupSchema.parse(req.body ?? {});
    const problems = passwordProblems(body.password);
    if (problems.length) throw badRequest(`Password needs: ${problems.join(', ')}.`);
    const passwordHash = await hashPassword(body.password);
    const user = ctx.users.createOwnerIfNone({ ...body, passwordHash });
    if (!user) throw conflict('The owner account already exists.', 'Sign in instead.');
    startSession(ctx, req, res, user.id);
    ctx.logger.info(`Owner account created for ${user.email}`);
    res.status(201).json({ user: toPublicUser(user) });
  });

  router.post('/login', async (req, res) => {
    const key = clientKey(req);
    limiter.check(key);
    const body = LoginSchema.parse(req.body ?? {});
    const user = ctx.users.findByEmail(body.email);
    // Always run one hash verification so response time does not reveal whether the email exists.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));
    if (!user || !ok) {
      limiter.fail(key);
      throw new HttpError(401, 'Wrong email or password.', 'invalid_credentials');
    }
    limiter.reset(key);
    startSession(ctx, req, res, user.id);
    res.json({ user: toPublicUser(user) });
  });

  router.post('/logout', (req, res) => {
    endSession(ctx, req, res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
