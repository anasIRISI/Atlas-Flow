import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@flowforge/shared';
import { makeTestApp, OWNER, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('owner setup', () => {
  it('reports setupRequired on a fresh install', async () => {
    const res = await request(t.app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ setupRequired: true, user: null });
  });

  it('creates the owner, signs them in, and refuses a second setup', async () => {
    const agent = request.agent(t.app);
    const res = await agent.post('/api/auth/setup').send(OWNER);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: OWNER.email, firstName: 'Ada', role: 'owner' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const status = await agent.get('/api/auth/status');
    expect(status.body.setupRequired).toBe(false);
    expect(status.body.user.email).toBe(OWNER.email);

    const again = await request(t.app).post('/api/auth/setup').send({ ...OWNER, email: 'other@x.io' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already exists/);
  });

  it('validates input with readable messages', async () => {
    const weak = await request(t.app).post('/api/auth/setup').send({ ...OWNER, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toMatch(/Password needs/);

    const badEmail = await request(t.app).post('/api/auth/setup').send({ ...OWNER, email: 'nope' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.message).toBe('email: Enter a valid email address');

    const missing = await request(t.app).post('/api/auth/setup').send({ email: 'a@b.co', password: 'Forge2026' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/firstName: First name is required/);
  });

  it('rejects broken JSON with 400, not 500', async () => {
    const res = await request(t.app).post('/api/auth/setup').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });
});

describe('login / logout', () => {
  beforeEach(async () => {
    await request(t.app).post('/api/auth/setup').send(OWNER);
  });

  it('protects private routes', async () => {
    const res = await request(t.app).get('/api/system/info');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/sign in/i);
  });

  it('signs in (email is case-insensitive), reads private data, signs out', async () => {
    const agent = request.agent(t.app);
    const login = await agent.post('/api/auth/login').send({ email: 'OWNER@flowforge.test', password: OWNER.password });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(OWNER.email);

    const info = await agent.get('/api/system/info');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ version: '0.1.0', localUrl: expect.stringContaining('http://localhost:') });

    expect((await agent.get('/api/auth/me')).body.user.email).toBe(OWNER.email);
    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await agent.get('/api/auth/status')).body.user).toBeNull();
  });

  it('rejects a wrong password and an unknown email with the same message', async () => {
    const wrong = await request(t.app).post('/api/auth/login').send({ email: OWNER.email, password: 'Wrong1234' });
    const unknown = await request(t.app).post('/api/auth/login').send({ email: 'x@y.zz', password: 'Wrong1234' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('blocks brute force after 10 failures', async () => {
    for (let i = 0; i < 10; i++) {
      await request(t.app).post('/api/auth/login').send({ email: OWNER.email, password: `Wrong${i}xx` });
    }
    const blocked = await request(t.app).post('/api/auth/login').send(OWNER);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.message).toMatch(/Too many failed attempts/);
  });

  it('ignores a forged or stale cookie', async () => {
    const res = await request(t.app).get('/api/system/info').set('Cookie', `${SESSION_COOKIE}=forged`);
    expect(res.status).toBe(401);
  });
});

describe('health + unknown routes', () => {
  it('serves a public health check', async () => {
    const res = await request(t.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', name: 'FlowForge' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns JSON 404 for unknown API routes (when signed in)', async () => {
    const agent = request.agent(t.app);
    await agent.post('/api/auth/setup').send(OWNER);
    const res = await agent.get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/API route not found/);
  });
});
