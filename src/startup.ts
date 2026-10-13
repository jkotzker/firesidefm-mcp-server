import { ConfigError, loadConfig } from './config.js';
import { FiresideClient, type FiresideClientOptions } from './fireside/client.js';
import { FiresideApiError } from './fireside/errors.js';
import type { Access, ServerDeps } from './server.js';
import { describeError } from './tools/errors.js';
import { Resolver } from './tools/resolve.js';

export interface Startup {
  deps: ServerDeps;
  /** Lines for stderr: configuration warnings and what was decided at startup. */
  notices: string[];
}

/**
 * The key check runs before the server answers the host's first message, so it gets a short
 * budget of its own: one attempt and no waiting out rate limits. Tool calls use the full budget.
 */
const KEY_CHECK = { maxRateLimitRetries: 0, requestTimeoutMs: 10_000 } as const;

/**
 * Reads configuration, checks the API key against Fireside, and decides whether the write tools
 * are offered: only for a Read/Write key, and never when FIRESIDE_READ_ONLY is set.
 * A rejected key (401) is fatal; any other failure to check it starts read-only.
 */
export async function startup(
  env: NodeJS.ProcessEnv,
  clientOptions: Omit<FiresideClientOptions, 'token'> = {},
): Promise<Startup> {
  const { config, warnings } = loadConfig(env);
  const notices = [...warnings];
  const options: FiresideClientOptions = {
    ...clientOptions,
    token: config.apiToken,
    ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
  };
  const client = new FiresideClient(options);

  let access: Access;
  try {
    const me = await new FiresideClient({ ...options, ...KEY_CHECK }).getMe();
    const readWrite = me.data.api_token.access === 'read_and_write';
    access = !readWrite ? 'read_only_key' : config.readOnly ? 'read_only_setting' : 'read_write';
    notices.push(
      `Connected to Fireside as ${me.data.name} with a ${readWrite ? 'Read/Write' : 'Read Only'} key` +
        `${access === 'read_only_setting' ? ' (write tools disabled by FIRESIDE_READ_ONLY)' : ''}.`,
    );
    if (access === 'read_write') {
      notices.push(
        config.uploadDirs
          ? `Files can be uploaded from ${config.uploadDirs.join(', ')}.`
          : 'File uploads are off: set FIRESIDE_UPLOAD_DIRS to the directories whose files may be uploaded.',
      );
    }
  } catch (error) {
    if (error instanceof FiresideApiError && error.details.status === 401) {
      throw new ConfigError(`Fireside rejected FIRESIDE_API_TOKEN.\n${describeError(error)}`);
    }
    access = 'unverified';
    notices.push(
      `Could not check the API key, so only read tools are offered; restart the server to try again.\n${describeError(error)}`,
    );
  }

  const resolver = new Resolver(client, config.defaultPodcast);
  return { deps: { client, resolver, access, uploadDirs: config.uploadDirs ?? [] }, notices };
}
