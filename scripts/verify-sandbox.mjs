// Live Linux integration checks. Only generated fixture credentials are touched.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPolicyStore, defaults, projectId } from '../lib/policy.mjs';
import { createSecretStore } from '../lib/secrets.mjs';
import { createDashboard } from '../server.mjs';

const execute = promisify(execFile), home = os.homedir(), workspace = path.join(home, 'opensensor');
const root = await fs.mkdtemp(path.join(workspace, '.nono-dashboard-check-'));
const project = path.join(root, 'project'), stateDir = path.join(root, 'management'), configDir = path.join(home, '.config');
const nono = path.join(home, '.local/bin/nono'), profileDir = path.join(configDir, 'nono/profiles');
await fs.mkdir(project); await fs.mkdir(stateDir); await fs.writeFile(path.join(project, 'readable.txt'), 'fixture');
const secretStore = createSecretStore(stateDir), profiles = [];
const store = createPolicyStore({ stateDir, configDir, workspace: root, sourceDir: path.resolve('.'), execute, nono, secretStore });
let secret, dashboard, upstream; let value = randomBytes(24).toString('hex');
async function run(policy, code, extra = []) {
  const snapshot = policy.secrets.some(s => s.mode === 'proxy') ? await secretStore.resolve(policy.secrets.map(s => s.secretId)) : undefined;
  const launched = await store.launch(project, snapshot); profiles.push(launched.profileName);
  try { return await execute(nono, ['run', '--profile', launched.profileName, '--allow-cwd', '--no-rollback', ...extra, '--', '/usr/bin/python3', '-c', code], { cwd: project, env: { ...process.env, ...launched.supervisorEnv }, timeout: 20000, maxBuffer: 200000 }); }
  catch (error) { throw new Error(String(error.stderr || error.stdout || error.message).replaceAll(value, '[REDACTED]')); }
}
try {
  const s = defaults(); s.storage = 'isolated'; s.projectAccess = 'read'; s.network.mode = 'blocked';
  await store.save(project, s, 0);
  const boundary = await run(s, `import pathlib,socket\nassert pathlib.Path('readable.txt').read_text()=='fixture'\ntry: pathlib.Path('must-not-exist').write_text('no')\nexcept PermissionError: pass\nelse: raise AssertionError('read-only write allowed')\ntry: pathlib.Path(${JSON.stringify(path.join(stateDir, 'project-settings.json'))}).read_text()\nexcept PermissionError: pass\nelse: raise AssertionError('management read allowed')\ntry: socket.create_connection(('192.0.2.1',443),0.5)\nexcept PermissionError: pass\nelse: raise AssertionError('network allowed')\nprint('BOUNDARY_PASS')`, ['--memory', '256M', '--max-processes', '32']);
  assert.match(boundary.stdout, /BOUNDARY_PASS/); console.log('PASS read-only files, management isolation, blocked network and cgroup limits');

  secret = await secretStore.save({ name: 'Temporary live verification fixture', value });
  value = randomBytes(24).toString('hex');
  secret = await secretStore.save({ id: secret.id, name: secret.name, value }); assert.equal(secret.version, 2);
  s.projectAccess = 'readwrite'; s.secrets = [{ secretId: secret.id, mode: 'env', env: 'OPENSENSOR_TEST_KEY' }];
  await store.save(project, s, 1);
  const injected = await run(s, `import os,hashlib\nassert hashlib.sha256(os.environ['OPENSENSOR_TEST_KEY'].encode()).hexdigest()==${JSON.stringify(createHash('sha256').update(value).digest('hex'))}\nprint('ENV_PASS')`);
  assert.match(injected.stdout, /ENV_PASS/); console.log('PASS real keyring credential injection');

  let requests = 0, authOK = true;
  upstream = http.createServer((req, res) => {
    authOK &&= req.headers.authorization === `Bearer ${value}`; requests++;
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk({ role: 'assistant', content: 'KILO_PROXY_PASS' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    } else res.end('UPSTREAM_PASS');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  s.network.mode = 'restricted';
  s.secrets = [{ secretId: secret.id, mode: 'proxy', env: 'OPENSENSOR_TEST_KEY', route: 'fixture', upstream: `http://127.0.0.1:${upstream.address().port}`, header: 'Authorization', format: 'Bearer {}', endpoints: [{ method: 'GET', path: '/v1/test' }] }];
  await store.save(project, s, 2);
  const proxy = await run(s, `import os,urllib.request,urllib.error,hashlib\nassert hashlib.sha256(os.environ['OPENSENSOR_TEST_KEY'].encode()).hexdigest()!=${JSON.stringify(createHash('sha256').update(value).digest('hex'))}\nbase=os.environ['FIXTURE_BASE_URL'].rstrip('/')\nassert urllib.request.urlopen(urllib.request.Request(base+'/v1/test',headers={'Authorization':'Bearer '+os.environ['OPENSENSOR_TEST_KEY']})).read()==b'UPSTREAM_PASS'\ntry: urllib.request.urlopen(urllib.request.Request(base+'/private',headers={'Authorization':'Bearer '+os.environ['OPENSENSOR_TEST_KEY']}))\nexcept urllib.error.HTTPError as e: assert e.code==403\nelse: raise AssertionError('denied endpoint passed')\nprint('PROXY_PASS')`);
  assert.match(proxy.stdout, /PROXY_PASS/); assert.equal(requests, 1); assert.equal(authOK, true); console.log('PASS credential proxy injects only at upstream and rejects other endpoints');

  s.secrets[0].upstream += '/v1'; s.secrets[0].endpoints = [{ method: 'POST', path: '/chat/completions' }];
  s.provider = { ...s.provider, enabled: true, id: 'fixture', model: 'demo', proxyRoute: 'fixture' };
  await store.save(project, s, 3);
  const kiloPolicy = await store.launch(project, await secretStore.resolve([secret.id])); profiles.push(kiloPolicy.profileName);
  const kilo = process.env.OPENSENSOR_KILO || path.join(path.dirname(process.execPath), 'kilo');
  const kiloResult = await execute(nono, ['run', '--profile', kiloPolicy.profileName, '--allow-cwd', '--no-rollback', '--', kilo, 'run', '--pure', '--model', 'fixture/demo', '--', 'Reply OK without tools.'], { cwd: project, env: { ...process.env, ...kiloPolicy.supervisorEnv }, timeout: 45000, maxBuffer: 300000 });
  assert.match(kiloResult.stdout, /KILO_PROXY_PASS/); assert.equal(authOK, true); console.log('PASS real Kilo uses the project provider through a credential proxy (local mock, no model spend)');

  const executable = path.join(project, 'fixture-kilo');
  await fs.writeFile(executable, '#!/usr/bin/python3\nimport os,sys,time,signal,subprocess\nsubprocess.run(["rg","--files","."],check=True,capture_output=True)\nassert not any(k.startswith("OPENSENSOR_SUPERVISOR_") for k in os.environ)\nif sys.argv[-1]=="Wait for deadline":\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n time.sleep(120)\ns=os.environ["OPENSENSOR_TEST_KEY"]\nsys.stdout.write(s[:10]);sys.stdout.flush();time.sleep(0.03);sys.stdout.write(s[10:]+"\\n");sys.stdout.flush()\nprint("LOG_PASS")\n', { mode: 0o700 });
  dashboard = createDashboard({ workspace: root, stateDir, configDir, nono, kilo: executable });
  await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${dashboard.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const api = async (url, body) => { const res = await fetch(origin + url, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); const data = await res.json(); if (!res.ok) throw new Error(`${res.status}: ${data.error}`); return data; };
  assert.equal((await fetch(origin + '/api/secrets', { headers })).status, 401);
  const key = JSON.parse(await fs.readFile(path.join(stateDir, 'browser-access.json'))).key;
  const auth = await fetch(origin + '/api/auth', { method: 'POST', headers, body: JSON.stringify({ token: key }) }); headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
  s.secrets = [{ secretId: secret.id, mode: 'env', env: 'OPENSENSOR_TEST_KEY' }]; s.network.mode = 'unrestricted'; s.provider.enabled = false;
  await api('/api/project-settings', { project, settings: s, revision: 4 });
  const session = await api('/api/sessions', { project, prompt: 'Run fixture', model: 'kilo/test' }); profiles.push(session.profileName);
  let detail;
  for (let i = 0; i < 100; i++) { detail = await api(`/api/sessions/${session.id}`); if (!['starting', 'running'].includes(detail.status)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(detail.status, 'completed'); assert.match(detail.output, /LOG_PASS/); assert.match(detail.output, /\[REDACTED\]/); assert.equal(detail.output.includes(value), false);
  assert.equal((await fs.readFile(path.join(stateDir, `${session.id}.log`), 'utf8')).includes(value), false);
  console.log('PASS authenticated API and on-disk masking of split credential output');
  const blocked = await execute(nono, ['run', '--profile', session.profileName, '--allow-cwd', '--no-rollback', '--', '/usr/bin/python3', '-c', `import urllib.request,urllib.error,json\nr=urllib.request.Request(${JSON.stringify(origin + '/api/secrets')},headers={'Origin':${JSON.stringify(origin)},'X-OpenSensor-Client':'dashboard'})\ntry: urllib.request.urlopen(r)\nexcept urllib.error.HTTPError as e: assert e.code==401\nelse: raise AssertionError('unauthenticated sandbox gained API access')\nprint('AUTH_PASS')`], { cwd: project, env: { ...process.env, [`OPENSENSOR_SUPERVISOR_SECRET_${secret.id.toUpperCase()}`]: value }, timeout: 20000 });
  assert.match(blocked.stdout, /AUTH_PASS/); console.log('PASS a sandboxed process cannot authenticate by forging dashboard headers');
  if (process.argv.includes('--deadline')) {
    s.limits.timeoutMinutes = 1; await api('/api/project-settings', { project, settings: s, revision: 5 });
    const timed = await api('/api/sessions', { project, prompt: 'Wait for deadline', model: 'kilo/test' }); profiles.push(timed.profileName);
    console.log('Checking the real one-minute deadline against a process that ignores SIGTERM…');
    let result;
    for (let i = 0; i < 80; i++) { result = await api(`/api/sessions/${timed.id}`); if (!['starting', 'running', 'stopping'].includes(result.status)) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    assert.equal(result.status, 'timed-out'); assert.match(result.output, /time limit reached/);
    console.log('PASS real session deadline terminates the process and records timed-out status');
  }
} catch (error) { console.error(String(error.stack || error.message).replaceAll(value, '[REDACTED]')); process.exitCode = 1; }
finally {
  if (dashboard) await dashboard.shutdown();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  if (secret) await secretStore.remove(secret.id);
  for (const name of profiles) await fs.unlink(path.join(profileDir, `${name}.json`)).catch(() => {});
  await fs.rm(path.join(home, '.local/share/opensensor-kilo-projects', projectId(project)), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
}
