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

/**
 * Report a startup failure in the defined shape and end the process.
 *
 * The exit code is chosen from the TYPED error rather than from the failure's message, and every
 * startup step below routes through here. Before this, only `Daemon.start()` was inside the handler:
 * CONSTRUCTING the Daemon opens the store and takes the ownership lock, so a storage failure there —
 * an unwritable state directory, for instance — escaped as an unhandled `BridgeError` and killed the
 * process with exit 1 and no typed payload at all. A caller could not tell a storage refusal from a
 * crash in unrelated code, which is the one distinction this boundary exists to make.
 * @param error the thrown value, of unknown shape
 * @returns never
 */
function failStartup(error: unknown): never {
  const bridgeError = toBridgeError(error);
  const payload = { ok: false, ...bridgeError.toJSON() };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  // 4 is the documented OWNERSHIP refusal (another process owns the directory) and 5 is the
  // documented storage refusal; anything else is a storage-class refusal too, because by this point
  // every other class of startup failure has been handled above.
  process.exit(bridgeError instanceof BridgeError && bridgeError.code === 'OWNER_HELD' ? 4 : 5);
}

// Construction is inside the boundary, because it is where the store is opened and the lock is
// taken. `Daemon` is declared before it is assigned so the value survives the `try` for the code
// below; the assignment cannot fail to have happened, since a failure exits the process.
/** @type {Daemon} */
let daemon;
/** @type {Awaited<ReturnType<Daemon['start']>>} */
let started;
try {
  daemon = new Daemon({
    stateDir,
    hostBase,
    hostScope: args.hostScope ?? config.hostScope,
    limits: config.limits,
  });
  started = await daemon.start();
  // Also inside the boundary: the event ingest opens the downlinks, and a failure here must be
  // reported the same typed way rather than surfacing as an unhandled rejection.
  await daemon.startEventIngest();
} catch (error) {
  failStartup(error);
}

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
