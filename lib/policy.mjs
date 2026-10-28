import fs from 'node:fs/promises';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, readJSON, atomicJSON, inside } from './core.mjs';
import { gitDefaults, normalizeGit, compileGit, parseGitRemote } from './git-policy.mjs';

export const projectId = project => createHash('sha256').update(project).digest('hex').slice(0, 20);
export const defaults = () => ({
  schemaVersion: 1, defaultModel: 'kilo/kilo-auto/free', autoApprove: false,
  projectAccess: 'readwrite', storage: 'shared', runtimes: ['python', 'bun', 'rust', 'nix', 'git'],
  extraPaths: [], denyPaths: [], network: { mode: 'unrestricted', allowDomains: [], denyDomains: [], connectPorts: [], listenPorts: [] },
  environment: { inherit: [], variables: {} }, secrets: [], git: gitDefaults(),
  provider: { enabled: false, id: 'project', model: '', baseURL: '', secretEnv: '', proxyRoute: '', context: 128000, output: 8192 },
  limits: { timeoutMinutes: 30, memoryMB: 0, maxProcesses: 0 }, allowGpu: false,
  rollback: { enabled: true, exclude: ['node_modules', '.next', '__pycache__', 'target', '.kilo'] }
});
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_*', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'KILO_DISABLE_AUTOUPDATE'];
const choose = (value, options, label) => { if (!options.includes(value)) throw new RequestError(`Invalid ${label}.`); return value; };
const bool = (value, label) => { if (typeof value !== 'boolean') throw new RequestError(`${label} must be on or off.`); return value; };
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw new RequestError(`${label} must be an integer from ${min} to ${max}.`); return value; };
const list = (value, label, max = 60) => { if (!Array.isArray(value) || value.length > max) throw new RequestError(`${label} must be a list with at most ${max} entries.`); return value; };
const strings = (value, label) => [...new Set(list(value, label).map(v => { if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\x00-\x1f]/.test(v)) throw new RequestError(`Invalid ${label} entry.`); return v.trim(); }))];
const envName = name => {
  if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,79}$/.test(name) || /^(NONO_|OPENSENSOR_SUPERVISOR_|LD_|DYLD_|XDG_|DBUS_|SSH_|GPG_|GIT_|KILO_CONFIG|OPENCODE_CONFIG|NODE_OPTIONS$|BASH_ENV$|ENV$|PYTHONPATH$|PYTHONHOME$|PATH$|HOME$|TMPDIR$)/.test(name)) throw new RequestError(`Environment name ${String(name).slice(0, 80)} is invalid or reserved for the sandbox.`);
  return name;
};
export function validateModel(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_~][a-zA-Z0-9_~./:@+-]{1,255}$/.test(model)) throw new RequestError('Use a model ID in provider/model format.');
  return model;
}

