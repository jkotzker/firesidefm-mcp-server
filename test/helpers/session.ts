import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterEach } from 'vitest';

import { serverWith } from './deps.js';
import type { Route } from './fake-fetch.js';
import { connect, type Connected, type Era } from './mcp.js';

/**
 * Returns an `open` that connects a client to a server answering from `routes`, closing it after each
 * test. Call once at the top of a test file.
 */
export function session() {
  let conn: Connected | undefined;
  afterEach(async () => {
    await conn?.close();
    conn = undefined;
  });

  return async function open(routes: Route[], options: Parameters<typeof serverWith>[1] = {}, era: Era = 'modern') {
    const server = serverWith(routes, options);
    conn = await connect(server.factory, era);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await conn!.client.callTool({ name, arguments: args })) as CallToolResult;
    return { call, requests: server.requests, client: conn.client };
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}
