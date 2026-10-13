import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { EpisodeFields } from '../fireside/client.js';
import { episodeArg, guarded, ok, pick, podcastArg, type ToolDeps } from './common.js';
import { ToolInputError } from './errors.js';
import { writtenEpisode, writtenEpisodeSchema } from './shape.js';

const episodeFields = {
  title: z.string().min(1).optional().describe('Episode title.'),
  subtitle: z.string().nullable().optional().describe('One-line summary. null clears it.'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Use lower-case letters, numbers and dashes only.')
    .optional()
    .describe("Path of the episode's page: lower-case letters, numbers and dashes, unique within the podcast."),
  description: z.string().nullable().optional().describe('Show notes, in Markdown. null clears them.'),
  season: z.number().int().min(0).nullable().optional().describe('Season number, from 0. null clears it.'),
  episode_type: z.enum(['full', 'trailer', 'bonus']).optional().describe('full, trailer, or bonus.'),
  explicit: z.boolean().optional().describe('Whether the episode has explicit content.'),
};
const FIELD_KEYS = Object.keys(episodeFields) as (keyof typeof episodeFields)[];

const output = { outputSchema: writtenEpisodeSchema } as const;

export function registerWriteTools(server: McpServer, { client, resolver }: ToolDeps): void {
  server.registerTool(
    'fireside_create_episode',
    {
      title: 'Create draft episode',
      description:
        "Create a private draft episode, starting from the podcast's episode defaults. Nothing is published. " +
        'Audio cannot be uploaded through the API: the user adds it in the Fireside dashboard before publishing. ' +
        'Without a slug, the next episode number is used.',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), ...episodeFields }),
      ...output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const res = await client.createEpisode(podcast, fields(args), ctx.mcpReq.signal);
        return ok(writtenEpisode(res.data));
      }),
  );

  server.registerTool(
    'fireside_update_episode',
    {
      title: 'Update episode',
      description:
        "Change an episode's title, subtitle, slug, show notes, season, type or explicit flag, leaving other fields alone. " +
        'Changes to a published episode go live immediately, and a new slug changes its public URL. ' +
        'Release date and visibility change only through fireside_publish_episode and fireside_unpublish_episode.',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg, ...episodeFields }),
      ...output,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const changes = fields(args);
        if (Object.keys(changes).length === 0) {
          throw new ToolInputError(`Nothing to change: pass at least one of ${FIELD_KEYS.join(', ')}.`);
        }
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.updateEpisode(podcast, episode, changes, ctx.mcpReq.signal);
        return ok(writtenEpisode(res.data));
      }),
  );

  server.registerTool(
    'fireside_publish_episode',
    {
      title: 'Publish episode',
      description:
        "Release an episode to the podcast's feed and website: now, at a future time (scheduled), or backdated. " +
        'The episode must already have audio. If the episode is set in the dashboard to post to connected social ' +
        'accounts, publishing posts there too. Confirm the episode, time and visibility with the user before calling.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg,
        published_at: z
          .string()
          .min(1)
          .optional()
          .describe(
            'ISO 8601 release time, e.g. 2026-10-12T09:00:00-04:00. A future time schedules the episode. ' +
              "Without a UTC offset it is read in the podcast's time zone. Omitted: now for a draft; an " +
              'already-published episode keeps its date.',
          ),
        visibility: z
          .enum(['public', 'unlisted'])
          .optional()
          .describe('public, or unlisted (reachable only by its link). Omitted: public for a draft; otherwise unchanged.'),
      }),
      ...output,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.publishEpisode(
          podcast,
          episode,
          pick(args, 'published_at', 'visibility'),
          ctx.mcpReq.signal,
        );
        return ok(writtenEpisode(res.data));
      }),
  );

  server.registerTool(
    'fireside_unpublish_episode',
    {
      title: 'Unpublish episode',
      description:
        'Turn an episode back into a private draft, removing it from the feed and website. Its release date is kept, ' +
        'so publishing again with that date puts it back in place.',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg }),
      ...output,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        const res = await client.unpublishEpisode(podcast, episode, ctx.mcpReq.signal);
        return ok(writtenEpisode(res.data));
      }),
  );
}

/** The episode fields among a tool's arguments; typed so the Zod shape must stay assignable to EpisodeFields. */
function fields(args: z.infer<z.ZodObject<typeof episodeFields>>): EpisodeFields {
  return pick(args, ...FIELD_KEYS);
}
