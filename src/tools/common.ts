import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { FiresideClient } from '../fireside/client.js';
import { errorResult } from './errors.js';
import type { Resolver } from './resolve.js';

export interface ToolDeps {
  client: FiresideClient;
  resolver: Resolver;
}

export function ok(output: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
}

/** Runs a tool body, turning any failure into an `isError` result the model can act on. */
export async function guarded(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return errorResult(error);
  }
}

export function podcastArg(resolver: Resolver) {
  const fallback = resolver.defaultPodcast
    ? `Defaults to the configured podcast (${resolver.defaultPodcast}).`
    : 'Required unless FIRESIDE_PODCAST is configured.';
  return z
    .string()
    .min(1)
    .optional()
    .describe(`Podcast token (UUID) or slug, as shown by fireside_list_podcasts. ${fallback}`);
}

export const episodeArg = z
  .string()
  .min(1)
  .describe('Episode token (UUID) or slug, as shown by fireside_list_episodes. For numbered episodes the slug is the episode number.');

export function pageArgs(maxPerPage: number, defaultPerPage: number) {
  return {
    page: z.number().int().min(1).optional().describe('Page number, from 1. Defaults to 1.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(maxPerPage)
      .optional()
      .describe(`Results per page, 1–${maxPerPage}. Defaults to ${defaultPerPage}.`),
  };
}
