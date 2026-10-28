import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { atomicJSON, readJSON } from './core.mjs';

const gatewayId = id => typeof id === 'string' && /^kilo\/[a-zA-Z0-9_~./:@+-]{1,250}$/.test(id);
export function createModelCatalog({ configDir, stateDir, kilo, execute, cwd }) {
  const file = path.join(stateDir, 'gateway-models.json');
  const saved = readJSON(file, {}); let ids = Array.isArray(saved.ids) ? saved.ids.filter(gatewayId) : [], at = Number(saved.at) || 0, pending, warning = '';
  async function refresh(force) {
    if (pending) return pending;
    pending = (async () => {
      try {
        const { stdout } = await execute(kilo, ['models', 'kilo', '--pure', ...(force ? ['--refresh'] : [])], { cwd, timeout: 25000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, XDG_CONFIG_HOME: configDir, KILO_DISABLE_AUTOUPDATE: 'true' } });
        const found = [...new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(gatewayId))];
        if (!found.length) throw new Error('Empty gateway catalog');
        ids = found; at = Date.now(); warning = ''; atomicJSON(file, { ids, at });
      } catch { warning = ids.length ? 'Gateway refresh failed; using the last saved Kilo gateway catalog.' : 'Kilo gateway catalog is unavailable. Check Kilo login/network access and refresh.'; }
      finally { pending = null; }
    })();
    return pending;
  }
  return async ({ force = false } = {}) => {
    const configured = await readModelCatalog(configDir);
    if (force || !ids.length) await refresh(force);
    else if (Date.now() - at > 15 * 60 * 1000) void refresh(false);
    const all = new Map(ids.map(id => [id, { id, provider: 'kilo', providerName: 'Kilo gateway', name: id.slice(5), source: 'Kilo gateway', disabled: configured.disabledProviders.includes('kilo') || Boolean(configured.enabledProviders && !configured.enabledProviders.includes('kilo')) }]));
    for (const model of configured.models) all.set(model.id, { ...all.get(model.id), ...model });
    const { disabledProviders, enabledProviders, ...publicConfig } = configured;
    return { ...publicConfig, models: [...all.values()].sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name)), configuredCount: configured.models.length, gatewayCount: ids.length, gatewayUpdatedAt: at ? new Date(at).toISOString() : null, warnings: [...configured.warnings, ...(warning ? [warning] : [])] };
  };
}

// Import display metadata only. Never expand {env:...}/{file:...}, return provider
// options, expose API keys, or evaluate config as JavaScript.
export async function readModelCatalog(configDir) {
  const models = new Map(), warnings = [], sources = []; let configuredModel = '', disabled = [], enabled;
  for (const name of ['config.json', 'kilo.json', 'kilo.jsonc']) {
    let text; try { text = await fs.readFile(path.join(configDir, 'kilo', name), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Could not read ${name}.`); continue; }
    const errors = []; const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) { warnings.push(`${name} contains invalid JSON; fix it and refresh the model catalog.`); continue; }
    sources.push(name);
    if (typeof config.model === 'string') configuredModel = config.model;
    if (Array.isArray(config.disabled_providers)) disabled = config.disabled_providers;
    if (Array.isArray(config.enabled_providers)) enabled = config.enabled_providers;
    for (const [provider, definition] of Object.entries(config.provider || {})) {
      if (!definition || typeof definition !== 'object') continue;
      for (const [model, definitionModel] of Object.entries(definition.models || {})) {
        if (!definitionModel || typeof definitionModel !== 'object') continue;
        const id = `${provider}/${model}`, old = models.get(id);
        models.set(id, { ...old, id, provider, providerName: typeof definition.name === 'string' ? definition.name : provider,
          name: typeof definitionModel.name === 'string' ? definitionModel.name : old?.name || model,
          context: Number.isSafeInteger(definitionModel.limit?.context) ? definitionModel.limit.context : old?.context,
          output: Number.isSafeInteger(definitionModel.limit?.output) ? definitionModel.limit.output : old?.output,
          source: name });
      }
    }
  }
  if (configuredModel.includes('/') && !models.has(configuredModel)) {
    const provider = configuredModel.split('/')[0]; models.set(configuredModel, { id: configuredModel, provider, providerName: provider, name: configuredModel.slice(provider.length + 1), source: sources.at(-1) });
  }
  return { models: [...models.values()].map(model => ({ ...model, disabled: disabled.includes(model.provider) || Boolean(enabled && !enabled.includes(model.provider)) })).sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name)), configuredModel, sources, warnings, disabledProviders: disabled, enabledProviders: enabled };
}
