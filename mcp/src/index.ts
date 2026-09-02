#!/usr/bin/env node
/**
 * Entry point. Speaks MCP over stdio, so stdout is reserved for the protocol - anything this process
 * wants to say to a human goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, TEMPLATES_DIR, VERSION } from './server.js';
import { loadTemplates } from './layout.js';
import { registerBlueprint } from './blueprints.js';

async function main(): Promise<void> {
  // Templates are registered before the server is built, because the apply_blueprint enum is
  // computed from BLUEPRINTS at registration time.
  const { loaded, errors } = await loadTemplates(TEMPLATES_DIR);
  for (const bp of loaded) registerBlueprint(bp);
  if (loaded.length > 0) process.stderr.write(`loaded ${loaded.length} layout template(s)
`);
  for (const e of errors) process.stderr.write(`template skipped - ${e}
`);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`powerbi-dashboard MCP server ${VERSION} ready\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
