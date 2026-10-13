import * as z from 'zod/v4';

import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { FileUploadError, FiresideApiError, FiresideResponseShapeError } from './errors.js';
import {
  episodeMetricsSchema,
  episodeSchema,
  errorBodySchema,
  itemEnvelope,
  listEnvelope,
  meSchema,
  monthlyDownloadsEnvelope,
  podcastSchema,
  type Upload,
  uploadSchema,
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
  /** A `file_url` from Upload a File. */
  audio_file_url?: string | undefined;
  cover_file_url?: string | undefined;
  transcript_file_url?: string | undefined;
}

export type FileKind = 'audio' | 'cover' | 'transcript';

/** Describes a file for Upload a File, which checks it against the plan's limits before anything is sent. */
export interface UploadRequest {
  kind: FileKind;
  filename: string;
  byte_size: number;
  content_type: string;
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
  /** Shortest time allowed for sending a file; larger files get longer. */
  minUploadTimeoutMs?: number;
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
  readonly #minUploadTimeoutMs: number;

  constructor(options: FiresideClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRateLimitRetries ?? 2;
    this.#maxRetryAfter = options.maxRetryAfterSeconds ?? 30;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#minUploadTimeoutMs = options.minUploadTimeoutMs ?? 60_000;
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

  createUpload(podcast: string, request: UploadRequest, signal?: AbortSignal) {
    return this.#request('POST', `podcasts/${seg(podcast)}/uploads`, itemEnvelope(uploadSchema), {
      body: request,
      signal,
    });
  }

  /**
   * Sends a file to the signed URL from createUpload. That URL carries its own authorisation, so the
   * Fireside key is never sent with it. `onProgress` is called with the bytes sent so far.
   */
  async sendFile(
    upload: Pick<Upload, 'upload_url' | 'method' | 'headers'>,
    file: { chunks: AsyncIterable<Uint8Array>; size: number },
    options: { signal?: AbortSignal | undefined; onProgress?: ((sent: number) => void) | undefined } = {},
  ): Promise<void> {
    if (!URL.canParse(upload.upload_url) || new URL(upload.upload_url).protocol !== 'https:') {
      throw new FileUploadError('Fireside returned an upload address that is not https, so the file was not sent.');
    }
    // The documentation specifies PUT; anything else is not what this code was written to send.
    if (upload.method.toUpperCase() !== 'PUT') {
      throw new FileUploadError(`Fireside asked for an upload by ${upload.method}, not PUT, so the file was not sent.`);
    }
    const onProgress = options.onProgress;
    async function* body() {
      let sent = 0;
      for await (const chunk of file.chunks) {
        sent += chunk.byteLength;
        onProgress?.(sent);
        yield chunk;
      }
    }
    // At least 100 KB per second, so a large file is not cut off by a limit meant for small ones.
    const limitMs = Math.max(this.#minUploadTimeoutMs, Math.ceil(file.size / 100));
    const timeout = AbortSignal.timeout(limitMs);
    const headers = new Headers(upload.headers);
    for (const name of ['content-length', 'transfer-encoding', 'host']) headers.delete(name);
    // Signed storage uploads refuse chunked bodies, so the length is sent explicitly.
    headers.set('Content-Length', String(file.size));
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers,
      body: body(),
      duplex: 'half',
      // A redirect would turn the upload into a GET elsewhere, re-sending these headers, and look like success.
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    };

    let response: Response;
    try {
      response = await this.#fetch(upload.upload_url, init);
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      if (timeout.aborted) {
        throw new FileUploadError(`The upload did not finish within ${Math.round(limitMs / 1000)} seconds.`);
      }
      // The signed URL is a credential for this one file; keep it out of error text.
      throw new FileUploadError(`Could not send the file: ${describe(cause).replaceAll(upload.upload_url, '[upload URL]')}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // Storage services answer in XML; only the error code is shown, since the rest can echo the signature.
      const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1];
      throw new FileUploadError(
        `The storage service refused the file (HTTP ${response.status}${code ? `, ${code}` : ''}).`,
        response.status,
      );
    }
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
      } catch (cause) {
        throw this.#transportError(cause, { method, path }, timeout, options.signal);
      }
      try {
        body = await readJson(response);
      } catch (cause) {
        // Fireside answered, so a write may already have been applied: keep the status.
        throw this.#transportError(cause, { method, path, status: response.status }, timeout, options.signal);
      }

      if (response.ok) {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new FiresideResponseShapeError(
            { method, path, status: response.status },
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

  /** A request that failed without a complete response: timed out, unreachable, or cut off. */
  #transportError(
    cause: unknown,
    details: { method: string; path: string; status?: number },
    timeout: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): unknown {
    if (callerSignal?.aborted) return cause;
    if (timeout.aborted) {
      return new FiresideApiError(`Fireside did not respond within ${this.#timeoutMs / 1000} seconds.`, details);
    }
    // Error text from fetch can quote request headers; never let the key through.
    const reason = describe(cause).replaceAll(this.#token, '[FIRESIDE_API_TOKEN]');
    const message =
      details.status === undefined
        ? `Could not reach Fireside: ${reason}`
        : `Fireside's response was cut off: ${reason}`;
    return new FiresideApiError(message, details);
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

const savedEpisodeSchema = z.looseObject({ token: z.string(), slug: z.string() });

function toApiError(response: Response, body: unknown, method: string, path: string): FiresideApiError {
  const parsed = errorBodySchema.safeParse(body);
  // Fireside documents Retry-After in whole seconds; anything else is ignored.
  const retryAfter = response.headers.get('retry-after')?.trim();
  const details: FiresideApiError['details'] = { status: response.status, method, path };
  if (retryAfter && /^\d+$/.test(retryAfter)) details.retryAfterSeconds = Number(retryAfter);
  if (parsed.success) {
    const { message, code, fields } = parsed.data.error;
    if (code !== undefined) details.code = code;
    if (fields !== undefined) details.fields = fields;
    const saved = savedEpisodeSchema.safeParse(parsed.data.data);
    if (code === 'upload_failed' && saved.success) details.savedEpisode = { token: saved.data.token, slug: saved.data.slug };
    return new FiresideApiError(message, details);
  }
  const snippet = (typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)).slice(0, 300);
  // The status is reported alongside the message, so the message carries only the body.
  return new FiresideApiError(snippet || 'Fireside returned no error details.', details);
}

/** The error message plus its cause: Node's fetch reports only "fetch failed" and keeps the reason in `cause`. */
function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const inner = cause.cause instanceof Error ? ((cause.cause as NodeJS.ErrnoException).code ?? cause.cause.message) : undefined;
  return inner && !cause.message.includes(inner) ? `${cause.message} (${inner})` : cause.message;
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