export function createPolicyStore({ stateDir, configDir, workspace, sourceDir, execute, nono, kilo, secretStore, home = os.homedir() }) {
  const file = path.join(stateDir, 'project-settings.json');
  const profileDir = path.join(configDir, 'nono/profiles');
  // Keep controller code, credentials, authentication and future policy revisions outside agent grants.
  const protectedRoots = [sourceDir, stateDir, path.join(configDir, 'nono'), path.join(configDir, 'systemd'),
    path.join(home, '.local/share/keyrings'), path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.codex'), path.join(home, '.agents')].filter(Boolean);
  const overlap = candidate => protectedRoots.some(root => inside(root, candidate) || inside(candidate, root));
  const executableRoots = [...new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => { try { return realpathSync(p); } catch { return path.resolve(p); } }))];
  // A PATH entry can be a symlink into a package tree. Protect writable runtime
  // dependencies as well as bin directories from being changed by an agent.
  const hostRuntimeRoots = ['.nvm', '.fnm', '.npm', '.bun', '.cargo', '.rustup', '.pyenv', '.local/lib', '.local/share/pnpm', '.local/share/fnm'].map(p => path.join(home, p));
  const settings = () => readJSON(file, {});
  const get = project => settings()[project] || { revision: 0, updatedAt: null, settings: defaults(), history: [] };
  async function kiloExecutableDirs() {
    // Kilo's npm launcher execs a native binary outside PATH. Command mediation
    // requires that exact installed runtime directory in its execute allowlist.
    const candidate = kilo && (path.isAbsolute(kilo) ? kilo : (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, kilo)).find(existsSync));
    if (!candidate) return [];
    try {
      const real = await fs.realpath(candidate), packages = path.resolve(path.dirname(real), '../node_modules/@kilocode');
      const dirs = [];
      for (const name of await fs.readdir(packages)) if (name.startsWith(`cli-${process.platform}-${process.arch}`)) {
        const dir = await fs.realpath(path.join(packages, name, 'bin')); if (existsSync(path.join(dir, 'kilo'))) dirs.push(dir);
      }
      return dirs;
    } catch { return []; }
  }

  async function safePath(input, project, deny = false) {
    if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f$*?\[\]{}]/.test(input)) throw new RequestError('Use an existing literal path; variables and globs are not supported.');
    let real;
    try { real = await fs.realpath(path.resolve(project, input)); } catch { throw new RequestError(`Path does not exist: ${input.slice(0, 180)}`); }
    if (deny) { if (!inside(project, real) || real === project) throw new RequestError('Denied paths must be inside the selected project.'); }
    else if (overlap(real) || real === home || real === workspace || real === '/' || inside('/proc', real) || inside('/sys', real) || (inside('/run', real) && !inside('/run/media', real)) || real === '/run/media' || inside('/dev', real)) throw new RequestError('That path overlaps dashboard controls, credentials, or host control files. Choose a narrower data directory.');
    return real;
  }

  async function normalize(project, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Project settings are required.');
    const d = defaults();
    for (const key of Object.keys(body)) if (!(key in d)) throw new RequestError(`Unsupported settings field: ${key}`);
    const v = { ...d, ...body };
    choose(v.schemaVersion, [1], 'settings schema version');
    const result = { schemaVersion: 1, defaultModel: validateModel(v.defaultModel), autoApprove: bool(v.autoApprove, 'Auto approval'),
      projectAccess: choose(v.projectAccess, ['read', 'readwrite'], 'project access'), storage: choose(v.storage, ['shared', 'isolated'], 'Kilo storage'),
      runtimes: strings(v.runtimes, 'runtimes').map(r => choose(r, ['python', 'bun', 'rust', 'nix', 'git'], 'runtime')),
      extraPaths: [], denyPaths: [], network: {}, environment: { inherit: [], variables: {} }, secrets: [], limits: {}, allowGpu: bool(v.allowGpu, 'GPU access'), rollback: {} };
    if (overlap(project)) throw new RequestError('Dashboard controller files cannot be used as a sandbox project.');
    for (const grant of list(v.extraPaths, 'Additional paths', 24)) {
      const real = await safePath(grant.path, project);
      if (grant.access === 'readwrite' && [...executableRoots, ...hostRuntimeRoots].some(root => inside(root, real) || inside(real, root))) throw new RequestError('Write grants cannot overlap host executables or runtime installations. Choose a project or data directory.');
      if (result.projectAccess === 'read' && grant.access === 'readwrite' && (inside(real, project) || inside(project, real))) throw new RequestError('A write grant conflicts with read-only project access.');
      result.extraPaths.push({ path: real, access: choose(grant.access, ['read', 'readwrite'], 'path access') });
    }
    for (const denied of strings(v.denyPaths, 'Denied paths')) result.denyPaths.push(await safePath(denied, project, true));
    const network = { ...d.network, ...v.network };
    result.network.mode = choose(network.mode, ['unrestricted', 'restricted', 'blocked'], 'network mode');
    for (const key of ['allowDomains', 'denyDomains']) result.network[key] = strings(network[key], 'domains').map(domain => {
      if (!/^(\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(domain)) throw new RequestError('Use hostnames or *.domain without ports or URL paths. Domain rules apply to all HTTP(S) ports.');
      return domain.toLowerCase();
    });
    for (const key of ['connectPorts', 'listenPorts']) result.network[key] = [...new Set(list(network[key], 'ports').map(p => integer(p, 1, 65535, 'Port')))];
    if (network.mode !== 'restricted' && (result.network.allowDomains.length || result.network.denyDomains.length || result.network.connectPorts.length || result.network.listenPorts.length)) throw new RequestError('Domain and port rules require restricted networking. Clear the rules or change the mode.');
    result.git = await normalizeGit(v.git, { home, project, network: result.network, projectAccess: result.projectAccess });
    const env = { ...d.environment, ...v.environment };
    result.environment.inherit = strings(env.inherit, 'Inherited variable names').map(envName);
    if (!env.variables || typeof env.variables !== 'object' || Array.isArray(env.variables) || Object.keys(env.variables).length > 60) throw new RequestError('Environment variables must be a name/value object with at most 60 entries.');
    for (const [key, value] of Object.entries(env.variables)) {
      envName(key); if (typeof value !== 'string' || value.length > 2000 || /[\x00\r\n]/.test(value)) throw new RequestError('Environment values must be single lines under 2,000 characters.');
      if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)/.test(key)) throw new RequestError(`Store ${key} in Secrets and bind it to this project.`);
      result.environment.variables[key] = value;
    }
    const metadata = secretStore.list(); const usedEnv = new Set(); const routes = new Set();
    for (const binding of list(v.secrets, 'Secret bindings', 20)) {
      if (!metadata.some(s => s.id === binding.secretId)) throw new RequestError('A selected secret no longer exists.');
      const item = { secretId: binding.secretId, mode: choose(binding.mode, ['env', 'proxy'], 'secret delivery'), env: envName(binding.env) };
      if (usedEnv.has(item.env) || item.env in result.environment.variables || result.environment.inherit.includes(item.env)) throw new RequestError('Each secret variable must be unique and cannot also be a plain or inherited variable.');
      usedEnv.add(item.env);
      if (item.mode === 'proxy') {
        if (network.mode !== 'restricted') throw new RequestError('Credential proxy bindings require restricted networking.');
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(binding.route || '')) throw new RequestError('Proxy route names use lowercase letters, digits and underscores.');
        if (routes.has(binding.route)) throw new RequestError('Proxy route names must be unique.'); routes.add(binding.route);
        let url; try { url = new URL(binding.upstream); } catch { throw new RequestError('Enter a valid upstream URL.'); }
        if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new RequestError('Proxy upstreams require HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.');
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && (url.port || '80') === String(process.env.OPENSENSOR_PORT || 4317)) throw new RequestError('The dashboard cannot be a credential upstream.');
        const denied = result.network.denyDomains.some(rule => { const [host, port] = rule.split(':'); return (!port || port === (url.port || (url.protocol === 'https:' ? '443' : '80'))) && (host === url.hostname || (host.startsWith('*.') && url.hostname.endsWith(host.slice(1)))); });
        if (denied) throw new RequestError('A credential upstream conflicts with the denied domains. Remove the binding or the conflicting deny rule.');
        if (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(binding.header || '') || /^(host|cookie|proxy-authorization)$/i.test(binding.header)) throw new RequestError('Use a credential header such as Authorization or X-API-Key.');
        Object.assign(item, { route: binding.route, upstream: url.toString().replace(/\/$/, ''), header: binding.header, format: choose(binding.format, ['Bearer {}', '{}'], 'credential format'), endpoints: [] });
        for (const rule of list(binding.endpoints || [], 'Endpoint rules')) {
          const method = choose(rule.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'], 'HTTP method');
          if (typeof rule.path !== 'string' || !rule.path.startsWith('/') || rule.path.length > 300 || /[\x00-\x20]/.test(rule.path)) throw new RequestError('Endpoint rules need an absolute path, optionally with * or **.');
          item.endpoints.push({ method, path: rule.path });
        }
      }
      result.secrets.push(item);
    }
    for (const route of routes) { const name = `${route.toUpperCase()}_BASE_URL`; if (usedEnv.has(name) || name in result.environment.variables || result.environment.inherit.includes(name)) throw new RequestError(`${name} is reserved for the credential proxy route.`); }
    const provider = { ...d.provider, ...v.provider };
    result.provider = { ...d.provider, enabled: bool(provider.enabled, 'Project provider') };
    if (provider.enabled) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(provider.id) || !/^[a-zA-Z0-9][a-zA-Z0-9_~./:@+-]{0,159}$/.test(provider.model)) throw new RequestError('Enter a provider ID and an API model ID using letters, digits, hyphens or underscores. Model IDs may also contain slashes.');
      let baseURL = '', secretEnv = '', proxyRoute = '';
      if (provider.proxyRoute) {
        const binding = result.secrets.find(b => b.mode === 'proxy' && b.route === provider.proxyRoute);
        if (!binding) throw new RequestError('Create a matching credential proxy binding before selecting it for this provider.');
        proxyRoute = binding.route; secretEnv = binding.env;
      } else {
        let url; try { url = new URL(provider.baseURL); } catch { throw new RequestError('Enter the project provider’s base URL, including its API prefix (for example /v1).'); }
        if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new RequestError('Provider URLs require HTTPS, or HTTP on loopback, without credentials or query parameters.');
        baseURL = url.toString().replace(/\/$/, '');
        if (provider.secretEnv) { secretEnv = envName(provider.secretEnv); if (!result.secrets.some(b => b.mode === 'env' && b.env === secretEnv)) throw new RequestError('The provider key must match an environment secret binding.'); }
      }
      result.provider = { enabled: true, id: provider.id, model: provider.model, baseURL, secretEnv, proxyRoute, context: integer(provider.context, 1024, 10000000, 'Context window'), output: integer(provider.output, 1, 1000000, 'Output token limit') };
      if (result.provider.output > result.provider.context) throw new RequestError('Output token limit cannot exceed the context window.');
      result.defaultModel = validateModel(`${provider.id}/${provider.model}`);
    }
    const limits = { ...d.limits, ...v.limits };
    result.limits = { timeoutMinutes: integer(limits.timeoutMinutes, 1, 1440, 'Time limit'), memoryMB: integer(limits.memoryMB, 0, 1048576, 'Memory limit'), maxProcesses: integer(limits.maxProcesses, 0, 100000, 'Process limit') };
    const rollback = { ...d.rollback, ...v.rollback };
    result.rollback = { enabled: bool(rollback.enabled, 'Rollback snapshots'), exclude: strings(rollback.exclude, 'Snapshot exclusions') };
    return result;
  }

  function compile(project, s, revision) {
    const id = projectId(project);
    const isolated = path.join(home, '.local/share/opensensor-kilo-projects', id);
    const dirs = s.storage === 'isolated'
      ? { config: path.join(isolated, 'config'), data: path.join(isolated, 'data'), cache: path.join(isolated, 'cache'), state: path.join(isolated, 'state') }
      : { config: configDir, data: process.env.XDG_DATA_HOME || path.join(home, '.local/share'), cache: process.env.XDG_CACHE_HOME || path.join(home, '.cache'), state: path.join(home, '.local/state/opensensor-kilo') };
    const allow = [path.join(dirs.config, 'kilo'), path.join(dirs.data, 'kilo'), path.join(dirs.cache, 'kilo'), dirs.state];
    const profile = { extends: 'default', meta: { name: `opensensor-${id}-r${revision}`, version: '1.0.0', description: `Project policy for ${path.basename(project)} · revision ${revision}`, author: 'OpenSensor' },
      groups: { include: ['node_runtime', ...s.runtimes.filter(r => r !== 'git' || s.git?.enabled === false).map(r => r === 'git' ? 'git_config' : `${r}_runtime`), { name: 'linux_sysfs_read', when: 'linux' }, 'unlink_protection'] },
      security: { signal_mode: 'isolated', process_info_mode: 'isolated', capability_elevation: false },
      linux: { af_unix_mediation: 'pathname' },
      filesystem: { allow, read: [], allow_file: [], read_file: [], deny: [...s.denyPaths, ...protectedRoots.filter(existsSync)] }, workdir: { access: s.projectAccess },
      network: { block: s.network.mode === 'blocked', ...(s.network.mode === 'restricted' ? { allow_domain: s.network.allowDomains, deny_domain: s.network.denyDomains, connect_port: s.network.connectPorts, listen_port: s.network.listenPorts } : {}) },
      environment: { allow_vars: [...BASE_ENV, ...s.environment.inherit], set_vars: { XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: path.join(dirs.cache, 'kilo/tmp'), KILO_DISABLE_AUTOUPDATE: 'true', ...s.environment.variables } },
      env_credentials: {}, diagnostics: { redaction: { extra_env_vars: s.secrets.map(b => b.env) } },
      open_urls: { allow_origins: [], allow_localhost: false }, allow_launch_services: false, allow_gpu: s.allowGpu,
      // Snapshot project work, not Kilo's shared login, large databases or caches.
      rollback: { exclude_patterns: [...s.rollback.exclude, ...allow], exclude_globs: ['*.tmp.[0-9]*.[0-9]*'] } };
    // A restricted policy with no routes means no outbound traffic; never silently fall back to unrestricted.
    if (s.network.mode === 'restricted' && !s.network.allowDomains.length && !s.secrets.some(b => b.mode === 'proxy')) profile.network.block = true;
    // nono treats an empty proxy domain allowlist as allow-all, even when a
    // credential route activated the proxy. Keep the allowlist non-empty and
    // limited to the explicitly configured hosts and credential destinations.
    if (s.network.mode === 'restricted') profile.network.allow_domain = [...new Set([...s.network.allowDomains, ...s.secrets.filter(b => b.mode === 'proxy').map(b => new URL(b.upstream).hostname)])];
    for (const b of s.secrets) {
      const key = `keyring://opensensor-nono-dashboard/${b.secretId}`;
      if (b.mode === 'env') {
        if (profile.env_credentials[key]) throw new RequestError('Bind a secret to one environment variable per project.');
        profile.env_credentials[key] = b.env;
      } else {
        (profile.network.credentials ||= []).push(b.route);
        (profile.network.custom_credentials ||= {})[b.route] = { upstream: b.upstream, credential_key: key, env_var: b.env, inject_header: b.header, credential_format: b.format, ...(b.endpoints.length ? { endpoint_rules: b.endpoints } : {}) };
      }
    }
    if (s.provider?.enabled) {
      const p = s.provider;
      const baseURL = p.proxyRoute ? `{env:${p.proxyRoute.toUpperCase()}_BASE_URL}` : p.baseURL;
      profile.environment.set_vars.KILO_CONFIG_CONTENT = JSON.stringify({ provider: { [p.id]: { npm: '@ai-sdk/openai-compatible', name: `Project · ${p.id}`, options: { baseURL, ...(p.secretEnv ? { apiKey: `{env:${p.secretEnv}}` } : {}) }, models: { [p.model]: { name: p.model, limit: { context: p.context, output: p.output } } } } } });
    }
    return { profile, dirs, profileName: profile.meta.name };
  }

  async function build(project, settings, revision, prepare = false) {
    const policy = compile(project, settings, revision);
    const git = await compileGit(project, settings, { home, configDir });
    if (git) policy.profile.command_policies = { ...git, executable_dirs: await kiloExecutableDirs() };
    for (const grant of settings.extraPaths) {
      const stats = await fs.stat(grant.path); const type = grant.access === 'read' ? 'read' : 'allow';
      policy.profile.filesystem[stats.isDirectory() ? type : `${type}_file`].push(grant.path);
    }
    if (prepare) for (const dir of [...policy.profile.filesystem.allow.slice(0, 4), policy.profile.environment.set_vars.TMPDIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return policy;
  }

  async function validate(project, body, revision) {
    const normalized = await normalize(project, body);
    const policy = await build(project, normalized, revision);
    const temp = path.join(stateDir, `validate-${randomUUID()}.json`); atomicJSON(temp, policy.profile);
    try { await execute(nono, ['profile', 'validate', '--json', temp], { timeout: 12000, maxBuffer: 128000 }); }
    catch (error) { throw new RequestError(`nono rejected the policy: ${String(error.stdout || error.stderr || 'validation failed').slice(0, 1500)}`); }
    finally { await fs.unlink(temp).catch(() => {}); }
    return { settings: normalized, ...policy };
  }
  return {
    get, protectedRoots, safePath,
    async gitContext(project) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))); env.HOME = home;
      const read = async args => { try { return (await execute('/usr/bin/git', ['--no-pager', 'config', ...args], { cwd: project, env, timeout: 3000, maxBuffer: 4000 })).stdout.trim(); } catch { return ''; } };
      const [authorName, authorEmail, origin] = await Promise.all([read(['--global', '--get', 'user.name']), read(['--global', '--get', 'user.email']), read(['--local', '--get', 'remote.origin.url'])]);
      let remote = ''; try { parseGitRemote(origin); remote = origin; } catch {}
      return { authorName: authorName.slice(0, 200), authorEmail: authorEmail.slice(0, 200), remote,
        knownHosts: existsSync(path.join(home, '.ssh/known_hosts')) ? path.join(home, '.ssh/known_hosts') : '', agentSocket: process.env.SSH_AUTH_SOCK || '' };
    },
    async preview(project, body) { return validate(project, body, get(project).revision + 1); },
    async save(project, body, expectedRevision) {
      const current = get(project);
      if (expectedRevision !== current.revision) throw new RequestError('Settings changed in another window. Reload them before saving.', 409);
      const validated = await validate(project, body, current.revision + 1);
      if (get(project).revision !== current.revision) throw new RequestError('Settings changed while validating. Reload and retry.', 409);
      const record = { revision: current.revision + 1, updatedAt: new Date().toISOString(), settings: validated.settings,
        history: [...(current.history || []), { revision: current.revision, updatedAt: current.updatedAt, settings: current.settings }].slice(-20) };
      atomicJSON(file, { ...settings(), [project]: record });
      return { ...record, profile: validated.profile, profileName: validated.profileName };
    },
    async describe(project) { const record = get(project); return { ...record, ...await build(project, record.settings, record.revision) }; },
    async launch(project, secretValues) {
      const record = get(project); const normalized = await normalize(project, record.settings);
      if (!secretValues && normalized.secrets.length) secretValues = await secretStore.resolve(normalized.secrets.map(b => b.secretId));
      const policy = await build(project, normalized, record.revision, true);
      const supervisorEnv = {};
      if (secretValues) {
        // Resolve one version per run before spawning. A rotation after spawn cannot race
        // nono's later keyring lookup or cause its value to differ from our log masker.
        policy.profile.environment.deny_vars = ['OPENSENSOR_SUPERVISOR_*'];
        for (const binding of normalized.secrets) {
          const name = `OPENSENSOR_SUPERVISOR_SECRET_${binding.secretId.toUpperCase()}`;
          if (!secretValues.has(binding.secretId)) throw new RequestError('A bound credential could not be resolved.', 503);
          if (binding.mode === 'env' && policy.profile.command_policies) {
            // nono's command broker replaces env_credentials with phantom tokens.
            // Explicit environment delivery means the real value is needed by
            // Kilo itself. Inherit only this bound name, never serialize its value.
            delete policy.profile.env_credentials[`keyring://opensensor-nono-dashboard/${binding.secretId}`];
            supervisorEnv[binding.env] = secretValues.get(binding.secretId);
            policy.profile.environment.allow_vars.push(binding.env);
            continue;
          }
          supervisorEnv[name] = secretValues.get(binding.secretId);
          const source = `env://${name}`;
          if (binding.mode === 'env') { delete policy.profile.env_credentials[`keyring://opensensor-nono-dashboard/${binding.secretId}`]; policy.profile.env_credentials[source] = binding.env; }
          else policy.profile.network.custom_credentials[binding.route].credential_key = source;
          policy.profile.diagnostics.redaction.extra_env_vars.push(name);
        }
      }
      // Materialize an immutable file for this launch; active runs never follow later settings edits.
      policy.profileName += `-${randomUUID().slice(0, 8)}`;
      atomicJSON(path.join(profileDir, `${policy.profileName}.json`), policy.profile);
      return { ...record, ...policy, settings: normalized, supervisorEnv };
    },
    bindings(id) { return Object.entries(settings()).filter(([, r]) => r.settings.secrets.some(s => s.secretId === id)).map(([project]) => ({ project, name: path.basename(project) })); }
  };
}
