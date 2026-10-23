import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { DailyRange } from '../fireside/client.js';
import {
  type DailyDownloads,
  dailyDownloadsSchema,
  episodeSchema,
  meSchema,
  monthlyDownloadsSchema,
  paginationSchema,
  podcastSchema,
} from '../fireside/schemas.js';
import { episodeArg, guarded, ok, pageArgs, pick, podcastArg, type ToolDeps } from './common.js';
import { daysBetween, MAX_DAYS_PER_REQUEST, mergeDaily, planDailyRanges, utcToday } from './daily.js';
import { ToolInputError } from './errors.js';
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

  const count = z.number().int();
  server.registerTool(
    'fireside_get_daily_downloads',
    {
      title: 'Get daily downloads',
      description:
        'Day-by-day downloads, oldest first, for a whole podcast or, with episode, for one episode. Days with no ' +
        'downloads appear with zeros, and each day is a calendar day in the podcast’s time zone. downloads is ' +
        'Fireside’s count, spotify is reported by Spotify, and total is their sum. One call covers up to a year; ' +
        'for a longer period, call once for each part.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg.optional().describe(
          'Episode token (UUID) or slug, as shown by fireside_list_episodes. Leave out for the whole podcast.',
        ),
        start_date: z.iso.date().optional().describe('First day, YYYY-MM-DD. Defaults to 29 days before end_date.'),
        end_date: z.iso.date().optional().describe('Last day, YYYY-MM-DD. Defaults to today in the podcast’s time zone.'),
      }),
      outputSchema: z.object({
        days: z.array(dailyDownloadsSchema),
        start_date: z.string(),
        end_date: z.string(),
        time_zone: z.string(),
        downloads: count,
        spotify: count,
        total: count,
      }),
      annotations: READ,
    },
    (args, ctx) =>
      guarded(async () => {
        const signal = ctx.mcpReq.signal;
        const podcast = await resolver.podcast(args.podcast, signal);
        const episode = args.episode === undefined ? undefined : await resolver.episode(podcast, args.episode, signal);
        const fetchDays = (range: DailyRange) => client.getDailyDownloads(podcast, episode, range, signal);
        const fetchAll = async (start: string, end: string) => {
          const parts: DailyDownloads[] = [];
          // One at a time: the requests share the key's rate limit, and the days must stay in order.
          for (const range of planDailyRanges(start, end)) parts.push(await fetchDays(range));
          return ok(mergeDaily(parts));
        };

        const { start_date: start, end_date: end } = args;
        if (start !== undefined && end !== undefined) return fetchAll(start, end);
        // Without a start, Fireside's own default of 30 days applies.
        if (start === undefined) return ok(mergeDaily([await fetchDays(pick(args, 'end_date'))]));
        // The podcast's date is within a day of UTC, so this range is at most 90 days whatever its time zone.
        if (daysBetween(start, utcToday()) <= MAX_DAYS_PER_REQUEST - 2) {
          return ok(mergeDaily([await fetchDays({ start_date: start })]));
        }
        // The API does not say which time zone a podcast uses, so ask Fireside for its "today" first.
        const today = (await fetchDays({})).meta.end_date;
        if (start > today) {
          throw new ToolInputError(
            `start_date ${start} is after today (${today}) for this podcast. Give a start_date on or before today.`,
          );
        }
        return fetchAll(start, today);
      }),
  );
}
