import type * as z from 'zod/v4';

import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { FiresideApiError, FiresideResponseShapeError } from './errors.js';
import {
  episodeMetricsSchema,
  episodeSchema,
  errorBodySchema,
  itemEnvelope,
  listEnvelope,
  meSchema,
  monthlyDownloadsEnvelope,
  podcastSchema,
} from './schemas.js';

export const DEFAULT_BASE_URL = 'https://fireside.fm/api/v1/';

/** Fields accepted by Create Episode and Update Episode. Unknown fields are refused by the API. */
export interface EpisodeFields {
  title?: string | undefined;
  subtitle?: string | null | undefined;
  slug?: string | undefined;
  description?: string | null | undefined;
  season?: number | null | undefined;
  episode_type?: 'full' | 'trailer' | 'bonus' | undefined;
  explicit?: boolean | undefined;
}

export interface PublishOptions {
  /** ISO 8601. Future schedules; past backdates; no offset means the podcast's time zone. */
  published_at?: string | undefined;
  visibility?: 'public' | 'unlisted' | undefined;
}

export interface PageOptions {
  page?: number | undefined;
  per_page?: number | undefined;
}

export interface FiresideClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries after a 429, honouring Retry-After. */
  maxRateLimitRetries?: number;
  /** Longest Retry-After we will wait out; anything longer is returned as an error. */
  maxRetryAfterSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Per-attempt limit on waiting for Fireside to respond. */
  requestTimeoutMs?: number;
}

type Query = Record<string, string | number | undefined>;

export class FiresideClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #maxRetryAfter: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #timeoutMs: number;

  constructor(options: FiresideClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRateLimitRetries ?? 2;
    this.#maxRetryAfter = options.maxRetryAfterSeconds ?? 30;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  getMe(signal?: AbortSignal) {
    return this.#request('GET', 'me', itemEnvelope(meSchema), { signal });
  }

  listPodcasts(page: PageOptions = {}, signal?: AbortSignal) {
    return this.#request('GET', 'podcasts', listEnvelope(podcastSchema), { query: { ...page }, signal });
  }

  getPodcast(podcast: string, signal?: AbortSignal) {
    return this.#request('GET', `podcasts/${seg(podcast)}`, itemEnvelope(podcastSchema), { signal });
  }

  listEpisodes(
    podcast: string,
    options: PageOptions & { status?: 'published' | 'scheduled' | 'draft' | undefined } = {},
    signal?: AbortSignal,
  ) {
    return this.#request('GET', `podcasts/${seg(podcast)}/episodes`, listEnvelope(episodeSchema), {
      query: { ...options },
      signal,
    });
  }

  getEpisode(podcast: string, episode: string, signal?: AbortSignal) {
    return this.#request('GET', episodePath(podcast, episode), itemEnvelope(episodeSchema), { signal });
  }

  createEpisode(podcast: string, fields: EpisodeFields, signal?: AbortSignal) {
    return this.#request('POST', `podcasts/${seg(podcast)}/episodes`, itemEnvelope(episodeSchema), {
      body: fields,
      signal,
    });
  }

  updateEpisode(podcast: string, episode: string, fields: EpisodeFields, signal?: AbortSignal) {
    return this.#request('PATCH', episodePath(podcast, episode), itemEnvelope(episodeSchema), {
      body: fields,
      signal,
    });
  }

  publishEpisode(podcast: string, episode: string, options: PublishOptions = {}, signal?: AbortSignal) {
    return this.#request('POST', `${episodePath(podcast, episode)}/publish`, itemEnvelope(episodeSchema), {
      body: options,
      signal,
    });
  }

  unpublishEpisode(podcast: string, episode: string, signal?: AbortSignal) {
    return this.#request('POST', `${episodePath(podcast, episode)}/unpublish`, itemEnvelope(episodeSchema), {
      signal,
    });
  }

  getEpisodeMetrics(podcast: string, page: PageOptions = {}, signal?: AbortSignal) {
    return this.#request('GET', `podcasts/${seg(podcast)}/metrics/episodes`, listEnvelope(episodeMetricsSchema), {
      query: { ...page },
      signal,
    });
  }

  getMonthlyDownloads(podcast: string, page: PageOptions = {}, signal?: AbortSignal) {
    return this.#request('GET', `podcasts/${seg(podcast)}/metrics/downloads`, monthlyDownloadsEnvelope, {
      query: { ...page },
      signal,
    });
  }

  async #request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    schema: S,
    options: { query?: Query; body?: object; signal?: AbortSignal | undefined },
  ): Promise<z.infer<S>> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/json',
      'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      init.signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      let body: unknown;
      try {
        response = await this.#fetch(url, init);
        body = await readJson(response);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (timeout.aborted) {
          throw new FiresideApiError(`Fireside did not respond within ${this.#timeoutMs / 1000} seconds.`, {
            method,
            path,
          });
        }
        throw new FiresideApiError(`Could not reach Fireside: ${describe(cause)}`, { method, path });
      }

      if (response.ok) {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new FiresideResponseShapeError(
            path,
            parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
          );
        }
        return parsed.data;
      }

      const error = toApiError(response, body, method, path);
      const wait = error.details.retryAfterSeconds;
      // A 429 means the request was not processed, so retrying is safe for writes too.
      if (response.status === 429 && attempt < this.#maxRetries && wait !== undefined && wait <= this.#maxRetryAfter) {
        await this.#sleep(wait * 1000, options.signal);
        continue;
      }
      throw error;
    }
  }
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function episodePath(podcast: string, episode: string): string {
  return `podcasts/${seg(podcast)}/episodes/${seg(episode)}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(response: Response, body: unknown, method: string, path: string): FiresideApiError {
  const parsed = errorBodySchema.safeParse(body);
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  const details: FiresideApiError['details'] = { status: response.status, method, path };
  if (Number.isFinite(retryAfter)) details.retryAfterSeconds = retryAfter;
  if (parsed.success) {
    const { message, code, fields } = parsed.data.error;
    if (code !== undefined) details.code = code;
    if (fields !== undefined) details.fields = fields;
    return new FiresideApiError(message, details);
  }
  const snippet = (typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)).slice(0, 300);
  return new FiresideApiError(
    `Fireside returned HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
    details,
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
