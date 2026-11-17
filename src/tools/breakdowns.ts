import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { breakdownRowSchema, paginationSchema } from '../fireside/schemas.js';
import { episodeArg, guarded, ok, pageArgs, pick, podcastArg, type ToolDeps } from './common.js';
import { ToolInputError } from './errors.js';

// Which breakdown each filter applies to, as Fireside documents it.
const FILTER_FOR = { app: 'platforms', platform: 'apps', country: 'regions' } as const;

export function registerBreakdownTool(server: McpServer, { client, resolver }: ToolDeps): void {
  server.registerTool(
    'fireside_get_download_breakdown',
    {
      title: 'Get downloads by platform, app or location',
      description:
        'All-time downloads by listener platform, podcast app, country, or region within a country, for a whole ' +
        'podcast or, with episode, for one episode, most downloads first. These are the numbers on the Fireside ' +
        "dashboard's Platforms, Apps and Countries pages. Each row has name, downloads and percent_of_total; " +
        'meta.total_downloads counts every download, including ones without a recorded name. The totals cover all ' +
        'time and cannot be limited to a date range. Needs a Fireside plan with Advanced Metrics.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        episode: episodeArg
          .optional()
          .describe('Episode token (UUID) or slug, as shown by fireside_list_episodes. Leave out for the whole podcast.'),
        by: z
          .enum(['platforms', 'apps', 'countries', 'regions'])
          .describe('platforms (iOS, Android and so on), apps, countries, or regions (states or provinces) of one country.'),
        app: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('With by platforms only: one app, named exactly as by apps lists it, to break it down by platform.'),
        platform: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('With by apps only: one platform, named exactly as by platforms lists it, to list the apps used on it.'),
        country: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Required with by regions, and only used there: a country, named exactly as by countries lists it.'),
        ...pageArgs(100, 25),
      }),
      outputSchema: z.object({
        rows: z.array(breakdownRowSchema),
        meta: z.looseObject({ total_downloads: z.number().int() }),
        pagination: paginationSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        for (const [filter, by] of Object.entries(FILTER_FOR) as [keyof typeof FILTER_FOR, string][]) {
          if (args[filter] !== undefined && args.by !== by) {
            throw new ToolInputError(`${filter} can be given only with by ${by}.`);
          }
        }
        if (args.by === 'regions' && args.country === undefined) {
          throw new ToolInputError('by regions needs country: a country named as by countries lists it.');
        }
        const signal = ctx.mcpReq.signal;
        const podcast = await resolver.podcast(args.podcast, signal);
        const episode = args.episode === undefined ? undefined : await resolver.episode(podcast, args.episode, signal);
        const query = pick(args, 'app', 'platform', 'country', 'page', 'per_page');
        const res = await client.getBreakdown(podcast, episode, args.by, query, signal);
        return ok({ rows: res.data, meta: res.meta, pagination: res.pagination });
      }),
  );
}
