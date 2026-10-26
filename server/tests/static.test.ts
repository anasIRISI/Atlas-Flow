import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

describe('frontend serving', () => {
  it('serves index.html for client-side routes', async () => {
    t = await makeTestApp();
    for (const path of ['/', '/home', '/workflows', '/workflow/abc/executions']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text).toContain('FlowForge test');
    }
  });

  it('serves hashed assets with long caching', async () => {
    t = await makeTestApp();
    const res = await request(t.app).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('never answers server routes with the SPA', async () => {
    t = await makeTestApp();
    for (const path of ['/webhook/abc', '/webhook-test/x', '/form/123', '/chat/1']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain('FlowForge test');
    }
  });

  it('shows a helpful page when the frontend is not built', async () => {
    t = await makeTestApp({ webDistDir: join(mkdtempSync(join(tmpdir(), 'ff-empty-')), 'dist') });
    const res = await request(t.app).get('/home');
    expect(res.status).toBe(503);
    expect(res.text).toContain('npm run build');
  });
});
