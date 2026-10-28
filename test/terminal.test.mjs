import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createDashboard, buildRunArgs } from '../server.mjs';
import { RedactingStream, redactionValues } from '../lib/redaction.mjs';
import { readModelCatalog, createModelCatalog } from '../lib/models.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'Timed out') { for (let i = 0; i < 150; i++) { const result = await predicate(); if (result) return result; await delay(20); } throw new Error(message); }

test('interactive prompts stay literal; masking emits prompts immediately and preserves split UTF-8', () => {
  const args = buildRunArgs({ name: 'fixture', interactive: true, prompt: '--help $(id)', model: 'local/demo' }, 'kilo');
  assert.equal(args.at(-1), '--prompt=--help $(id)'); assert.equal(args.includes('run', args.indexOf('kilo')), false);
  assert.ok(buildRunArgs({ name: 'fixture', interactive: true, model: 'local/demo' }, 'kilo').includes('--pure'));
  const secret = 'A🦆long-secret'; const input = Buffer.from('ready> '+secret+' done 🌍');
  for (let split = 0; split < input.length; split++) {
    let output = ''; const stream = new RedactingStream(redactionValues([secret]), text => { output += text; });
    stream.push('type here> '); assert.equal(output, 'type here> ');
    stream.push(input.subarray(0, split)); stream.push(input.subarray(split)); stream.end();
    assert.equal(output, 'type here> ready> [REDACTED] done 🌍');
  }
});

test('model catalog merges active JSONC files and exposes only display metadata', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-models-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, 'kilo'));
  await fs.writeFile(path.join(temp, 'kilo/config.json'), JSON.stringify({ model: 'local/a', provider: { local: { name: 'Local', options: { apiKey: 'never-return-this' }, models: { a: { name: 'Before', limit: { context: 10000 } }, b: { name: 'Second' } } } } }));
  await fs.writeFile(path.join(temp, 'kilo/kilo.jsonc'), '{// comments and trailing comma\n"model":"local/a","provider":{"local":{"name":"Local","models":{"a":{"name":"After","options":{"apiKey":"{file:/never-read}"}},},},},}');
  await fs.writeFile(path.join(temp, 'kilo/kilo.jsonc.backup'), '{"provider":{"stale":{"models":{"old":{}}}}}');
  let catalog = await readModelCatalog(temp); assert.equal(catalog.models.length, 2); assert.equal(catalog.models[0].name, 'After'); assert.equal(catalog.models[0].context, 10000);
  assert.equal(JSON.stringify(catalog).includes('apiKey'), false); assert.equal(JSON.stringify(catalog).includes('never'), false);
  await fs.writeFile(path.join(temp, 'kilo/kilo.jsonc'), '{bad'); catalog = await readModelCatalog(temp); assert.equal(catalog.warnings.length, 1); assert.equal(catalog.models.length, 2);
});

test('gateway models merge with configured models, refresh and survive offline restarts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-gateway-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'kilo')); await fs.writeFile(path.join(root, 'kilo/config.json'), JSON.stringify({ provider: { kilo: { models: { 'vendor/model': { name: 'Configured display name' } } }, local: { models: { custom: {} } } } }));
  let calls = 0, fail = false;
  const execute = async (_command, args) => { calls++; assert.ok(args.includes('--pure')); if (fail) throw new Error('offline'); return { stdout: 'Unrelated log\nkilo/vendor/model\nkilo/vendor/model:free\nkilo/~vendor/latest\nnot-a-model secret\n' }; };
  const options = { configDir: root, stateDir: root, kilo: 'kilo', execute, cwd: root }, catalog = createModelCatalog(options);
  let first = await catalog(); assert.equal(first.models.length, 4); assert.equal(first.gatewayCount, 3); assert.equal(first.models.find(m => m.id === 'kilo/vendor/model').name, 'Configured display name');
  await catalog(); assert.equal(calls, 1);
  fail = true; first = await catalog({ force: true }); assert.equal(first.gatewayCount, 3); assert.match(first.warnings[0], /last saved/);
  const restored = await createModelCatalog(options)(); assert.equal(restored.gatewayCount, 3); assert.equal(calls, 2);
});

