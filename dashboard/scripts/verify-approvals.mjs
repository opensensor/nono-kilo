// Real nono sandbox, loopback fixtures only. Never calls a model provider.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server.mjs';
import { defaults, projectId } from '../lib/policy.mjs';

const preview = process.argv.includes('--preview');
const home = os.homedir(), workspace = path.join(home, 'opensensor');
const root = await fs.mkdtemp(path.join(workspace, '.nono-approvals-check-'));
const project = path.join(root, 'approval-demo'), stateDir = path.join(root, 'state'), configDir = path.join(home, '.config');
await fs.mkdir(project); await fs.mkdir(stateDir);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, count = 300) { for (let i = 0; i < count; i++) { if (await predicate()) return; await pause(50); } throw new Error(`Timed out: ${label}`); }
let dashboard, record, requests = 0; const profiles = [];
const upstream = http.createServer((_req, res) => { requests++; res.end('APPROVAL_UPSTREAM_PASS'); });
const second = http.createServer((_req, res) => { requests++; res.end('APPROVAL_UPSTREAM_PASS'); });
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
  const firstPort = upstream.address().port, secondPort = second.address().port;
  // Ambient nono CLI overrides must not defeat the managed approval policy.
  process.env.NONO_ALLOW_NET = '1'; process.env.NONO_UPSTREAM_PROXY = `127.0.0.1:${firstPort}`; process.env.NONO_UPSTREAM_BYPASS = '127.0.0.1';
  const binary = path.join(project, 'fixture-kilo');
  await fs.writeFile(binary, `#!/usr/bin/python3
import os, socket, http.client, urllib.parse, pathlib, json, time, base64, sys
if '--version' in sys.argv: print('local-approval-fixture'); sys.exit()
if 'models' in sys.argv: print('{}'); sys.exit()
while not pathlib.Path('targets.json').exists(): time.sleep(.02)
for port in json.loads(pathlib.Path('targets.json').read_text()):
 try: socket.create_connection(('127.0.0.1',port),.5)
 except PermissionError: pass
 else: raise AssertionError('Direct egress bypassed approval: '+str(port))
print('PASS direct network, approval gate and controller bypass blocked',flush=True)
proxy=urllib.parse.urlparse(os.environ['HTTP_PROXY'])
auth={'Proxy-Authorization':'Basic '+base64.b64encode((urllib.parse.unquote(proxy.username or '')+':'+urllib.parse.unquote(proxy.password or '')).encode()).decode()}
def tunnel(host,port,allowed=True):
 c=http.client.HTTPConnection(proxy.hostname,proxy.port,timeout=330)
 c.set_tunnel(host,port,headers=auth)
 try:
  c.request('GET','/'); r=c.getresponse(); data=r.read()
 except OSError:
  assert not allowed, 'Unexpected proxy denial'
 else: assert allowed and b'APPROVAL_UPSTREAM_PASS' in data
 finally: c.close()
tunnel('127.0.0.1',${firstPort}); print('PASS allow once',flush=True)
tunnel('127.0.0.1',${firstPort}); print('PASS allow session',flush=True)
tunnel('127.0.0.1',${firstPort}); print('PASS repeat connection',flush=True)
tunnel('localhost',${firstPort},False); tunnel('localhost',${firstPort},False); print('PASS denial remembered',flush=True)
c=http.client.HTTPConnection(proxy.hostname,proxy.port,timeout=330)
c.request('GET','http://127.0.0.1:${secondPort}/absolute',headers=auth); r=c.getresponse(); assert r.status==200 and b'APPROVAL_UPSTREAM_PASS' in r.read(); c.close()
print('PASS absolute HTTP uses approval gate',flush=True)
`, { mode: 0o700 });
  dashboard = createDashboard({ workspace, stateDir, configDir, kilo: binary });
  await new Promise(resolve => dashboard.listen(preview ? 4318 : 0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${dashboard.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' };
  const key = JSON.parse(await fs.readFile(path.join(stateDir, 'browser-access.json'))).key;
  const auth = await fetch(origin + '/api/auth', { method: 'POST', headers, body: JSON.stringify({ token: key }) }); headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (url, body) => { const res = await fetch(origin + url, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); const data = await res.json(); if (!res.ok) throw new Error(`${res.status}: ${data.error}`); return data; };
  await api('/api/projects', { path: project });
  const settings = defaults(); settings.network.mode = 'approval'; settings.storage = 'isolated'; settings.rollback.enabled = false;
  await api('/api/project-settings', { project, settings, revision: 0 });
  record = await api('/api/sessions', { project, model: 'fixture/local', prompt: 'Verify live network approvals with local test connections.', interactive: true, cols: 110, rows: 30 }); profiles.push(record.profileName);
  await fs.writeFile(path.join(project, 'targets.json'), JSON.stringify([firstPort, secondPort, dashboard.address().port, Number(record.policy.network.upstream_proxy.split(':')[1])]));
  const pending = async () => (await api(`/api/sessions/${record.id}/approvals`)).pending;
  await until(async () => (await pending()).length > 0, 'initial pending network request');
  assert.equal(requests, 0); assert.equal((await api(`/api/sessions/${record.id}?output=0`)).approvalWait, true);
  console.log('PASS real nono holds an unknown destination without contacting upstream; runtime clock pauses');
  if (preview) {
    await fs.writeFile('/tmp/opensensor-approvals-preview.json', JSON.stringify({ origin, stateDir, project, session: record.id }), { mode: 0o600 });
    console.log('Preview ready at http://localhost:4318; metadata /tmp/opensensor-approvals-preview.json');
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } else {
    const answer = async (decision, host, port) => {
      await until(async () => (await pending()).some(p => p.host === host && p.port === port), `request ${host}:${port}`);
      const request = (await pending()).find(p => p.host === host && p.port === port);
      // The decision API must not accept a web page or unauthenticated caller.
      const url = origin + `/api/sessions/${record.id}/approvals/${request.id}`;
      assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Cookie: '' }, body: JSON.stringify({ decision }) })).status, 401);
      assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: JSON.stringify({ decision }) })).status, 403);
      await api(`/api/sessions/${record.id}/approvals/${request.id}`, { decision });
    };
    await answer('allow-once', '127.0.0.1', firstPort);
    await answer('allow-session', '127.0.0.1', firstPort);
    await answer('deny', 'localhost', firstPort);
    await answer('allow-once', '127.0.0.1', secondPort);
    await until(async () => (await api(`/api/sessions/${record.id}?output=0`)).status === 'completed', 'fixture finishes');
    const detail = await api(`/api/sessions/${record.id}`);
    assert.match(detail.output, /PASS direct network, approval gate and controller bypass blocked/);
    assert.match(detail.output, /PASS denial remembered/); assert.match(detail.output, /PASS absolute HTTP uses approval gate/);
    assert.equal(requests, 4); assert.equal((await pending()).length, 0);
    console.log('PASS real CONNECT + absolute HTTP allow/deny, exact session grants, bypass rejection, API authentication and clean exit');
  }
} catch (error) {
  console.error(error.stack || error); process.exitCode = 1;
  if (record) console.error((await fs.readFile(path.join(stateDir, `${record.id}.log`), 'utf8').catch(() => '')).slice(-6500));
} finally {
  if (dashboard) await dashboard.shutdown();
  for (const s of [upstream, second]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  for (const name of profiles) await fs.unlink(path.join(configDir, 'nono/profiles', name + '.json')).catch(() => {});
  await fs.rm(path.join(home, '.local/share/opensensor-kilo-projects', projectId(project)), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
  if (preview) await fs.rm('/tmp/opensensor-approvals-preview.json', { force: true });
}
