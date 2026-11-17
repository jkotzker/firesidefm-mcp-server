import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { PodcastFields } from '../fireside/client.js';
import { podcastSchema } from '../fireside/schemas.js';
import { guarded, ok, pick, podcastArg, type ToolDeps } from './common.js';
import { ToolInputError } from './errors.js';

const DEFAULT_KEYS = ['subtitle', 'description', 'keywords', 'tags', 'episode_type', 'auto_season'] as const;

const episodeDefaults = z.strictObject({
  subtitle: z.string().max(255).nullable().optional().describe('The summary new episodes start with, up to 255 characters.'),
  description: z.string().nullable().optional().describe('The show notes new episodes start with, in Markdown.'),
  keywords: z.string().max(255).nullable().optional().describe('Comma-separated keywords, up to 255 characters.'),
  tags: z.string().nullable().optional().describe('Comma-separated tags.'),
  episode_type: z.enum(['full', 'trailer', 'bonus']).optional().describe('full, trailer, or bonus.'),
  auto_season: z
    .boolean()
    .optional()
    .describe('true starts new episodes in the latest published season; false leaves their season blank.'),
});

export function registerPodcastWriteTools(server: McpServer, { client, resolver }: ToolDeps): void {
  server.registerTool(
    'fireside_update_podcast',
    {
      title: 'Update podcast',
      description:
        "Change a podcast's subtitle, description or cover art, or the defaults new episodes start with, leaving " +
        "everything else alone. Changes appear on the podcast's website and in its RSS feed right away, so " +
        'confirm them with the user first. For new cover art, upload the image with fireside_upload_file and ' +
        'podcast_cover set, and pass its file_url. The title, web address, custom domain and feed cannot be ' +
        'changed. Needs the manager or owner role.',
      inputSchema: z.strictObject({
        podcast: podcastArg(resolver),
        subtitle: z
          .string()
          .nullable()
          .optional()
          .describe('A short line about the podcast, shown under its title on its website and in its feed. null clears it.'),
        description: z
          .string()
          .nullable()
          .optional()
          .describe('What the podcast is about, in plain text, for its website, feed and podcast apps.'),
        cover_file_url: z
          .string()
          .min(1)
          .optional()
          .describe(
            'New cover art: a file_url from fireside_upload_file with podcast_cover set. A square JPG, PNG, GIF or ' +
              'WebP at least 1400 pixels wide.',
          ),
        episode_defaults: episodeDefaults
          .optional()
          .describe('What new episodes start with. Only the defaults passed change.'),
      }),
      // Update Podcast returns the podcast as Get Podcast does, without total_downloads.
      outputSchema: podcastSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      guarded(async () => {
        const changes: PodcastFields = pick(args, 'subtitle', 'description', 'cover_file_url');
        const defaults = args.episode_defaults === undefined ? {} : pick(args.episode_defaults, ...DEFAULT_KEYS);
        if (Object.keys(defaults).length > 0) changes.episode_defaults = defaults;
        if (Object.keys(changes).length === 0) {
          throw new ToolInputError(
            'Nothing to change: pass at least one of subtitle, description, cover_file_url, or an episode_defaults field.',
          );
        }
        const podcast = await resolver.podcast(args.podcast, ctx.mcpReq.signal);
        return ok((await client.updatePodcast(podcast, changes, ctx.mcpReq.signal)).data);
      }),
  );
}
