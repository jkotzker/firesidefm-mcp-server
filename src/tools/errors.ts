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
    return `${error.message}\nNothing was attached to an episode. Try fireside_upload_file again.`;
  }
  if (error instanceof FiresideResponseShapeError) {
    if (error.request.method === 'GET') return error.message;
    return `${error.message}\n${isUploadRequest(error.request.path) ? UPLOAD_RETRY_HINT : APPLIED_HINT}`;
  }
  if (!(error instanceof FiresideApiError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const { status, code, fields, retryAfterSeconds, method, savedEpisode } = error.details;
  const label = [status === undefined ? undefined : `HTTP ${status}`, code].filter(Boolean).join(', ');
  const lines = [`Fireside API error${label ? ` (${label})` : ''}: ${error.message}`];
  if (fields) {
    for (const [field, messages] of Object.entries(fields)) {
      lines.push(`- ${field}: ${Array.isArray(messages) ? messages.join('; ') : JSON.stringify(messages)}`);
    }
  }
  const hint = outcomeUnknown(method, status)
    ? isUploadRequest(error.details.path)
      ? UPLOAD_RETRY_HINT
      : MAYBE_APPLIED_HINT
    : code === 'upload_failed'
      ? uploadFailedHint(savedEpisode)
      : hintFor(status, code, retryAfterSeconds);
  if (hint) lines.push(hint);
  return lines.join('\n');
}

const APPLIED_HINT =
  'The change was saved. Do not repeat the call; check the episode with fireside_get_episode or fireside_list_episodes.';
const MAYBE_APPLIED_HINT =
  'Fireside may have received and applied this change. Check the episode with fireside_get_episode or ' +
  'fireside_list_episodes before trying again: episodes cannot be deleted through the API, so repeating a create ' +
  'leaves a duplicate draft.';

// Asking for an upload changes no episode, so whatever happened to it, trying again is safe.
const UPLOAD_RETRY_HINT = 'Nothing was attached to an episode. Try fireside_upload_file again.';

function isUploadRequest(path: string): boolean {
  return path.endsWith('/uploads');
}

/** A change that failed with no response, or whose successful response was cut off, may still have been applied. */
function outcomeUnknown(method: string, status: number | undefined): boolean {
  return method !== 'GET' && (status === undefined || (status >= 200 && status < 300));
}

/** Fireside saves the episode's other changes when a file fails, so a repeated create would leave a second draft. */
function uploadFailedHint(saved: { token: string; slug: string } | undefined): string {
  const episode = saved ? `episode ${saved.slug} (token ${saved.token})` : 'the episode';
  return (
    `The file was not attached, but the other changes were saved to ${episode}. Do not repeat ` +
    'fireside_create_episode, which would create a second draft. Attach the file with fireside_update_episode, ' +
    'uploading it again with fireside_upload_file if needed.'
  );
}

function hintFor(status: number | undefined, code: string | undefined, retryAfter: number | undefined): string | undefined {
  switch (code) {
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
      return 'Not found, or not accessible with this key. fireside_list_podcasts and fireside_list_episodes show valid tokens.';
    case 429:
      return `Fireside's rate limit (120 requests per minute) was exceeded.${retryAfter === undefined ? '' : ` Retry after ${retryAfter} seconds.`}`;
  }
  return undefined;
}
