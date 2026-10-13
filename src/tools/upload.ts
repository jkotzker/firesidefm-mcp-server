import { constants } from 'node:fs';
import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { EpisodeFields, FileKind } from '../fireside/client.js';
import { FiresideApiError } from '../fireside/errors.js';
import type { Upload } from '../fireside/schemas.js';
import { episodeArg, guarded, ok, podcastArg, type ToolDeps } from './common.js';
import { describeError, ToolInputError } from './errors.js';
import { differences, readMp3 } from './mp3.js';
import { writtenEpisode, writtenEpisodeSchema } from './shape.js';

// The kinds and types Upload a File accepts; it requires an extension that matches the kind.
const FILE_TYPES: Record<string, { kind: FileKind; contentType: string }> = {
  '.mp3': { kind: 'audio', contentType: 'audio/mpeg' },
  '.jpg': { kind: 'cover', contentType: 'image/jpeg' },
  '.jpeg': { kind: 'cover', contentType: 'image/jpeg' },
  '.png': { kind: 'cover', contentType: 'image/png' },
  '.gif': { kind: 'cover', contentType: 'image/gif' },
  '.webp': { kind: 'cover', contentType: 'image/webp' },
  '.txt': { kind: 'transcript', contentType: 'text/plain' },
};

// macOS and Windows file systems ignore letter case by default.
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

const FIELDS = ['audio_file_url', 'cover_file_url', 'transcript_file_url'] as const;
type FileField = (typeof FIELDS)[number];

const uploadOutputSchema = z.object({
  kind: z.enum(['audio', 'cover', 'transcript']),
  filename: z.string(),
  byte_size: z.number().int(),
  field: z.enum(FIELDS),
  file_url: z.string(),
  expires_at: z.string(),
  audio: z
    .object({
      channels: z.string(),
      bitrate_kbps: z.number(),
      variable_bitrate: z.boolean(),
      sample_rate_hz: z.number(),
      duration_seconds: z.number(),
    })
    .optional(),
  episode: writtenEpisodeSchema.optional(),
});

export interface UploadDeps extends ToolDeps {
  /** Absolute directories whose files may be uploaded. */
  uploadDirs: readonly string[];
}

export function registerUploadTool(server: McpServer, { client, resolver, uploadDirs }: UploadDeps): void {
  const where = uploadDirs.join(', ');
  server.registerTool(
    'fireside_upload_file',
    {
      title: 'Upload episode file',
      description:
        'Upload episode audio (.mp3), cover art (.jpg, .jpeg, .png, .gif or .webp) or a transcript (.txt) from this ' +
        `computer. Only files inside ${where} can be sent; upload only a file the user asked for. With episode, the ` +
        'file is attached to that episode, and changes to a published episode go live immediately. Without it, pass ' +
        "the result's file_url to fireside_create_episode or fireside_update_episode in the field it names; " +
        'resending it with fireside_update_episode also retries an audio transfer that failed. ' +
        'An MP3 is checked first and refused if it differs from the settings Fireside suggests, unless ' +
        'accept_audio_specs is set. Audio then transfers in the background: fireside_get_episode shows its audio_status.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        path: z.string().trim().min(1).describe(`Absolute path of the file, inside ${where}.`),
        episode: episodeArg
          .optional()
          .describe(
            'Episode token or slug to attach the file to, replacing its current one. Omit it to get a file_url for ' +
              'fireside_create_episode or fireside_update_episode instead.',
          ),
        accept_audio_specs: z
          .boolean()
          .optional()
          .describe(
            "Upload an MP3 even though it differs from Fireside's suggested settings (mono, 64–96 kb/s, 44.1 kHz). " +
              'Set it only after telling the user how the file differs and the user agreeing.',
          ),
      }),
      outputSchema: uploadOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const signal = ctx.mcpReq.signal;
        const file = await openFile(args.path, uploadDirs);
        try {
          const audio = file.kind === 'audio' ? await checkAudio(file, args.accept_audio_specs === true) : undefined;
          const podcast = await resolver.podcast(args.podcast, signal);
          // Resolved before uploading, so a mistyped episode costs no upload.
          const episode = args.episode === undefined ? undefined : await resolver.episode(podcast, args.episode, signal);

          let upload: Upload;
          try {
            upload = (
              await client.createUpload(
                podcast,
                { kind: file.kind, filename: file.filename, byte_size: file.size, content_type: file.contentType },
                signal,
              )
            ).data;
          } catch (error) {
            throw withSizeNote(error, file.size);
          }
          const progressToken = ctx.mcpReq._meta?.progressToken;
          await client.sendFile(
            upload,
            // Read through the handle opened by the checks, never by path again.
            { chunks: file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false }), size: file.size },
            {
              signal,
              onProgress: progressToken === undefined ? undefined : progress(progressToken, file.size, ctx.mcpReq.notify),
            },
          );

          const field: FileField = `${file.kind}_file_url`;
          // file_url is returned after attaching too: resending it with fireside_update_episode retries a failed
          // background audio transfer without uploading the file again.
          const result = {
            kind: file.kind,
            filename: file.filename,
            byte_size: file.size,
            field,
            file_url: upload.file_url,
            expires_at: upload.expires_at,
            ...(audio ? { audio } : {}),
          };
          if (episode === undefined) return ok(result);
          const changes: EpisodeFields = {};
          changes[field] = upload.file_url;
          try {
            const res = await client.updateEpisode(podcast, episode, changes, signal);
            return ok({ ...result, episode: writtenEpisode(res.data) });
          } catch (error) {
            if (!fileNotTheProblem(error)) throw error;
            // The upload itself succeeded; resending a large file to retry the attachment would waste it.
            throw new ToolInputError(
              `${describeError(error)}\nThe file itself was uploaded. If the episode does not show it, attach it with ` +
                `fireside_update_episode using ${field}: ${upload.file_url} (Fireside gives it an expiry of ` +
                `${upload.expires_at}) rather than uploading it again.`,
            );
          }
        } finally {
          await file.handle.close();
        }
      }),
  );
}

