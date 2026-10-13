import { describe, expect, it } from 'vitest';

import { FiresideClient } from '../src/fireside/client.js';
import { FiresideApiError, FiresideResponseShapeError } from '../src/fireside/errors.js';
import { fakeFetch, fixture, type Route } from './helpers/fake-fetch.js';

const TOKEN = `fire_${'a'.repeat(64)}`;
const POD = '550e8400-e29b-41d4-a716-446655440000';
const EP = '6a20c700-51d3-4c0a-abe7-da88d972a27c';

function client(routes: Route[], extra: { sleeps?: number[] } = {}) {
  const fake = fakeFetch(routes);
  const sleeps = extra.sleeps ?? [];
  const c = new FiresideClient({
    token: TOKEN,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, requests: fake.requests, sleeps };
}

describe('FiresideClient reads', () => {
  it('sends the bearer token, JSON accept header and a user agent', async () => {
    const { c, requests } = client([{ method: 'GET', path: 'me', body: fixture('me') }]);
    const me = await c.getMe();
    expect(me.data.api_token.access).toBe('read_only');
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.headers.get('accept')).toBe('application/json');
    expect(requests[0]!.headers.get('user-agent')).toMatch(/^firesidefm-mcp-server\//);
    expect(requests[0]!.body).toBeUndefined();
  });

  it('lists podcasts with pagination parameters', async () => {
    const { c, requests } = client([{ method: 'GET', path: 'podcasts', body: fixture('podcasts') }]);
    const res = await c.listPodcasts({ page: 2, per_page: 10 });
    expect(res.data[0]!.token).toBe(POD);
    expect(res.pagination.next).toBe(2);
    expect(requests[0]!.url.searchParams.get('page')).toBe('2');
    expect(requests[0]!.url.searchParams.get('per_page')).toBe('10');
  });

  it('omits unset query parameters', async () => {
    const { c, requests } = client([{ method: 'GET', path: `podcasts/${POD}/episodes`, body: fixture('episodes') }]);
    await c.listEpisodes(POD);
    expect([...requests[0]!.url.searchParams.keys()]).toEqual([]);
  });

  it('gets a podcast including total_downloads', async () => {
    const { c } = client([{ method: 'GET', path: `podcasts/${POD}`, body: fixture('podcast') }]);
    expect((await c.getPodcast(POD)).data.total_downloads).toBe(50000);
  });

  it('lists episodes filtered by status', async () => {
    const { c, requests } = client([{ method: 'GET', path: `podcasts/${POD}/episodes`, body: fixture('episodes') }]);
    const res = await c.listEpisodes(POD, { status: 'draft', per_page: 5 });
    expect(res.data[0]!.hosts[0]!.name).toBe('Jane Doe');
    expect(requests[0]!.url.searchParams.get('status')).toBe('draft');
  });

  it('gets an episode with its description', async () => {
    const { c } = client([{ method: 'GET', path: `podcasts/${POD}/episodes/${EP}`, body: fixture('episode') }]);
    expect((await c.getEpisode(POD, EP)).data.description).toContain('Markdown');
  });

  it('gets episode metrics and monthly downloads', async () => {
    const { c } = client([
      { method: 'GET', path: `podcasts/${POD}/metrics/episodes`, body: fixture('episode-metrics') },
      { method: 'GET', path: `podcasts/${POD}/metrics/downloads`, body: fixture('monthly-downloads') },
    ]);
    expect((await c.getEpisodeMetrics(POD)).data[0]!.downloads.total).toBe(5000);
    const monthly = await c.getMonthlyDownloads(POD);
    expect(monthly.meta.total_downloads).toBe(50000);
    expect(monthly.data[0]).toEqual({ date: '2026-03-01', value: 1500 });
  });

  it('URL-encodes path segments', async () => {
    const { c, requests } = client([{ method: 'GET', path: 'podcasts/a%2Fb', body: fixture('podcast') }]);
    await c.getPodcast('a/b');
    expect(requests[0]!.url.pathname).toBe('/api/v1/podcasts/a%2Fb');
  });

  it('passes through fields the docs do not list yet', async () => {
    const body = fixture('podcast') as { data: Record<string, unknown> };
    body.data.brand_new_field = 'hello';
    const { c } = client([{ method: 'GET', path: `podcasts/${POD}`, body }]);
    expect((await c.getPodcast(POD)).data).toHaveProperty('brand_new_field', 'hello');
  });
});

describe('FiresideClient writes', () => {
  it('creates an episode with a JSON body', async () => {
    const { c, requests } = client([
      { method: 'POST', path: `podcasts/${POD}/episodes`, status: 201, body: fixture('episode') },
    ]);
    await c.createEpisode(POD, { title: 'Hello', season: 1, episode_type: 'bonus' });
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
    expect(requests[0]!.body).toEqual({ title: 'Hello', season: 1, episode_type: 'bonus' });
  });

  it('updates an episode with PATCH and only the given fields', async () => {
    const { c, requests } = client([{ method: 'PATCH', path: `podcasts/${POD}/episodes/${EP}`, body: fixture('episode') }]);
    await c.updateEpisode(POD, EP, { subtitle: null });
    expect(requests[0]!.body).toEqual({ subtitle: null });
  });

  it('publishes with schedule and visibility', async () => {
    const { c, requests } = client([
      { method: 'POST', path: `podcasts/${POD}/episodes/${EP}/publish`, body: fixture('episode') },
    ]);
    await c.publishEpisode(POD, EP, { published_at: '2026-10-12T09:00:00-04:00', visibility: 'unlisted' });
    expect(requests[0]!.body).toEqual({ published_at: '2026-10-12T09:00:00-04:00', visibility: 'unlisted' });
  });

  it('unpublishes with no body', async () => {
    const { c, requests } = client([
      { method: 'POST', path: `podcasts/${POD}/episodes/${EP}/unpublish`, body: fixture('episode') },
    ]);
    await c.unpublishEpisode(POD, EP);
    expect(requests[0]!.body).toBeUndefined();
  });
});

describe('FiresideClient errors', () => {
  it.each([
    [401, 'error-unauthorized', 'unauthorized'],
    [403, 'error-write-access', 'write_access_required'],
    [422, 'error-validation', 'validation_failed'],
  ])('maps HTTP %i to a FiresideApiError with its code', async (status, name, code) => {
    const { c } = client([{ method: 'POST', path: `podcasts/${POD}/episodes`, status, body: fixture(name) }]);
    const error = await c.createEpisode(POD, { title: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FiresideApiError);
    expect((error as FiresideApiError).details).toMatchObject({ status, code, method: 'POST' });
  });

  it('carries per-field validation messages', async () => {
    const { c } = client([{ method: 'POST', path: `podcasts/${POD}/episodes`, status: 422, body: fixture('error-validation') }]);
    const error = (await c.createEpisode(POD, { slug: 'taken' }).catch((e: unknown) => e)) as FiresideApiError;
    expect(error.message).toBe('slug has already been taken');
    expect(error.details.fields).toEqual({ slug: ['has already been taken'] });
  });

  it('handles a non-JSON error body', async () => {
    const { c } = client([{ method: 'GET', path: 'me', status: 502, body: '<html>Bad Gateway</html>' }]);
    const error = (await c.getMe().catch((e: unknown) => e)) as FiresideApiError;
    expect(error.details.status).toBe(502);
    expect(error.message).toContain('HTTP 502');
  });

  it('keeps the body of a JSON error in an undocumented shape', async () => {
    const { c } = client([{ method: 'POST', path: `podcasts/${POD}/episodes`, status: 400, body: { errors: ['title is weird'] } }]);
    const error = (await c.createEpisode(POD, { title: 'x' }).catch((e: unknown) => e)) as FiresideApiError;
    expect(error.message).toContain('title is weird');
  });

  it('accepts field errors that are not lists of strings', async () => {
    const body = { error: { message: 'Invalid', code: 'validation_failed', fields: { season: 'must be a number' } } };
    const { c } = client([{ method: 'POST', path: `podcasts/${POD}/episodes`, status: 422, body }]);
    const error = (await c.createEpisode(POD, { title: 'x' }).catch((e: unknown) => e)) as FiresideApiError;
    expect(error.details).toMatchObject({ code: 'validation_failed', fields: { season: 'must be a number' } });
  });

  it('times out a request Fireside never answers', async () => {
    const c = new FiresideClient({
      token: TOKEN,
      requestTimeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    });
    const error = (await c.getMe().catch((e: unknown) => e)) as FiresideApiError;
    expect(error).toBeInstanceOf(FiresideApiError);
    expect(error.message).toContain('did not respond within 0.05 seconds');
  });

  it('wraps network failures', async () => {
    const c = new FiresideClient({
      token: TOKEN,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = (await c.getMe().catch((e: unknown) => e)) as FiresideApiError;
    expect(error).toBeInstanceOf(FiresideApiError);
    expect(error.details.status).toBeUndefined();
    expect(error.message).toContain('Could not reach Fireside');
  });

  it('reports a response that does not match the documented shape', async () => {
    const { c } = client([{ method: 'GET', path: 'me', body: { data: { name: 'x' } } }]);
    await expect(c.getMe()).rejects.toBeInstanceOf(FiresideResponseShapeError);
  });
});

describe('FiresideClient rate limiting', () => {
  const limited: Route = {
    method: 'GET',
    path: 'me',
    status: 429,
    body: fixture('error-rate-limited'),
    headers: { 'Retry-After': '3' },
  };

  it('waits out Retry-After and retries', async () => {
    const { c, sleeps, requests } = client([limited, { method: 'GET', path: 'me', body: fixture('me') }]);
    await c.getMe();
    expect(sleeps).toEqual([3000]);
    expect(requests).toHaveLength(2);
  });

  it('gives up after the retry budget', async () => {
    const { c, sleeps } = client([limited, limited, limited]);
    const error = (await c.getMe().catch((e: unknown) => e)) as FiresideApiError;
    expect(error.details).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 3 });
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('does not wait out an unreasonably long Retry-After', async () => {
    const { c, sleeps } = client([{ ...limited, headers: { 'Retry-After': '600' } }]);
    await expect(c.getMe()).rejects.toBeInstanceOf(FiresideApiError);
    expect(sleeps).toEqual([]);
  });

  it('stops waiting when the request is cancelled', async () => {
    const fake = fakeFetch([limited]);
    const c = new FiresideClient({ token: TOKEN, fetch: fake.fetch });
    const controller = new AbortController();
    const pending = c.getMe(controller.signal);
    setTimeout(() => controller.abort(new Error('cancelled')), 10);
    await expect(pending).rejects.toThrow('cancelled');
  });
});
