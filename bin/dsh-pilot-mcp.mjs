#!/usr/bin/env node
/**
 * MCP gateway entry point (stdio).
 *
 * Why this file exists: this is the process an MCP client spawns. It must be thin, must fail
 * closed with an actionable message when the daemon is unreachable, and must never print
 * anything to stdout that is not a JSON-RPC message — a stray log line would corrupt the
 * protocol stream and silently break the caller.
 *
 * Usage: node bin/dsh-pilot-mcp.mjs [--state-dir DIR] [--socket PATH]
 */

import { resolveConfig } from '../lib/config.js';
import { socketPathFor } from '../lib/ipc.js';
import { runMcpGateway } from '../lib/gateway.js';
import { toBridgeError } from '../lib/errors.js';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state-dir') out.stateDir = argv[++i];
    else if (arg === '--socket') out.socketPath = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: dsh-pilot-mcp [--state-dir DIR] [--socket PATH]\n');
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = resolveConfig();
const stateDir = args.stateDir ?? config.stateDir;
const socketPath = args.socketPath ?? config.socketPath ?? socketPathFor(stateDir);

try {
  const outcome = await runMcpGateway({ socketPath });
  process.stderr.write(`dsh-pilot-mcp: exiting (${outcome.reason}) after ${outcome.requests} requests\n`);
  process.exit(0);
} catch (error) {
  const bridgeError = toBridgeError(error);
  // stdout stays clean: the diagnostic goes to stderr so the client's JSON-RPC stream is intact.
  process.stderr.write(`dsh-pilot-mcp: ${bridgeError.code}: ${bridgeError.message}\n`);
  process.exit(1);
}
