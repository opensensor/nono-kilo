import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createDashboard, validateProject, buildRunArgs } from '../server.mjs';

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
  for (const input of ['.', '..', '../outside', 'escape', 'project/file.txt']) await assert.rejects(validateProject(input, workspace));
});

test('task text is a literal argument and tool auto approval is opt-in', () => {
  const prompt = '--help $(touch /tmp/not-a-command) ; echo nope';
  const args = buildRunArgs({ name: 'example', prompt, model: 'kilo/kilo-auto/free' }, '/usr/bin/kilo');
  assert.deepEqual(args.slice(-2), ['--', prompt]);
  assert.equal(args.includes('--auto'), false);
  assert.throws(() => buildRunArgs({ name: 'x', prompt: 'hello', model: '--help' }, 'kilo'));
  assert.throws(() => buildRunArgs({ name: 'x', prompt: '', model: 'kilo/test' }, 'kilo'));
});

test('HTTP origin guards, process lifecycle and captured output', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-dashboard-http-'));
  const workspace = path.join(temp, 'workspace');
  const project = path.join(workspace, 'demo');
  const binary = path.join(temp, 'fake-nono');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(binary, `#!/usr/bin/env node\nif(process.argv[2]==='ps'){console.log('[]');process.exit(0)}\nif(process.argv[2]==='--version'){console.log('test runtime');process.exit(0)}\nconsole.log(JSON.stringify(process.argv.slice(2)));\nprocess.on('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  const server = createDashboard({ workspace, stateDir: path.join(temp, 'state'), configDir: path.join(temp, 'config'), nono: binary, kilo: binary });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdown(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const body = JSON.stringify({ project, prompt: `$(touch ${path.join(project, 'should-not-exist')})`, model: 'kilo/test' });
  const request = (route, options = {}) => fetch(base + route, options);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/bootstrap`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  assert.equal((await request('/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ project: workspace, prompt: 'test', model: 'kilo/test' }) })).status, 400);
  const started = await request('/api/sessions', { method: 'POST', headers, body });
  assert.equal(started.status, 201);
  const session = await started.json();
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = await (await request(`/api/sessions/${session.id}`)).json();
    if (detail.output) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(detail.output, /touch/);
  await assert.rejects(fs.access(path.join(project, 'should-not-exist')));
  assert.equal((await request(`/api/sessions/${session.id}/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  for (let i = 0; i < 40; i++) {
    detail = await (await request(`/api/sessions/${session.id}`)).json();
    if (detail.status === 'stopped') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(detail.status, 'stopped');
  assert.equal((await request('/api/sessions/unknown/stop', { method: 'POST', headers, body: '{}' })).status, 404);
});
