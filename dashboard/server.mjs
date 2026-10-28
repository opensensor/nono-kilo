import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RequestError, atomicJSON, inside, readJSON } from './lib/core.mjs';
import { createAuth } from './lib/auth.mjs';
import { createSecretStore } from './lib/secrets.mjs';
import { createPolicyStore, isWsl2, wsl2ProxyUnsupported } from './lib/policy.mjs';
import { RedactingStream, redactionValues, redact } from './lib/redaction.mjs';
import { validateProject, projectMetadata } from './lib/projects.mjs';
import { TerminalHub, terminalSize } from './lib/terminal.mjs';
import pty from 'node-pty';
import { createModelCatalog } from './lib/models.mjs';
import { HARNESSES, buildAgentCommand, configuredModel, validateHarness } from './lib/harnesses.mjs';
import { NetworkMonitor } from './lib/network.mjs';
import { NetworkApprovals, SessionDeadline } from './lib/network-approvals.mjs';
import { dashboardOrigin } from './lib/http-access.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = 'opensensor-kilo-local';
const FREE_MODEL = 'kilo/kilo-auto/free';
const MAX_LOG = 8 * 1024 * 1024;
const activeStatus = status => ['starting', 'running', 'stopping'].includes(status);
const VENDOR_FILES = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/fit.js': '@xterm/addon-fit/lib/addon-fit.js', '/vendor/search.js': '@xterm/addon-search/lib/addon-search.js',
  '/vendor/webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js'
};

export { RequestError, validateProject };

export function buildRunArgs({ name, prompt = '', model, autoApprove = false, profileName = PROFILE, settings, interactive = false, harness = settings?.harness || 'kilo' }, binaries) {
  const available = typeof binaries === 'string' ? { kilo: binaries } : binaries;
  return [...sandboxArgs(name, profileName, settings), '--', ...buildAgentCommand({ harness, prompt, model, autoApprove, interactive }, available)];
}

function sandboxArgs(name, profileName, settings) {
  return ['run', '--name', name, '--profile', profileName, '--allow-cwd',
    ...(settings?.rollback.enabled === false ? ['--no-rollback'] : ['--rollback', '--no-rollback-prompt']),
    ...(settings?.limits.memoryMB ? ['--memory', `${settings.limits.memoryMB}M`] : []),
    ...(settings?.limits.maxProcesses ? ['--max-processes', String(settings.limits.maxProcesses)] : []),
    ...(settings?.allowGpu ? ['--allow-gpu'] : [])];
}

