import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicJSON } from './core.mjs';

const active = r => ['starting', 'running', 'stopping'].includes(r.status);
const blank = () => ({ version: 1, events: [], destinations: [], samples: [], connections: [], totals: { allowed: 0, denied: 0, responses: 0, connections: 0 }, truncated: false });
const safe = (s, max = 180) => String(s || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
function host(value) {
  try { const u = new URL(value.includes('://') ? value : `https://${value}`); return { host: u.hostname, port: Number(u.port || (u.protocol === 'http:' ? 80 : 443)) }; } catch { return null; }
}
export function cleanNetworkEvent(event, source = 'audit') {
  const target = host(String(event.target || '')); if (!target || !/^[a-zA-Z0-9.:[\]_-]{1,253}$/.test(target.host)) return null;
  const decision = String(event.decision || '').toLowerCase();
  const kind = event.kind === 'response' ? 'response' : decision === 'allow' ? 'allow' : decision === 'deny' ? 'deny' : null; if (!kind) return null;
  const port = Number(event.port || target.port); if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const timestamp = Number(event.timestamp_unix_ms) || Date.parse(event.at); if (!Number.isFinite(timestamp)) return null;
  return { at: new Date(timestamp).toISOString(), source, kind, host: safe(target.host), port,
    method: /^[A-Z]{1,12}$/.test(event.method) ? event.method : '', mode: safe(event.mode, 30),
    status: Number.isInteger(Number(event.status)) && Number(event.status) >= 100 && Number(event.status) < 600 ? Number(event.status) : null };
}
export function parseProxyLine(line, routes = {}) {
  if (!/proxy request (allowed|denied)|l7 proxy response|l7 endpoint policy decision/.test(line)) return null;
  const field = name => { const value = line.match(new RegExp(`(?:^|\\s)${name}=("(?:[^"\\\\]|\\\\.)*"|[^\\s]+)`))?.[1]; if (!value?.startsWith('"')) return value; try { return JSON.parse(value); } catch { return ''; } };
  const target = field('target') || field('host');
  return cleanNetworkEvent({ at: line.match(/^\S+/)?.[0], target: routes[target] || target, port: field('port'), method: field('method'), mode: field('mode'),
    status: field('status'), decision: field('decision') || (/l7 proxy response/.test(line) ? 'allow' : ''), kind: /l7 proxy response/.test(line) ? 'response' : '' }, 'supervisor');
}
export function decodeAddress(hex, ipv6 = false) {
  if (!ipv6) return hex.match(/../g).reverse().map(p => parseInt(p, 16)).join('.');
  const bytes = hex.match(/.{8}/g).flatMap(word => word.match(/../g).reverse());
  return bytes.join('').match(/.{4}/g).map(p => parseInt(p, 16).toString(16)).join(':');
}
export function parseSocketTable(text, family, inodes) {
  const result = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const c = line.trim().split(/\s+/); if (!inodes.has(c[9])) continue;
    const [local, lp] = c[1].split(':'), [remote, rp] = c[2].split(':'); const port = parseInt(rp, 16); if (!port || c[3] === '0A') continue;
    result.push({ inode: c[9], host: decodeAddress(remote, family.endsWith('6')), port, localPort: parseInt(lp, 16),
      protocol: family.startsWith('udp') ? 'UDP' : 'TCP', state: { '01': 'Established', '02': 'Connecting', '03': 'Handshake', '08': 'Closing' }[c[3]] || 'Closing', process: inodes.get(c[9]) });
  }
  return result;
}
async function procInfo(pid) {
  try { const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8'), end = raw.lastIndexOf(')'), values = raw.slice(end + 2).split(' '); return { pid: Number(pid), ppid: Number(values[1]), start: values[19], name: safe(raw.slice(raw.indexOf('(') + 1, end), 48) }; } catch { return null; }
}
async function socketSample(pid, start) {
  const root = await procInfo(pid); if (!root || root.start !== start) return { connections: [], available: false };
  const entries = (await fs.readdir('/proc')).filter(p => /^\d+$/.test(p));
  const processes = (await Promise.all(entries.map(procInfo))).filter(Boolean), selected = new Set([pid]);
  for (let n = 0; n < 32; n++) { const before = selected.size; for (const p of processes) if (selected.has(p.ppid)) selected.add(p.pid); if (selected.size === before) break; }
  const inodes = new Map(); let readable = false;
  await Promise.all(processes.filter(p => selected.has(p.pid)).map(async p => {
    try { const names = await fs.readdir(`/proc/${p.pid}/fd`); readable = true;
      await Promise.all(names.map(async fd => { try { const link = await fs.readlink(`/proc/${p.pid}/fd/${fd}`), match = /^socket:\[(\d+)\]$/.exec(link); if (match) inodes.set(match[1], p.name); } catch {} }));
    } catch {}
  }));
  const tables = await Promise.all(['tcp', 'tcp6', 'udp', 'udp6'].map(async family => { try { return parseSocketTable(await fs.readFile(`/proc/${pid}/net/${family}`, 'utf8'), family, inodes); } catch { return []; } }));
  return { connections: tables.flat().slice(0, 500), available: readable };
}

export class NetworkMonitor {
  constructor(stateDir, home = os.homedir()) {
    this.stateDir = stateDir; this.auditRoot = path.join(process.env.XDG_STATE_HOME || path.join(home, '.local/state'), 'nono/audit'); this.streams = new Map(); this.closed = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), 2000); this.timer.unref();
  }
  logPath(id) { return path.join(this.stateDir, `${id}.network.log`); }
  snapshotPath(id) { return path.join(this.stateDir, `${id}.network.json`); }
  async track(record, pid) {
    const process = await procInfo(pid); if (!process || this.closed) return;
    this.streams.set(record.id, { record, pid, start: process.start, data: blank(), seen: new Set(), offset: 0, partial: '', lastSaved: 0 });
  }
  add(stream, event) {
    if (!event) return; const d = stream.data; d.events.push(event); if (d.events.length > 2000) { d.events.shift(); d.truncated = true; }
    d.totals[event.kind === 'allow' ? 'allowed' : event.kind === 'deny' ? 'denied' : 'responses']++;
    this.destination(d, event.host, event.port, event.kind, event.at);
  }
  destination(data, host, port, kind, at) {
    let entry = data.destinations.find(d => d.host === host && d.port === port);
    if (!entry) { if (data.destinations.length >= 200) { data.truncated = true; return; } data.destinations.push(entry = { host, port, allowed: 0, denied: 0, responses: 0, connections: 0, lastSeen: at }); }
    entry[kind === 'allow' ? 'allowed' : kind === 'deny' ? 'denied' : kind === 'response' ? 'responses' : 'connections']++; entry.lastSeen = at;
  }
  async ingest(stream) {
    let file;
    try {
      file = await fs.open(this.logPath(stream.record.id), 'r'); const { size } = await file.stat();
      if (size < stream.offset) { stream.offset = 0; stream.partial = ''; }
      if (size - stream.offset > 1024 * 1024) { stream.offset = size - 1024 * 1024; stream.partial = ''; stream.data.truncated = true; }
      const buffer = Buffer.alloc(Math.min(1024 * 1024, size - stream.offset)); const { bytesRead } = await file.read(buffer, 0, buffer.length, stream.offset); stream.offset += bytesRead;
      const lines = (stream.partial + buffer.subarray(0, bytesRead).toString()).split('\n'); stream.partial = lines.pop().slice(-8000);
      const routes = Object.fromEntries((stream.record.settings?.secrets || []).filter(s => s.mode === 'proxy').map(s => [s.route, s.upstream]));
      for (const line of lines) this.add(stream, parseProxyLine(line, routes));
      if (size > 8 * 1024 * 1024) { await fs.truncate(this.logPath(stream.record.id), 0); stream.offset = 0; stream.data.truncated = true; }
    } catch {} finally { await file?.close(); }
  }
  async tick() {
    if (this.busy || this.closed) return; this.busy = true;
    try { await Promise.all([...this.streams.values()].map(async stream => {
      await this.ingest(stream); const d = stream.data, at = new Date().toISOString();
      if (active(stream.record)) {
        const sample = await socketSample(stream.pid, stream.start); d.samplingAvailable = sample.available; d.connections = sample.connections;
        for (const c of sample.connections) if (!stream.seen.has(c.inode)) { stream.seen.add(c.inode); d.totals.connections++; this.destination(d, c.host, c.port, 'connection', at); }
        if (stream.seen.size > 10000) { stream.seen.clear(); d.truncated = true; }
        d.samples.push({ at, active: d.connections.length, allowed: d.totals.allowed, denied: d.totals.denied }); if (d.samples.length > 900) d.samples.shift();
      } else d.connections = [];
      d.updatedAt = at;
      if (Date.now() - stream.lastSaved > 10000 || !active(stream.record)) { atomicJSON(this.snapshotPath(stream.record.id), d); stream.lastSaved = Date.now(); }
      if (!active(stream.record)) this.streams.delete(stream.record.id);
    })); } finally { this.busy = false; }
  }
  async snapshot(record) {
    let data = this.streams.get(record.id)?.data;
    if (!data) {
      try { const raw = await fs.readFile(this.snapshotPath(record.id), 'utf8'); data = raw.length < 2 * 1024 * 1024 ? JSON.parse(raw) : blank(); } catch { data = blank(); }
      // Older sessions have no dashboard network trace. Use nono's own audit.
      if (!data.events.length && /^[a-f0-9]{16}$/.test(record.nonoId || '')) {
        let file;
        try {
          file = await fs.open(path.join(this.auditRoot, record.nonoId, 'audit-events.ndjson'), 'r'); const { size } = await file.stat(), offset = Math.max(0, size - 2 * 1024 * 1024), buffer = Buffer.alloc(size - offset); await file.read(buffer, 0, buffer.length, offset);
          const routes = Object.fromEntries((record.settings?.secrets || []).filter(s => s.mode === 'proxy').map(s => [s.route, s.upstream]));
          for (const line of buffer.toString().split('\n')) { try { const row = JSON.parse(line); if (row.event?.type === 'network') { const event = row.event.event; this.add({ data }, cleanNetworkEvent({ ...event, target: routes[event.target] || event.target })); } } catch {} }
        } catch {} finally { await file?.close(); }
      }
    }
    return { ...data, session: record.id, live: active(record), mode: record.settings?.network?.mode || 'unknown',
      coverage: { sockets: Boolean(data.samplingAvailable), proxy: Boolean(record.networkTrace || data.events.length), intervalMs: 2000, bodies: false },
      events: data.events.slice(-250).reverse(), destinations: data.destinations.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)) };
  }
  async close() { clearInterval(this.timer); this.closed = true; while (this.busy) await new Promise(resolve => setTimeout(resolve, 10)); for (const stream of this.streams.values()) { await this.ingest(stream); stream.data.connections = []; atomicJSON(this.snapshotPath(stream.record.id), stream.data); } this.streams.clear(); }
}
