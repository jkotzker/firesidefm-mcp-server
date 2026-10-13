#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ConfigError } from './config.js';
import { createServer } from './server.js';
import { startup } from './startup.js';
import { SERVER_NAME } from './version.js';

// stdout carries the protocol; everything human-readable goes to stderr.
const log = (message: string) => process.stderr.write(`${SERVER_NAME}: ${message}\n`);

try {
  const { deps, notices } = await startup(process.env);
  for (const notice of notices) log(notice);
  serveStdio(() => createServer(deps));
} catch (error) {
  log(error instanceof ConfigError ? error.message : `failed to start: ${String(error)}`);
  process.exitCode = 1;
}
