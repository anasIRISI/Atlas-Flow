import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT } from '@flowforge/shared';
import { ConfigError, loadConfig } from '../src/config.js';
import { ROOT_DIR } from '../src/paths.js';

describe('config', () => {
  it('works with an empty environment (no .env file)', () => {
    const config = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.dataDir).toBe(join(ROOT_DIR, "data"));
    expect(config.localUrl).toBe(`http://localhost:${DEFAULT_PORT}`);
    expect(config.sessionTtlMs).toBe(7 * 24 * 3600 * 1000);
  });

  it('treats blank values (copied from .env.example) as unset', () => {
    const config = loadConfig({ PORT: '', PUBLIC_URL: '  ', FLOWFORGE_DATA_DIR: '' });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.dataDir).toBe(join(ROOT_DIR, "data"));
  });

  it('uses PUBLIC_URL without trailing slash', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://abc.trycloudflare.com/' }).publicUrl).toBe('https://abc.trycloudflare.com');
  });

  it('falls back to localhost when bound to loopback only', () => {
    expect(loadConfig({ HOST: '127.0.0.1', PORT: '6000' }).publicUrl).toBe('http://localhost:6000');
  });

  it('resolves a relative data dir against the repo root', () => {
    expect(loadConfig({ FLOWFORGE_DATA_DIR: 'tmp/ffdata' }).dataDir).toBe(join(ROOT_DIR, "tmp", "ffdata"));
  });

  it('reports every invalid value in one readable error', () => {
    expect(() => loadConfig({ PORT: 'abc', PUBLIC_URL: 'not a url' })).toThrowError(ConfigError);
    try {
      loadConfig({ PORT: 'abc', PUBLIC_URL: 'ftp://x.y' });
    } catch (err) {
      expect((err as Error).message).toMatch(/PORT/);
      expect((err as Error).message).toMatch(/PUBLIC_URL/);
    }
  });
});
