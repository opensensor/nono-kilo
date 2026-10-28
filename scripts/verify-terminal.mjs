// Real Kilo TUI + nono + a local fixture model. No external model requests.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import headless from '@xterm/headless';
import { createDashboard } from '../server.mjs';
import { createSecretStore } from '../lib/secrets.mjs';
import { defaults, projectId } from '../lib/policy.mjs';

const preview = process.argv.includes('--preview'), home = os.homedir(), workspace = path.join(home, 'opensensor');
const root = await fs.mkdtemp(path.join(workspace, '.nono-terminal-check-'));
const project = path.join(root, 'terminal-demo'), stateDir = path.join(root, 'state'), configDir = path.join(home, '.config');
await fs.mkdir(project); await fs.mkdir(stateDir); await fs.writeFile(path.join(project, 'README.txt'), 'Disposable terminal verification project. No private repository data.\n');
const keyring = createSecretStore(stateDir), value = randomBytes(24).toString('hex');
let secret, dashboard, upstream, ws, record, clientTerm; const profiles = []; const requests = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, count = 450) { for (let i = 0; i < count; i++) { if (await predicate()) return; await pause(100); } throw new Error(`Timed out: ${label}`); }
try {
  secret = await keyring.save({ name: 'Temporary terminal verification fixture', value });
  upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.headers.authorization !== `Bearer ${value}`) { res.writeHead(401); return res.end('Fixture credential missing'); }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let data; try { data = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    requests.push(data);
    const latest = data.messages?.filter(m => m.role === 'user').at(-1)?.content;
    const content = typeof latest === 'string' ? latest : latest?.filter(c => c.type === 'text').map(c => c.text).join(' ') || '';
    const reply = `TERMINAL_STREAM_PASS — local model received: ${content.slice(0, 300)}. You can send another instruction below.`;
    if (!data.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'demo', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(chunk({ role: 'assistant' }));
    for (const word of reply.split(' ')) { if (res.destroyed) break; res.write(chunk({ content: word + ' ' })); await pause(25); }
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  dashboard = createDashboard({ workspace, stateDir, configDir, kilo: path.join(path.dirname(process.execPath), 'kilo') });
  await new Promise(resolve => dashboard.listen(preview ? 4318 : 0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${dashboard.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const key = JSON.parse(await fs.readFile(path.join(stateDir, 'browser-access.json'))).key;
  const auth = await fetch(origin+'/api/auth', { method: 'POST', headers, body: JSON.stringify({ token: key }) }); headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (url, body) => { const res = await fetch(origin+url, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); const data = await res.json(); if (!res.ok) throw new Error(`${res.status}: ${data.error}`); return data; };
  await api('/api/projects', { path: project });
  const s = defaults(); s.storage = 'isolated'; s.projectAccess = 'read'; s.network.mode = 'restricted'; s.rollback.enabled = false; s.limits.timeoutMinutes = 30;
  s.defaultModel = 'terminalfixture/demo';
  s.provider = { ...s.provider, enabled: true, id: 'terminalfixture', model: 'demo', proxyRoute: 'terminalfixture' };
  s.secrets = [{ secretId: secret.id, mode: 'proxy', env: 'TERMINAL_FIXTURE_KEY', route: 'terminalfixture', upstream: `http://127.0.0.1:${upstream.address().port}/v1`, header: 'Authorization', format: 'Bearer {}', endpoints: [{ method: 'POST', path: '/chat/completions' }] }];
  await api('/api/project-settings', { project, settings: s, revision: 0 });
  record = await api('/api/sessions', { project, model: s.defaultModel, prompt: 'Verify live terminal output.', interactive: true, cols: 110, rows: 32 }); profiles.push(record.profileName);
  clientTerm = new headless.Terminal({ cols: 110, rows: 32, allowProposedApi: true });
  const screen = () => { const b = clientTerm.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) || '').join('\n'); };
  const frames = []; ws = new WebSocket(origin.replace('http:', 'ws:')+`/api/sessions/${record.id}/terminal`, { headers });
  ws.on('message', raw => {
    const frame = JSON.parse(raw); frames.push(frame);
    if (['snapshot', 'output'].includes(frame.type)) { if (frame.type === 'snapshot') clientTerm.resize(frame.cols, frame.rows); clientTerm.write(frame.data, () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', sequence: frame.sequence })); }); }
  });
  await until(() => frames.some(f => f.type === 'snapshot'), 'initial screen');
  await until(() => screen().includes('TERMINAL_STREAM_PASS'), 'real Kilo output');
  console.log('PASS real Kilo interactive TUI runs through nono and a credential proxy');
  ws.send(JSON.stringify({ type: 'control' })); const clientId = frames.find(f => f.type === 'snapshot').clientId;
  await until(() => frames.some(f => f.type === 'state' && f.controller === clientId), 'terminal control');
  await pause(700); ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~SECOND_STEERING_CHECK\x1b[201~' })); await pause(100); ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  await until(() => requests.some(r => JSON.stringify(r.messages?.filter(m => m.role === 'user')).includes('SECOND_STEERING_CHECK')), 'second instruction reaches local model');
  await until(() => screen().includes('SECOND_STEERING_CHECK'), 'second instruction appears in terminal');
  console.log('PASS live steering reaches a second model turn without restarting the sandbox');
  const log = await fs.readFile(path.join(stateDir, `${record.id}.log`), 'utf8'); assert.equal(log.includes(value), false);
  ws.close(); clientTerm.dispose(); clientTerm = null;
  if (preview) {
    await fs.writeFile('/tmp/opensensor-terminal-preview.json', JSON.stringify({ origin, stateDir, project, session: record.id }), { mode: 0o600 });
    console.log(`Preview ready at ${origin}; metadata /tmp/opensensor-terminal-preview.json`);
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } else {
    await api(`/api/sessions/${record.id}/stop`, {});
    await until(async () => (await api(`/api/sessions/${record.id}?output=0`)).status === 'stopped', 'PTY sandbox stops');
    console.log('PASS stopping the terminal ends its sandbox');
  }
} catch (error) {
  console.error(String(error.stack || error).replaceAll(value, '[REDACTED]')); process.exitCode = 1;
  if (record) { const log = await fs.readFile(path.join(stateDir, `${record.id}.log`), 'utf8').catch(() => ''); console.error(log.slice(-5000).replaceAll(value, '[REDACTED]')); }
} finally {
  ws?.terminate(); clientTerm?.dispose(); if (dashboard) await dashboard.shutdown();
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  if (secret) await keyring.remove(secret.id);
  for (const name of profiles) await fs.unlink(path.join(configDir, 'nono/profiles', name+'.json')).catch(() => {});
  await fs.rm(path.join(home, '.local/share/opensensor-kilo-projects', projectId(project)), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
  if (preview) await fs.rm('/tmp/opensensor-terminal-preview.json', { force: true });
}
