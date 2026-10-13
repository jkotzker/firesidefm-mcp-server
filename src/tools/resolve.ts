import type { FiresideClient } from '../fireside/client.js';
import { ToolInputError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bound the pages read when looking up a slug, so a misbehaving `next` cannot loop forever.
const MAX_PODCAST_PAGES = 20; // 1,000 podcasts
const MAX_EPISODE_PAGES = 50; // 5,000 episodes

/**
 * Turns the podcast and episode references a user is likely to give (a slug, or an episode
 * number, which is an episode's default slug) into the tokens the API requires.
 */
export class Resolver {
  readonly #client: FiresideClient;
  readonly #defaultPodcast: string | undefined;
  // Slug → token. Podcast slugs rarely change, so they are cached for the life of the process.
  readonly #podcastTokens = new Map<string, string>();

  constructor(client: FiresideClient, defaultPodcast?: string) {
    this.#client = client;
    this.#defaultPodcast = defaultPodcast;
  }

  get defaultPodcast(): string | undefined {
    return this.#defaultPodcast;
  }

  async podcast(ref: string | undefined, signal?: AbortSignal): Promise<string> {
    const value = ref?.trim() || this.#defaultPodcast;
    if (!value) {
      throw new ToolInputError(
        'No podcast given. Pass `podcast` (a token or slug from fireside_list_podcasts), ' +
          'or set FIRESIDE_PODCAST in the server configuration.',
      );
    }
    if (UUID.test(value)) return value;

    const key = value.toLowerCase();
    const cached = this.#podcastTokens.get(key);
    if (cached) return cached;

    const slugs: string[] = [];
    let page: number | null = 1;
    for (let read = 0; page !== null && read < MAX_PODCAST_PAGES; read++) {
      const res = await this.#client.listPodcasts({ page, per_page: 50 }, signal);
      for (const podcast of res.data) {
        this.#podcastTokens.set(podcast.slug.toLowerCase(), podcast.token);
        slugs.push(podcast.slug);
      }
      page = res.pagination.next;
    }
    const found = this.#podcastTokens.get(key);
    if (found) return found;
    if (page !== null) {
      throw new ToolInputError(
        `No podcast with slug "${value}" among the first ${slugs.length} podcasts searched. Pass the podcast's token instead.`,
      );
    }
    throw new ToolInputError(
      `No podcast with slug "${value}" is visible to this API key. Available: ${slugs.join(', ') || 'none'}.`,
    );
  }

  async episode(podcastToken: string, ref: string, signal?: AbortSignal): Promise<string> {
    const value = ref.trim();
    if (UUID.test(value)) return value;

    const key = value.toLowerCase();
    let page: number | null = 1;
    let searched = 0;
    for (let read = 0; page !== null && read < MAX_EPISODE_PAGES; read++) {
      const res = await this.#client.listEpisodes(podcastToken, { page, per_page: 100 }, signal);
      const match = res.data.find((episode) => episode.slug.toLowerCase() === key);
      if (match) return match.token;
      searched += res.data.length;
      page = res.pagination.next;
    }
    if (page !== null) {
      throw new ToolInputError(
        `No episode with slug "${value}" among the ${searched} most recent episodes searched. Pass the episode's token instead.`,
      );
    }
    throw new ToolInputError(
      `No episode with slug "${value}" in this podcast. Pass an episode token or slug from fireside_list_episodes.`,
    );
  }
}
