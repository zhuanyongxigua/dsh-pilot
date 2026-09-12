#!/usr/bin/env node
/**
 * MCP gateway entry point (stdio).
 *
 * Why this file exists: this is the process an MCP client spawns. It must be thin, must fail
 * closed with an actionable message when the daemon is unreachable, and must never print
 * anything to stdout that is not a JSON-RPC message — a stray log line would corrupt the
 * protocol stream and silently break the caller.
 *
 * Usage: node dist/bin/dsh-pilot-mcp.js [--state-dir DIR] [--socket PATH]
 */

import { resolveConfig } from '../lib/config.ts';
import { socketPathFor } from '../lib/ipc.ts';
import { runMcpGateway, type GatewayIo } from '../lib/gateway.ts';
import { toBridgeError } from '../lib/errors.ts';

/** The flags this entry point accepts. A flag with no value leaves its field undefined here. */
interface McpArgs {
  stateDir?: string;
  socketPath?: string;
}

/**
 * @param argv
 */
function parseArgs(argv: string[]): McpArgs {
  const out: McpArgs = {};
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

/**
 * Every Node process facility the protocol face needs, supplied here rather than read inside
 * `src/lib/gateway.ts` — that module must stay free of Node-only APIs (AGENTS.md section 4), and
 * `npm run typecheck:contract` fails the build if it is not.
 */
const io: GatewayIo = {
  input: process.stdin,
  output: process.stdout,
  pid: process.pid,
  /**
   * @param name
   * @param handler
   */
  onSignal: (name, handler): void => { process.on(name, handler); },
};

try {
  const outcome = await runMcpGateway({ socketPath, io });
  process.stderr.write(`dsh-pilot-mcp: exiting (${outcome.reason}) after ${outcome.requests} requests\n`);
  process.exit(0);
} catch (error) {
  const bridgeError = toBridgeError(error);
  // stdout stays clean: the diagnostic goes to stderr so the client's JSON-RPC stream is intact.
  process.stderr.write(`dsh-pilot-mcp: ${bridgeError.code}: ${bridgeError.message}\n`);
  process.exit(1);
}
