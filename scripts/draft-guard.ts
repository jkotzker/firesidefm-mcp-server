/**
 * A fetch for live write checks that can touch only one new draft episode: it allows GETs, a
 * single POST that creates an episode, and PATCHes to episodes registered with `allow()` (the
 * draft just created). Publish and unpublish, and everything else, are refused before sending.
 */
export function draftGuard(base: typeof fetch = fetch) {
  const writable = new Set<string>();
  let creates = 0;

  const guarded: typeof fetch = (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace(/^\/api\/v1\//, '');
    const refuse = (why: string): never => {
      throw new Error(`Refusing ${method} ${path}: ${why}`);
    };
    if (/publish/.test(path)) refuse('publish and unpublish are never sent by this check.');
    if (method === 'POST') {
      if (!/^podcasts\/[^/]+\/episodes$/.test(path)) refuse('the only POST allowed is creating an episode.');
      if (creates > 0) refuse('this check creates exactly one draft.');
      creates++;
    } else if (method === 'PATCH') {
      const episode = /^podcasts\/[^/]+\/episodes\/([^/]+)$/.exec(path)?.[1];
      if (!episode || !writable.has(episode)) refuse('only the draft created by this run may be changed.');
    } else if (method !== 'GET') {
      refuse('method not allowed.');
    }
    return base(input, init);
  };

  return { fetch: guarded, allow: (episodeToken: string) => writable.add(episodeToken) };
}
