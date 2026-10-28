import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = 'opensensor-kilo-local';
const FREE_MODEL = 'kilo/kilo-auto/free';
const MAX_LOG = 1024 * 1024;
const activeStatus = status => ['starting', 'running', 'stopping'].includes(status);

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function validateProject(input, workspace) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new RequestError('Choose a project directory.');
  let resolved;
  try { resolved = await fs.realpath(path.resolve(workspace, input)); }
  catch { throw new RequestError('That project directory does not exist.'); }
  const base = await fs.realpath(workspace);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).includes('.git')) {
    throw new RequestError('Choose an individual project inside the workspace, not the workspace root.');
  }
  if (!(await fs.stat(resolved)).isDirectory()) throw new RequestError('The project must be a directory.');
  return resolved;
}

export function buildRunArgs({ name, prompt, model, autoApprove = false }, kilo) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new RequestError('Enter a task of 1–12,000 characters.');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_~][a-zA-Z0-9_~./:@+-]{1,255}$/.test(model)) throw new RequestError('Use a model ID in provider/model format.');
  if (typeof autoApprove !== 'boolean') throw new RequestError('Auto approval must be on or off.');
  return ['run', '--name', name, '--profile', PROFILE, '--allow-cwd', '--no-rollback-prompt', '--', kilo,
    'run', '--pure', '--model', model, '--title', prompt.trim().slice(0, 80), ...(autoApprove ? ['--auto'] : []), '--', prompt.trim()];
}

function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function configuredModel(configDir) {
  let model = '';
  for (const filename of ['config.json', 'kilo.json', 'kilo.jsonc']) {
    try {
      const text = readFileSync(path.join(configDir, 'kilo', filename), 'utf8');
      const match = text.match(/^\s*"model"\s*:\s*"([^"\r\n]+)"/m);
      if (match) model = match[1];
    } catch { /* No Kilo config is also supported. */ }
  }
  return model;
}

