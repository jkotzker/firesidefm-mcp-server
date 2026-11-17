// Write check against the real Fireside API that touches ONE new draft episode and nothing else.
// Run by hand, never in CI:
//
//   security add-generic-password -U -s firesidefm-mcp-server -a read-write -w   # once; prompts for the key
//   npx tsx scripts/live-draft-check.ts
//
// It creates one private draft, edits it, sets, edits and deletes chapters and links on it, and
// reads it back through the MCP tools. The API cannot delete episodes, so the draft must be deleted
// by hand in the Fireside dashboard afterwards. Every request goes through draftGuard
// (scripts/draft-guard.ts): GETs, one create, and changes to the draft this run created and its
// chapters and links. Publish, unpublish and changes to the podcast are refused before they are sent.

import { execFileSync } from 'node:child_process';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { createServer } from '../src/server.js';
import { startup } from '../src/startup.js';
import { connect } from '../test/helpers/mcp.js';
import { draftGuard } from './draft-guard.js';

const KEYCHAIN_SERVICE = 'firesidefm-mcp-server';
const KEYCHAIN_ACCOUNT = 'read-write';
const SLUG_PREFIX = 'mcp-server-test-draft';

// For a rehearsal against a local stand-in, set FIRESIDE_API_BASE_URL. The key comes from
// FIRESIDE_API_TOKEN when it is set (for example from a password manager with `op run`), and from
// the Keychain otherwise.
const baseUrl = process.env.FIRESIDE_API_BASE_URL;
const token = process.env.FIRESIDE_API_TOKEN
  ? process.env.FIRESIDE_API_TOKEN.trim()
  : execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
      encoding: 'utf8',
    }).trim();

const guard = draftGuard();

let failures = 0;
function report(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
}

type Episode = Record<string, unknown> & { token: string; slug: string; title: string };

console.log(`Target: ${baseUrl ?? 'the real Fireside API'}`);
console.log(`Key: ${token.length} characters, ${/^fire_[0-9a-f]{64}$/.test(token) ? 'expected format' : 'UNEXPECTED format'}`);
const { deps, notices } = await startup(
  { FIRESIDE_API_TOKEN: token, ...(baseUrl ? { FIRESIDE_API_BASE_URL: baseUrl } : {}) },
  { fetch: guard.fetch },
);
if (deps.access !== 'read_write') {
  console.log(notices.join('\n'));
  throw new Error('Write tools are not enabled (see above), so there is nothing to check. Stopping.');
}