/**
 * Checks the path against the upload directories and opens it. The file is read through the returned
 * handle, so it cannot be replaced between the checks and the upload. The checks are repeated once the
 * file is open; a process rewriting the upload directories during that moment could still race them.
 */
async function openFile(path: string, dirs: readonly string[]) {
  const outside = new ToolInputError(
    `${path} is outside the upload directories. Files can be uploaded only from ${dirs.join(', ')}, as set in ` +
      'FIRESIDE_UPLOAD_DIRS. Ask the user before changing that.',
  );
  if (!isAbsolute(path)) {
    throw new ToolInputError(`Give the file's absolute path. Files can be uploaded only from ${dirs.join(', ')}.`);
  }
  const realDirs = (await Promise.all(dirs.map((dir) => realpath(dir).catch(() => undefined)))).filter(
    (dir) => dir !== undefined,
  );
  // Checked before the file is touched, so a refusal does not reveal whether a path elsewhere exists. Letter
  // case is ignored where the file system usually ignores it; the check on the resolved path is exact.
  const requested = resolve(path);
  const fold = CASE_INSENSITIVE ? (p: string) => p.toLowerCase() : (p: string) => p;
  if (![...dirs, ...realDirs].some((dir) => isInside(fold(requested), fold(dir)))) throw outside;
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new ToolInputError(`${path} does not exist or cannot be read.`);
  }
  // Checked again once links are followed, so a link inside an allowed directory cannot reach a file outside it.
  if (!realDirs.some((dir) => isInside(real, dir))) throw outside;
  const type = FILE_TYPES[extname(real).toLowerCase()];
  if (!type) {
    throw new ToolInputError(
      `Fireside accepts .mp3 audio, .jpg, .jpeg, .png, .gif or .webp cover art, and .txt transcripts; ${basename(real)} is none of these.`,
    );
  }
  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a named pipe would otherwise wait forever for a writer; it changes nothing for files.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new ToolInputError(`${path} does not exist or cannot be read.`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ToolInputError(`${path} is not a file.`);
    if (info.size === 0) throw new ToolInputError(`${path} is empty.`);
    // The open followed the path again; make sure it reached the file that was checked.
    const again = await realpath(requested).catch(() => undefined);
    const atPath = again === undefined ? undefined : await stat(again).catch(() => undefined);
    if (again !== real || atPath?.dev !== info.dev || atPath?.ino !== info.ino) {
      throw new ToolInputError(`${path} changed while it was being checked. Nothing was uploaded; try again.`);
    }
    return { handle, filename: basename(real), size: info.size, ...type };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Refuses a file that is not an MP3, and one that differs from Fireside's suggestions unless the user accepted that. */
async function checkAudio(file: { handle: FileHandle; size: number; filename: string }, accepted: boolean) {
  const audio = await readMp3(file.handle, file.size);
  if (!audio) {
    throw new ToolInputError(
      `${file.filename} is not an MP3 file (no MPEG Layer III audio was found), and Fireside accepts only MP3 audio. ` +
        'Nothing was uploaded. It needs converting to MP3 first.',
    );
  }
  const diffs = differences(audio);
  if (diffs.length > 0 && !accepted) {
    throw new ToolInputError(
      `${file.filename} differs from what Fireside suggests for MP3 uploads (mono, 64–96 kb/s, 44.1 kHz): it has ` +
        `${diffs.join('; ')}. Nothing was uploaded. Tell the user; to upload it as it is, call fireside_upload_file ` +
        'again with accept_audio_specs: true.',
    );
  }
  return audio;
}

/**
 * Fireside checks a file against the plan's limits when asked for an upload, before anything is sent,
 * and the API does not say what the plan allows; so a refusal names the size as a possible cause.
 */
function withSizeNote(error: unknown, size: number): unknown {
  if (!(error instanceof FiresideApiError) || error.details.status === undefined) return error;
  // 413 and 422 are the statuses a size refusal can take; others (a 403 for the role, say) have their own hint.
  if (error.details.status !== 413 && error.details.status !== 422) return error;
  return new ToolInputError(
    `${describeError(error)}\nThe file is ${size.toLocaleString('en-US')} bytes (${(size / 1e6).toFixed(1)} MB, ` +
      `${(size / 2 ** 20).toFixed(1)} MiB). Fireside checks files against the plan's limits: cover art up to 1.91 MB, ` +
      "transcripts up to 195 KB, and audio up to the plan's MP3 limit, which the Fireside dashboard shows where " +
      'episode audio is uploaded. If the file is larger, that is a likely cause.',
  );
}

/**
 * Whether an attach failure left the uploaded file usable: no response, a server error, a rate limit or
 * a missing episode. Fireside refusing the file itself (upload_failed, 422) is not fixed by resending it.
 */
function fileNotTheProblem(error: unknown): boolean {
  if (!(error instanceof FiresideApiError)) return false;
  const { status } = error.details;
  return status === undefined || status >= 500 || status === 429 || status === 404;
}

function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** Progress notifications at most once a second, so a long upload keeps the host informed without flooding it. */
function progress(
  progressToken: string | number,
  total: number,
  notify: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total: number } }) => Promise<void>,
): (sent: number) => void {
  let last = 0;
  return (sent) => {
    const now = Date.now();
    if (sent < total && now - last < 1000) return;
    last = now;
    notify({ method: 'notifications/progress', params: { progressToken, progress: sent, total } }).catch(() => {});
  };
}
