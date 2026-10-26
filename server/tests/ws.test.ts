import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import type { ServerEvent } from '@flowforge/shared';
import { listen, makeTestApp, OWNER, type TestApp } from './helpers.js';

let t: TestApp;
let base: string;
let cookie: string;

beforeEach(async () => {
  t = await makeTestApp();
  base = await listen(t);
  const res = await request(t.app).post('/api/auth/setup').send(OWNER);
  cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
});
afterEach(async () => {
  await t.close();
});

/** Opens a socket and collects every message it receives. */
function connect(headers: Record<string, string> = {}) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
  const messages: ServerEvent[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const next = (type: ServerEvent['type']) =>
    new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
      const check = () => {
        const found = messages.find((m) => m.type === type);
        if (found) {
          clearTimeout(timer);
          messages.splice(messages.indexOf(found), 1);
          resolve(found);
        } else setTimeout(check, 10);
      };
      check();
    });
  return { socket, next };
}

describe('websocket hub', () => {
  it('rejects connections without a valid session', async () => {
    const { socket } = connect();
    const status = await new Promise<number>((resolve) => socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it('closes upgrade requests to other paths', async () => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/not-ws`, { headers: { Cookie: cookie } });
    const status = await new Promise<number>((resolve) => socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(404);
  });

  it('greets an authenticated client and answers pings', async () => {
    const { socket, next } = connect({ Cookie: cookie });
    const ready = await next('connection.ready');
    expect(ready.data).toMatchObject({ serverVersion: '0.1.0' });
    expect(typeof ready.ts).toBe('number');
    socket.send(JSON.stringify({ type: 'ping' }));
    await next('pong');
    socket.close();
  });

  it('delivers room events only to subscribers', async () => {
    const a = connect({ Cookie: cookie });
    const b = connect({ Cookie: cookie });
    await a.next('connection.ready');
    await b.next('connection.ready');
    a.socket.send(JSON.stringify({ type: 'subscribe', room: 'workflow:wf1' }));
    a.socket.send(JSON.stringify({ type: 'ping' }));
    await a.next('pong'); // subscription processed (messages are handled in order)

    t.ws.publish('workflow:wf1', 'error', { message: 'room event' });
    const got = await a.next('error');
    expect(got.data).toEqual({ message: 'room event' });
    await expect(b.next('error')).rejects.toThrow(/timeout/);
    a.socket.close();
    b.socket.close();
  });

  it('answers garbage with an error instead of crashing', async () => {
    const { socket, next } = connect({ Cookie: cookie });
    await next('connection.ready');
    socket.send('not json');
    expect((await next('error')).data).toEqual({ message: 'Messages must be JSON.' });
    socket.send(JSON.stringify({ type: 'subscribe', room: 'admin:all' }));
    expect(((await next('error')).data as { message: string }).message).toMatch(/Invalid room/);
    socket.send(JSON.stringify({ type: 'ping' }));
    await next('pong');
    socket.close();
  });
});
