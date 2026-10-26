import type { IncomingMessage } from 'node:http';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { parse as parseCookies } from 'cookie';
import { SESSION_COOKIE, type PublicUser } from '@flowforge/shared';
import type { AppContext } from '../context.js';
import { toPublicUser } from '../db/repositories/users.js';
import { unauthorized } from '../http/errors.js';

function cookieOptions(ctx: AppContext, req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Secure only when the request arrived over https (e.g. through a Cloudflare tunnel); localhost is plain http.
    secure: req.secure,
    path: '/',
    maxAge: ctx.config.sessionTtlMs,
  };
}

export function startSession(ctx: AppContext, req: Request, res: Response, userId: string): void {
  const token = ctx.sessions.create(userId, ctx.config.sessionTtlMs, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, cookieOptions(ctx, req));
}

export function endSession(ctx: AppContext, req: Request, res: Response): void {
  if (req.sessionToken) ctx.sessions.delete(req.sessionToken);
  const { maxAge: _ignored, ...options } = cookieOptions(ctx, req);
  res.clearCookie(SESSION_COOKIE, options);
}

/** Resolves the user from a raw Cookie header (used by HTTP middleware and the WebSocket upgrade). */
export function userFromCookieHeader(ctx: AppContext, header: string | undefined): { user: PublicUser; token: string } | undefined {
  if (!header) return undefined;
  const token = parseCookies(header)[SESSION_COOKIE];
  if (!token) return undefined;
  const session = ctx.sessions.findValid(token);
  if (!session) return undefined;
  const user = ctx.users.findById(session.userId);
  return user ? { user: toPublicUser(user), token } : undefined;
}

export function sessionMiddleware(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const found = userFromCookieHeader(ctx, req.headers.cookie);
    if (found) {
      req.user = found.user;
      req.sessionToken = found.token;
    } else {
      req.sessionToken = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized());
};

export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
