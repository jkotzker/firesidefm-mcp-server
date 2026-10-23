import * as z from 'zod/v4';

// Response shapes as documented at https://fireside.fm/docs/api (captured 2026-10-13).
// Objects are loose: fields the docs don't list yet pass through instead of failing the parse,
// because the API is young and still growing. Documented fields are typed as documented.

const nullableString = z.string().nullable();

export const paginationSchema = z.looseObject({
  page: z.number().int(),
  per_page: z.number().int(),
  max_per_page: z.number().int(),
  previous: z.number().int().nullable(),
  next: z.number().int().nullable(),
});

export const meSchema = z.looseObject({
  name: z.string(),
  email: z.string(),
  created_at: z.string(),
  api_token: z.looseObject({
    name: z.string(),
    access: z.enum(['read_only', 'read_and_write']),
    created_at: z.string(),
  }),
});

export const podcastSchema = z.looseObject({
  token: z.string(),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  subtitle: nullableString,
  author_name: z.string(),
  language: z.string(),
  explicit: z.boolean(),
  artwork_url: nullableString,
  total_downloads: z.number().int().optional(),
  created_at: z.string(),
  url: z.string(),
  feed_url: z.string(),
  type: z.string(),
  categories: z.array(z.looseObject({ name: z.string(), parent: nullableString })),
  copyright: z.string(),
  donation_url: nullableString,
  owner: z.looseObject({ name: z.string(), email: z.string() }),
});
export type Podcast = z.infer<typeof podcastSchema>;

const person = z.looseObject({ name: z.string(), url: nullableString });

export const episodeSchema = z.looseObject({
  token: z.string(),
  title: z.string(),
  subtitle: nullableString,
  slug: z.string(),
  season: z.number().int().nullable(),
  episode_type: z.string(),
  status: z.enum(['published', 'scheduled', 'draft']),
  visibility: z.enum(['public', 'unlisted', 'private']),
  members_only: z.boolean(),
  explicit: z.boolean(),
  duration: z.number().int().nullable(),
  published_at: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  url: nullableString,
  preview_url: z.string(),
  audio_url: nullableString,
  audio_size: z.number().int().nullable(),
  // Documented as processing, ready, failed or none; a string so that a new status does not break every read.
  audio_status: z.string(),
  audio_error: nullableString,
  guid: z.string(),
  // Documented as the podcast's artwork when the episode has none, and podcast artwork can be null.
  artwork_url: nullableString,
  transcript_url: nullableString,
  chapters_url: nullableString,
  player_url: z.string(),
  player_embed_code: z.string(),
  soundbite: z
    .looseObject({ title: z.string(), start_time: z.number(), duration: z.number() })
    .nullable(),
  hosts: z.array(person),
  guests: z.array(person),
  // Documented on Get Episode and Create Episode; list results and other write responses may omit it.
  description: nullableString.optional(),
});
export type Episode = z.infer<typeof episodeSchema>;

export const downloadsSchema = z.looseObject({
  '1_day': z.number().int().nullable(),
  '7_day': z.number().int().nullable(),
  '14_day': z.number().int().nullable(),
  '30_day': z.number().int().nullable(),
  '90_day': z.number().int().nullable(),
  spotify: z.number().int(),
  total: z.number().int(),
});

// The docs say metrics items carry every List Episodes field, but their example shows only a
// subset, so only the fields present in the example are required here.
export const episodeMetricsSchema = z.looseObject({
  token: z.string(),
  title: z.string(),
  slug: z.string(),
  status: z.string(),
  published_at: nullableString,
  downloads: downloadsSchema,
});
export type EpisodeMetrics = z.infer<typeof episodeMetricsSchema>;

export const monthlyDownloadsSchema = z.looseObject({
  date: z.string(),
  value: z.number().int(),
});

export const uploadSchema = z.looseObject({
  kind: z.string(),
  upload_url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  file_url: z.string(),
  expires_at: z.string(),
});
export type Upload = z.infer<typeof uploadSchema>;

export const errorBodySchema = z.object({
  error: z.looseObject({
    message: z.string(),
    code: z.string().optional(),
    // Documented as field → list of messages; anything else is kept and stringified when shown.
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  // An upload_failed error carries the episode, whose other changes were saved.
  data: z.unknown().optional(),
});

export function itemEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: item });
}

export function listEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: z.array(item), pagination: paginationSchema });
}

export const monthlyDownloadsEnvelope = z.looseObject({
  data: z.array(monthlyDownloadsSchema),
  meta: z.looseObject({ total_downloads: z.number().int() }),
  pagination: paginationSchema,
});

export const dailyDownloadsSchema = z.looseObject({
  day: z.string(),
  downloads: z.number().int(),
  spotify: z.number().int(),
  total: z.number().int(),
});

export const dailyDownloadsEnvelope = z.looseObject({
  data: z.array(dailyDownloadsSchema),
  meta: z.looseObject({
    start_date: z.string(),
    end_date: z.string(),
    time_zone: z.string(),
    downloads: z.number().int(),
    spotify: z.number().int(),
    total: z.number().int(),
  }),
});
export type DailyDownloads = z.infer<typeof dailyDownloadsEnvelope>;
