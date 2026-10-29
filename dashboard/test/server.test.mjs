import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createDashboard, validateProject, buildRunArgs } from '../server.mjs';
import { defaults } from '../lib/policy.mjs';

test('project grants reject the workspace root, traversal, files and escaping symlinks', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-dashboard-paths-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  const project = path.join(workspace, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(temp, 'outside'));
  await fs.symlink(path.join(temp, 'outside'), path.join(workspace, 'escape'));
  await fs.writeFile(path.join(project, 'file.txt'), 'fixture');
  assert.equal(await validateProject('project', workspace), project);
  assert.equal(await validateProject(path.join(temp, 'outside'), workspace), path.join(temp, 'outside'));
  for (const input of ['.', '..', '../outside', 'escape', 'project/file.txt']) await assert.rejects(validateProject(input, workspace));
  for (const input of ['/', '/proc', '/run/user', os.homedir()]) await assert.rejects(validateProject(input, workspace));
});

test('task text is a literal argument and tool auto approval is opt-in', () => {
  const prompt = '--help $(touch /tmp/not-a-command) ; echo nope';
  const args = buildRunArgs({ name: 'example', prompt, model: 'kilo/kilo-auto/free' }, '/usr/bin/kilo');
  assert.deepEqual(args.slice(-2), ['--', prompt]);
  assert.equal(args.includes('--auto'), false);
  assert.equal(args.includes('--rollback'), true);
  const noRollback = buildRunArgs({ name: 'x', prompt: 'hello', model: 'kilo/test', settings: { rollback: { enabled: false }, limits: {} } }, 'kilo');
  assert.equal(noRollback.includes('--rollback'), false); assert.equal(noRollback.includes('--no-rollback'), true);
  assert.throws(() => buildRunArgs({ name: 'x', prompt: 'hello', model: '--help' }, 'kilo'));
  assert.throws(() => buildRunArgs({ name: 'x', prompt: '', model: 'kilo/test' }, 'kilo'));
});

