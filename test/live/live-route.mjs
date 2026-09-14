/**
 * Live-route derivation for the opt-in live suite.
 *
 * Why this file exists: the live suite must run against a REAL provider route without this
 * repository ever containing an endpoint or a credential. So it reads the operator's own DSH
 * settings, copies the NON-SECRET parts of one provider entry into a fresh single-use home, and
 * leaves the credential as an environment-variable NAME that the child process inherits from the
 * operator's environment.
 *
 * What it deliberately never does:
 *   - it never reads, prints, logs or stores a credential VALUE. A value may pass through the
 *     environment into the authenticated network client — that is unavoidable for any real route —
 *     but it never enters an assertion message, a fixture, a snapshot or a committed file;
 *   - it never writes to the operator's real settings file, home, or any Host the operator runs;
 *   - it never selects a fallback route: if the operator's default route cannot be described, the
 *     suite SKIPS. It does not pick another provider, because a silently substituted route would
 *     make every number the live suite produces meaningless.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Locate the operator's DSH settings file without assuming one layout.
 * @param {Record<string,string|undefined>} env
 * @returns {string|null}
 */
export function locateOperatorSettings(env = process.env) {
  const candidates = [];
  if (env.DSH_PILOT_SETTINGS_FILE) candidates.push(env.DSH_PILOT_SETTINGS_FILE);
  if (env.DSH_HOME) candidates.push(join(env.DSH_HOME, 'settings.yaml'));
  candidates.push(join(homedir(), '.dsh', 'settings.yaml'));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Extract the non-secret description of one provider route from a settings file.
 *
 * This is a deliberately small YAML reader, not a general one: it only needs `llm-pi-ai.providers.
 * <id>` with `api`, `baseURL`, `apiKeyEnv` and a model list, which is the shape the operator's file
 * has. A hand-rolled reader is used rather than a dependency because the project has zero runtime
 * dependencies and adding a YAML parser only for the opt-in live suite would not be worth it.
 *
 * @param {string} text raw settings.yaml contents
 * @param {string} providerId
 * @returns {{providerId: string, api: string, baseURL: string, apiKeyEnv: string|null, modelIds: string[]}|null}
 */
export function parseProviderRoute(text, providerId) {
  const lines = text.split('\n');
  // Find the `llm-pi-ai:` top-level block, then its `providers:` child, then the provider key.
  let inLlm = false;
  let inProviders = false;
  let inProvider = false;
  let indentOfProvidersKey = -1;
  let indentOfProviderKey = -1;
  /**
   * `apiKeyEnv` starts null because a provider block may name no credential variable, and
   * `modelIds` is filled by the `- id:` lines; both are the same shape the `@returns` documents.
   * @type {{providerId: string, api: string, baseURL: string, apiKeyEnv: string|null, modelIds: string[]}}
   */
  const route = { providerId, api: '', baseURL: '', apiKeyEnv: null, modelIds: [] };
  let any = false;

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (withoutComment.trim() === '') continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();

    if (indent === 0) {
      inLlm = line === 'llm-pi-ai:';
      inProviders = false;
      inProvider = false;
      continue;
    }
    if (!inLlm) continue;

    if (!inProviders) {
      if (indent === 2 && line === 'providers:') { inProviders = true; continue; }
      continue;
    }
    if (!inProvider) {
      if (line === `${providerId}:`) {
        inProvider = true;
        indentOfProviderKey = indent;
        any = true;
      }
      continue;
    }
    // Inside the provider block: a key at the provider's own indent ends it.
    if (indent <= indentOfProviderKey && !line.startsWith('-')) {
      inProvider = false;
      continue;
    }
    if (indentOfProviderKey === -1) indentOfProvidersKey = indentOfProvidersKey;
    const match = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      const cleaned = value.replace(/^["']|["']$/g, '').trim();
      if (key === 'api') route.api = cleaned;
      else if (key === 'baseURL') route.baseURL = cleaned;
      else if (key === 'apiKeyEnv') route.apiKeyEnv = cleaned;
      continue;
    }
    const modelMatch = line.match(/^-\s*id:\s*(.+)$/);
    if (modelMatch) route.modelIds.push(modelMatch[1].replace(/^["']|["']$/g, '').trim());
  }

  if (!any || !route.baseURL || !route.api) return null;
  return route;
}

/**
 * Read the operator's declared default model selection.
 * @param {string} text
 * @returns {{provider: string, model: string}|null}
 */
export function parseDefaultModel(text) {
  const lines = text.split('\n');
  let inBlock = false;
  let provider = null;
  let model = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) { inBlock = trimmed === 'agent-default-model:'; continue; }
    if (!inBlock) continue;
    const match = trimmed.match(/^(provider|model):\s*(.+)$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '').trim();
    if (match[1] === 'provider') provider = value;
    else model = value;
  }
  return provider && model ? { provider, model } : null;
}

/**
 * Build the settings YAML for a live single-use Host.
 *
 * The credential appears ONLY as `apiKeyEnv: <NAME>`. The route's own base URL is written because
 * it is configuration, not a secret, and it stays inside an ignored temp directory — it is never
 * committed, and no documentation or report may quote it.
 *
 * @param {{route: {providerId: string, api: string, baseURL: string, apiKeyEnv: string|null}, modelId: string, displayName?: string}} options
 */
export function liveHostSettings({ route, modelId, displayName }) {
  return [
    'llm-pi-ai:',
    '  providers:',
    `    ${route.providerId}:`,
    `      api: ${route.api}`,
    `      baseURL: ${route.baseURL}`,
    ...(route.apiKeyEnv ? [`      apiKeyEnv: ${route.apiKeyEnv}`] : []),
    ...(displayName ? [`      displayName: ${displayName}`] : []),
    '      models:',
    `        - id: ${modelId}`,
    '          contextWindow: 200000',
    '          maxTokens: 8192',
    '          input:',
    '            - text',
    '          reasoningEfforts: false',
    'agent-default-model:',
    `  provider: ${route.providerId}`,
    `  model: ${modelId}`,
    '',
  ].join('\n');
}

/**
 * Resolve ONE credential by NAME, without ever returning it, printing it, or storing it anywhere.
 *
 * Why this exists: a credential is frequently exported by the operator's login shell and is
 * therefore absent from a nested process's environment. On macOS the same variable is often still
 * visible through `launchctl`, which lets the child process receive it without the value ever
 * entering this process's logs, an assertion message, a fixture, or a file.
 *
 * The value is placed directly into `target[envName]` and is never read back by any code in this
 * repository. Only the NAME is ever reported. If no path yields it, that is reported as a fact.
 *
 * @param {string} envName
 * @param {Record<string,string|undefined>} target environment object to populate, usually `process.env`
 * @returns {{resolved: boolean, via: string|null, detail?: string}}
 */
export function resolveCredentialByName(envName, target = process.env) {
  if (target[envName]) return { resolved: true, via: 'inherited environment' };

  // macOS launchd: read the value straight into the target and never echo it.
  try {
    const value = execFileSync('launchctl', ['getenv', envName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (value) {
      target[envName] = value;
      return { resolved: true, via: 'launchctl getenv' };
    }
  } catch { /* not present, or launchctl unavailable on this platform */ }

  // The operator's own shell profile. Only the ONE named variable is taken, and the output is
  // never printed; a `printf` of every exported name would put unrelated secrets in our logs.
  const profile = process.env.DSH_PILOT_CREDENTIAL_PROFILE || join(homedir(), '.zshrc');
  if (existsSync(profile)) {
    try {
      const value = execFileSync('/bin/zsh', ['-c', `source ${JSON.stringify(profile)} >/dev/null 2>&1; printf '%s' "$${envName}"`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value) {
        target[envName] = value;
        return { resolved: true, via: `sourced ${profile}` };
      }
    } catch { /* the profile refused or the name is absent */ }
  }

  return { resolved: false, via: null, detail: `${envName} could not be resolved by name` };
}

/**
 * Resolve everything the live suite needs, or explain why it cannot run.
 *
 * Returns `{ok:false, reason}` rather than throwing, so the layer can SKIP with a precise reason
 * instead of failing — an absent live route is a missing external capability, not a defect.
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveLiveRoute(env = process.env) {
  const settingsPath = locateOperatorSettings(env);
  if (!settingsPath) return { ok: false, reason: 'no DSH settings file found; set DSH_PILOT_SETTINGS_FILE or DSH_HOME' };
  let text;
  try { text = readFileSync(settingsPath, 'utf8'); } catch (error) {
    return { ok: false, reason: `settings file could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const selection = parseDefaultModel(text);
  if (!selection) return { ok: false, reason: 'the settings file declares no agent-default-model selection' };
  const route = parseProviderRoute(text, selection.provider);
  if (!route) return { ok: false, reason: `provider "${selection.provider}" is not described in the settings file's llm-pi-ai block` };
  if (!route.apiKeyEnv) return { ok: false, reason: `provider "${selection.provider}" names no apiKeyEnv, so no credential can be located by name` };
  const credential = resolveCredentialByName(route.apiKeyEnv, env);
  if (!credential.resolved) {
    // The NAME is safe to report; the value is never read here.
    return { ok: false, reason: `credential ${route.apiKeyEnv} (the name provider "${selection.provider}" references) could not be resolved by any allowed path` };
  }
  return {
    ok: true,
    settingsPath,
    providerId: route.providerId,
    modelId: selection.model,
    api: route.api,
    baseURL: route.baseURL,
    credentialEnvName: route.apiKeyEnv,
    credentialVia: credential.via,
    settings: liveHostSettings({ route, modelId: selection.model }),
  };
}
