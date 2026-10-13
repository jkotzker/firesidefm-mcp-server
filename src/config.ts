export interface Config {
  apiToken: string;
  /** Podcast token or slug used when a tool call names no podcast. */
  defaultPodcast?: string;
  /** Register only read tools, even for a Read/Write key. */
  readOnly: boolean;
  /** Overrides the API base URL; meant for tests against a local stand-in. */
  apiBaseUrl?: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const TOKEN_PATTERN = /^fire_[0-9a-f]{64}$/;

export function loadConfig(env: NodeJS.ProcessEnv): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const apiToken = env.FIRESIDE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new ConfigError(
      'FIRESIDE_API_TOKEN is not set. Create an API key at https://app.fireside.fm/api_tokens ' +
        'and pass it to this server as the FIRESIDE_API_TOKEN environment variable.',
    );
  }
  if (!TOKEN_PATTERN.test(apiToken)) {
    // Documented format, not enforced: if Fireside changes it, a bad key still fails with a 401.
    warnings.push('FIRESIDE_API_TOKEN does not look like a Fireside key (fire_ followed by 64 hex characters).');
  }

  const config: Config = { apiToken, readOnly: parseBoolean(env.FIRESIDE_READ_ONLY, 'FIRESIDE_READ_ONLY') };
  const defaultPodcast = env.FIRESIDE_PODCAST?.trim();
  if (defaultPodcast) config.defaultPodcast = defaultPodcast;
  const apiBaseUrl = env.FIRESIDE_API_BASE_URL?.trim();
  if (apiBaseUrl) {
    config.apiBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    warnings.push(`Using FIRESIDE_API_BASE_URL ${config.apiBaseUrl} instead of the Fireside API.`);
  }
  return { config, warnings };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true' || normalized === '1') return true;
  throw new ConfigError(`${name} must be true or false, not "${value}".`);
}