test('LAN HTTP origin guards, authentication, process lifecycle and captured output', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-dashboard-http-'));
  const workspace = path.join(temp, 'workspace');
  const project = path.join(workspace, 'demo');
  const binary = path.join(temp, 'fake-nono');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(binary, `#!/usr/bin/env node\nif(process.argv[2]==='ps'){console.log('[]');process.exit(0)}\nif(['--version','profile'].includes(process.argv[2])){console.log('test runtime');process.exit(0)}\nconsole.log(JSON.stringify(process.argv.slice(2)));\nprocess.on('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  const server = createDashboard({ workspace, stateDir: path.join(temp, 'state'), configDir: path.join(temp, 'config'), home: temp, nono: binary, kilo: binary, claude: binary, codex: binary });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(async () => { await server.shutdown(); await fs.rm(temp, { recursive: true, force: true }); });
  const lan = Object.values(os.networkInterfaces()).flat().find(n => !n.internal && n.family === 'IPv4')?.address || '127.0.0.1';
  const base = `http://${lan}:${server.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const body = JSON.stringify({ project, prompt: `$(touch ${path.join(project, 'should-not-exist')})`, model: 'kilo/test' });
  const request = (route, options = {}) => fetch(base + route, options);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/bootstrap`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const forgedHost = `attacker.invalid:${server.address().port}`;
  assert.equal((await request('/api/sessions', { headers: { Host: forgedHost, Origin: `http://${forgedHost}` } })).status, 403);
  assert.equal((await request('/api/sessions', { headers: { Origin: `http://localhost:${server.address().port}` } })).status, 403);
  const page = await request('/'); assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy').includes(`ws://${lan}:${server.address().port}`));
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/`)).status, 200);
  assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  assert.equal((await request('/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers, body })).status, 401);
  assert.equal((await request('/api/secrets')).status, 401);
  assert.equal((await request('/api/auth', { method: 'POST', headers, body: '{"token":"wrong"}' })).status, 401);
  const { key } = JSON.parse(await fs.readFile(path.join(temp, 'state/browser-access.json')));
  const authenticated = await request('/api/auth', { method: 'POST', headers, body: JSON.stringify({ token: key }) });
  assert.equal(authenticated.status, 200);
  const cookie = authenticated.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  headers.Cookie = cookie.split(';')[0];
  const launchCommand = await (await request('/api/project-command', { method: 'POST', headers, body: JSON.stringify({ project }) })).json();
  assert.match(launchCommand.command, /scripts\/run-project\.mjs/);
  assert.equal(launchCommand.command.includes(key), false);
  assert.match(launchCommand.note, /latest saved project policy/);
  assert.equal((await request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ project: workspace, prompt: 'test', model: 'kilo/test' }) })).status, 400);
  const started = await request('/api/sessions', { method: 'POST', headers, body });
  assert.equal(started.status, 201);
  const session = await started.json();
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = await (await request(`/api/sessions/${session.id}`, { headers })).json();
    if (detail.output) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(detail.output, /touch/);
  await assert.rejects(fs.access(path.join(project, 'should-not-exist')));
  execFileSync('git', ['init', '-q', project]);
  const monitor = path.join(temp, 'untrusted-monitor');
  const marker = path.join(temp, 'host-helper-must-not-run');
  await fs.writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  execFileSync('git', ['-C', project, 'config', 'core.fsmonitor', monitor]);
  assert.equal((await request(`/api/sessions/${session.id}/diff`, { headers })).status, 200);
  await assert.rejects(fs.access(marker));
  assert.equal((await request(`/api/sessions/${session.id}/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  for (let i = 0; i < 40; i++) {
    detail = await (await request(`/api/sessions/${session.id}`, { headers })).json();
    if (detail.status === 'stopped') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(detail.status, 'stopped');
  for (const harness of ['claude', 'codex']) {
    const started = await request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ project, prompt: 'inspect safely', harness, model: '', interactive: true }) });
    assert.equal(started.status, 201);
    const native = await started.json();
    assert.equal(native.harness, harness);
    assert.equal(native.policy.extends, `nolabs-ai/${harness}`);
    assert.equal((await request(`/api/sessions/${native.id}/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  }
  assert.equal((await request('/api/sessions/unknown/stop', { method: 'POST', headers, body: '{}' })).status, 404);
});

test('learning review promotes only observed project hosts into a restricted policy', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-dashboard-learning-'));
  const workspace = path.join(temp, 'workspace'), project = path.join(workspace, 'demo'), stateDir = path.join(temp, 'state');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(stateDir);
  const settings = defaults(); settings.network.mode = 'learning'; settings.network.denyDomains = ['blocked.example.com'];
  await fs.writeFile(path.join(stateDir, 'project-settings.json'), JSON.stringify({ [project]: { revision: 1, updatedAt: new Date().toISOString(), settings, history: [] } }));
  const record = { id: 'learning-fixture', project, status: 'completed', settings, networkTrace: true };
  await fs.writeFile(path.join(stateDir, 'sessions.json'), JSON.stringify([record]));
  await fs.writeFile(path.join(stateDir, `${record.id}.network.json`), JSON.stringify({ events: [], destinations: [
    { host: 'api.example.com', port: 443, allowed: 3, denied: 0, responses: 2, connections: 0, lastSeen: '2026-10-01T00:00:00.000Z' },
    { host: 'blocked.example.com', port: 443, allowed: 0, denied: 2, responses: 0, connections: 0, lastSeen: '2026-10-01T00:00:01.000Z' }
  ], samples: [], connections: [], totals: { allowed: 3, denied: 2, responses: 2, connections: 0 }, truncated: false }));
  const server = createDashboard({ workspace, stateDir, configDir: path.join(temp, 'config'), home: temp, nono: '/fake', kilo: '/fake',
    execute: async () => ({ stdout: '{}', stderr: '' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdown(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const request = (route, body) => fetch(base + route, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
  const { key } = JSON.parse(await fs.readFile(path.join(stateDir, 'browser-access.json')));
  const auth = await request('/api/auth', { token: key }); headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/project-command', { project })).status, 400);
  const reviewed = await (await request(`/api/network-learning?project=${encodeURIComponent(project)}`)).json();
  assert.deepEqual(reviewed.domains.map(d => d.host), ['api.example.com']);
  assert.equal((await request('/api/network-learning/finish', { project, revision: 1, domains: ['unseen.example.com'] })).status, 409);
  const finished = await (await request('/api/network-learning/finish', { project, revision: 1, domains: ['api.example.com'] })).json();
  assert.equal(finished.revision, 2); assert.equal(finished.settings.network.mode, 'restricted');
  assert.deepEqual(finished.profile.network.allow_domain, ['api.example.com']);
  assert.deepEqual(finished.profile.network.deny_domain, ['blocked.example.com']);
  assert.equal((await request('/api/network-learning/finish', { project, revision: 1, domains: [] })).status, 409);
  const guided = await (await request('/api/project-preset', { project, revision: 2, preset: 'guided' })).json();
  assert.equal(guided.revision, 3); assert.equal(guided.settings.network.mode, 'approval');
  assert.deepEqual(guided.settings.network.allowDomains, ['api.example.com']);
  assert.equal((await request('/api/project-preset', { project, revision: 2, preset: 'offline' })).status, 409);
  assert.equal((await request('/api/project-preset', { project, revision: 3, preset: 'unsupported' })).status, 400);
  const offline = await (await request('/api/project-preset', { project, revision: 3, preset: 'offline' })).json();
  assert.equal(offline.revision, 4); assert.equal(offline.settings.network.mode, 'blocked');
  assert.equal(offline.profile.network.block, true);
});