const { client, close } = await connect(() => createServer(deps));
try {
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const structured = <T>(r: CallToolResult) => r.structuredContent as T;

  const { tools } = await client.listTools();
  report('Read/Write key offers all tools but the upload', tools.length === 24, `${tools.length} tools`);

  const podcasts = structured<{ podcasts: { slug: string }[] }>(await call('fireside_list_podcasts', {})).podcasts;
  if (podcasts.length !== 1) throw new Error(`Expected exactly one podcast, found ${podcasts.length}. Stopping.`);
  const podcast = podcasts[0]!.slug;

  const draftsBefore = structured<{ episodes: Episode[] }>(
    await call('fireside_list_episodes', { podcast, status: 'draft', per_page: 50 }),
  ).episodes;
  const leftover = draftsBefore.filter((e) => e.slug.startsWith(SLUG_PREFIX));
  if (leftover.length > 0) {
    throw new Error(`A test draft from an earlier run still exists (${leftover.map((e) => e.slug).join(', ')}). Delete it in the dashboard first.`);
  }
  report('drafts before', true, `${draftsBefore.length}`);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const slug = `${SLUG_PREFIX}-${stamp}`;
  const title = '[TEST] firesidefm-mcp-server draft - do not publish';
  const created = await call('fireside_create_episode', {
    podcast,
    title,
    slug,
    subtitle: 'Created by a test of firesidefm-mcp-server.',
    description: 'Created by an automated test of **firesidefm-mcp-server**. Safe to delete.',
  });
  if (created.isError) throw new Error(`Create failed: ${textOf(created)}`);
  const draft = structured<Episode>(created);
  guard.allow(draft.token);
  console.log(`\nCreated draft: "${draft.title}", slug ${draft.slug}, token ${draft.token}\n`);
  report('created as a private draft', draft.status === 'draft' && draft.visibility === 'private', `status ${String(draft.status)}, visibility ${String(draft.visibility)}`);
  // Since 2026-11 Fireside gives a new draft a published_at (observed: its creation time), so status and
  // visibility, not published_at, say whether an episode is released.
  report('not released', draft.status === 'draft' && draft.url === null, `published_at ${String(draft.published_at)}`);
  report('fields saved', draft.slug === slug && draft.title === title && typeof draft.description === 'string');
  report('no audio', draft.has_audio === false);
  report('no preview_url in output', !('preview_url' in draft));

  const updated = await call('fireside_update_episode', {
    podcast,
    episode: draft.token,
    title: `${title} (updated)`,
    subtitle: null,
    description: 'Updated by an automated test of **firesidefm-mcp-server**. Safe to delete.',
  });
  if (updated.isError) throw new Error(`Update failed: ${textOf(updated)}`);
  const after = structured<Episode>(updated);
  report('update applied', after.title === `${title} (updated)` && after.subtitle === null && String(after.description).startsWith('Updated'));
  report('still a private draft', after.status === 'draft' && after.visibility === 'private' && after.url === null);

  const read = await call('fireside_get_episode', { podcast, episode: slug });
  const fetched = structured<Episode>(read);
  report('read back by slug', !read.isError && fetched.token === draft.token && fetched.title === after.title, read.isError ? textOf(read) : '');

  type Chapter = { token: string; start: number; timecode: string; title: string };
  type Chapters = { chapters: Chapter[]; audio_chapters: string };
  const ep = { podcast, episode: draft.token };
  const set = await call('fireside_set_chapters', {
    ...ep,
    chapters: [
      { start: 0, title: 'Intro' },
      { start: '01:30', title: 'Second part' },
    ],
  });
  const setOut = structured<Chapters>(set);
  report(
    'chapters set, timecode string read as seconds',
    !set.isError && setOut.chapters.length === 2 && setOut.chapters[1]?.start === 90,
    set.isError ? textOf(set) : `audio_chapters ${setOut.audio_chapters}`,
  );
  const added = await call('fireside_add_chapter', { ...ep, start: 120, title: 'Third part' });
  if (added.isError) throw new Error(`Add chapter failed: ${textOf(added)}`);
  const third = structured<{ chapter: Chapter }>(added).chapter;
  report('chapter added', third.timecode === '00:02:00', third.timecode);
  const renamed = await call('fireside_update_chapter', { ...ep, chapter: third.token, title: 'Third part (renamed)' });
  report('chapter renamed', !renamed.isError && structured<{ chapter: Chapter }>(renamed).chapter.start === 120);
  const removed = await call('fireside_delete_chapter', { ...ep, chapter: third.token });
  report('chapter deleted', !removed.isError);
  const bad = await call('fireside_set_chapters', {
    ...ep,
    chapters: [
      { start: 0, title: 'Intro' },
      { start: 'not a time', title: 'Bad' },
    ],
  });
  report('invalid list refused by position', bad.isError === true && /chapters\[\d\]\.start/.test(textOf(bad)), textOf(bad).split('\n')[1] ?? '');
  const chaptersNow = structured<Chapters>(await call('fireside_list_chapters', ep));
  report('two chapters remain', chaptersNow.chapters.length === 2, chaptersNow.chapters.map((c) => c.title).join(', '));

  type Link = { token: string; url: string; title: string; excerpt: string | null };
  const links = await call('fireside_set_links', {
    ...ep,
    links: [
      { url: 'https://example.com/first', title: 'First link', excerpt: 'A note' },
      { url: 'https://example.com/second', title: 'Second link' },
    ],
  });
  if (links.isError) throw new Error(`Set links failed: ${textOf(links)}`);
  const linksOut = structured<{ links: Link[] }>(links).links;
  report('links set in order', linksOut.map((l) => l.title).join() === 'First link,Second link');
  const cleared = await call('fireside_update_link', { ...ep, link: linksOut[0]!.token, excerpt: null });
  report('excerpt removed', !cleared.isError && structured<{ link: Link }>(cleared).link.excerpt === null);
  const addedLink = await call('fireside_add_link', { ...ep, url: 'https://example.com/third', title: 'Third link' });
  report('link added', !addedLink.isError);
  const reordered = await call('fireside_set_links', {
    ...ep,
    links: [...linksOut].reverse().map((l) => ({ token: l.token, url: l.url, title: l.title })),
  });
  const reorderedOut = structured<{ links: Link[] }>(reordered).links;
  report('links reordered, third removed', !reordered.isError && reorderedOut.map((l) => l.title).join() === 'Second link,First link');
  const deletedLink = await call('fireside_delete_link', { ...ep, link: reorderedOut[0]!.token });
  report('link deleted', !deletedLink.isError);

  const draftsAfter = structured<{ episodes: Episode[] }>(
    await call('fireside_list_episodes', { podcast, status: 'draft', per_page: 50 }),
  ).episodes;
  report('exactly one draft added', draftsAfter.length === draftsBefore.length + 1, `${draftsBefore.length} → ${draftsAfter.length}`);
} finally {
  await close();
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
console.log('Delete the test draft by hand in the Fireside dashboard; the API cannot delete episodes.');
process.exitCode = failures === 0 ? 0 : 1;
