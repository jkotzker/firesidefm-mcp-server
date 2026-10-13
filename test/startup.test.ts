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

  it('rejects an unrecognised read-only value', () => {
    expect(() => loadConfig({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_READ_ONLY: 'yes' })).toThrow(/true or false/);
  });
});

describe('startup', () => {
  it('offers write tools for a Read/Write key', async () => {
    const { deps, notices } = await start({}, [{ method: 'GET', path: 'me', body: meWith('read_and_write') }]);
    expect(deps.writeTools).toBe(true);
    expect(notices.join('\n')).toContain('Read/Write key');
  });

  it('withholds write tools for a Read Only key', async () => {
    const { deps } = await start({}, [{ method: 'GET', path: 'me', body: meWith('read_only') }]);
    expect(deps.writeTools).toBe(false);
  });

  it('withholds write tools when FIRESIDE_READ_ONLY is set', async () => {
    const { deps, notices } = await start({ FIRESIDE_READ_ONLY: 'true' }, [
      { method: 'GET', path: 'me', body: meWith('read_and_write') },
    ]);
    expect(deps.writeTools).toBe(false);
    expect(notices.join('\n')).toContain('disabled by FIRESIDE_READ_ONLY');
  });

  it('fails on a rejected key', async () => {
    await expect(
      start({}, [{ method: 'GET', path: 'me', status: 401, body: fixture('error-unauthorized') }]),
    ).rejects.toThrow(/rejected FIRESIDE_API_TOKEN/);
  });

  it('starts read-only when the key cannot be checked', async () => {
    const { deps, notices } = await start({}, [{ method: 'GET', path: 'me', status: 503, body: 'down' }]);
    expect(deps.writeTools).toBe(false);
    expect(notices.join('\n')).toContain('only read tools are offered');
  });
});