export function createDashboard(options = {}) {
  const workspace = path.resolve(options.workspace || process.env.OPENSENSOR_WORKSPACE || path.join(os.homedir(), 'opensensor'));
  const stateDir = options.stateDir || process.env.OPENSENSOR_DASHBOARD_STATE || path.join(os.homedir(), '.local/state/nono-kilo-dashboard');
  const configDir = options.configDir || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const nono = options.nono || process.env.OPENSENSOR_NONO || path.join(os.homedir(), '.local/bin/nono');
  const kilo = options.kilo || process.env.OPENSENSOR_KILO || 'kilo';
  const execute = options.execute || exec;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(stateDir, 'sessions.json');
  const projectsFile = path.join(stateDir, 'projects.json');
  const records = new Map(readJSON(indexFile, []).map(record => [record.id, record]));
  const children = new Map();
  let cache = { at: 0, sessions: [] };
  let refreshPromise;
  let closing = false;
  for (const record of records.values()) {
    if (activeStatus(record.status)) { record.status = 'interrupted'; record.endedAt = new Date().toISOString(); }
  }
  const persist = () => writeFileSync(indexFile, JSON.stringify([...records.values()], null, 2), { mode: 0o600 });
  const logPath = id => path.join(stateDir, `${id}.log`);
  const runCommand = (command, args, extra = {}) => execute(command, args, { timeout: 12000, maxBuffer: 1024 * 1024, ...extra });

  async function projects() {
    const discovered = [];
    for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const candidate = path.join(workspace, entry.name);
      if (existsSync(path.join(candidate, '.git')) || entry.name === 'nono-kilo-demo') discovered.push(candidate);
    }
    const entries = [...new Set([...discovered, ...readJSON(projectsFile, [])])];
    const valid = await Promise.all(entries.map(async candidate => {
      try {
        const real = await validateProject(candidate, workspace);
        return { path: real, name: path.basename(real), relative: path.relative(workspace, real), demo: path.basename(real) === 'nono-kilo-demo' };
      } catch { return null; }
    }));
    return valid.filter(Boolean).sort((a, b) => Number(b.demo) - Number(a.demo) || a.name.localeCompare(b.name));
  }

  async function refreshNono() {
    if (Date.now() - cache.at < 1500) return cache.sessions;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const { stdout } = await runCommand(nono, ['ps', '--all', '--json']);
        cache = { at: Date.now(), sessions: JSON.parse(stdout).filter(s => s.profile === PROFILE) };
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
      if (owned.has(session.name) || !session.command?.includes('run') || !session.command.some(arg => path.basename(arg) === 'kilo')) continue;
      try { await validateProject(session.workdir, workspace); } catch { continue; }
      const prompt = session.command.at(-1);
      external.push({ id: `external-${session.session_id}`, nonoId: session.session_id, name: session.name,
        project: session.workdir, projectName: path.basename(session.workdir), prompt,
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
    if (record.logBytes >= MAX_LOG) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_LOG - (record.logBytes || 0);
    const accepted = bytes.subarray(0, remaining);
    appendFileSync(logPath(record.id), accepted, { mode: 0o600 });
    record.logBytes = (record.logBytes || 0) + accepted.length;
    if (bytes.length >= remaining) appendFileSync(logPath(record.id), '\n[Dashboard output limit reached: 1 MiB.]\n');
  }

  async function start(body) {
    if (closing) throw new RequestError('Dashboard is restarting.', 503);
    const project = await validateProject(body.project, workspace);
    if ([...records.values()].filter(r => activeStatus(r.status)).length >= 3) throw new RequestError('Three dashboard sessions are already running. Stop one before starting another.', 409);
    const id = randomUUID();
    const name = `kilo-${id.slice(0, 8)}`;
    const check = body.kind === 'check';
    const model = body.model || FREE_MODEL;
    let args;
    if (check) {
      const fixture = path.join(stateDir, `${id}.fixture`);
      writeFileSync(fixture, 'Harmless sandbox boundary fixture.\n', { mode: 0o600 });
      const code = `import os, pathlib, sys\np=pathlib.Path(sys.argv[1])\nf=pathlib.Path('.nono-check-${id}.tmp')\nf.write_text('ok')\nassert f.read_text() == 'ok'\nf.unlink()\nprint('PASS  Project reads and writes work',flush=True)\nassert 'OPENSENSOR_DEMO_SECRET' not in os.environ\nprint('PASS  Unrelated environment variables are filtered',flush=True)\nfor target,mode in [(p,'r'),(p.with_suffix('.escape'),'w')]:\n try:\n  with target.open(mode) as handle: handle.read() if mode=='r' else handle.write('escape')\n except PermissionError:\n  print('PASS  Outside-project '+('read' if mode=='r' else 'write')+' denied',flush=True)\n else: raise RuntimeError('Sandbox boundary failed')\nprint('All four sandbox checks passed.',flush=True)`;
      args = ['run', '--name', name, '--profile', PROFILE, '--allow-cwd', '--no-rollback-prompt', '--block-net', '--', 'python3', '-c', code, fixture];
    } else {
      args = buildRunArgs({ name, prompt: body.prompt, model, autoApprove: body.autoApprove ?? false }, kilo);
    }
    const record = { id, name, project, projectName: path.basename(project), model: check ? 'No model · offline' : model,
      prompt: check ? 'Verify filesystem and environment boundaries' : body.prompt.trim(), kind: check ? 'check' : 'task',
      autoApprove: !check && Boolean(body.autoApprove), status: 'starting', startedAt: new Date().toISOString(), logBytes: 0 };
    // Prepare the same directories as the local launcher before nono resolves grants.
    for (const dir of [path.join(configDir, 'kilo'), path.join(configDir, 'nono/profile-drafts'),
      path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'kilo'),
      path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'opensensor-kilo'),
      path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'kilo/tmp')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    records.set(id, record);
    persist();
    const child = spawn(nono, args, { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENSENSOR_DEMO_SECRET: 'harmless-test-value', KILO_DISABLE_AUTOUPDATE: 'true' } });
    children.set(id, child);
    child.on('spawn', () => { record.status = 'running'; persist(); cache.at = 0; });
    child.stdout.on('data', data => append(record, data));
    child.stderr.on('data', data => append(record, data));
    child.on('error', error => { append(record, `Could not launch nono: ${error.message}\n`); });
    child.on('close', (code, signal) => {
      record.status = record.status === 'stopping' ? 'stopped' : code === 0 ? 'completed' : 'failed';
      record.exitCode = code; record.signal = signal; record.endedAt = new Date().toISOString();
      children.delete(id); persist(); cache.at = 0;
      if (check) fs.unlink(path.join(stateDir, `${id}.fixture`)).catch(() => {});
    });
    return record;
  }

  async function stop(id) {
    const record = await findSession(id);
    if (!activeStatus(record.status)) throw new RequestError('This session has already ended.', 409);
    if (!record.external) { record.status = 'stopping'; persist(); }
    if (record.nonoId) {
      await runCommand(nono, ['stop', record.nonoId, '--timeout', '3'], { timeout: 8000 });
    } else {
      const child = children.get(id);
      if (!child?.pid) throw new RequestError('The session is not ready to stop. Try again.', 409);
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    cache.at = 0;
    return { stopped: true };
  }

  async function details(id) {
    const record = await findSession(id);
    let output = '';
    if (record.external) output = 'This session was started in a terminal. Its terminal transcript was not captured by the dashboard.\n';
    else { try { output = stripVTControlCharacters(await fs.readFile(logPath(id), 'utf8')).slice(-160000); } catch {} }
    return { ...record, output };
  }

  async function diff(id) {
    const record = await findSession(id);
    const project = await validateProject(record.project, workspace);
    try {
      const [changes, status] = await Promise.all([
        runCommand('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', '.'], { cwd: project, maxBuffer: 2 * 1024 * 1024 }),
        runCommand('git', ['status', '--short', '--untracked-files=normal'], { cwd: project })
      ]);
      return { diff: changes.stdout.slice(0, 160000), status: status.stdout, note: 'Current working tree, including any changes made before this session.' };
    } catch { return { diff: '', status: '', note: 'Working tree changes are available for Git projects.' }; }
  }

  async function bootstrap() {
    const runtime = await Promise.allSettled([runCommand(nono, ['--version']), runCommand(kilo, ['--version'])]);
    const profile = readJSON(path.join(configDir, 'nono/profiles', `${PROFILE}.json`), null);
    return { workspace, projects: await projects(), sessions: await allSessions(), profile,
      profileName: PROFILE, defaultModel: FREE_MODEL, configuredModel: configuredModel(configDir),
      runtime: { nono: runtime[0].status === 'fulfilled' ? runtime[0].value.stdout.trim() : 'Unavailable',
        kilo: runtime[1].status === 'fulfilled' ? runtime[1].value.stdout.trim() : 'Unavailable',
        platform: process.platform, ready: runtime.every(r => r.status === 'fulfilled') && Boolean(profile) } };
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origins = new Set([...hosts].map(host => `http://${host}`));
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const json = (status, data) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) throw new RequestError('Only the local dashboard origin is allowed.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      // A top-level link to the app is safe; its APIs still require same-origin requests.
      if (url.pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError('Cross-site requests are not allowed.', 403);
      let body;
      if (req.method === 'POST') {
        if (!origins.has(req.headers.origin) || req.headers['x-opensensor-client'] !== 'dashboard' || !req.headers['content-type']?.startsWith('application/json')) throw new RequestError('Use the local dashboard to make changes.', 403);
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 20000) throw new RequestError('Request is too large.', 413); }
        try { body = JSON.parse(raw); } catch { throw new RequestError('Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Expected a JSON object.');
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(200, await bootstrap());
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, await allSessions());
      if (req.method === 'POST' && url.pathname === '/api/sessions') return json(201, await start(body));
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const project = await validateProject(body.path, workspace);
        writeFileSync(projectsFile, JSON.stringify([...new Set([...readJSON(projectsFile, []), project])]), { mode: 0o600 });
        return json(200, await projects());
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)(?:\/(stop|diff))?$/);
      if (match) {
        if (req.method === 'POST' && match[2] === 'stop') return json(200, await stop(match[1]));
        if (req.method === 'GET' && match[2] === 'diff') return json(200, await diff(match[1]));
        if (req.method === 'GET' && !match[2]) return json(200, await details(match[1]));
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/favicon.svg'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
        res.writeHead(200, { ...headers, 'Content-Type': types[name.split('.').at(-1)] });
        return res.end(await fs.readFile(path.join(ROOT, 'public', name)));
      }
      throw new RequestError('Not found.', 404);
    } catch (error) { if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'The dashboard could not complete the request.' }); }
  });

  server.shutdown = async () => {
    closing = true;
    for (const child of children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDashboard();
  const port = Number(process.env.OPENSENSOR_PORT || 4317);
  server.listen(port, '127.0.0.1', () => console.log(`OpenSensor Kilo dashboard: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.shutdown().then(() => process.exit(0)));
}
