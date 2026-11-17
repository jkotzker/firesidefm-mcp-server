import type { CallToolResult } from '@modelcontextprotocol/server';

import { FileUploadError, FiresideApiError, FiresideResponseShapeError } from '../fireside/errors.js';

/** An error whose message is already written for the model and the user. */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: describeError(error) }], isError: true };
}

export function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof FileUploadError) {
    // A retry asks for a new signed address, which helps after no response, a server error or an expired
    // signature (403); any other refusal is about the file and will happen again.
    const { status } = error;
    const retry = status === undefined || status >= 500 || status === 403;
    return `${error.message}\nNothing was attached to an episode. ${
      retry
        ? 'Try fireside_upload_file again.'
        : 'Trying again with the same file is unlikely to help; tell the user what the storage service said.'
    }`;
  }
  if (error instanceof FiresideResponseShapeError) {
    const { method, path } = error.request;
    if (method === 'GET') return error.message;
    return `${error.message}\n${isUploadRequest(path) ? UPLOAD_RETRY_HINT : appliedHint(path)}`;
  }
  if (!(error instanceof FiresideApiError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const { status, code, fields, retryAfterSeconds, method, path, savedEpisode } = error.details;
  const label = [status === undefined ? undefined : `HTTP ${status}`, code].filter(Boolean).join(', ');
  const lines = [`Fireside API error${label ? ` (${label})` : ''}: ${error.message}`];
  if (fields) {
    for (const [field, messages] of Object.entries(fields)) {
      lines.push(`- ${field}: ${Array.isArray(messages) ? messages.join('; ') : JSON.stringify(messages)}`);
    }
  }
  const hint = outcomeUnknown(method, status)
    ? isUploadRequest(path)
      ? UPLOAD_RETRY_HINT
      : maybeAppliedHint(method, path)
    : code === 'upload_failed'
      ? uploadFailedHint(method, path, savedEpisode)
      : hintFor(status, code, retryAfterSeconds, method, path);
  if (hint) lines.push(hint);
  return lines.join('\n');
}

type Subject = 'episode' | 'chapters' | 'links' | 'podcast';

/** What a write request changed, judged from its API path. */
function subjectOf(path: string): Subject {
  if (/^podcasts\/[^/]+\/episodes\/[^/]+\/chapters(\/|$)/.test(path)) return 'chapters';
  if (/^podcasts\/[^/]+\/episodes\/[^/]+\/links(\/|$)/.test(path)) return 'links';
  if (/^podcasts\/[^/]+$/.test(path)) return 'podcast';
  return 'episode';
}

const CHECK: Record<Subject, string> = {
  episode: 'the episode with fireside_get_episode or fireside_list_episodes',
  chapters: "the episode's chapters with fireside_list_chapters",
  links: "the episode's links with fireside_list_links",
  podcast: 'the podcast with fireside_get_podcast',
};

const VALID_TOKENS = 'fireside_list_podcasts and fireside_list_episodes show valid tokens';
const LISTS: Record<Subject, string> = {
  episode: `${VALID_TOKENS}.`,
  podcast: `${VALID_TOKENS}.`,
  chapters: `${VALID_TOKENS}, and fireside_list_chapters the episode's chapter tokens.`,
  links: `${VALID_TOKENS}, and fireside_list_links the episode's link tokens.`,
};

function appliedHint(path: string): string {
  return `The change was saved. Do not repeat the call; check ${CHECK[subjectOf(path)]}.`;
}

function maybeAppliedHint(method: string, path: string): string {
  const subject = subjectOf(path);
  const check = `Fireside may have received and applied this change. Check ${CHECK[subject]} before trying again`;
  if (subject === 'episode') {
    return `${check}: episodes cannot be deleted through the API, so repeating a create leaves a duplicate draft.`;
  }
  switch (method) {
    case 'POST':
      return `${check}: repeating it may add a second copy.`;
    case 'DELETE':
      return `${check}: it may already be deleted.`;
    default:
      // Replacing a whole list, or patching fields, with the same values ends in the same state.
      return `${check}, or send the same change again, which is safe.`;
  }
}

// Asking for an upload changes no episode, so whatever happened to it, trying again is safe.
const UPLOAD_RETRY_HINT = 'Nothing was attached to an episode. Try fireside_upload_file again.';

function isUploadRequest(path: string): boolean {
  return path.endsWith('/uploads');
}

/** A change that failed with no response, or whose successful response was cut off, may still have been applied. */
function outcomeUnknown(method: string, status: number | undefined): boolean {
  return method !== 'GET' && (status === undefined || (status >= 200 && status < 300));
}

/**
 * Fireside could not process the file, but saves the request's other changes, so a repeated create would
 * leave a second draft. The file itself is the likely problem, so sending it again is no fix.
 */
function uploadFailedHint(method: string, path: string, saved: { token: string; slug: string } | undefined): string {
  if (subjectOf(path) === 'podcast') {
    return (
      "Fireside could not process the cover art, so the podcast's cover did not change; any other changes in the " +
      'same call were saved. Check the image with the user (a square JPG, PNG, GIF or WebP at least 1400 pixels ' +
      'wide) and upload a corrected one with fireside_upload_file.'
    );
  }
  const episode = saved ? `episode ${saved.slug} (token ${saved.token})` : 'the episode';
  const check = 'Check the file with the user; attach a corrected one with fireside_update_episode.';
  return method === 'POST'
    ? `Fireside could not process the file, so it was not attached, but ${episode} was created with the other ` +
        `fields. Do not repeat fireside_create_episode, which would create a second draft. ${check}`
    : `Fireside could not process the file, so it was not attached to ${episode}; any other changes in the same ` +
        `call were saved. ${check}`;
}

function hintFor(
  status: number | undefined,
  code: string | undefined,
  retryAfter: number | undefined,
  method: string,
  path: string,
): string | undefined {
  const subject = subjectOf(path);
  if (code === 'validation_failed' && method === 'PUT' && (subject === 'chapters' || subject === 'links')) {
    return (
      'Nothing was saved: Fireside changes the whole list or none of it. Each field above names an item by its ' +
      'position in the list you sent, counting from 0; correct those items and send the whole list again.'
    );
  }
  switch (code) {
    case 'advanced_metrics_required':
      return (
        'Downloads by platform, app, country and region need a Fireside plan with Advanced Metrics, which this ' +
        "podcast's plan does not include. fireside_get_daily_downloads, fireside_get_monthly_downloads and " +
        'fireside_get_episode_metrics report download totals without that breakdown.'
      );
    case 'write_access_required':
      return (
        'This API key is Read Only. Change it to Read/Write under Account > API Keys ' +
        '(https://app.fireside.fm/api_tokens), then restart this server.'
      );
    case 'podcast_inactive':
      return 'The podcast is on hiatus, suspended, or taken down: its episodes can be read but not changed.';
    case 'audio_required':
      return (
        'Attach audio first, with fireside_upload_file if this server offers it, or in the Fireside dashboard. ' +
        'Audio transfers in the background; fireside_get_episode shows its audio_status.'
      );
    case 'validation_failed':
      return 'Nothing was saved. Correct the fields above and try again.';
  }
  switch (status) {
    case undefined:
      return 'The request did not reach Fireside. Check the network connection and try again.';
    case 400:
      return 'A parameter or field was missing, unknown, or the wrong type.';
    case 401:
      return 'Check FIRESIDE_API_TOKEN: the key may be mistyped or revoked.';
    case 403:
      return 'Your role on this podcast, or your Fireside plan, does not allow this.';
    case 404:
      return `Not found, or not accessible with this key. ${LISTS[subject]}`;
    case 429:
      return `Fireside's rate limit (120 requests per minute) was exceeded.${retryAfter === undefined ? '' : ` Retry after ${retryAfter} seconds.`}`;
  }
  return undefined;
}
