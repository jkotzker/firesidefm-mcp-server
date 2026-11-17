import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { chapterSchema } from '../fireside/schemas.js';
import { episodeArg, guarded, ok, pick, podcastArg, type ToolDeps } from './common.js';
import { ToolInputError } from './errors.js';

const AUDIO_CHAPTERS =
  'audio_chapters says whether the MP3 has these chapters yet: up_to_date, writing (being written into it), ' +
  'out_of_date (it has older chapters from a dashboard change not yet written), no_audio (they are written into ' +
  'the MP3 once one is added), or off (the episode is set in the dashboard not to write chapters).';
const LIVE =
  "Changes reach the episode's feed right away and are written into its MP3 in the background. Chapters that start " +
  'after the audio ends are left out of the MP3.';

const start = z
  .union([z.number().int().min(0), z.string().trim().min(1)])
  .describe('When the chapter starts: whole seconds, like 330, or a timecode string, like "05:30" or "1:02:03".');
const title = z.string().trim().min(1).max(1000).describe('The chapter title, up to 1,000 characters.');
const chapterArg = z.string().trim().min(1).describe('The chapter token, from fireside_list_chapters.');

const listOutput = z.object({ chapters: z.array(chapterSchema), audio_chapters: z.string() });
const itemOutput = z.object({ chapter: chapterSchema, audio_chapters: z.string() });

export function registerChapterTools(server: McpServer, { client, resolver }: ToolDeps, write: boolean): void {
  server.registerTool(
    'fireside_list_chapters',
    {
      title: 'List chapters',
      description:
        "List an episode's chapters in order, each with its token, start (in seconds), timecode (HH:MM:SS) and " +
        `title. ${AUDIO_CHAPTERS} Needs the owner, manager, or producer role.`,
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg }),
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.listChapters(podcast, episode, ctx.mcpReq.signal);
        return ok({ chapters: res.data, audio_chapters: res.audio_chapters });
      }),
  );
  if (!write) return;

  server.registerTool(
    'fireside_set_chapters',
    {
      title: 'Replace chapters',
      description:
        "Replace an episode's whole chapter list, for example with chapters written from its transcript. Chapters " +
        'left out are deleted, and an empty list deletes them all, so to change one or two use ' +
        'fireside_add_chapter, fireside_update_chapter or fireside_delete_chapter instead. ' +
        "Include a chapter's " +
        'token (from fireside_list_chapters) to keep and update it; leave the token out to add a new one. If any ' +
        `chapter is invalid, nothing changes. ${LIVE}`,
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        chapters: z
          .array(
            z.strictObject({
              token: chapterArg.optional().describe("An existing chapter's token, to keep it. Omit for a new chapter."),
              start,
              title,
            }),
          )
          .max(255)
          .describe('The complete new chapter list, up to 255 chapters.'),
      }),
      outputSchema: listOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const chapters = args.chapters.map((c) => ({ ...pick(c, 'token'), start: c.start, title: c.title }));
        const res = await client.replaceChapters(podcast, episode, chapters, ctx.mcpReq.signal);
        return ok({ chapters: res.data, audio_chapters: res.audio_chapters });
      }),
  );

  server.registerTool(
    'fireside_add_chapter',
    {
      title: 'Add chapter',
      description: `Add one chapter to an episode. To set many at once, use fireside_set_chapters. ${LIVE}`,
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg, start, title }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.createChapter(podcast, episode, pick(args, 'start', 'title'), ctx.mcpReq.signal);
        return ok({ chapter: res.data, audio_chapters: res.audio_chapters });
      }),
  );

  server.registerTool(
    'fireside_update_chapter',
    {
      title: 'Update chapter',
      description: `Change one chapter's start or title, leaving the other alone. ${LIVE}`,
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        chapter: chapterArg,
        start: start.optional(),
        title: title.optional(),
      }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const changes = pick(args, 'start', 'title');
        if (Object.keys(changes).length === 0) throw new ToolInputError('Nothing to change: pass start, title, or both.');
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.updateChapter(podcast, episode, args.chapter, changes, ctx.mcpReq.signal);
        return ok({ chapter: res.data, audio_chapters: res.audio_chapters });
      }),
  );

  server.registerTool(
    'fireside_delete_chapter',
    {
      title: 'Delete chapter',
      description: `Delete one chapter from an episode. Returns the chapter as it was. ${LIVE}`,
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg, chapter: chapterArg }),
      outputSchema: itemOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.deleteChapter(podcast, episode, args.chapter, ctx.mcpReq.signal);
        return ok({ chapter: res.data, audio_chapters: res.audio_chapters });
      }),
  );
}
