/**
 * A fetch for live write checks that can touch only one new draft episode: it allows GETs, a
 * single POST that creates an episode, PATCHes to episodes registered with `allow()` (the draft
 * just created), and changes to that draft's chapters and links. Publish and unpublish, changes to
 * the podcast, and everything else, are refused before sending.
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
    const list = /^podcasts\/[^/]+\/episodes\/([^/]+)\/(chapters|links)(?:\/([^/]+))?$/.exec(path);
    if (list && method !== 'GET') {
      const [, episode, , item] = list;
      if (!writable.has(episode!)) refuse('only the draft created by this run may have its chapters or links changed.');
      // PUT and POST address the whole list; PATCH and DELETE one chapter or link.
      const wholeList = (method === 'PUT' || method === 'POST') && item === undefined;
      const oneItem = (method === 'PATCH' || method === 'DELETE') && item !== undefined;
      if (!wholeList && !oneItem) refuse('method not allowed here.');
    } else if (method === 'POST') {
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
