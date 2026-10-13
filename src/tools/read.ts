import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { episodeSchema, meSchema, monthlyDownloadsSchema, paginationSchema, podcastSchema } from '../fireside/schemas.js';
import { episodeArg, guarded, ok, pageArgs, pick, podcastArg, type ToolDeps } from './common.js';
import {
  episodeMetricsSummary,
  episodeMetricsSummarySchema,
  episodeSummary,
  episodeSummarySchema,
  podcastSummary,
  podcastSummarySchema,
} from './shape.js';

const READ = { readOnlyHint: true, openWorldHint: true } as const;

export function registerReadTools(server: McpServer, { client, resolver }: ToolDeps): void {
  server.registerTool(
    'fireside_get_account',
    {
      title: 'Get Fireside account',
      description:
        'Show the Fireside account this server is connected to, and whether its API key is read_only or read_and_write.',
      outputSchema: meSchema,
      annotations: READ,
    },
    (ctx) => guarded(async () => ok((await client.getMe(ctx.mcpReq.signal)).data)),
  );

  server.registerTool(
    'fireside_list_podcasts',
    {
      title: 'List podcasts',
      description:
        'List the podcasts this account owns or collaborates on (complete, active podcasts only). ' +
        'Returns a summary of each; use fireside_get_podcast for full details and all-time downloads.',
      inputSchema: z.strictObject(pageArgs(50, 50)),
      outputSchema: z.object({ podcasts: z.array(podcastSummarySchema), pagination: paginationSchema }),
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const res = await client.listPodcasts(args, ctx.mcpReq.signal);
        return ok({ podcasts: res.data.map(podcastSummary), pagination: res.pagination });
      }),
  );

  server.registerTool(
    'fireside_get_podcast',
    {
      title: 'Get podcast',
      description:
        "Get one podcast's full details: description, artwork, categories, feed and website URLs, owner, and all-time total downloads.",
      inputSchema: z.strictObject({ podcast: podcastArg(resolver) }),
      outputSchema: podcastSchema,
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        return ok((await client.getPodcast(podcast, ctx.mcpReq.signal)).data);
      }),
  );

  server.registerTool(
    'fireside_list_episodes',
    {
      title: 'List episodes',
      description:
        "List a podcast's episodes, newest first, including drafts and scheduled episodes. " +
        'Returns a summary of each (has_audio shows whether audio has been uploaded); ' +
        'use fireside_get_episode for show notes and all other fields. Needs the owner, manager, or producer role.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        status: z
          .enum(['published', 'scheduled', 'draft'])
          .optional()
          .describe('Only episodes with this status. Defaults to all.'),
        ...pageArgs(100, 25),
      }),
      outputSchema: z.object({ episodes: z.array(episodeSummarySchema), pagination: paginationSchema }),
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const res = await client.listEpisodes(
          podcast,
          pick(args, 'status', 'page', 'per_page'),
          ctx.mcpReq.signal,
        );
        return ok({ episodes: res.data.map(episodeSummary), pagination: res.pagination });
      }),
  );

  server.registerTool(
    'fireside_get_episode',
    {
      title: 'Get episode',
      description:
        'Get every field of one episode, including its show notes (description), audio, transcript and chapters URLs, ' +
        'hosts and guests, and web player. preview_url is a private link: anyone who has it can play the episode ' +
        'before release, so share it only when the user asks for it.',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), episode: episodeArg }),
      outputSchema: episodeSchema,
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const episode = await resolver.episode(podcast, args.episode, ctx.mcpReq.signal);
        return ok((await client.getEpisode(podcast, episode, ctx.mcpReq.signal)).data);
      }),
  );

  server.registerTool(
    'fireside_get_episode_metrics',
    {
      title: 'Get episode downloads',
      description:
        "Download counts for a podcast's published episodes, newest first: downloads within 1, 7, 14, 30 and 90 days " +
        'of release (null until that much time has passed), Spotify streams, and all-time total (which includes Spotify).',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), ...pageArgs(100, 25) }),
      outputSchema: z.object({ episodes: z.array(episodeMetricsSummarySchema), pagination: paginationSchema }),
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const res = await client.getEpisodeMetrics(
          podcast,
          pick(args, 'page', 'per_page'),
          ctx.mcpReq.signal,
        );
        return ok({ episodes: res.data.map(episodeMetricsSummary), pagination: res.pagination });
      }),
  );

  server.registerTool(
    'fireside_get_monthly_downloads',
    {
      title: 'Get monthly downloads',
      description:
        "A podcast's total downloads per calendar month, most recent first, plus its all-time total. " +
        'Each month is identified by its first day (YYYY-MM-DD).',
      inputSchema: z.strictObject({ podcast: podcastArg(resolver), ...pageArgs(36, 12) }),
      outputSchema: z.object({
        months: z.array(monthlyDownloadsSchema),
        total_downloads: z.number().int(),
        pagination: paginationSchema,
      }),
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        const res = await client.getMonthlyDownloads(
          podcast,
          pick(args, 'page', 'per_page'),
          ctx.mcpReq.signal,
        );
        return ok({ months: res.data, total_downloads: res.meta.total_downloads, pagination: res.pagination });
      }),
  );
}
