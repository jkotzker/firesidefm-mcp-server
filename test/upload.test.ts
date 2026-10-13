import { createReadStream, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FiresideClient } from '../src/fireside/client.js';
import { FileUploadError } from '../src/fireside/errors.js';
import { EP, POD, serverWith, TOKEN } from './helpers/deps.js';
import { fakeFetch, fixture, type Route } from './helpers/fake-fetch.js';
import { connect, type Connected } from './helpers/mcp.js';
import { mp3 } from './helpers/mp3.js';

const UPLOAD_URL = 'https://uploads.example.test/bucket/key-1';
const SIGNED_URL = `${UPLOAD_URL}?signature=s3cr3t`;
const FILE_URL = 'https://uploads.example.test/bucket/key-1/file';
const AUDIO = mp3();
// Larger than one read chunk (64 KiB), so progress is reported more than once.
const LONG = mp3({ frames: 1500 });

let root: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  // realpath: the system temporary directory is itself a symlink on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fireside-upload-')));
  allowed = join(root, 'allowed');
  outside = join(root, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(join(allowed, 'episode.mp3'), AUDIO);
  writeFileSync(join(allowed, 'long.mp3'), LONG);
  writeFileSync(join(allowed, 'stereo.mp3'), mp3({ kbps: 128, mono: false }));
  writeFileSync(join(allowed, 'renamed.mp3'), Buffer.concat([Buffer.from('RIFF....WAVEfmt ', 'latin1'), Buffer.alloc(2000)]));
  symlinkSync(allowed, join(root, 'linked-dir'));
  writeFileSync(join(allowed, 'notes.txt'), 'Hello.\n');
  writeFileSync(join(allowed, 'readme.md'), '# Notes\n');
  writeFileSync(join(allowed, 'empty.txt'), '');
  writeFileSync(join(outside, 'secret.txt'), 'not for upload\n');
  symlinkSync(join(outside, 'secret.txt'), join(allowed, 'link.txt'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function uploadRoute(kind: string, contentType: string): Route {
  return {
    method: 'POST',
    path: `podcasts/${POD}/uploads`,
    status: 201,
    body: {
      data: {
        kind,
        upload_url: SIGNED_URL,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        file_url: FILE_URL,
        expires_at: '2026-10-13T15:00:00Z',
      },
    },
  };
}

const putRoute: Route = { method: 'PUT', path: UPLOAD_URL, body: '' };

function chunks(path: string) {
  return { chunks: createReadStream(path), size: statSync(path).size };
}

describe('FiresideClient uploads', () => {
  function client(routes: Route[]) {
    const fake = fakeFetch(routes);
    return { c: new FiresideClient({ token: TOKEN, fetch: fake.fetch }), requests: fake.requests };
  }

  it('asks for an upload with the file described', async () => {
    const { c, requests } = client([uploadRoute('audio', 'audio/mpeg')]);
    const res = await c.createUpload(POD, { kind: 'audio', filename: 'a.mp3', byte_size: 10, content_type: 'audio/mpeg' });
    expect(res.data.file_url).toBe(FILE_URL);
    expect(requests[0]!.body).toEqual({ kind: 'audio', filename: 'a.mp3', byte_size: 10, content_type: 'audio/mpeg' });
  });

  it('sends the file with the returned headers and its length, and never the API key', async () => {
    const { c, requests } = client([putRoute]);
    const sent: number[] = [];
    await c.sendFile(
      { upload_url: SIGNED_URL, method: 'PUT', headers: { 'Content-Type': 'audio/mpeg' } },
      chunks(join(allowed, 'episode.mp3')),
      { onProgress: (n) => sent.push(n) },
    );
    const put = requests[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url.href).toBe(SIGNED_URL);
    expect(put.headers.get('content-type')).toBe('audio/mpeg');
    expect(put.headers.get('content-length')).toBe(String(AUDIO.length));
    expect(put.headers.has('authorization')).toBe(false);
    expect(put.body).toEqual(AUDIO);
    expect(sent.at(-1)).toBe(AUDIO.length);
  });

  it('refuses an upload address that is not https', async () => {
    const { c, requests } = client([]);
    await expect(
      c.sendFile({ upload_url: 'http://uploads.example.test/x', method: 'PUT', headers: {} }, chunks(join(allowed, 'notes.txt'))),
    ).rejects.toBeInstanceOf(FileUploadError);
    expect(requests).toHaveLength(0);
  });

  it('reports a refused upload by status and code only, keeping the signed URL out', async () => {
    const { c } = client([
      {
        ...putRoute,
        status: 403,
        body: '<Error><Code>AccessDenied</Code><StringToSign>abc</StringToSign><Signature>s3cr3t</Signature></Error>',
        headers: { 'Content-Type': 'application/xml' },
      },
    ]);
    const error = await c
      .sendFile({ upload_url: SIGNED_URL, method: 'PUT', headers: {} }, chunks(join(allowed, 'notes.txt')))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileUploadError);
    expect((error as Error).message).toBe('The storage service refused the file (HTTP 403, AccessDenied).');
  });

  it('keeps the signed URL out of a network failure', async () => {
    const c = new FiresideClient({
      token: TOKEN,
      fetch: async (input) => {
        throw new TypeError(`fetch failed for ${String(input)}`);
      },
    });
    const error = await c
      .sendFile({ upload_url: SIGNED_URL, method: 'PUT', headers: {} }, chunks(join(allowed, 'notes.txt')))
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('[upload URL]');
    expect((error as Error).message).not.toContain('s3cr3t');
  });

  // Signed storage uploads refuse chunked bodies; this checks what really goes over the wire.
  it('sends a Content-Length, not a chunked body, over a real connection', async () => {
    let seen: { headers: IncomingHttpHeaders; length: number } | undefined;
    const server = createServer((req, res) => {
      let length = 0;
      req.on('data', (chunk: Buffer) => (length += chunk.length));
      req.on('end', () => {
        seen = { headers: req.headers, length };
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // The client requires https, so the request is redirected to the local server after that check.
      const c = new FiresideClient({ token: TOKEN, fetch: (_input, init) => fetch(`http://127.0.0.1:${port}/`, init) });
      await c.sendFile({ upload_url: SIGNED_URL, method: 'PUT', headers: {} }, chunks(join(allowed, 'episode.mp3')));
    } finally {
      server.close();
    }
    expect(seen?.headers['content-length']).toBe(String(AUDIO.length));
    expect(seen?.headers['transfer-encoding']).toBeUndefined();
    expect(seen?.length).toBe(AUDIO.length);
  });

  // A fetch that answers only when its request is aborted.
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));

  it('gives up on an upload that does not finish in time', async () => {
    const c = new FiresideClient({ token: TOKEN, fetch: hanging, minUploadTimeoutMs: 20 });
    const error = await c
      .sendFile({ upload_url: SIGNED_URL, method: 'PUT', headers: {} }, chunks(join(allowed, 'notes.txt')))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileUploadError);
    expect((error as Error).message).toContain('did not finish within');
  });

  it('passes a cancellation through instead of reporting a failed upload', async () => {
    const c = new FiresideClient({ token: TOKEN, fetch: hanging });
    const controller = new AbortController();
    const pending = c
      .sendFile({ upload_url: SIGNED_URL, method: 'PUT', headers: {} }, chunks(join(allowed, 'notes.txt')), {
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(FileUploadError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('fireside_upload_file', () => {
  let conn: Connected | undefined;
  afterEach(async () => {
    await conn?.close();
    conn = undefined;
  });

  async function open(routes: Route[], uploadDirs = [allowed]) {
    const server = serverWith(routes, { writeTools: true, uploadDirs });
    conn = await connect(server.factory, 'modern');
    const call = async (args: Record<string, unknown>, onprogress?: (p: { progress: number }) => void) =>
      (await conn!.client.callTool(
        { name: 'fireside_upload_file', arguments: args },
        onprogress ? { onprogress } : undefined,
      )) as CallToolResult;
    return { call, requests: server.requests, client: conn.client };
  }

  const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  it('is offered only with write access and upload directories', async () => {
    for (const [options, offered] of [
      [{ writeTools: true, uploadDirs: [allowed] }, true],
      [{ writeTools: true }, false],
      [{ access: 'read_only_key' as const, uploadDirs: [allowed] }, false],
    ] as const) {
      const c = await connect(serverWith([], options).factory, 'modern');
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      await c.close();
      expect(names.includes('fireside_upload_file')).toBe(offered);
    }
  });

  it('uploads a file and attaches it to an episode', async () => {
    const { call, requests } = await open([
      uploadRoute('audio', 'audio/mpeg'),
      putRoute,
      { method: 'PATCH', path: `podcasts/${POD}/episodes/${EP}`, body: fixture('episode') },
    ]);
    const progress: number[] = [];
    const result = await call({ podcast: POD, episode: EP, path: join(allowed, 'episode.mp3') }, (p) =>
      progress.push(p.progress),
    );
    expect(result.isError).toBeFalsy();
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT', 'PATCH']);
    expect(requests[0]!.body).toEqual({
      kind: 'audio',
      filename: 'episode.mp3',
      byte_size: AUDIO.length,
      content_type: 'audio/mpeg',
    });
    expect(requests[1]!.headers.has('authorization')).toBe(false);
    expect(requests[2]!.body).toEqual({ audio_file_url: FILE_URL });
    expect(result.structuredContent).toMatchObject({
      kind: 'audio',
      field: 'audio_file_url',
      episode: { token: EP, audio_status: 'ready' },
    });
    expect(result.structuredContent).not.toHaveProperty('file_url');
    expect(result.structuredContent).toMatchObject({ audio: { channels: 'mono', bitrate_kbps: 64, sample_rate_hz: 44_100 } });
    expect(progress.at(-1)).toBe(AUDIO.length);
  });

  it('stops an MP3 that differs from the suggested settings, naming the differences', async () => {
    const { call, requests } = await open([]);
    const result = await call({ podcast: POD, path: join(allowed, 'stereo.mp3') });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('it has stereo, not mono; 128 kb/s, not 64–96 kb/s.');
    expect(text(result)).toContain('accept_audio_specs: true');
    expect(requests).toHaveLength(0);
  });

  it('uploads such an MP3 when the differences are accepted', async () => {
    const { call, requests } = await open([uploadRoute('audio', 'audio/mpeg'), putRoute]);
    const result = await call({ podcast: POD, path: join(allowed, 'stereo.mp3'), accept_audio_specs: true });
    expect(result.isError).toBeFalsy();
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT']);
    expect(result.structuredContent).toMatchObject({ audio: { channels: 'stereo', bitrate_kbps: 128 } });
  });

  it('refuses a file named .mp3 that holds no MP3 audio, even when specs are accepted', async () => {
    const { call, requests } = await open([]);
    const result = await call({ podcast: POD, path: join(allowed, 'renamed.mp3'), accept_audio_specs: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('renamed.mp3 is not an MP3 file');
    expect(requests).toHaveLength(0);
  });

  it('names the file size when Fireside refuses the upload', async () => {
    const { call } = await open([
      {
        method: 'POST',
        path: `podcasts/${POD}/uploads`,
        status: 422,
        body: { error: { message: 'byte_size is too large', code: 'validation_failed' } },
      },
    ]);
    const result = await call({ podcast: POD, path: join(allowed, 'long.mp3') });
    expect(result.isError).toBe(true);
    // 1500 frames × 208 bytes = 312,000 bytes = 0.3 MB = 0.3 MiB.
    expect(text(result)).toContain('The file is 312,000 bytes (0.3 MB, 0.3 MiB)');
    expect(text(result)).toContain("audio up to the plan's MP3 limit");
  });

  it('reports progress at most once a second, and at the end', async () => {
    const { call } = await open([uploadRoute('audio', 'audio/mpeg'), putRoute]);
    const progress: number[] = [];
    const result = await call({ podcast: POD, path: join(allowed, 'long.mp3') }, (p) => progress.push(p.progress));
    expect(result.isError).toBeFalsy();
    // The first chunk and the last: every chunk in between arrives within the same second.
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBeLessThan(LONG.length);
    expect(progress[1]).toBe(LONG.length);
  });

  it('accepts files from an upload directory given through a symbolic link', async () => {
    const { call } = await open([uploadRoute('transcript', 'text/plain'), putRoute], [join(root, 'linked-dir')]);
    const result = await call({ podcast: POD, path: join(root, 'linked-dir', 'notes.txt') });
    expect(result.isError).toBeFalsy();
  });

  it('keeps the uploaded file_url when attaching it fails', async () => {
    const { call } = await open([
      uploadRoute('audio', 'audio/mpeg'),
      putRoute,
      { method: 'PATCH', path: `podcasts/${POD}/episodes/${EP}`, status: 404, body: { error: { message: 'Not found' } } },
    ]);
    const result = await call({ podcast: POD, episode: EP, path: join(allowed, 'episode.mp3') });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`fireside_update_episode with audio_file_url: ${FILE_URL}`);
  });

  it('does not treat a failed upload request as a saved change', async () => {
    const { call } = await open([{ ...uploadRoute('audio', 'audio/mpeg'), body: { data: { kind: 'audio' } } }]);
    const result = await call({ podcast: POD, path: join(allowed, 'episode.mp3') });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Try fireside_upload_file again');
    expect(text(result)).not.toContain('The change was saved');
  });

  it('returns a file_url when no episode is given', async () => {
    const { call, requests } = await open([uploadRoute('transcript', 'text/plain'), putRoute]);
    const result = await call({ podcast: POD, path: join(allowed, 'notes.txt') });
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toMatchObject({ kind: 'transcript', content_type: 'text/plain' });
    expect(result.structuredContent).toEqual({
      kind: 'transcript',
      filename: 'notes.txt',
      byte_size: 7,
      field: 'transcript_file_url',
      file_url: FILE_URL,
      expires_at: '2026-10-13T15:00:00Z',
    });
  });

  it.each([
    ['a file outside the upload directories', () => join(outside, 'secret.txt'), 'outside the upload directories'],
    // The same answer as for a file that exists, so refusals say nothing about paths elsewhere.
    ['a missing file outside them', () => join(outside, 'missing.txt'), 'outside the upload directories'],
    ['a link that leads outside them', () => join(allowed, 'link.txt'), 'outside the upload directories'],
    ['a relative path', () => 'allowed/notes.txt', 'absolute path'],
    ['a type Fireside does not accept', () => join(allowed, 'readme.md'), 'readme.md is none of these'],
    ['an empty file', () => join(allowed, 'empty.txt'), 'is empty'],
    ['a missing file', () => join(allowed, 'missing.mp3'), 'does not exist'],
  ])('refuses %s before calling Fireside', async (_label, path, message) => {
    const { call, requests } = await open([]);
    const result = await call({ podcast: POD, path: path() });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(requests).toHaveLength(0);
  });

  it('says nothing was attached when the upload itself fails', async () => {
    const { call, requests } = await open([uploadRoute('audio', 'audio/mpeg'), { ...putRoute, status: 403, body: '' }]);
    const result = await call({ podcast: POD, episode: EP, path: join(allowed, 'episode.mp3') });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing was attached to an episode');
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT']);
  });
});

describe('file fields on create and update', () => {
  let conn: Connected | undefined;
  afterEach(async () => {
    await conn?.close();
    conn = undefined;
  });

  it('fireside_update_episode sends a file_url', async () => {
    const server = serverWith([{ method: 'PATCH', path: `podcasts/${POD}/episodes/${EP}`, body: fixture('episode') }], {
      writeTools: true,
    });
    conn = await connect(server.factory, 'modern');
    const result = (await conn.client.callTool({
      name: 'fireside_update_episode',
      arguments: { podcast: POD, episode: EP, cover_file_url: FILE_URL },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(server.requests[0]!.body).toEqual({ cover_file_url: FILE_URL });
  });

  it('warns not to repeat a create when the file failed but the episode was saved', async () => {
    const draft = fixture('episode-draft') as { data: { token: string; slug: string } };
    const server = serverWith(
      [
        {
          method: 'POST',
          path: `podcasts/${POD}/episodes`,
          status: 422,
          body: { error: { message: 'cover.png could not be processed', code: 'upload_failed' }, data: draft.data },
        },
      ],
      { writeTools: true },
    );
    conn = await connect(server.factory, 'modern');
    const result = (await conn.client.callTool({
      name: 'fireside_create_episode',
      arguments: { podcast: POD, title: 'New', cover_file_url: FILE_URL },
    })) as CallToolResult;
    const message = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(result.isError).toBe(true);
    expect(message).toContain('Do not repeat fireside_create_episode');
    expect(message).toContain(`episode ${draft.data.slug} (token ${draft.data.token})`);
  });
});