export function createDashboard(options = {}) {
  const workspace = path.resolve(options.workspace || process.env.OPENSENSOR_WORKSPACE || path.join(os.homedir(), 'opensensor'));
  const stateDir = options.stateDir || process.env.OPENSENSOR_DASHBOARD_STATE || path.join(os.homedir(), '.local/state/nono-kilo-dashboard');
  const configDir = options.configDir || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const nono = options.nono || process.env.OPENSENSOR_NONO || path.join(os.homedir(), '.local/bin/nono');
  const kilo = options.kilo || process.env.OPENSENSOR_KILO || 'kilo';
  const binaries = { kilo, claude: options.claude || process.env.OPENSENSOR_CLAUDE || 'claude', codex: options.codex || process.env.OPENSENSOR_CODEX || 'codex' };
  const execute = options.execute || exec;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const auth = createAuth(stateDir);
  const secrets = createSecretStore(stateDir, options.keyringCall);
  const policies = createPolicyStore({ stateDir, configDir, workspace, sourceDir: ROOT, execute, nono, ...binaries, secretStore: secrets, home: options.home });
  const sandboxPath = (process.env.PATH || '/usr/bin:/bin').split(path.delimiter).filter(dir => !policies.protectedRoots.some(root => inside(root, path.resolve(dir)))).join(path.delimiter);
  const auditFile = path.join(stateDir, 'audit.json');
  const audit = (event, metadata = {}) => atomicJSON(auditFile, [...readJSON(auditFile, []), { at: new Date().toISOString(), event, ...metadata }].slice(-500));
  let mutationQueue = Promise.resolve();
  const mutate = operation => { const result = mutationQueue.then(operation); mutationQueue = result.catch(() => {}); return result; };
  async function projectPath(input) {
    const project = await validateProject(input, workspace);
    if (policies.protectedRoots.some(root => inside(root, project) || inside(project, root))) throw new RequestError('The dashboard controller cannot be used as a sandbox project.');
    return project;
  }
  const indexFile = path.join(stateDir, 'sessions.json');
  const projectsFile = path.join(stateDir, 'projects.json');
  const records = new Map(readJSON(indexFile, []).map(record => [record.id, record]));
  const children = new Map();
  const deadlines = new Map();
  let cache = { at: 0, sessions: [] };
  let refreshPromise;
  let closing = false;
  for (const record of records.values()) {
    if (activeStatus(record.status)) { record.status = 'interrupted'; record.endedAt = new Date().toISOString(); }
    record.pendingApprovals = 0; record.approvalWait = false; record.deadlineAt = null;
  }
  const persist = () => atomicJSON(indexFile, [...records.values()]);
  const logPath = id => path.join(stateDir, `${id}.log`);
  const runCommand = (command, args, extra = {}) => execute(command, args, { timeout: 12000, maxBuffer: 1024 * 1024, ...extra });
  const modelCatalog = createModelCatalog({ configDir, stateDir, kilo, execute, cwd: ROOT });
  const network = new NetworkMonitor(stateDir, options.home);
  const approvals = new NetworkApprovals({ stateDir, audit, protectedPorts: () => [server.address()?.port],
    onChange: (id, count) => {
      const record = records.get(id); if (!record) return;
      record.pendingApprovals = count;
      const timer = deadlines.get(id); if (count) timer?.pause(); else timer?.resume();
      persist(); terminals.status(id);
    } });
  const terminals = new TerminalHub({ getSession: findSession, audit,
    loadArchive: async record => {
      const screen = readJSON(path.join(stateDir, `${record.id}.screen.json`), null); if (screen) return screen;
      let data = 'This terminal session was not captured by the dashboard.\r\n';
      if (!record.external) { try { data = await fs.readFile(logPath(record.id), 'utf8'); } catch { data = 'No output was captured.\r\n'; } }
      return { cols: record.cols || 110, rows: record.rows || 30, data };
    },
    saveScreen: (id, data) => atomicJSON(path.join(stateDir, `${id}.screen.json`), data)
  });

  async function projects() {
    const discovered = [];
    for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const candidate = path.join(workspace, entry.name);
      if (existsSync(path.join(candidate, '.git')) || entry.name === 'nono-kilo-demo') discovered.push(candidate);
    }
    const registered = readJSON(projectsFile, []);
    const entries = [...new Set([...discovered, ...registered])];
    const valid = await Promise.all(entries.map(async candidate => {
      try {
        const real = await projectPath(candidate);
        return projectMetadata(real, workspace);
      } catch { return registered.includes(candidate) ? projectMetadata(candidate, workspace, false) : null; }
    }));
    return valid.filter(Boolean).sort((a, b) => Number(b.demo) - Number(a.demo) || a.name.localeCompare(b.name));
  }

  async function refreshNono() {
    if (Date.now() - cache.at < 1500) return cache.sessions;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const { stdout } = await runCommand(nono, ['ps', '--all', '--json']);
        cache = { at: Date.now(), sessions: JSON.parse(stdout).filter(s => s.profile === PROFILE || s.profile?.startsWith('opensensor-')) };
        for (const record of records.values()) {
          const session = cache.sessions.find(s => s.name === record.name);
          if (session) record.nonoId = session.session_id;
        }
      } catch { cache.at = Date.now(); }
      return cache.sessions;
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  async function allSessions() {
    const native = await refreshNono();
    const owned = new Set([...records.values()].map(r => r.name));
    const external = [];
    for (const session of native) {
      const harness = Object.keys(HARNESSES).find(name => session.command?.some(arg => typeof arg === 'string' && path.basename(arg) === name));
      if (owned.has(session.name) || !harness || !session.command?.includes('run')) continue;
      try { await validateProject(session.workdir, workspace); } catch { continue; }
      const prompt = session.command.at(-1);
      external.push({ id: `external-${session.session_id}`, nonoId: session.session_id, name: session.name,
        project: session.workdir, projectName: path.basename(session.workdir), prompt, harness,
        model: session.command.includes('--model') ? session.command[session.command.indexOf('--model') + 1] : 'Configured model',
        status: session.status === 'running' ? 'running' : session.exit_code === 0 ? 'completed' : 'stopped',
        startedAt: session.started, exitCode: session.exit_code, kind: 'task', external: true });
    }
    return [...records.values(), ...external].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  async function findSession(id) {
    const session = (await allSessions()).find(s => s.id === id);
    if (!session) throw new RequestError('Session not found.', 404);
    return session;
  }

  function append(record, chunk) {
    terminals.write(record.id, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    if (record.logBytes >= MAX_LOG) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_LOG - (record.logBytes || 0);
    const accepted = bytes.subarray(0, remaining);
    appendFileSync(logPath(record.id), accepted, { mode: 0o600 });
    record.logBytes = (record.logBytes || 0) + accepted.length;
    if (bytes.length >= remaining) appendFileSync(logPath(record.id), '\n[Transcript archive limit reached: 8 MiB. The live terminal continues streaming.]\n');
  }

  async function start(body) {
    if (closing) throw new RequestError('Dashboard is restarting.', 503);
    const project = await projectPath(body.project);
    if ([...records.values()].filter(r => activeStatus(r.status)).length >= 3) throw new RequestError('Three dashboard sessions are already running. Stop one before starting another.', 409);
    const id = randomUUID();
    try {
    const harness = validateHarness(body.harness || policies.get(project).settings.harness || 'kilo');
    const name = `${harness}-${id.slice(0, 8)}`;
    const check = body.kind === 'check';
    if (body.interactive !== undefined && typeof body.interactive !== 'boolean') throw new RequestError('Interactive mode must be on or off.');
    const interactive = !check && body.interactive === true;
    const savedSettings = policies.get(project).settings;
    const model = body.model === undefined ? configuredModel(savedSettings, harness) : body.model;
    const autoApprove = body.autoApprove ?? savedSettings.autoApprove;
    if (!check) buildAgentCommand({ harness, prompt: body.prompt, model, autoApprove, interactive }, binaries);
    const size = terminalSize(body.cols ?? 110, body.rows ?? 30);
    const boundValues = await secrets.resolve(savedSettings.secrets.map(s => s.secretId));
    const policy = await policies.launch(project, boundValues, { harness, networkApproval: settings => approvals.open(id, {
      ...settings.network, allowDomains: [...new Set([...settings.network.allowDomains, ...settings.secrets.filter(s => s.mode === 'proxy').map(s => new URL(s.upstream).hostname)])]
    }) });
    const redactions = redactionValues([...boundValues.values(), ...policy.settings.environment.inherit.filter(name => /KEY|SECRET|TOKEN|PASS|AUTH|CREDENTIAL/.test(name)).map(name => process.env[name]).filter(Boolean)]);
    const metadata = secrets.list();
    let args;
    if (check) {
      const fixture = path.join(stateDir, `${id}.fixture`);
      writeFileSync(fixture, 'Harmless sandbox boundary fixture.\n', { mode: 0o600 });
      const readOnly = policy.settings.projectAccess === 'read';
      const code = `import os, pathlib, sys, socket\np=pathlib.Path(sys.argv[1])\nf=pathlib.Path('.nono-check-${id}.tmp')\nassert pathlib.Path('.').is_dir()\ntry:\n f.write_text('ok')\n assert f.read_text() == 'ok'\n f.unlink()\n assert not ${readOnly ? 'True' : 'False'}, 'Read-only write unexpectedly succeeded'\n print('PASS  Project reads and writes work',flush=True)\nexcept PermissionError:\n assert ${readOnly ? 'True' : 'False'}, 'Project write unexpectedly denied'\n print('PASS  Read-only project rejects writes',flush=True)\nassert 'OPENSENSOR_DEMO_SECRET' not in os.environ\nprint('PASS  Unrelated environment variables are filtered',flush=True)\nfor target,mode in [(p,'r'),(p.with_suffix('.escape'),'w')]:\n try:\n  with target.open(mode) as handle: handle.read() if mode=='r' else handle.write('escape')\n except PermissionError:\n  print('PASS  Dashboard controls: '+('read' if mode=='r' else 'write')+' denied',flush=True)\n else: raise RuntimeError('Sandbox boundary failed')\n${policy.profile.network.block && !policy.settings.network.connectPorts.length ? "try:\n socket.create_connection(('192.0.2.1',443),timeout=0.5)\nexcept PermissionError:\n print('PASS  Direct outbound connection denied',flush=True)\nelse: raise RuntimeError('Network boundary failed')\n" : ''}print('All configured boundary checks passed.',flush=True)`;
      args = [...sandboxArgs(name, policy.profileName, policy.settings), '--', '/usr/bin/python3', '-c', code, fixture];
    } else {
      args = buildRunArgs({ name, prompt: body.prompt, model, autoApprove, profileName: policy.profileName, settings: policy.settings, interactive, harness }, binaries);
    }
    const record = { id, name, project, projectName: path.basename(project), harness, model: check ? 'No model · boundary test' : model || 'CLI default',
      prompt: check ? 'Verify saved sandbox policy' : redact(body.prompt?.trim() || `Interactive ${HARNESSES[harness].name} session`, redactions), kind: check ? 'check' : 'task',
      interactive, cols: size.cols, rows: size.rows, networkTrace: true, networkApprovals: policy.settings.network.mode === 'approval', pendingApprovals: 0,
      autoApprove: !check && autoApprove, status: 'starting', startedAt: new Date().toISOString(), logBytes: 0,
      policyRevision: policy.revision, profileName: policy.profileName, policy: policy.profile, settings: policy.settings,
      secretVersions: policy.settings.secrets.map(b => { const s = metadata.find(s => s.id === b.secretId); return { name: s.name, version: s.version, env: b.env, mode: b.mode }; }) };
    records.set(id, record);
    terminals.create(record, size);
    persist();
    audit('session.started', { project, session: id, revision: policy.revision });
    // A supervisor-owned trace gives the network view live proxy decisions.
    // Keep it separate from the PTY, so logs never corrupt the agent TUI.
    await fs.writeFile(network.logPath(id), '', { mode: 0o600 });
    args.unshift('--log-file', network.logPath(id));
    const env = { ...process.env, ...policy.supervisorEnv, PATH: sandboxPath, NONO_NO_SAVE_PROMPT: '1', RUST_LOG: 'off,nono_proxy::audit=info', OPENSENSOR_DEMO_SECRET: 'harmless-test-value', KILO_DISABLE_AUTOUPDATE: 'true',
      ...(interactive ? { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'OpenSensor' } : {}) };
    if (record.networkApprovals) {
      // CLI environment overrides must not replace the enforced upstream gate
      // or turn proxy-only egress into allow-all, even on a customized host.
      for (const name of Object.keys(env)) if (name.startsWith('NONO_')) delete env[name];
      env.NONO_NO_SAVE_PROMPT = '1';
    }
    const stdout = new RedactingStream(redactions, data => append(record, data));
    const stderr = new RedactingStream(redactions, data => append(record, data));
    let finished = false, child, resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const onDone = (code, signal) => {
      if (finished) return; finished = true;
      deadlines.get(id)?.stop(); deadlines.delete(id); stdout.end(); stderr.end();
      record.status = record.timedOut ? 'timed-out' : record.status === 'stopping' ? 'stopped' : code === 0 ? 'completed' : 'failed';
      record.approvalWait = false; record.deadlineAt = null;
      record.exitCode = code; record.signal = signal; record.endedAt = new Date().toISOString();
      children.delete(id); persist(); cache.at = 0;
      approvals.closeSession(id).catch(() => {});
      terminals.finish(id); resolveDone();
      audit('session.ended', { session: id, status: record.status, exitCode: code });
      if (check) fs.unlink(path.join(stateDir, `${id}.fixture`)).catch(() => {});
    };
    try {
      if (interactive) {
        child = pty.spawn(nono, args, { cwd: project, name: 'xterm-256color', ...size, env });
        child.onData(data => stdout.push(data));
        child.onExit(({ exitCode, signal }) => onDone(exitCode, signal));
        terminals.attachProcess(id, { write: data => child.write(data), resize: (cols, rows) => { child.resize(cols, rows); record.cols = cols; record.rows = rows; }, pause: () => child.pause(), resume: () => child.resume() });
      } else {
        child = spawn(nono, args, { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
        child.stdout.on('data', data => stdout.push(data)); child.stderr.on('data', data => stderr.push(data));
        child.on('error', error => { append(record, `Could not launch nono: ${error.message}\n`); });
        child.on('close', onDone);
        terminals.attachProcess(id, { pause: () => { child.stdout.pause(); child.stderr.pause(); }, resume: () => { child.stdout.resume(); child.stderr.resume(); } });
      }
      child.done = done; children.set(id, child);
      network.track(record, child.pid).catch(() => {});
      record.status = 'running'; persist(); cache.at = 0; terminals.status(id);
      const deadline = new SessionDeadline(policy.settings.limits.timeoutMinutes * 60000, () => {
        record.timedOut = true; append(record, '\n[Dashboard time limit reached. Stopping session.]\n');
        stop(id).catch(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} });
      }, timer => { record.approvalWait = timer.paused; record.deadlineAt = timer.paused ? null : new Date(Date.now() + timer.remaining).toISOString(); });
      deadlines.set(id, deadline); if (record.pendingApprovals) deadline.pause(); persist();
    } catch (error) { append(record, `Could not launch the terminal: ${error.message}\n`); onDone(1, null); }
    return record;
    } catch (error) { await approvals.closeSession(id); throw error; }
  }

  async function stop(id) {
    const record = await findSession(id);
    if (!activeStatus(record.status)) throw new RequestError('This session has already ended.', 409);
    if (!record.external) { record.status = 'stopping'; persist(); terminals.status(id); }
    deadlines.get(id)?.stop(); await approvals.closeSession(id);
    audit('session.stop-requested', { session: id });
    if (record.nonoId) {
      await runCommand(nono, ['stop', record.nonoId, '--timeout', '3'], { timeout: 8000 });
    } else {
      const child = children.get(id);
      if (!child?.pid) throw new RequestError('The session is not ready to stop. Try again.', 409);
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const child = children.get(id);
    if (child) { const timer = setTimeout(() => { if (children.get(id) === child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 5000); timer.unref(); }
    cache.at = 0;
    return { stopped: true };
  }

  async function details(id, includeOutput = true) {
    const record = await findSession(id);
    let output = '';
    if (includeOutput && record.external) output = 'This session was started in a terminal. Its terminal transcript was not captured by the dashboard.\n';
    else if (includeOutput) { try { output = stripVTControlCharacters(await fs.readFile(logPath(id), 'utf8')).slice(-160000); } catch {} }
    return { ...record, output };
  }

  async function diff(id) {
    const record = await findSession(id);
    const project = await validateProject(record.project, workspace);
    try {
      // Repository configuration is agent-writable. Never execute its fsmonitor, hooks, diff helpers or pager on the host.
      const git = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];
      const [changes, status] = await Promise.all([
        runCommand('git', [...git, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', '.'], { cwd: project, maxBuffer: 2 * 1024 * 1024 }),
        runCommand('git', [...git, 'status', '--short', '--untracked-files=normal', '--ignore-submodules=all'], { cwd: project })
      ]);
      return { diff: changes.stdout.slice(0, 160000), status: status.stdout, note: 'Current working tree, including any changes made before this session.' };
    } catch { return { diff: '', status: '', note: 'Working tree changes are available for Git projects.' }; }
  }

  async function bootstrap() {
    const runtime = await Promise.allSettled([runCommand(nono, ['--version']), ...Object.values(binaries).map(binary => runCommand(binary, ['--version']))]);
    const installed = Object.fromEntries(Object.keys(binaries).map((name, index) => [name, runtime[index + 1].status === 'fulfilled' ? runtime[index + 1].value.stdout.trim() : 'Unavailable']));
    const profile = readJSON(path.join(configDir, 'nono/profiles', `${PROFILE}.json`), null);
    return { workspace, projects: await projects(), sessions: await allSessions(), profile,
      profileName: PROFILE, defaultModel: FREE_MODEL, defaultSettings: policies.defaultSettings(), ...await modelCatalog(), keyring: await secrets.status(),
      terminal: { available: true, scrollback: 5000, archiveBytes: MAX_LOG },
      runtime: { nono: runtime[0].status === 'fulfilled' ? runtime[0].value.stdout.trim() : 'Unavailable', ...installed,
        platform: process.platform, wsl2: isWsl2(), proxyUnsupported: wsl2ProxyUnsupported(), ready: runtime[0].status === 'fulfilled' && Object.values(installed).some(value => value !== 'Unavailable') } };
  }

  const server = http.createServer(async (req, res) => {
    const origin = dashboardOrigin(req, server);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${origin ? ` ${origin.replace('http:', 'ws:')}` : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` };
    const json = (status, data, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(data)); };
    try {
      if (!origin) throw new RequestError('Only this dashboard host and origin are allowed.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      // A top-level link to the app is safe; its APIs still require same-origin requests.
      if (url.pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError('Cross-site requests are not allowed.', 403);
      let body;
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-opensensor-client'] !== 'dashboard' || !req.headers['content-type']?.startsWith('application/json')) throw new RequestError('Use the dashboard to make changes.', 403);
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 128000) throw new RequestError('Request is too large.', 413); }
        try { body = JSON.parse(raw); } catch { throw new RequestError('Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Expected a JSON object.');
      }
      if (req.method === 'POST' && url.pathname === '/api/auth') return json(200, { authenticated: true }, { 'Set-Cookie': auth.login(body.token) });
      if (url.pathname.startsWith('/api/') && !auth.check(req)) throw new RequestError('Open your private dashboard link to sign in.', 401);
      if (req.method === 'POST' && url.pathname === '/api/logout') return json(200, { authenticated: false }, { 'Set-Cookie': auth.logout() });
      if (req.method === 'GET' && url.pathname === '/api/project-settings') return json(200, await policies.describe(await projectPath(url.searchParams.get('project'))));
      if (req.method === 'POST' && url.pathname === '/api/project-settings') return json(200, await mutate(async () => {
        const project = await projectPath(body.project); const saved = await policies.save(project, body.settings, body.revision);
        audit('settings.saved', { project, revision: saved.revision }); return saved;
      }));
      if (req.method === 'POST' && url.pathname === '/api/project-settings/validate') return json(200, await policies.preview(await projectPath(body.project), body.settings));
      if (req.method === 'POST' && url.pathname === '/api/project-command') {
        const project = await projectPath(body.project);
        if (policies.get(project).settings.network.mode === 'approval') throw new RequestError('Start this project with Start session in the dashboard so you can answer its network approvals.');
        const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
        return json(200, { command: `cd ${quote(project)}\n${['env', `PATH=${sandboxPath}`, `OPENSENSOR_WORKSPACE=${workspace}`, `OPENSENSOR_DASHBOARD_STATE=${stateDir}`, `XDG_CONFIG_HOME=${configDir}`, `OPENSENSOR_NONO=${nono}`, `OPENSENSOR_KILO=${kilo}`, `OPENSENSOR_CLAUDE=${binaries.claude}`, `OPENSENSOR_CODEX=${binaries.codex}`, process.execPath, path.join(ROOT, 'scripts/run-project.mjs'), project].map(quote).join(' ')}`, note: 'Loads the latest saved project policy and resolves its bound keyring credentials at launch. Dashboard time limits and captured-log masking apply only to dashboard-launched sessions.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/secrets') return json(200, { status: await secrets.status(), secrets: secrets.list().map(s => ({ ...s, projects: policies.bindings(s.id) })) });
      if (req.method === 'GET' && url.pathname === '/api/git-context') return json(200, await policies.gitContext(await projectPath(url.searchParams.get('project'))));
      if (req.method === 'POST' && url.pathname === '/api/secrets') return json(201, await mutate(async () => { const s = await secrets.save(body); audit(body.id ? 'secret.rotated' : 'secret.created', { id: s.id, name: s.name, version: s.version }); return s; }));
      const secretMatch = url.pathname.match(/^\/api\/secrets\/([a-f0-9]{32})\/(enabled|delete)$/);
      if (req.method === 'POST' && secretMatch) return json(200, await mutate(async () => {
        const id = secretMatch[1];
        if (secretMatch[2] === 'delete') {
          if (policies.bindings(id).length) throw new RequestError('Remove this secret from project settings before deleting it.', 409);
          await secrets.remove(id); audit('secret.deleted', { id }); return { deleted: true };
        }
        const s = await secrets.setEnabled(id, body.enabled); audit('secret.enabled-changed', { id, enabled: s.enabled }); return s;
      }));
      if (req.method === 'GET' && url.pathname === '/api/audit') return json(200, readJSON(auditFile, []).slice(-100).reverse());
      if (req.method === 'GET' && url.pathname === '/api/models') return json(200, await modelCatalog({ force: url.searchParams.get('refresh') === '1' }));
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(200, await bootstrap());
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, await allSessions());
      if (req.method === 'GET' && url.pathname === '/api/approvals') return json(200, [...records.values()].filter(r => r.pendingApprovals && activeStatus(r.status)).map(r => ({ session: r.id, project: r.projectName, ...approvals.snapshot(r.id) })));
      if (req.method === 'POST' && url.pathname === '/api/sessions') return json(201, await mutate(() => start(body)));
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const project = await projectPath(body.path);
        writeFileSync(projectsFile, JSON.stringify([...new Set([...readJSON(projectsFile, []), project])]), { mode: 0o600 });
        return json(200, await projects());
      }
      const decisionMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/approvals\/([a-z0-9-]+)$/);
      if (req.method === 'POST' && decisionMatch) {
        const record = await findSession(decisionMatch[1]);
        if (!activeStatus(record.status) || record.status === 'stopping') throw new RequestError('This session is no longer accepting approvals.', 409);
        return json(200, approvals.decide(record.id, decisionMatch[2], body.decision));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)(?:\/(stop|diff|log|network|approvals))?$/);
      if (match) {
        if (req.method === 'POST' && match[2] === 'stop') return json(200, await stop(match[1]));
        if (req.method === 'GET' && match[2] === 'diff') return json(200, await diff(match[1]));
        if (req.method === 'GET' && match[2] === 'network') return json(200, await network.snapshot(await findSession(match[1])));
        if (req.method === 'GET' && match[2] === 'approvals') { await findSession(match[1]); return json(200, approvals.snapshot(match[1])); }
        if (req.method === 'GET' && match[2] === 'log') {
          const record = await findSession(match[1]); let output = 'No captured transcript.';
          if (!record.external) { try { output = await fs.readFile(logPath(record.id), 'utf8'); } catch {} }
          res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(url.searchParams.get('format') === 'ansi' ? output : stripVTControlCharacters(output));
        }
        if (req.method === 'GET' && !match[2]) return json(200, await details(match[1], url.searchParams.get('output') !== '0'));
      }
      if (req.method === 'GET' && VENDOR_FILES[url.pathname]) {
        res.writeHead(200, { ...headers, 'Content-Type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
        return res.end(await fs.readFile(path.join(ROOT, 'node_modules', VENDOR_FILES[url.pathname])));
      }
      if (req.method === 'GET' && ['/', '/app.js', '/settings.js', '/terminal.js', '/network.js', '/approvals.js', '/style.css', '/favicon.svg'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
        res.writeHead(200, { ...headers, 'Content-Type': types[name.split('.').at(-1)] });
        return res.end(await fs.readFile(path.join(ROOT, 'public', name)));
      }
      throw new RequestError('Not found.', 404);
    } catch (error) { if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'The dashboard could not complete the request.' }); }
  });
  terminals.connect(server, auth);

  server.shutdown = async () => {
    closing = true;
    for (const timer of deadlines.values()) timer.stop(); await approvals.close();
    const drain = async ms => { let timer; try { await Promise.race([Promise.all([...children.values()].map(child => child.done)), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); } finally { clearTimeout(timer); } };
    for (const child of children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await drain(3000);
    for (const child of children.values()) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await drain(1000);
    await terminals.flush(); terminals.close(); await network.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDashboard();
  const port = Number(process.env.OPENSENSOR_PORT || 4317);
  const host = process.env.OPENSENSOR_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`OpenSensor Kilo dashboard listening on ${host}:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.shutdown().then(() => process.exit(0)));
}
