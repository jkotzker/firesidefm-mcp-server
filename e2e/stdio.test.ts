import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture } from '../test/helpers/fake-fetch.js';
import { EP, POD, TOKEN } from '../test/helpers/deps.js';

// Runs the built dist/cli.js as an MCP host would, over stdio, against a local stand-in for the
// Fireside API. Nothing leaves the machine. Run with `npm run test:e2e`, which builds first.

const routes: Record<string, unknown> = {
  'GET /api/v1/me': (() => {
    const me = fixture('me') as { data: { api_token: { access: string } } };
    me.data.api_token.access = 'read_and_write';
    return me;
  })(),
  'GET /api/v1/podcasts': fixture('podcasts'),
  [`GET /api/v1/podcasts/${POD}`]: fixture('podcast'),
  [`GET /api/v1/podcasts/${POD}/episodes`]: fixture('episodes'),
  [`GET /api/v1/podcasts/${POD}/episodes/${EP}`]: fixture('episode'),
};

let api: Server;
let baseUrl: string;
const seen: { method: string; path: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization });
    // The documented podcasts example points at a page 2; serve it as an empty last page.
    const body =
      url.pathname === '/api/v1/podcasts' && url.searchParams.get('page') === '2'
        ? { data: [], pagination: { page: 2, per_page: 50, max_per_page: 50, previous: 1, next: null } }
        : routes[`${req.method} ${url.pathname}`];
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: { message: 'Not found', code: 'not_found' } }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v1/`;
});

afterAll(() => {
  api.close();
});

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/cli.js', import.meta.url).pathname],
    env: { PATH: process.env.PATH ?? '', FIRESIDE_API_BASE_URL: baseUrl, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

describe('built server over stdio', () => {
  it('starts with a Read/Write key, offers all tools, and answers a call', async () => {
    const client = await connect({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_PODCAST: 'my-podcast' });
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(11);

      const result = (await client.callTool({ name: 'fireside_get_episode', arguments: { episode: '42' } })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ token: EP, title: 'Alternating Currents' });
      expect(seen.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('honours FIRESIDE_READ_ONLY', async () => {
    const client = await connect({ FIRESIDE_API_TOKEN: TOKEN, FIRESIDE_READ_ONLY: 'true' });
    try {
      expect((await client.listTools()).tools).toHaveLength(7);
    } finally {
      await client.close();
    }
  });

  it('exits with an explanation when no token is configured', async () => {
    const child = spawnSync(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname], {
      env: { PATH: process.env.PATH ?? '' },
      input: '',
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('FIRESIDE_API_TOKEN is not set');
    expect(child.stdout).toBe('');
  });
});
