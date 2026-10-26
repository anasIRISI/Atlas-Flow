import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@flowforge/shared';
import type { Logger } from '../logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, hint?: string) => new HttpError(400, message, 'bad_request', hint);
export const unauthorized = (message = 'Please sign in to continue.') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message: string) => new HttpError(403, message, 'forbidden');
export const notFound = (message: string) => new HttpError(404, message, 'not_found');
export const conflict = (message: string, hint?: string) => new HttpError(409, message, 'conflict', hint);
export const tooManyRequests = (message: string) => new HttpError(429, message, 'too_many_requests');

/** Turns any thrown error into a JSON `{ error: { message, … } }` response. Never leaks stack traces. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let body: ApiErrorBody;
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { message: err.message, code: err.code, hint: err.hint } };
    } else if (err instanceof ZodError) {
      status = 400;
      const first = err.issues[0];
      const field = first?.path.join('.');
      body = {
        error: {
          message: first ? `${field ? `${field}: ` : ''}${first.message}` : 'Invalid request',
          code: 'validation_error',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: { message: 'The request body is not valid JSON.', code: 'invalid_json' } };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { error: { message: 'The request body is too large.', code: 'payload_too_large' } };
    } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      // Client errors raised by Express itself (e.g. malformed %-encoding in the URL).
      status = err.status;
      body = { error: { message: err.expose && err.message ? err.message : 'Bad request', code: 'bad_request' } };
    } else {
      logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
      body = { error: { message: 'Internal server error. Check the server logs for details.', code: 'internal' } };
    }
    res.status(status).json(body);
  };
}
