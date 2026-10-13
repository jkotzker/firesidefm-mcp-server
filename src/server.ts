import { McpServer } from '@modelcontextprotocol/server';

import type { FiresideClient } from './fireside/client.js';
import { registerReadTools } from './tools/read.js';
import type { Resolver } from './tools/resolve.js';
import { registerWriteTools } from './tools/write.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface ServerDeps {
  client: FiresideClient;
  resolver: Resolver;
  /** Register the tools that change episodes. */
  writeTools: boolean;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Tools for a Fireside.fm podcast hosting account. Podcasts and episodes can be named by token or slug ' +
        '(episode slugs default to the episode number but are often customised, e.g. s02e04). Audio cannot be uploaded through the API. ' +
        (deps.writeTools
          ? 'Publishing is public and may post to connected social accounts, so confirm before publishing.'
          : 'This server is read-only: the API key is Read Only or FIRESIDE_READ_ONLY is set.'),
    },
  );
  registerReadTools(server, deps);
  if (deps.writeTools) registerWriteTools(server, deps);
  return server;
}
