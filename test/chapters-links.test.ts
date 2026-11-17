import { describe, expect, it } from 'vitest';

import { EP, POD } from './helpers/deps.js';
import { fixture } from './helpers/fake-fetch.js';
import { session, text } from './helpers/session.js';

const open = session();
const W = { writeTools: true };
const CHAPTERS = `podcasts/${POD}/episodes/${EP}/chapters`;
const LINKS = `podcasts/${POD}/episodes/${EP}/links`;
const CH = '4e7a5b6c-0000-4000-8000-000000000002';
const LN = '8d02c3d4-0000-4000-8000-000000000012';

describe('chapters', () => {
  it('fireside_list_chapters works with a Read Only key and returns audio_chapters', async () => {
    const { call, requests } = await open([{ method: 'GET', path: CHAPTERS, body: fixture('chapters') }]);
    const result = await call('fireside_list_chapters', { podcast: POD, episode: EP });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.method).toBe('GET');
    expect(result.structuredContent).toMatchObject({
      chapters: [{ title: 'Intro', start: 0 }, { title: 'Listener Mail', timecode: '00:05:30' }],
      audio_chapters: 'up_to_date',
    });
  });

  it('accepts an audio_chapters value the docs do not list', async () => {
    const body = { ...(fixture('chapters') as object), audio_chapters: 'rewriting' };
    const { call } = await open([{ method: 'GET', path: CHAPTERS, body }]);
    const result = await call('fireside_list_chapters', { podcast: POD, episode: EP });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ audio_chapters: 'rewriting' });
  });

  it('fireside_set_chapters PUTs the whole list, keeping tokens only where given', async () => {
    const { call, requests } = await open([{ method: 'PUT', path: CHAPTERS, body: fixture('chapters') }], W);
    const result = await call('fireside_set_chapters', {
      podcast: POD,
      episode: EP,
      chapters: [
        { token: CH, start: 0, title: 'Welcome' },
        { start: '12:45', title: 'Interview' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.body).toEqual({
      chapters: [
        { token: CH, start: 0, title: 'Welcome' },
        { start: '12:45', title: 'Interview' },
      ],
    });
  });

  it('fireside_set_chapters sends an empty list to delete every chapter', async () => {
    const { call, requests } = await open(
      [{ method: 'PUT', path: CHAPTERS, body: { data: [], audio_chapters: 'writing' } }],
      W,
    );
    const result = await call('fireside_set_chapters', { podcast: POD, episode: EP, chapters: [] });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({ chapters: [] });
  });

  it('explains a rejected list by position, and that nothing was saved', async () => {
    const message = 'must be whole seconds (like 330) or a timecode (like "05:30" or "1:02:03")';
    const { call } = await open(
      [
        {
          method: 'PUT',
          path: CHAPTERS,
          status: 422,
          body: {
            error: {
              message: `chapters[1].start ${message}`,
              code: 'validation_failed',
              fields: { 'chapters[1].start': [message] },
            },
          },
        },
      ],
      W,
    );
    const result = await call('fireside_set_chapters', {
      podcast: POD,
      episode: EP,
      chapters: [
        { start: 0, title: 'Intro' },
        { start: 'soon', title: 'Later' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`- chapters[1].start: ${message}`);
    expect(text(result)).toContain('Fireside changes the whole list or none of it');
  });

  it('refuses more than 255 chapters before calling Fireside', async () => {
    const { call, requests } = await open([], W);
    const chapters = Array.from({ length: 256 }, (_, i) => ({ start: i, title: `Part ${i}` }));
    const result = await call('fireside_set_chapters', { podcast: POD, episode: EP, chapters });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('fireside_add_chapter POSTs one chapter and returns it with audio_chapters', async () => {
    const { call, requests } = await open([{ method: 'POST', path: CHAPTERS, status: 201, body: fixture('chapter') }], W);
    const result = await call('fireside_add_chapter', { podcast: POD, episode: EP, start: '12:45', title: 'Interview' });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({ start: '12:45', title: 'Interview' });
    expect(result.structuredContent).toMatchObject({ chapter: { token: CH, start: 765 }, audio_chapters: 'writing' });
  });

  it('fireside_update_chapter PATCHes only the fields given', async () => {
    const { call, requests } = await open([{ method: 'PATCH', path: `${CHAPTERS}/${CH}`, body: fixture('chapter') }], W);
    const result = await call('fireside_update_chapter', { podcast: POD, episode: EP, chapter: CH, title: 'Interview' });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({ title: 'Interview' });
  });

  it('fireside_update_chapter refuses an empty change', async () => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_update_chapter', { podcast: POD, episode: EP, chapter: CH });
    expect(text(result)).toContain('Nothing to change');
    expect(requests).toHaveLength(0);
  });

  it('fireside_delete_chapter sends DELETE with no body and returns the chapter as it was', async () => {
    const { call, requests } = await open([{ method: 'DELETE', path: `${CHAPTERS}/${CH}`, body: fixture('chapter') }], W);
    const result = await call('fireside_delete_chapter', { podcast: POD, episode: EP, chapter: CH });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.body).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ chapter: { token: CH } });
  });

  it('points to fireside_list_chapters for an unknown chapter token', async () => {
    const { call } = await open(
      [{ method: 'PATCH', path: `${CHAPTERS}/${CH}`, status: 404, body: { error: { message: 'Not found', code: 'not_found' } } }],
      W,
    );
    const result = await call('fireside_update_chapter', { podcast: POD, episode: EP, chapter: CH, start: 1 });
    expect(text(result)).toContain('fireside_list_chapters');
  });

  it('warns that an add with no answer may have been applied, and that repeating it may duplicate', async () => {
    // No route: the request fails as if Fireside could not be reached.
    const { call } = await open([], W);
    const result = await call('fireside_add_chapter', { podcast: POD, episode: EP, start: 0, title: 'Intro' });
    expect(text(result)).toContain("Check the episode's chapters with fireside_list_chapters");
    expect(text(result)).toContain('may add a second copy');
  });

  it('says a replace with no answer is safe to send again', async () => {
    const { call } = await open([], W);
    const result = await call('fireside_set_chapters', { podcast: POD, episode: EP, chapters: [] });
    expect(text(result)).toContain('send the same change again, which is safe');
  });
});

describe('links', () => {
  it('fireside_list_links returns links, with clicks only where Fireside sends them', async () => {
    const { call } = await open([{ method: 'GET', path: LINKS, body: fixture('links') }]);
    const result = await call('fireside_list_links', { podcast: POD, episode: EP });
    expect(result.isError).toBeFalsy();
    const links = (result.structuredContent as { links: Record<string, unknown>[] }).links;
    expect(links[0]).toMatchObject({ title: 'The Book We Mentioned', excerpt: null, clicks: 12 });
    expect(links[1]).not.toHaveProperty('clicks');
  });

  it('fireside_set_links PUTs the list in order, sending excerpt only when given', async () => {
    const { call, requests } = await open([{ method: 'PUT', path: LINKS, body: fixture('links') }], W);
    const result = await call('fireside_set_links', {
      podcast: POD,
      episode: EP,
      links: [
        { url: 'https://example.com/talk', title: 'Her Conference Talk', excerpt: null },
        { token: LN, url: 'https://example.com/book', title: 'The Book We Mentioned' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({
      links: [
        { url: 'https://example.com/talk', title: 'Her Conference Talk', excerpt: null },
        { token: LN, url: 'https://example.com/book', title: 'The Book We Mentioned' },
      ],
    });
  });

  it('refuses a URL listed twice before calling Fireside', async () => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_set_links', {
      podcast: POD,
      episode: EP,
      links: [
        { url: 'https://example.com/a', title: 'A' },
        { url: 'https://example.com/a', title: 'A again' },
      ],
    });
    expect(text(result)).toContain('https://example.com/a appears more than once');
    expect(requests).toHaveLength(0);
  });

  it.each(['ftp://example.com/file', 'example.com/no-scheme'])('refuses %s before calling Fireside', async (url) => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_add_link', { podcast: POD, episode: EP, url, title: 'X' });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('fireside_add_link POSTs the link', async () => {
    const { call, requests } = await open([{ method: 'POST', path: LINKS, status: 201, body: fixture('link') }], W);
    const result = await call('fireside_add_link', {
      podcast: POD,
      episode: EP,
      url: 'https://example.com/talk',
      title: 'Her Conference Talk',
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({ url: 'https://example.com/talk', title: 'Her Conference Talk' });
    expect(result.structuredContent).toMatchObject({ link: { token: LN, clicks: 3 } });
  });

  it('fireside_update_link sends excerpt null to remove the excerpt', async () => {
    const { call, requests } = await open([{ method: 'PATCH', path: `${LINKS}/${LN}`, body: fixture('link') }], W);
    const result = await call('fireside_update_link', { podcast: POD, episode: EP, link: LN, excerpt: null });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.body).toEqual({ excerpt: null });
  });

  it('fireside_update_link refuses an empty change', async () => {
    const { call, requests } = await open([], W);
    const result = await call('fireside_update_link', { podcast: POD, episode: EP, link: LN });
    expect(text(result)).toContain('Nothing to change');
    expect(requests).toHaveLength(0);
  });

  it('fireside_delete_link sends DELETE and returns the link as it was', async () => {
    const { call, requests } = await open([{ method: 'DELETE', path: `${LINKS}/${LN}`, body: fixture('link') }], W);
    const result = await call('fireside_delete_link', { podcast: POD, episode: EP, link: LN });
    expect(result.isError).toBeFalsy();
    expect(requests[0]!.method).toBe('DELETE');
    expect(result.structuredContent).toMatchObject({ link: { token: LN } });
  });

  it('says a delete with no answer may already have happened', async () => {
    const { call } = await open([], W);
    const result = await call('fireside_delete_link', { podcast: POD, episode: EP, link: LN });
    expect(text(result)).toContain("Check the episode's links with fireside_list_links");
    expect(text(result)).toContain('it may already be deleted');
  });

  it('explains a rejected link list by position', async () => {
    const { call } = await open(
      [
        {
          method: 'PUT',
          path: LINKS,
          status: 422,
          body: {
            error: { message: 'links[1].url has already been taken', code: 'validation_failed', fields: { 'links[1].url': ['has already been taken'] } },
          },
        },
      ],
      W,
    );
    const result = await call('fireside_set_links', {
      podcast: POD,
      episode: EP,
      links: [
        { url: 'https://example.com/a', title: 'A' },
        { url: 'https://example.com/b', title: 'B' },
      ],
    });
    expect(text(result)).toContain('- links[1].url: has already been taken');
    expect(text(result)).toContain('by its position in the list you sent, counting from 0');
  });
});
