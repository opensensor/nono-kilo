import { WebSocketServer, WebSocket } from 'ws';
import headless from '@xterm/headless';
import serialization from '@xterm/addon-serialize';
import { randomUUID } from 'node:crypto';
import { RequestError } from './core.mjs';

const { Terminal } = headless;
const { SerializeAddon } = serialization;
const HIGH = 1024 * 1024, LOW = 128 * 1024;
const active = status => ['starting', 'running', 'stopping'].includes(status);
export function terminalSize(cols = 110, rows = 30) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 5 || rows > 120) throw new RequestError('Terminal size must be 20–300 columns and 5–120 rows.');
  return { cols, rows };
}

export class TerminalHub {
  constructor({ getSession, loadArchive, saveScreen, audit }) {
    this.getSession = getSession; this.loadArchive = loadArchive; this.saveScreen = saveScreen; this.audit = audit;
    this.streams = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) { if (!ws.isAlive || !this.auth.check(ws.request)) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
    }, 20000); this.heartbeat.unref();
  }
  create(record, size = { cols: 110, rows: 30 }) {
    const terminal = new Terminal({ ...size, scrollback: 5000, allowProposedApi: true, convertEol: !record.interactive, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    // Terminal reports are generated once by the server emulator, including while detached.
    const stream = { record, terminal, serializer, mouseModes: new Set(), handlers: {}, clients: new Set(), controller: null, sequence: 0, pending: 0, paused: false, touched: Date.now() };
    // SerializeAddon restores mouse tracking, but omits coordinate encodings.
    // Observe parsed DEC modes so split output chunks and resets are handled.
    for (const final of ['h', 'l']) terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
      for (const mode of params) if ([1005, 1006, 1015, 1016].includes(mode)) {
        if (final === 'h') stream.mouseModes.add(mode); else stream.mouseModes.delete(mode);
      }
      return false;
    });
    terminal.parser.registerEscHandler({ final: 'c' }, () => { stream.mouseModes.clear(); return false; });
    terminal.onData(data => { try { if (active(record.status)) stream.handlers.write?.(data); } catch {} });
    this.streams.set(record.id, stream); return stream;
  }
  attachProcess(id, handlers) { const stream = this.streams.get(id); if (stream) stream.handlers = handlers; }
  write(id, data) {
    const stream = this.streams.get(id); if (!stream || !data) return;
    const bytes = Buffer.byteLength(data); stream.pending += bytes;
    if (stream.pending > HIGH && !stream.paused) { stream.paused = true; stream.handlers.pause?.(); }
    stream.terminal.write(data, () => {
      stream.pending -= bytes; stream.sequence++; stream.touched = Date.now();
      this.broadcast(stream, { type: 'output', sequence: stream.sequence, data });
      if (stream.paused && stream.pending < LOW) { stream.paused = false; stream.handlers.resume?.(); }
    });
  }
  status(id) { const stream = this.streams.get(id); if (stream) this.broadcast(stream, this.state(stream)); }
  finish(id) {
    const stream = this.streams.get(id); if (!stream) return;
    stream.controller = null; stream.handlers = {};
    stream.terminal.write('', () => {
      this.broadcast(stream, this.state(stream));
      this.saveScreen(id, { cols: stream.terminal.cols, rows: stream.terminal.rows, data: stream.serializer.serialize({ scrollback: 2500 }), mouseEncoding: this.mouseEncoding(stream) });
      this.trim();
    });
  }
  state(stream) { return { type: 'state', status: stream.record.status, interactive: Boolean(stream.record.interactive), controller: stream.controller?.clientId || null, viewers: stream.clients.size, cols: stream.terminal.cols, rows: stream.terminal.rows }; }
  mouseEncoding(stream) { return '\x1b[?1005;1006;1015;1016l' + [...stream.mouseModes].map(mode => `\x1b[?${mode}h`).join(''); }
  send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > HIGH || ws.unackedBytes > 2 * HIGH || ws.unacked?.length > 10000) { ws.close(1013, 'Viewer is behind; reconnect for a current screen.'); return; }
    if (message.type === 'output') { const bytes = Buffer.byteLength(message.data); ws.unacked.push({ sequence: message.sequence, bytes }); ws.unackedBytes += bytes; }
    ws.send(JSON.stringify(message));
  }
  broadcast(stream, message) { for (const ws of stream.clients) if (ws.ready) this.send(ws, message); }
  async streamFor(id) {
    let stream = this.streams.get(id); if (stream) return stream;
    const record = await this.getSession(id);
    const archive = await this.loadArchive(record);
    // Another client may have opened the same archive while disk reads were pending.
    stream = this.streams.get(id); if (stream) return stream;
    stream = this.create(record, { cols: archive.cols || 110, rows: archive.rows || 30 });
    await new Promise(resolve => stream.terminal.write((archive.data || '') + (archive.mouseEncoding || ''), resolve));
    return stream;
  }
  connect(server, auth) {
    this.auth = auth;
    server.on('upgrade', async (req, socket, head) => {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const reject = status => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
      if (!hosts.includes(req.headers.host) || !hosts.map(h => `http://${h}`).includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') return reject('403 Forbidden');
      if (!auth.check(req)) return reject('401 Unauthorized');
      const match = req.url?.match(/^\/api\/sessions\/([a-z0-9-]+)\/terminal$/);
      if (!match) return reject('404 Not Found');
      if (this.wss.clients.size >= 24) return reject('503 Service Unavailable');
      try {
        const stream = await this.streamFor(match[1]);
        if (socket.destroyed) return;
        this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws, req, stream));
      } catch { reject('404 Not Found'); }
    });
  }
  accept(ws, request, stream) {
    ws.request = request; ws.clientId = randomUUID(); ws.isAlive = true; ws.ready = false; ws.unacked = []; ws.unackedBytes = 0;
    let windowStart = Date.now(), inputBytes = 0;
    stream.clients.add(ws); stream.touched = Date.now();
    this.trim();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      stream.clients.delete(ws); if (stream.controller === ws) stream.controller = null;
      this.broadcast(stream, this.state(stream)); this.trim();
    });
    ws.on('message', raw => {
      try {
        if (!ws.ready || !this.auth.check(request)) return ws.close(1008, 'Authenticate again.');
        const message = JSON.parse(raw.toString());
        if (message.type === 'ping') return this.send(ws, { type: 'pong', at: message.at });
        if (message.type === 'ack') {
          if (!Number.isSafeInteger(message.sequence) || message.sequence > stream.sequence) throw new RequestError('Invalid stream acknowledgement.');
          let consumed = 0; for (const entry of ws.unacked) { if (entry.sequence > message.sequence) break; ws.unackedBytes -= entry.bytes; consumed++; }
          ws.unacked.splice(0, consumed); return;
        }
        if (message.type === 'control') {
          if (!stream.record.interactive || !active(stream.record.status) || !stream.handlers.write) throw new RequestError('This session is read-only.');
          if (!stream.controller || stream.controller === ws || message.takeover === true) { stream.controller = ws; this.audit('terminal.control', { session: stream.record.id }); }
          this.broadcast(stream, this.state(stream)); return;
        }
        if (message.type === 'release') { if (stream.controller === ws) stream.controller = null; this.broadcast(stream, this.state(stream)); return; }
        if (stream.controller !== ws || !active(stream.record.status)) throw new RequestError('Take terminal control before sending input.');
        if (message.type === 'resize') {
          const { cols, rows } = terminalSize(message.cols, message.rows);
          stream.handlers.resize(cols, rows); stream.terminal.resize(cols, rows); this.broadcast(stream, this.state(stream)); return;
        }
        if (message.type === 'input') {
          if (typeof message.data !== 'string' || message.data.length > 32768 || !['utf8', 'base64', undefined].includes(message.encoding)) throw new RequestError('Input is too large. Paste in smaller chunks.');
          const data = message.encoding === 'base64' ? Buffer.from(message.data, 'base64') : message.data;
          if (Date.now() - windowStart > 1000) { windowStart = Date.now(); inputBytes = 0; }
          inputBytes += Buffer.byteLength(data); if (inputBytes > 256 * 1024) throw new RequestError('Terminal input is arriving too quickly.');
          stream.handlers.write(data); return;
        }
        throw new RequestError('Unknown terminal action.');
      } catch (error) { this.send(ws, { type: 'error', message: error.status ? error.message : 'Terminal action failed.' }); }
    });
    stream.terminal.write('', () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.send(ws, { ...this.state(stream), type: 'snapshot', clientId: ws.clientId, sequence: stream.sequence, data: stream.serializer.serialize({ scrollback: 2500 }), mouseEncoding: this.mouseEncoding(stream) });
      ws.ready = true; this.broadcast(stream, this.state(stream));
    });
  }
  trim() {
    if (this.streams.size <= 8) return;
    const idle = [...this.streams.entries()].filter(([, s]) => !active(s.record.status) && !s.clients.size && !s.pending).sort((a, b) => a[1].touched - b[1].touched);
    while (this.streams.size > 8 && idle.length) { const [id, s] = idle.shift(); s.terminal.dispose(); this.streams.delete(id); }
  }
  close() {
    clearInterval(this.heartbeat); for (const ws of this.wss.clients) ws.terminate(); this.wss.close();
    for (const stream of this.streams.values()) stream.terminal.dispose(); this.streams.clear();
  }
  async flush() { await Promise.all([...this.streams.values()].map(s => new Promise(resolve => s.terminal.write('', resolve)))); }
}
