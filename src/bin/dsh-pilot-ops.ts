#!/usr/bin/env node
/**
 * Operator CLI: the human authority channel.
 *
 * Why this file exists: the design keeps human decisions out of model reach. An MCP tool can
 * list pending approvals but can never decide one; deciding requires the authority token that
 * lives in the daemon's private state directory (mode 0600), and this CLI is the tool that
 * reads it. Running it is an explicit human act, which is exactly what an approval is.
 *
 * Usage:
 *   dsh-pilot-ops status
 *   dsh-pilot-ops interactions --task TASK
 *   dsh-pilot-ops decide --task TASK --interaction INT --decision allowed-once|rejected
 *   dsh-pilot-ops operations --task TASK
 *   dsh-pilot-ops events --task TASK --session SESS [--limit N]
 */

import { readFileSync } from 'node:fs';
import { resolveConfig } from '../lib/config.ts';
import { IpcClient, socketPathFor, readAuthorityToken } from '../lib/ipc.ts';
import { toBridgeError } from '../lib/errors.ts';

/** The command and its flags, as parsed from the command line. */
interface OpsArgs {
  command: string;
  flags: Record<string, string>;
}

/**
 * @param argv
 * @returns the command and every flag it was given
 */
function parseArgs(argv: string[]): OpsArgs {
  const command = argv[0] ?? 'help';
  /**
   * Every flag value is stored as the raw string (or `'true'` for a valueless flag), which is
   * what the declared `Record<string, string>` return type promises.
   */
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, flags };
}

const { command, flags } = parseArgs(process.argv.slice(2));
const config = resolveConfig();
const stateDir = flags['state-dir'] ?? config.stateDir;
const socketPath = flags.socket ?? config.socketPath ?? socketPathFor(stateDir);

/**
 * @param request
 * @returns the daemon's reply value
 */
async function call(request: object): Promise<unknown> {
  const ipc = new IpcClient({ socketPath });
  await ipc.ready();
  try {
    return await ipc.request(request);
  } finally {
    ipc.close();
  }
}

/** @param value */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  switch (command) {
    case 'status':
      emit(await call({ op: 'health' }));
      break;
    case 'interactions':
      emit(await call({ op: 'interaction.list', taskId: requireFlag('task'), state: flags.state ?? null }));
      break;
    case 'operations':
      emit(await call({ op: 'session.state', taskId: requireFlag('task'), sessionId: requireFlag('session') }));
      break;
    case 'events':
      emit(await call({
        op: 'session.events',
        taskId: requireFlag('task'),
        sessionId: requireFlag('session'),
        limit: Number(flags.limit ?? 50),
      }));
      break;
    case 'decide': {
      const token = readAuthorityToken(stateDir);
      if (!token) {
        process.stderr.write(`no authority token at ${stateDir}/authority.token; start the daemon first\n`);
        process.exit(1);
      }
      // Prefer an explicit --token-file so a caller can hand authority over deliberately,
      // without ever putting the value on a command line (where it would land in shell history).
      const supplied = flags['token-file'] ? readFileSync(flags['token-file'], 'utf8').trim() : token;
      emit(await call({
        op: 'interaction.decide',
        taskId: requireFlag('task'),
        interactionId: requireFlag('interaction'),
        decision: requireFlag('decision'),
        authorityToken: supplied,
      }));
      break;
    }
    default:
      process.stderr.write([
        'usage: dsh-pilot-ops <command> [flags]',
        '  status',
        '  interactions --task TASK [--state pending]',
        '  operations --task TASK --session SESS',
        '  events --task TASK --session SESS [--limit N]',
        '  decide --task TASK --interaction INT --decision allowed-once|rejected [--token-file FILE]',
        '',
      ].join('\n'));
      process.exit(command === 'help' ? 0 : 2);
  }
} catch (error) {
  process.stderr.write(`${toBridgeError(error).code}: ${toBridgeError(error).message}\n`);
  process.exit(1);
}

/**
 * @param name
 * @returns the flag's value
 */
function requireFlag(name: string): string {
  const value = flags[name];
  if (!value || value === 'true') {
    process.stderr.write(`missing required flag --${name}\n`);
    process.exit(2);
  }
  return value;
}
