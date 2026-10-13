import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';
import { startup } from '../src/startup.js';
import { TOKEN } from './helpers/deps.js';
import { fakeFetch, fixture, type Route } from './helpers/fake-fetch.js';

function meWith(access: 'read_only' | 'read_and_write') {
  const me = fixture('me') as { data: { api_token: { access: string } } };
  me.data.api_token.access = access;
  return me;
}

async function start(env: Record<string, string>, routes: Route[]) {
  const fake = fakeFetch(routes);
  return startup({ FIRESIDE_API_TOKEN: TOKEN, ...env }, { fetch: fake.fetch, sleep: async () => {} });
}

describe('loadConfig', () => {
  it('requires FIRESIDE_API_TOKEN', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ FIRESIDE_API_TOKEN: '  ' })).toThrow(/FIRESIDE_API_TOKEN is not set/);
  });

  it('warns about, but accepts, a token in an unexpected format', () => {
    const { config, warnings } = loadConfig({ FIRESIDE_API_TOKEN: 'abc' });
    expect(config.apiToken).toBe('abc');
    expect(warnings).toHaveLength(1);
  });

  it('reads the default podcast and read-only flag', () => {
    const { config, warnings } = loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_PODCAST: ' my-podcast ', FIRESIDE_READ_ONLY: 'TRUE' });
    expect(config).toEqual({ apiToken: TOKEN, defaultPodcast: 'my-podcast', readOnly: true });
    expect(warnings).toEqual([]);
  });

  it.each([
    ['a line break', `${TOKEN.slice(0, 30)}\n${TOKEN.slice(30)}`],
    ['a space', `${TOKEN.slice(0, 30)} ${TOKEN.slice(30)}`],
    ['a non-ASCII character', `${TOKEN}\u200b`],
  ])('rejects a token containing %s without echoing it', (_label, token) => {
    const error = (() => {
      try {
        loadConfig({ FIRESIDE_API_TOKEN: token });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).not.toContain(TOKEN.slice(0, 20));
  });

  it('reads FIRESIDE_UPLOAD_DIRS as a path list, expanding ~', () => {
    const { config } = loadConfig({
      FIRESIDE_API_TOKEN: TOKEN,
      FIRESIDE_UPLOAD_DIRS: ` /podcast/audio${delimiter}~/Episodes/ ${delimiter}`,
    });
    expect(config.uploadDirs).toEqual(['/podcast/audio', join(homedir(), 'Episodes')]);
  });

  it('rejects a relative upload directory', () => {
    expect(() => loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_UPLOAD_DIRS: 'episodes' })).toThrow(
      /absolute directories, not "episodes"/,
    );
  });

  it('normalises FIRESIDE_API_BASE_URL and warns that it is in use', () => {
    const { config, warnings } = loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_API_BASE_URL: 'http://127.0.0.1:9/api/v1' });
    expect(config.apiBaseUrl).toBe('http://127.0.0.1:9/api/v1/');
    expect(warnings.join('\n')).toContain('http://127.0.0.1:9/api/v1/');
  });

  it.each(['localhost:9/api', 'ftp://example.com/api/', 'not a url'])('rejects FIRESIDE_API_BASE_URL %s', (url) => {
    expect(() => loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_API_BASE_URL: url })).toThrow(ConfigError);
  });

  it('rejects an unrecognised read-only value', () => {
    expect(() => loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_READ_ONLY: 'yes' })).toThrow(/true or false/);
  });
});

describe('startup', () => {
  it('offers write tools for a Read/Write key', async () => {
    const { deps, notices } = await start({}, [{ method: 'GET', path: 'me', body: meWith('read_and_write') }]);
    expect(deps.access).toBe('read_write');
    expect(deps.uploadDirs).toEqual([]);
    expect(notices.join('\n')).toContain('Read/Write key');
    expect(notices.join('\n')).toContain('File uploads are off: set FIRESIDE_UPLOAD_DIRS');
  });

  it('passes upload directories on and names them', async () => {
    const { deps, notices } = await start({ FIRESIDE_UPLOAD_DIRS: '/podcast/audio' }, [
      { method: 'GET', path: 'me', body: meWith('read_and_write') },
    ]);
    expect(deps.uploadDirs).toEqual(['/podcast/audio']);
    expect(notices.join('\n')).toContain('Files can be uploaded from /podcast/audio.');
    expect(notices.join('\n')).toContain('lists /podcast/audio, which is not an existing directory');
  });

  it('withholds write tools for a Read Only key', async () => {
    const { deps } = await start({}, [{ method: 'GET', path: 'me', body: meWith('read_only') }]);
    expect(deps.access).toBe('read_only_key');
  });

  it('withholds write tools when FIRESIDE_READ_ONLY is set', async () => {
    const { deps, notices } = await start({ FIRESIDE_READ_ONLY: 'true' }, [
      { method: 'GET', path: 'me', body: meWith('read_and_write') },
    ]);
    expect(deps.access).toBe('read_only_setting');
    expect(notices.join('\n')).toContain('disabled by FIRESIDE_READ_ONLY');
  });

  it('fails on a rejected key', async () => {
    await expect(
      start({}, [{ method: 'GET', path: 'me', status: 401, body: fixture('error-unauthorized') }]),
    ).rejects.toSatisfy((e) => e instanceof ConfigError && /rejected FIRESIDE_API_TOKEN/.test(e.message));
  });

  it('starts read-only when the key cannot be checked', async () => {
    const { deps, notices } = await start({}, [{ method: 'GET', path: 'me', status: 503, body: 'down' }]);
    expect(deps.access).toBe('unverified');
    expect(notices.join('\n')).toContain('only read tools are offered; restart the server to try again');
  });

  it('does not hold up startup waiting out a rate limit', async () => {
    const sleeps: number[] = [];
    const fake = fakeFetch([
      { method: 'GET', path: 'me', status: 429, body: fixture('error-rate-limited'), headers: { 'Retry-After': '5' } },
    ]);
    const { deps } = await startup(
      { FIRESIDE_API_TOKEN: TOKEN },
      { fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(deps.access).toBe('unverified');
    expect(sleeps).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });
});
