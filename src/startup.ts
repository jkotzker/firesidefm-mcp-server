import { type Config, ConfigError, loadConfig } from './config.js';
import { FiresideClient, type FiresideClientOptions } from './fireside/client.js';
import { FiresideApiError } from './fireside/errors.js';
import type { ServerDeps } from './server.js';
import { describeError } from './tools/errors.js';
import { Resolver } from './tools/resolve.js';

export interface Startup {
  deps: ServerDeps;
  config: Config;
  /** Lines for stderr: configuration warnings and what was decided at startup. */
  notices: string[];
}

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
  const client = new FiresideClient({
    ...clientOptions,
    token: config.apiToken,
    ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
  });

  let writeTools = false;
  try {
    const me = await client.getMe();
    const access = me.data.api_token.access;
    writeTools = access === 'read_and_write' && !config.readOnly;
    notices.push(
      `Connected to Fireside as ${me.data.name} with a ${access === 'read_and_write' ? 'Read/Write' : 'Read Only'} key` +
        `${access === 'read_and_write' && config.readOnly ? ' (write tools disabled by FIRESIDE_READ_ONLY)' : ''}.`,
    );
  } catch (error) {
    if (error instanceof FiresideApiError && error.details.status === 401) {
      throw new ConfigError(`Fireside rejected FIRESIDE_API_TOKEN.\n${describeError(error)}`);
    }
    notices.push(`Could not check the API key, so only read tools are offered.\n${describeError(error)}`);
  }

  return { deps: { client, resolver: new Resolver(client, config.defaultPodcast), writeTools }, config, notices };
}
