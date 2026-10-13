/** A request to the Fireside API that did not succeed. */
export class FiresideApiError extends Error {
  override readonly name = 'FiresideApiError';

  constructor(
    message: string,
    readonly details: {
      /** HTTP status; undefined when the request never got a response. */
      status?: number;
      /** Fireside's machine-readable error code, e.g. `write_access_required`. */
      code?: string;
      /** Per-field validation messages from a 422. */
      fields?: Record<string, unknown>;
      /** Seconds Fireside asked us to wait, from `Retry-After` on a 429. */
      retryAfterSeconds?: number;
      /** The episode an `upload_failed` error says was saved apart from the file. */
      savedEpisode?: { token: string; slug: string };
      method: string;
      path: string;
    },
  ) {
    super(message);
  }
}

/** Fireside answered successfully, but not in the documented shape. */
export class FiresideResponseShapeError extends Error {
  override readonly name = 'FiresideResponseShapeError';

  constructor(
    readonly request: { method: string; path: string; status: number },
    readonly issues: string[],
  ) {
    const { method, path, status } = request;
    super(
      (method === 'GET'
        ? `Fireside returned a response for ${path} that does not match the documented shape: `
        : `Fireside accepted the change (HTTP ${status}), but its response does not match the documented shape: `) +
        `${issues.join('; ')}. The API may have changed; please report this.`,
    );
  }
}

/** Sending a file to its signed upload URL failed, so nothing was attached to an episode. */
export class FileUploadError extends Error {
  override readonly name = 'FileUploadError';

  constructor(
    message: string,
    /** HTTP status from the storage service; undefined when the upload got no response. */
    readonly status?: number,
  ) {
    super(message);
  }
}
