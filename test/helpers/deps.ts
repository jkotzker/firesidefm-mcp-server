import { FiresideClient } from '../../src/fireside/client.js';
import { type Access, createServer, type ServerDeps } from '../../src/server.js';
import { Resolver } from '../../src/tools/resolve.js';
import { fakeFetch, type Route } from './fake-fetch.js';

export const TOKEN = `fire_${'a'.repeat(64)}`;
export const POD = '550e8400-e29b-41d4-a716-446655440000';
export const EP = '6a20c700-51d3-4c0a-abe7-da88d972a27c';

/** `writeTools: true` is shorthand for `access: 'read_write'`; the default is a Read Only key. */
export function serverWith(
  routes: Route[],
  options: { writeTools?: boolean; access?: Access; defaultPodcast?: string } = {},
) {
  const fake = fakeFetch(routes);
  const client = new FiresideClient({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const deps: ServerDeps = {
    client,
    resolver: new Resolver(client, options.defaultPodcast),
    access: options.writeTools ? 'read_write' : (options.access ?? 'read_only_key'),
  };
  return { factory: () => createServer(deps), requests: fake.requests };
}
