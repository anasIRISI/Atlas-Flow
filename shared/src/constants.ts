export const APP_NAME = 'FlowForge';
export const APP_VERSION = '0.1.0';

/** n8n uses 5678; FlowForge uses 5679 so both can run side by side. */
export const DEFAULT_PORT = 5679;

export const SESSION_COOKIE = 'ff_session';
export const WS_PATH = '/ws';

/** URL prefixes handled by the server itself (never by the single-page app). */
export const SERVER_ROUTE_PREFIXES = [
  '/api',
  '/ws',
  '/webhook',
  '/webhook-test',
  '/webhook-waiting',
  '/form',
  '/form-test',
  '/form-waiting',
  '/chat',
  '/chat-test',
] as const;