test('authenticated PTY streams support input, ownership, resize, reconnect and persisted screens', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-pty-')), workspace = path.join(root, 'workspace'), project = path.join(root, 'drive/project');
  await fs.mkdir(workspace); await fs.mkdir(project, { recursive: true }); const stateDir = path.join(root, 'state'), binary = path.join(root, 'fixture');
  await fs.writeFile(binary, `#!/usr/bin/env node
if(process.argv[2]==='ps'){console.log('[]');process.exit(0)}
if(['--version','profile'].includes(process.argv[2])){console.log('fixture');process.exit(0)}
process.stdin.setRawMode(true);process.stdin.resume();
process.stdout.write('\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h\\x1b[2J\\x1b[HREADY '+process.stdin.isTTY+' '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n');
process.stdout.on('resize',()=>process.stdout.write('SIZE '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
process.stdin.on('data',d=>{process.stdout.write('INPUT '+JSON.stringify(d.toString())+'\\r\\n');if(d.toString()==='quit')process.exit(0)});
process.on('SIGTERM',()=>process.exit(0));
`, { mode: 0o700 });
  const server = createDashboard({ workspace, stateDir, configDir: path.join(root, 'config'), home: root, nono: binary, kilo: binary });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = []; t.after(async () => { for (const ws of sockets) ws.terminate(); await server.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { Origin: origin, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const key = JSON.parse(await fs.readFile(path.join(stateDir, 'browser-access.json'))).key;
  const auth = await fetch(origin+'/api/auth', { method: 'POST', headers, body: JSON.stringify({ token: key }) }); headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (url, body) => { const res = await fetch(origin+url, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); assert.ok(res.ok, await res.clone().text()); return res.json(); };
  assert.equal((await api('/api/projects', { path: project }))[0].external, true);
  const record = await api('/api/sessions', { project, interactive: true, model: 'local/demo', cols: 90, rows: 25 });
  const url = origin.replace('http:', 'ws:')+`/api/sessions/${record.id}/terminal`;
  async function rejected(head, code) { await new Promise((resolve, reject) => { const ws = new WebSocket(url, { headers: head }); ws.on('open', () => reject(new Error('Unexpected connection'))); ws.on('error', () => {}); ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, code); res.resume(); ws.terminate(); resolve(); }); }); }
  await rejected({ Origin: origin }, 401); await rejected({ ...headers, Origin: 'https://other.invalid' }, 403);
  async function connect() {
    const ws = new WebSocket(url, { headers }); sockets.push(ws); const frames = [];
    ws.on('message', raw => { const frame = JSON.parse(raw); frames.push(frame); if (['snapshot', 'output'].includes(frame.type)) ws.send(JSON.stringify({ type: 'ack', sequence: frame.sequence })); });
    const snapshot = await until(() => frames.find(f => f.type === 'snapshot')); return { ws, frames, snapshot, send: obj => ws.send(JSON.stringify(obj)) };
  }
  const a = await connect(); await until(() => JSON.stringify(a.frames).includes('READY true 90x25'));
  a.send({ type: 'control' }); await until(() => a.frames.some(f => f.type === 'state' && f.controller === a.snapshot.clientId));
  a.send({ type: 'input', data: 'hello ∑\r' }); await until(() => JSON.stringify(a.frames).includes('hello ∑'));
  const b = await connect(); assert.match(b.snapshot.data, /hello ∑/); assert.match(b.snapshot.data, /\x1b\[\?1049h/); assert.match(b.snapshot.mouseEncoding, /\x1b\[\?1006h/);
  b.send({ type: 'input', data: 'forbidden-input' }); await until(() => b.frames.some(f => f.type === 'error'));
  a.send({ type: 'resize', cols: 130, rows: 36 }); await until(() => JSON.stringify(a.frames).includes('SIZE 130x36'));
  b.send({ type: 'control', takeover: true }); await until(() => a.frames.some(f => f.type === 'state' && f.controller === b.snapshot.clientId));
  a.send({ type: 'input', data: 'old-owner-input' }); await until(() => a.frames.some(f => f.type === 'error'));
  b.send({ type: 'input', data: 'steering works' }); await until(() => JSON.stringify(b.frames).includes('steering works'));
  b.ws.close(); await until(() => a.frames.at(-1)?.type === 'state' && a.frames.at(-1).controller === null);
  const c = await connect(); assert.match(c.snapshot.data, /steering works/); assert.equal(c.snapshot.cols, 130);
  await api(`/api/sessions/${record.id}/stop`, {}); await until(async () => (await api(`/api/sessions/${record.id}?output=0`)).status === 'stopped');
  const disk = await until(async () => { try { return await fs.readFile(path.join(stateDir, `${record.id}.screen.json`), 'utf8'); } catch {} }); assert.match(disk, /steering works/);
  const log = await (await fetch(origin+`/api/sessions/${record.id}/log`, { headers })).text(); assert.match(log, /hello ∑/); assert.doesNotMatch(log, /forbidden-input|old-owner-input/);
  c.send({ type: 'control' }); await until(() => c.frames.some(f => f.type === 'error' && /read-only/.test(f.message)));
});
