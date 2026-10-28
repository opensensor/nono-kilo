import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { NetworkApprovals, SessionDeadline, connectionTarget } from '../lib/network-approvals.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(10); } throw new Error('Condition timed out'); }
async function fixture(t, extra = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nono-approvals-')); let connections = 0;
  const upstream = net.createServer(socket => { connections++; socket.end('LOCAL_FIXTURE'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const broker = new NetworkApprovals({ stateDir, timeoutMs: 1000, resolve: async () => [{ address: '127.0.0.1', family: 4 }], ...extra });
  const address = await broker.open('session-a', { allowDomains: ['known.example'], denyDomains: ['denied.example', '*.blocked.example'] });
  const sockets = [];
  const connect = (host = 'new.example', port = upstream.address().port, gate = address) => {
    const socket = net.connect(Number(gate.split(':')[1]), '127.0.0.1'); sockets.push(socket);
    const result = new Promise((resolve, reject) => { let data = ''; socket.on('data', b => data += b); socket.on('end', () => resolve(data)); socket.on('error', reject); });
    socket.on('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    return { socket, result };
  };
  t.after(async () => { for (const s of sockets) s.destroy(); await broker.close(); await new Promise(resolve => upstream.close(resolve)); await fs.rm(stateDir, { recursive: true, force: true }); });
  return { broker, address, connect, connections: () => connections, port: upstream.address().port };
}

test('network approvals hold connections, scope grants to exact host and port, and remember denials', async t => {
  const f = await fixture(t);
  const first = f.connect(); await until(() => f.broker.snapshot('session-a').pending.length === 1);
  assert.equal(f.connections(), 0);
  const pending = f.broker.snapshot('session-a').pending[0];
  assert.throws(() => f.broker.decide('wrong-session', pending.id, 'allow-session'), /already been answered/);
  f.broker.decide('session-a', pending.id, 'allow-once'); assert.match(await first.result, /200 Connection Established[\s\S]*LOCAL_FIXTURE/);
  assert.throws(() => f.broker.decide('session-a', pending.id, 'allow-once'), /already been answered/);
  const second = f.connect(); await until(() => f.broker.snapshot('session-a').pending.length === 1);
  f.broker.decide('session-a', f.broker.snapshot('session-a').pending[0].id, 'allow-session'); await second.result;
  assert.match(await f.connect().result, /200 Connection/);
  const otherPort = f.connect('new.example', f.port === 65535 ? 65534 : f.port + 1);
  await until(() => f.broker.snapshot('session-a').pending.length === 1);
  f.broker.decide('session-a', f.broker.snapshot('session-a').pending[0].id, 'deny'); assert.match(await otherPort.result, /403 Denied/);
  assert.match(await f.connect('new.example', f.port === 65535 ? 65534 : f.port + 1).result, /403 Denied/);
  assert.match(await f.connect('denied.example').result, /403 Denied/);
  assert.match(await f.connect('nested.blocked.example').result, /403 Denied/);
  assert.equal(f.connections(), 3);
  assert.match(await f.connect('known.example').result, /200 Connection/);
});

test('expiry, disconnect, session stop and controller endpoints fail closed', async t => {
  const f = await fixture(t, { timeoutMs: 80, protectedPorts: () => [4317] });
  const expired = f.connect(); await until(() => f.broker.snapshot('session-a').pending.length === 1);
  const stale = f.broker.snapshot('session-a').pending[0];
  assert.match(await expired.result, /403/); assert.equal(f.broker.snapshot('session-a').history.at(-1).decision, 'expired');
  assert.throws(() => f.broker.decide('session-a', stale.id, 'allow-once'), /already been answered/);
  assert.match(await f.connect('localhost', 4317).result, /403/);
  assert.match(await f.connect('169.254.169.254').result, /403/);
  assert.match(await f.connect('new.example', Number(f.address.split(':')[1])).result, /403/);
  const cancelled = f.connect(); await until(() => f.broker.snapshot('session-a').pending.length === 1);
  cancelled.socket.destroy(); await until(() => f.broker.snapshot('session-a').pending.length === 0);
  assert.equal(f.broker.snapshot('session-a').history.at(-1).decision, 'cancelled');
  const stopped = f.connect(); await until(() => f.broker.snapshot('session-a').pending.length === 1);
  await f.broker.closeSession('session-a'); stopped.socket.destroy();
  assert.equal(f.broker.snapshot('session-a').pending.length, 0); assert.equal(f.connections(), 0);
});

test('approval targets reject ambiguous authority and resolved metadata', async t => {
  for (const authority of ['user@example.com:443', 'example.com:443/path', 'example.com:0', '127.1:80', '0x7f000001:80', '[fe80::1%eth0]:443', 'localhost:65536']) assert.throws(() => connectionTarget(authority));
  assert.deepEqual(connectionTarget('EXAMPLE.com.:443'), { host: 'example.com', port: 443 });
  const f = await fixture(t, { resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
  assert.match(await f.connect('known.example').result, /403/); assert.equal(f.connections(), 0);
});

test('approved DNS addresses support IPv6 to IPv4 fallback without another lookup', async t => {
  let lookups = 0;
  const f = await fixture(t, { resolve: async () => { lookups++; return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]; } });
  assert.match(await f.connect('known.example').result, /200 Connection/);
  assert.equal(lookups, 1); assert.equal(f.connections(), 1);
});

test('runtime deadline excludes time spent waiting for a decision', async t => {
  let expired = false; const timer = new SessionDeadline(120, () => expired = true); t.after(() => timer.stop());
  await pause(20); timer.pause(); await pause(160); assert.equal(expired, false);
  timer.resume(); await until(() => expired); assert.equal(timer.ended, true);
});
