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
  // A flag's value is checked for existence, exactly as the daemon's command line now does. The
  // unchecked form read `argv[++i]` and assigned `undefined`, which for `--state-dir` silently sent the
  // gateway at the DEFAULT state directory — a different daemon — and for `--socket` fell through to
  // whatever the configuration resolved to. A gateway that connects to the wrong daemon is worse than
  // one that refuses to start.
  let i = 0;
  const value = (flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      process.stderr.write(`${flag} requires a value\n`);
      process.exit(2);
    }
    i += 1;
    return next;
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state-dir') out.stateDir = value(arg);
    else if (arg === '--socket') out.socketPath = value(arg);
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
  // The SAME reply bound the daemon enforces, read from the same environment: a gateway that applied a
  // different number would refuse frames the daemon considers deliverable, and the symptom would be a
  // dropped connection rather than a bound.
  const outcome = await runMcpGateway({ socketPath, io, maxReplyBytes: config.limits.ipcReplyMaxBytes });
  process.stderr.write(`dsh-pilot-mcp: exiting (${outcome.reason}) after ${outcome.requests} requests\n`);
  process.exit(0);
} catch (error) {
  const bridgeError = toBridgeError(error);
  // stdout stays clean: the diagnostic goes to stderr so the client's JSON-RPC stream is intact.
  process.stderr.write(`dsh-pilot-mcp: ${bridgeError.code}: ${bridgeError.message}\n`);
  process.exit(1);
}
