import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

export type Era = 'modern' | 'legacy';

export interface Connected {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Connects an SDK client to a server factory in-process, with no port bound.
 * 'modern' negotiates protocol 2026-07-28 via server/discover; 'legacy' uses the
 * 2025-era initialize handshake that older hosts still send.
 */
export async function connect(factory: () => McpServer, era: Era = 'modern'): Promise<Connected> {
  const handler = createMcpHandler(() => factory());
  const transport = new StreamableHTTPClientTransport(new URL('http://in-process.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}
