// Write check against the real Fireside API that touches ONE new draft episode and nothing else.
// Run by hand, never in CI:
//
//   security add-generic-password -U -s firesidefm-mcp-server -a read-write -w   # once; prompts for the key
//   npx tsx scripts/live-draft-check.ts
//
// It creates one private draft, edits it, and reads it back through the MCP tools. The API cannot
// delete episodes, so the draft must be deleted by hand in the Fireside dashboard afterwards.
// Every request goes through draftGuard (scripts/draft-guard.ts): GETs, one create, and PATCHes to
// the draft this run created. Publish and unpublish requests are refused before they are sent.

import { execFileSync } from 'node:child_process';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { createServer } from '../src/server.js';
import { startup } from '../src/startup.js';
import { connect } from '../test/helpers/mcp.js';
import { draftGuard } from './draft-guard.js';

const KEYCHAIN_SERVICE = 'firesidefm-mcp-server';
const KEYCHAIN_ACCOUNT = 'read-write';
const SLUG_PREFIX = 'mcp-server-test-draft';

// FIRESIDE_API_TOKEN and FIRESIDE_API_BASE_URL override the Keychain and the real API, for a
// rehearsal against a local stand-in.
const token =
  process.env.FIRESIDE_API_TOKEN ??
  execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
  encoding: 'utf8',
}).trim();
const baseUrl = process.env.FIRESIDE_API_BASE_URL;

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

console.log(`Key: ${token.length} characters, ${/^fire_[0-9a-f]{64}$/.test(token) ? 'expected format' : 'UNEXPECTED format'}`);
const { deps, notices } = await startup(
  { FIRESIDE_API_TOKEN: token, ...(baseUrl ? { FIRESIDE_API_BASE_URL: baseUrl } : {}) },
  { fetch: guard.fetch },
);
if (!deps.writeTools) {
  console.log(notices.join('\n'));
  throw new Error('Write tools are not enabled (see above), so there is nothing to check. Stopping.');
}

const { client, close } = await connect(() => createServer(deps));
try {
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const structured = <T>(r: CallToolResult) => r.structuredContent as T;

  const { tools } = await client.listTools();
  report('Read/Write key offers all tools', tools.length === 11, `${tools.length} tools`);

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
  report('not released', draft.published_at === null, `published_at ${String(draft.published_at)}`);
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
  report('still a private draft', after.status === 'draft' && after.visibility === 'private' && after.published_at === null);

  const read = await call('fireside_get_episode', { podcast, episode: slug });
  const fetched = structured<Episode>(read);
  report('read back by slug', !read.isError && fetched.token === draft.token && fetched.title === after.title, read.isError ? textOf(read) : '');

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
