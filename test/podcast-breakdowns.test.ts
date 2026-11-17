import { describe, expect, it } from 'vitest';

import { EP, POD } from './helpers/deps.js';
import { fixture } from './helpers/fake-fetch.js';
import { session, text } from './helpers/session.js';

const open = session();
const W = { writeTools: true };
const podcast = (fixture('podcast') as { data: Record<string, unknown> }).data;
const DEFAULTS = {
  subtitle: null,
  description: 'Thanks for listening!',
  keywords: 'tech, news',
  tags: null,
  episode_type: 'full',
  auto_season: false,
};

describe('podcast settings', () => {
  it('fireside_get_podcast returns episode_defaults when Fireside sends them', async () => {
    const { call } = await open([{ method: 'GET', path: `podcasts/${POD}`, body: { data: { ...podcast, episode_defaults: DEFAULTS } } }]);
    const result = await call('fireside_get_podcast', { podcast: POD });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ episode_defaults: DEFAULTS });
  });

  it('fireside_update_podcast is offered only with write access', async () => {
    for (const [options, offered] of [
      [W, true],
      [{}, false],
    ] as const) {
      const { client } = await open([], options);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.includes('fireside_update_podcast')).toBe(offered);
    }
  });

  it('fireside_update_podcast PATCHes only the fields and defaults given', async () => {
    const { total_downloads: _omitted, ...updated } = podcast;
    const { call, requests } = await open([{ method: 'PATCH', path: `podcasts/${POD}`, body: { data: updated } }], W);
    const result = await call('fireside_update_podcast', {
      podcast: POD,
      description: 'A weekly show about things.',
      subtitle: null,
      episode_defaults: { episode_type: 'full', keywords: null },
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.method).toBe('PATCH');
    expect(requests[0]!.body).toEqual({
      description: 'A weekly show about things.',
      subtitle: null,
      episode_defaults: { episode_type: 'full', keywords: null },
    });
    expect(result.structuredContent).toMatchObject({ token: POD });
  });

  it.each([
    ['nothing', {}],
    ['an empty episode_defaults', { episode_defaults: {} }],
  ])('fireside_update_podcast refuses %s', async (_label, args) => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_update_podcast', { podcast: POD, ...args });
    expect(text(result)).toContain('Nothing to change');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['the title', { title: 'New name' }],
    ['an unknown episode default', { episode_defaults: { footer: 'x' } }],
    ['a summary default over 255 characters', { episode_defaults: { subtitle: 'x'.repeat(256) } }],
  ])('fireside_update_podcast refuses %s before calling Fireside', async (_label, args) => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_update_podcast', { podcast: POD, ...args });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('explains a cover Fireside could not process without calling it an episode', async () => {
    const { call } = await open(
      [
        {
          method: 'PATCH',
          path: `podcasts/${POD}`,
          status: 422,
          body: { error: { message: 'cover.png could not be processed', code: 'upload_failed' }, data: podcast },
        },
      ],
      W,
    );
    const result = await call('fireside_update_podcast', {
      podcast: POD,
      description: 'New',
      cover_file_url: 'https://uploads.example.test/cover',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("the podcast's cover did not change; any other changes in the same call were saved");
    expect(text(result)).not.toContain('episode');
  });

  it('says a podcast change with no answer is safe to send again', async () => {
    const { call } = await open([], W);
    const result = await call('fireside_update_podcast', { podcast: POD, description: 'New' });
    expect(text(result)).toContain('Check the podcast with fireside_get_podcast');
    expect(text(result)).toContain('which is safe');
  });
});

describe('fireside_get_download_breakdown', () => {
  it.each([
    ['platforms', `podcasts/${POD}/metrics/platforms`, {}],
    ['countries', `podcasts/${POD}/metrics/countries`, {}],
    ['apps', `podcasts/${POD}/episodes/${EP}/metrics/apps`, { episode: EP }],
  ])('asks for %s at the right path', async (by, path, extra) => {
    const { call, requests } = await open([{ method: 'GET', path, body: fixture('breakdown-apps') }]);
    const result = await call('fireside_get_download_breakdown', { podcast: POD, by, ...extra });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.url.searchParams.get('per_page')).toBe('25');
  });

  it('passes the filter and returns rows, meta and pagination, with unnamed rows kept', async () => {
    const { call, requests } = await open([
      { method: 'GET', path: `podcasts/${POD}/metrics/apps`, body: fixture('breakdown-apps') },
    ]);
    const result = await call('fireside_get_download_breakdown', { podcast: POD, by: 'apps', platform: 'iOS', page: 2 });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.url.searchParams.get('platform')).toBe('iOS');
    expect(requests[0]!.url.searchParams.get('page')).toBe('2');
    expect(result.structuredContent).toMatchObject({
      rows: [{ name: 'Apple Podcasts', percent_of_platform: 74.29 }, { name: 'Overcast' }, { name: null }],
      meta: { platform: 'iOS', platform_downloads: 7000, total_downloads: 10000 },
      pagination: { next: null },
    });
  });

  it('sends country for regions', async () => {
    const { call, requests } = await open([
      { method: 'GET', path: `podcasts/${POD}/metrics/regions`, body: fixture('breakdown-apps') },
    ]);
    await call('fireside_get_download_breakdown', { podcast: POD, by: 'regions', country: 'United States' });
    expect(requests[0]!.url.searchParams.get('country')).toBe('United States');
  });

  it.each([
    ['app with apps', { by: 'apps', app: 'Overcast' }, 'app can be given only with by platforms'],
    ['platform with platforms', { by: 'platforms', platform: 'iOS' }, 'platform can be given only with by apps'],
    ['country with countries', { by: 'countries', country: 'Canada' }, 'country can be given only with by regions'],
    ['regions without a country', { by: 'regions' }, 'by regions needs country'],
  ])('refuses %s before calling Fireside', async (_label, args, message) => {
    const { call, requests } = await open([]);
    const result = await call('fireside_get_download_breakdown', { podcast: POD, ...args });
    expect(text(result)).toContain(message);
    expect(requests).toHaveLength(0);
  });

  it('explains advanced_metrics_required', async () => {
    const { call } = await open([
      {
        method: 'GET',
        path: `podcasts/${POD}/metrics/countries`,
        status: 403,
        body: { error: { message: 'Advanced Metrics required', code: 'advanced_metrics_required' } },
      },
    ]);
    const result = await call('fireside_get_download_breakdown', { podcast: POD, by: 'countries' });
    expect(text(result)).toContain('need a Fireside plan with Advanced Metrics');
  });
});
