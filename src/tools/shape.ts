import * as z from 'zod/v4';

import {
  downloadsSchema,
  type Episode,
  type EpisodeMetrics,
  episodeSchema,
  type Podcast,
  paginationSchema,
  podcastSchema,
} from '../fireside/schemas.js';

// List tools return trimmed records so a page of results stays small in the model's context;
// the get tools return everything Fireside sends.

export const podcastSummarySchema = z.object({
  token: z.string(),
  title: z.string(),
  slug: z.string(),
  subtitle: z.string().nullable(),
  url: z.string(),
  feed_url: z.string(),
  type: z.string(),
  language: z.string(),
  explicit: z.boolean(),
  created_at: z.string(),
});

export function podcastSummary(p: Podcast): z.infer<typeof podcastSummarySchema> {
  return {
    token: p.token,
    title: p.title,
    slug: p.slug,
    subtitle: p.subtitle,
    url: p.url,
    feed_url: p.feed_url,
    type: p.type,
    language: p.language,
    explicit: p.explicit,
    created_at: p.created_at,
  };
}

export const episodeSummarySchema = z.object({
  token: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  slug: z.string(),
  season: z.number().int().nullable(),
  episode_type: z.string(),
  status: z.string(),
  visibility: z.string(),
  members_only: z.boolean(),
  explicit: z.boolean(),
  duration: z.number().int().nullable(),
  has_audio: z.boolean(),
  published_at: z.string().nullable(),
  updated_at: z.string(),
  url: z.string().nullable(),
});

export function episodeSummary(e: Episode): z.infer<typeof episodeSummarySchema> {
  return {
    token: e.token,
    title: e.title,
    subtitle: e.subtitle,
    slug: e.slug,
    season: e.season,
    episode_type: e.episode_type,
    status: e.status,
    visibility: e.visibility,
    members_only: e.members_only,
    explicit: e.explicit,
    duration: e.duration,
    has_audio: e.audio_url !== null,
    published_at: e.published_at,
    updated_at: e.updated_at,
    url: e.url,
  };
}

/**
 * What the write tools return: the summary plus the show notes, without the private preview link.
 * The docs promise `description` only from Create and Get, so it is left out rather than reported
 * as null when a response doesn't carry it.
 */
export const writtenEpisodeSchema = episodeSummarySchema.extend({ description: z.string().nullable().optional() });

export function writtenEpisode(e: Episode): z.infer<typeof writtenEpisodeSchema> {
  const summary = episodeSummary(e);
  return e.description === undefined ? summary : { ...summary, description: e.description };
}

export const episodeMetricsSummarySchema = z.object({
  token: z.string(),
  title: z.string(),
  slug: z.string(),
  published_at: z.string().nullable(),
  downloads: downloadsSchema,
});

export function episodeMetricsSummary(m: EpisodeMetrics): z.infer<typeof episodeMetricsSummarySchema> {
  return { token: m.token, title: m.title, slug: m.slug, published_at: m.published_at, downloads: m.downloads };
}

export const fullPodcastSchema = podcastSchema;
export const fullEpisodeSchema = episodeSchema;
export const pageSchema = paginationSchema;
