import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicJSON, readJSON, RequestError } from './core.mjs';

const normalize = host => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
const matches = (host, rule) => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule;
const key = ({ host, port }) => `${host}:${port}`;
const reject = (socket, status = 403) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };

export function connectionTarget(authority) {
  // CONNECT authority only. URL paths, userinfo, ambiguous numeric IPs and
  // scoped IPv6 addresses must not change what an approval actually grants.
  if (typeof authority !== 'string' || authority.length > 300 || /[\s/@?#%\\]/.test(authority)) throw new Error('Invalid destination');
  const match = /^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(authority);
  if (!match) throw new Error('Invalid destination');
  const host = normalize(match[1]), port = Number(match[2]);
  if (!host || port < 1 || port > 65535 || host.includes('..') || (!net.isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) throw new Error('Invalid destination');
  const canonical = normalize(new URL(`http://${match[1]}:${port}`).hostname);
  if (canonical !== host) throw new Error('Ambiguous destination');
  return { host, port };
}

function forbiddenAddress(address) {
  const host = normalize(address);
  if (net.isIPv4(host)) { const [a, b] = host.split('.').map(Number); return a === 0 || a >= 224 || (a === 169 && b === 254); }
  if (net.isIPv6(host)) {
    if (host === '::' || /^ff/.test(host) || /^fe[89ab]/.test(host) || host === 'fd00:ec2::254') return true;
    if (host.startsWith('::ffff:')) {
      const suffix = host.slice(7);
      if (net.isIPv4(suffix)) return forbiddenAddress(suffix);
      const words = suffix.split(':').map(v => parseInt(v, 16));
      if (words.length === 2) return forbiddenAddress(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
    }
  }
  return false;
}

// This is an upstream CONNECT gate for nono, not a replacement for its sandbox.
// Only nono's proxy is reachable by the child. Every unknown host:port waits
// here before an upstream socket is opened; no request bodies are inspected.
export class NetworkApprovals {
  constructor({ stateDir, onChange = () => {}, audit = () => {}, protectedPorts = () => [], timeoutMs = 300000, resolve = lookup }) {
    Object.assign(this, { stateDir, onChange, audit, protectedPorts, timeoutMs, resolve });
    this.sessions = new Map(); this.closed = false;
  }
  historyPath(id) { return path.join(this.stateDir, `${id}.approvals.json`); }
  async open(id, settings) {
    if (this.closed) throw new Error('Approval service is closed');
    const session = { id, settings, pending: new Map(), rules: new Map(), history: [], sockets: new Set(), closed: false };
    const server = session.server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    server.maxConnections = 256; server.headersTimeout = 10000;
    server.on('connection', socket => { session.sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => session.sockets.delete(socket)); });
    server.on('clientError', (_error, socket) => reject(socket, 400));
    server.on('connect', (req, socket, head) => { this.connect(session, req, socket, head).catch(() => reject(socket, 502)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.sessions.set(id, session);
    return `127.0.0.1:${server.address().port}`;
  }
  snapshot(id) {
    const session = this.sessions.get(id);
    return { pending: session ? [...session.pending.values()].map(p => p.view) : [],
      history: session?.history || readJSON(this.historyPath(id), []) };
  }
  changed(session) { this.onChange(session.id, session.pending.size); }
  save(session, entry) {
    session.history.push(entry); if (session.history.length > 200) session.history.shift();
    atomicJSON(this.historyPath(session.id), session.history);
    this.audit('network.approval', { session: session.id, ...entry });
  }
  settle(session, pending, decision, reason, allow = false) {
    if (!session.pending.delete(pending.view.id)) return;
    clearTimeout(pending.timer); pending.cleanup();
    this.save(session, { ...pending.view, decision, reason, decidedAt: new Date().toISOString() });
    pending.resolve(allow); this.changed(session);
  }
  decide(sessionId, requestId, decision) {
    if (!['allow-once', 'allow-session', 'deny'].includes(decision)) throw new RequestError('Choose Allow once, Allow for session, or Deny.');
    const session = this.sessions.get(sessionId), pending = session?.pending.get(requestId);
    if (!pending || session.closed || pending.view.expiresAt <= new Date().toISOString()) throw new RequestError('This request has expired or already been answered.', 409);
    const target = key(pending.view);
    if (decision !== 'allow-once') session.rules.set(target, decision === 'allow-session');
    for (const item of [...session.pending.values()]) if (item === pending || (decision !== 'allow-once' && key(item.view) === target)) {
      this.settle(session, item, decision, decision === 'deny' ? 'Denied by you for this session.' : 'Approved by you.', decision !== 'deny');
    }
    return this.snapshot(sessionId);
  }
  async permission(session, target, socket) {
    if (session.settings.denyDomains.some(rule => matches(target.host, rule))) return false;
    const existing = session.rules.get(key(target)); if (existing !== undefined) return existing;
    if (session.settings.allowDomains.some(rule => matches(target.host, rule))) return true;
    if (session.pending.size >= 32) return false;
    return new Promise(resolve => {
      const now = Date.now(), id = randomUUID();
      const pending = { resolve, view: { id, ...target, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.timeoutMs).toISOString() } };
      const cancel = () => this.settle(session, pending, 'cancelled', 'The client closed its connection.');
      pending.cleanup = () => { socket.off('close', cancel); socket.off('end', cancel); };
      socket.once('close', cancel); socket.once('end', cancel);
      pending.timer = setTimeout(() => this.settle(session, pending, 'expired', 'No decision received before the approval deadline.'), this.timeoutMs);
      pending.timer.unref(); session.pending.set(id, pending); this.changed(session);
    });
  }
  async connect(session, req, socket, head) {
    // nono waits for the CONNECT response before sending payload. Keep the
    // read side flowing while approval is pending so a FIN cancels it promptly;
    // refuse premature data rather than buffering an unbounded request body.
    if (head.length) return reject(socket, 400);
    const premature = () => socket.destroy();
    socket.on('data', premature); socket.resume();
    const target = connectionTarget(req.url);
    // The gate cannot proxy into itself, another session's gate, or the
    // dashboard controller, even if a domain resolves there after approval.
    const reserved = new Set([...this.protectedPorts(), ...[...this.sessions.values()].map(s => s.server.address()?.port)]);
    if (session.closed || reserved.has(target.port) || target.host === 'metadata.google.internal' || forbiddenAddress(target.host)) return reject(socket);
    if (!await this.permission(session, target, socket) || session.closed || socket.destroyed) return reject(socket);
    socket.pause(); socket.off('data', premature);
    const addresses = await this.resolve(target.host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => forbiddenAddress(a.address))) return reject(socket);
    if (session.closed || socket.destroyed) return;
    // Connect to the already checked address, never re-resolve after checking.
    const upstream = net.connect({ host: target.host, port: target.port, autoSelectFamily: true,
      lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) });
    session.sockets.add(upstream); upstream.on('close', () => session.sockets.delete(upstream));
    const timer = setTimeout(() => upstream.destroy(new Error('Connection timed out')), 10000); timer.unref();
    socket.once('close', () => upstream.destroy());
    upstream.once('error', () => { clearTimeout(timer); reject(socket, 502); });
    upstream.once('connect', () => {
      clearTimeout(timer);
      if (session.closed || socket.destroyed) return upstream.destroy();
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket); socket.pipe(upstream); socket.resume();
    });
  }
  async closeSession(id) {
    const session = this.sessions.get(id); if (!session || session.closed) return;
    session.closed = true;
    for (const p of [...session.pending.values()]) this.settle(session, p, 'cancelled', 'The sandbox session ended.');
    for (const socket of session.sockets) socket.destroy();
    await new Promise(resolve => session.server.close(resolve)); this.sessions.delete(id);
  }
  async close() { this.closed = true; await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id))); }
}

export class SessionDeadline {
  constructor(durationMs, expire, changed = () => {}) {
    this.remaining = durationMs; this.expire = expire; this.changed = changed; this.paused = true; this.resume();
  }
  pause() {
    if (this.paused || this.ended) return;
    this.remaining = Math.max(0, this.remaining - (performance.now() - this.started));
    clearTimeout(this.timer); this.paused = true; this.changed(this);
  }
  resume() {
    if (!this.paused || this.ended) return;
    this.paused = false; this.started = performance.now();
    this.timer = setTimeout(() => { this.ended = true; this.expire(); }, this.remaining); this.timer.unref(); this.changed(this);
  }
  stop() { this.ended = true; clearTimeout(this.timer); }
}
