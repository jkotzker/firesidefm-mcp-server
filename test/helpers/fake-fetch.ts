import { readFileSync } from 'node:fs';

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export interface Route {
  method: string;
  /** Path relative to the API base, e.g. `podcasts/abc/episodes`. */
  path: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fetch stand-in that answers from a list of routes. Routes are consumed in order when the
 * same method and path appear more than once, so a test can script a 429 followed by a 200.
 */
export function fakeFetch(routes: Route[], baseUrl = 'https://fireside.fm/api/v1/') {
  const remaining = [...routes];
  const requests: RecordedRequest[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const rawBody = init?.body;
    requests.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody,
    });
    const path = url.pathname.slice(new URL(baseUrl).pathname.length);
    const index = remaining.findIndex((r) => r.method === method && r.path === path);
    if (index === -1) throw new Error(`fakeFetch: no route for ${method} ${path}`);
    const [route] = remaining.splice(index, 1);
    const body = route!.body === undefined ? '' : typeof route!.body === 'string' ? route!.body : JSON.stringify(route!.body);
    return new Response(body, {
      status: route!.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...route!.headers },
    });
  };

  return { fetch, requests };
}
