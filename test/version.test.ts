import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';

const readJson = <T>(file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as T;

const pkg = readJson<{ name: string; version: string; mcpName: string }>('package.json');

describe('version', () => {
  it('matches package.json', () => {
    expect(SERVER_NAME).toBe(pkg.name);
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('matches server.json, which the MCP Registry checks against the npm package', () => {
    const server = readJson<{
      name: string;
      version: string;
      description: string;
      packages: { identifier: string; version: string }[];
    }>('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([expect.objectContaining({ identifier: pkg.name, version: pkg.version })]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
