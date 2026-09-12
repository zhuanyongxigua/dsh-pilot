#!/usr/bin/env node
/**
 * Daemon entry point.
 *
 * Why this file exists: it is the process boundary the design depends on. One daemon owns the
 * state directory and the Host connection; MCP gateways only talk to it over IPC. Starting it
 * is explicit — nothing here starts, stops or mutates any Host.
 *
 * Usage: node dist/bin/dsh-pilot-daemon.js [--state-dir DIR] [--host URL] [--ready-file FILE]
 */

import { writeFileSync } from 'node:fs';
import { resolveConfig, assertScratchStateDir } from '../lib/config.ts';
import { Daemon } from '../lib/daemon.ts';
import { BridgeError, toBridgeError } from '../lib/errors.ts';

/** The flags this entry point accepts. */
interface DaemonArgs {
  stateDir?: string;
  hostBase?: string;
  hostScope?: string;
  readyFile?: string;
  json: boolean;
}

/**
 * @param argv
 * @returns parsed flags, with `json` always present
 */
function parseArgs(argv: string[]): DaemonArgs {
  const out: DaemonArgs = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state-dir') out.stateDir = argv[++i];
    else if (arg === '--host') out.hostBase = argv[++i];
    else if (arg === '--host-scope') out.hostScope = argv[++i];
    else if (arg === '--ready-file') out.readyFile = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: dsh-pilot-daemon [--state-dir DIR] [--host URL] [--ready-file FILE] [--json]\n');
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
const stateDir = args.stateDir ? resolvePath(args.stateDir) : config.stateDir;
const hostBase = (args.hostBase ?? config.hostBase).replace(/\/+$/, '');

const guard = assertScratchStateDir(stateDir);
if (!guard.safe) {
  process.stderr.write(`${guard.reason}\n`);
  process.exit(3);
}

const daemon = new Daemon({
  stateDir,
  hostBase,
  hostScope: args.hostScope ?? config.hostScope,
  limits: config.limits,
});

// The startup report, as `Daemon.start` returns it. Declared rather than inferred because the value
// is produced inside the `try` below, and the catch arm exits the process.
let started: Awaited<ReturnType<Daemon['start']>>;
try {
  started = await daemon.start();
} catch (error) {
  const bridgeError = toBridgeError(error);
  const payload = { ok: false, ...bridgeError.toJSON() };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(bridgeError instanceof BridgeError && bridgeError.code === 'OWNER_HELD' ? 4 : 5);
}

await daemon.startEventIngest();

const ready = {
  ok: true,
  pid: process.pid,
  stateDir: started.stateDir,
  socketPath: started.socketPath,
  generation: started.generation,
  recovery: started.recovery,
  authorityTokenPath: started.authorityTokenPath,
  authorityTokenCreated: started.authorityTokenCreated,
  hostBase,
};
if (args.readyFile) {
  writeFileSync(args.readyFile, `${JSON.stringify(ready)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(ready)}\n`);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`daemon: ${signal}, stopping\n`);
  await daemon.stop();
  process.exit(0);
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('uncaughtException', (error) => {
  process.stderr.write(`daemon: uncaught exception: ${error.message}\n`);
  process.exit(6);
});

/**
 * @param path
 * @returns the path, resolved against the process working directory when relative
 */
function resolvePath(path: string): string {
  return path.startsWith('/') ? path : `${process.cwd()}/${path}`;
}
