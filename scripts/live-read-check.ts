// Read-only check against the real Fireside API. Run by hand, never in CI:
//
//   security add-generic-password -U -s firesidefm-mcp-server -a read-only -w   # once; prompts for the key
//   npm run build && npx tsx scripts/live-read-check.ts
//
// It refuses to run unless the key is Read Only, sends only GET requests, and prints field names,
// counts and slugs, never response values such as preview URLs or download figures.

import { execFileSync } from 'node:child_process';

import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type * as z from 'zod/v4';

import { FiresideClient } from '../src/fireside/client.js';
import {
  downloadsSchema,
  episodeMetricsSchema,
  episodeSchema,
  meSchema,
  monthlyDownloadsEnvelope,
  monthlyDownloadsSchema,
  paginationSchema,
  podcastSchema,
} from '../src/fireside/schemas.js';

const KEYCHAIN_SERVICE = 'firesidefm-mcp-server';
const KEYCHAIN_ACCOUNT = 'read-only';

function readToken(): string {
  return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
    encoding: 'utf8',
  }).trim();
}

const getOnly: typeof fetch = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`Refusing ${method} ${String(input)}: this check sends only GET requests.`);
  return fetch(input, init);
};

let failures = 0;
function report(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Field names present but undocumented, and documented but absent. */
function compareKeys(label: string, value: unknown, schema: z.ZodObject) {
  const documented = Object.keys(schema.shape);
  const actual = Object.keys(value as object);
  const extra = actual.filter((k) => !documented.includes(k));
  const missing = documented.filter((k) => !actual.includes(k));
  console.log(
    `     ${label}: ${actual.length} fields; undocumented: ${extra.join(', ') || 'none'}; absent: ${missing.join(', ') || 'none'}`,
  );
}

async function direct(token: string) {
  console.log('\n# Fireside API, called directly');
  const client = new FiresideClient({ token, fetch: getOnly });

  const me = await client.getMe();
  report('GET me', true, `key access ${me.data.api_token.access}`);
  compareKeys('me', me.data, meSchema);
  compareKeys('me.api_token', me.data.api_token, meSchema.shape.api_token);
  if (me.data.api_token.access !== 'read_only') {
    throw new Error('This key is not Read Only. Stopping before any further request.');
  }

  const podcasts = await client.listPodcasts();
  report('GET podcasts', podcasts.data.length > 0, `${podcasts.data.length} podcast(s): ${podcasts.data.map((p) => p.slug).join(', ')}`);
  compareKeys('pagination', podcasts.pagination, paginationSchema);
  const pod = podcasts.data[0];
  if (!pod) throw new Error('The key sees no podcasts.');
  compareKeys('podcast (list item)', pod, podcastSchema);

  const podcast = await client.getPodcast(pod.token);
  report('GET podcasts/:podcast', podcast.data.token === pod.token);
  compareKeys('podcast', podcast.data, podcastSchema);

  const episodes = await client.listEpisodes(pod.token, { per_page: 25 });
  const byStatus: Record<string, number> = {};
  for (const e of episodes.data) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  report(
    'GET episodes',
    true,
    `page 1: ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}; next page ${episodes.pagination.next ?? 'none'}`,
  );
  const published = episodes.data.find((e) => e.status === 'published');
  if (episodes.data[0]) compareKeys('episode (list item)', episodes.data[0], episodeSchema);

  if (published) {
    const episode = await client.getEpisode(pod.token, published.token);
    report('GET episodes/:episode', episode.data.token === published.token, `published episode slug ${published.slug}`);
    compareKeys('episode', episode.data, episodeSchema);
  } else {
    report('GET episodes/:episode', false, 'no published episode on page 1 to read');
  }

  const metrics = await client.getEpisodeMetrics(pod.token, { per_page: 5 });
  report('GET metrics/episodes', true, `${metrics.data.length} item(s)`);
  if (metrics.data[0]) {
    compareKeys('episode metrics item', metrics.data[0], episodeMetricsSchema);
    compareKeys('episode metrics downloads', metrics.data[0].downloads, downloadsSchema);
  }

  const monthly = await client.getMonthlyDownloads(pod.token, { per_page: 3 });
  report('GET metrics/downloads', true, `${monthly.data.length} month(s)`);
  if (monthly.data[0]) compareKeys('monthly downloads item', monthly.data[0], monthlyDownloadsSchema);
  compareKeys('monthly downloads meta', monthly.meta, monthlyDownloadsEnvelope.shape.meta);

  return { podcastSlug: pod.slug, episodeSlug: published?.slug };
}

async function overMcp(token: string, podcastSlug: string, episodeSlug: string | undefined) {
  console.log('\n# MCP server (dist/cli.js) over stdio');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/cli.js', import.meta.url).pathname],
    env: { PATH: process.env.PATH ?? '', FIRESIDE_API_TOKEN: token, FIRESIDE_READ_ONLY: 'true' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'live-read-check', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    report('protocol version', true, client.getNegotiatedProtocolVersion() ?? 'unknown');
    const { tools } = await client.listTools();
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    report('only read tools offered', tools.length === 7 && writes.length === 0, `${tools.length} tools; write tools: ${writes.join(', ') || 'none'}`);

    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;

    const account = await call('fireside_get_account', {});
    report('fireside_get_account', !account.isError, account.isError ? textOf(account) : '');

    const list = await call('fireside_list_episodes', { podcast: podcastSlug, per_page: 3 });
    const listed = (list.structuredContent as { episodes?: Record<string, unknown>[] } | undefined)?.episodes ?? [];
    report('fireside_list_episodes by podcast slug', !list.isError && listed.length > 0, list.isError ? textOf(list) : `${listed.length} episode(s)`);
    report('list output omits preview_url', listed.every((e) => !('preview_url' in e)));

    if (episodeSlug) {
      const one = await call('fireside_get_episode', { podcast: podcastSlug, episode: episodeSlug });
      report('fireside_get_episode by episode slug', !one.isError, one.isError ? textOf(one) : `slug ${episodeSlug}`);
    }
  } finally {
    await client.close();
  }
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
}

const token = readToken();
console.log(`Key from Keychain: ${token.length} characters, ${/^fire_[0-9a-f]{64}$/.test(token) ? 'expected format' : 'UNEXPECTED format'}`);
const { podcastSlug, episodeSlug } = await direct(token);
await overMcp(token, podcastSlug, episodeSlug);
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exitCode = failures === 0 ? 0 : 1;
