/** Shape of every error response from `/api/*`. */
export interface ApiErrorBody {
  error: {
    message: string;
    code?: string;
    /** Optional hint telling the user how to fix the problem. */
    hint?: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: 'ok';
  name: string;
  version: string;
  uptimeSeconds: number;
  nodeVersion: string;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  /** Base URL used for webhooks, forms and QR codes. */
  publicUrl: string;
  /** Where publicUrl comes from: PUBLIC_URL in .env, the detected LAN address, or localhost only. */
  publicUrlSource: 'env' | 'lan' | 'localhost';
  port: number;
  localUrl: string;
  dataDir: string;
  startedAt: string;
}
