/* A real terminal: output is streamed over a same-origin authenticated WebSocket.
   Input is never queued across disconnects or separately logged. Process echoes
   remain part of the masked output transcript. */
window.LiveTerminal = class LiveTerminal {
  constructor({ notice, onState }) {
    this.$ = id => document.getElementById(id); this.notice = notice; this.onState = onState;
    this.generation = 0; this.fontSize = Math.max(11, Math.min(22, Number(localStorage.getItem('opensensor.terminal.font')) || 14));
    this.$('terminal-reconnect').onclick = () => this.connect(this.id);
    this.$('terminal-control').onclick = () => this.send({ type: 'control', takeover: true });
    this.$('terminal-release').onclick = () => this.send({ type: 'release' });
    this.$('terminal-escape').onclick = () => { this.input('\x1b'); this.term?.focus(); };
    this.$('terminal-interrupt').onclick = () => { this.input('\x03'); this.term?.focus(); };
    this.$('terminal-copy').onclick = () => this.copy();
    this.$('terminal-select').onclick = () => this.openCopy();
    this.$('copy-terminal-text').onclick = () => this.copy(this.$('terminal-copy-text').value);
    this.$('terminal-focus').onclick = () => this.focusView(!document.body.classList.contains('terminal-focus'));
    this.focusView(localStorage.getItem('opensensor.terminal.focus') === 'true');
    this.$('terminal-paste').onclick = async () => { if (!this.controls) return; try { const text = await navigator.clipboard.readText(); if (text.length > 24000) throw new Error('Paste at most 24,000 characters at a time.'); this.term.paste(text); this.term.focus(); } catch (error) { this.notice(error.message || 'Use your browser’s paste shortcut.', true); } };
    this.$('terminal-smaller').onclick = () => this.zoom(-1); this.$('terminal-larger').onclick = () => this.zoom(1);
    this.$('terminal-bottom').onclick = () => this.term?.scrollToBottom();
    this.$('terminal-fullscreen').onclick = async () => {
      const panel = this.$('output-panel');
      if (panel.classList.contains('expanded')) { panel.classList.remove('expanded'); document.body.classList.remove('terminal-expanded'); }
      else if (document.fullscreenElement) await document.exitFullscreen();
      else { try { await panel.requestFullscreen(); } catch { panel.classList.add('expanded'); document.body.classList.add('terminal-expanded'); } }
      this.fullscreenLabel(); this.fit();
    };
    document.addEventListener('fullscreenchange', () => { this.fullscreenLabel(); this.fit(); });
    this.$('terminal-stop').onclick = () => this.$('stop-session').click();
    this.$('terminal-search').oninput = () => this.find(false, true);
    this.$('terminal-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.find(event.shiftKey); } };
    this.$('terminal-next').onclick = () => this.find(false); this.$('terminal-previous').onclick = () => this.find(true);
    this.$('steering-form').onsubmit = event => { event.preventDefault(); this.steer(); };
    this.$('steering-input').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.steer(); } };
    this.observer = new ResizeObserver(() => this.fit()); this.observer.observe(this.$('terminal-surface'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.fit(); });
  }
  createTerminal(generation) {
    this.term?.dispose(); this.$('terminal-surface').replaceChildren();
    const openLink = (_event, uri) => { try { const url = new URL(uri); if (['http:', 'https:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer'); } catch {} };
    const term = this.term = new Terminal({ cols: 110, rows: 30, cursorBlink: true, cursorStyle: 'bar', fontSize: this.fontSize,
      fontFamily: '"Cascadia Code", "SFMono-Regular", "Liberation Mono", monospace', lineHeight: 1.15, scrollback: 5000,
      allowProposedApi: true, screenReaderMode: true, scrollOnUserInput: true, linkHandler: { activate: openLink },
      theme: { background: '#12231d', foreground: '#d2e3d7', cursor: '#a8e8ba', selectionBackground: '#456c54', black: '#14271e', red: '#ed8c87', green: '#9cd5a2', yellow: '#e8d497', blue: '#95b7df', magenta: '#c9add9', cyan: '#8bd5cf', white: '#dceade', brightBlack: '#728a7b', brightWhite: '#ffffff' } });
    this.fitter = new FitAddon.FitAddon(); term.loadAddon(this.fitter);
    this.search = new SearchAddon.SearchAddon(); term.loadAddon(this.search);
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => { this.$('terminal-matches').textContent = this.$('terminal-search').value ? `${resultIndex + 1} / ${resultCount}` : ''; });
    term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink));
    term.open(this.$('terminal-surface'));
    this.$('terminal-renderer').textContent = 'DOM renderer';
    try { const webgl = new WebglAddon.WebglAddon(); term.loadAddon(webgl); webgl.onContextLoss(() => { webgl.dispose(); this.$('terminal-renderer').textContent = 'DOM renderer'; }); this.$('terminal-renderer').textContent = 'WebGL'; } catch { /* The accessible DOM renderer remains available. */ }
    // The server emulator answers terminal reports once, including when no browser is attached.
    // No remote clipboard writes, window operations, or automatic browser navigation.
    term.parser.registerOscHandler(52, () => true);
    for (const identifier of [{ final: 'n' }, { prefix: '?', final: 'n' }, { final: 'c' }, { prefix: '>', final: 'c' }, { final: 't' }]) term.parser.registerCsiHandler(identifier, () => true);
    for (const code of [10, 11, 12]) term.parser.registerOscHandler(code, data => data === '?');
    term.onData(data => { if (generation === this.generation && !this.report(data)) this.input(data); });
    term.onBinary(data => { if (generation === this.generation && this.controls) this.send({ type: 'input', encoding: 'base64', data: btoa(data) }); });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyF') { this.$('terminal-search').focus(); return false; }
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) { event.preventDefault(); this.copy(); return false; }
      return true;
    });
    this.$('terminal-surface').oncopy = event => { const text = term.getSelection(); if (text) { event.clipboardData?.setData('text/plain', text); event.preventDefault(); } };
  }
  report(data) { return /^\x1b\[[?>=]?[\d;:]*[cnR]$/.test(data) || /^\x1b\](?:10|11|12);/.test(data) || /^\x1bP[>01]/.test(data); }
  fullscreenLabel() { this.$('terminal-fullscreen').textContent = document.fullscreenElement || this.$('output-panel').classList.contains('expanded') ? '⛶ Exit full screen' : '⛶ Full screen'; }
  focusView(enabled) { document.body.classList.toggle('terminal-focus', enabled); localStorage.setItem('opensensor.terminal.focus', enabled); this.$('terminal-focus').textContent = enabled ? '↙ Exit focus view' : '↗ Focus view'; this.$('terminal-focus').setAttribute('aria-pressed', String(enabled)); this.fit(); }
  screenText(scrollback = false) {
    if (!this.term) return ''; const buffer = this.term.buffer.active, start = scrollback ? 0 : buffer.viewportY, end = scrollback ? buffer.length : Math.min(buffer.length, start + this.term.rows);
    return Array.from({ length: end - start }, (_, i) => (buffer.getLine(start + i)?.translateToString(true, 0, this.term.cols) || '')).join('\n').trimEnd();
  }
  openCopy(value = this.term?.getSelection() || this.screenText(true)) {
    this.$('terminal-copy-text').value = value; if (!this.$('terminal-copy-dialog').open) this.$('terminal-copy-dialog').showModal(); this.$('terminal-copy-text').focus(); this.$('terminal-copy-text').select();
  }
  async copy(value) {
    const selected = this.term?.getSelection(), text = value ?? (selected || this.screenText()); if (!text) return this.notice('There is no terminal text to copy yet.');
    try { await navigator.clipboard.writeText(text); this.notice(value ? 'Text copied.' : selected ? 'Terminal selection copied.' : 'Visible terminal screen copied.'); }
    catch { this.openCopy(text); this.notice('Text is selected. Press Ctrl+C or ⌘C to copy.'); }
  }
  send(message) { if (this.ws?.readyState !== WebSocket.OPEN || !this.ready) return false; this.ws.send(JSON.stringify(message)); return true; }
  input(data) {
    if (!this.controls || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    // Preserve surrogate pairs when splitting large Unicode pastes.
    const chars = [...data]; for (let i = 0; i < chars.length; i += 8000) this.send({ type: 'input', data: chars.slice(i, i + 8000).join('') });
    return true;
  }
  steer() {
    const text = this.$('steering-input').value; if (!text.trim() || !this.controls) return;
    const generation = this.generation; this.term.paste(text);
    setTimeout(() => { if (generation === this.generation && this.input('\r')) { this.$('steering-input').value = ''; this.term.scrollToBottom(); } }, 60);
  }
  zoom(delta) { this.fontSize = Math.max(11, Math.min(22, this.fontSize + delta)); localStorage.setItem('opensensor.terminal.font', this.fontSize); if (this.term) this.term.options.fontSize = this.fontSize; this.fit(); }
  fit() {
    clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => {
      if (!this.term || !this.$('terminal-surface').clientWidth || !this.controls) return;
      const size = this.fitter.proposeDimensions(); if (!size) return;
      const cols = Math.max(20, Math.min(300, size.cols)), rows = Math.max(5, Math.min(120, size.rows));
      if (cols !== this.remote?.cols || rows !== this.remote?.rows) { this.term.resize(cols, rows); this.send({ type: 'resize', cols, rows }); }
    }, 80);
  }
  find(previous, incremental = false) {
    const value = this.$('terminal-search').value; if (!this.search) return;
    if (!value) { this.search.clearDecorations(); this.$('terminal-matches').textContent = ''; return; }
    this.search[previous ? 'findPrevious' : 'findNext'](value, { incremental, decorations: { matchBackground: '#566547', matchOverviewRuler: '#a2c082', activeMatchBackground: '#b29550', activeMatchBorder: '#efd9a0', activeMatchColorOverviewRuler: '#efd9a0' } });
  }
  update(message) {
    const was = this.controls; this.remote = message;
    const running = ['starting', 'running', 'stopping'].includes(message.status);
    this.controls = Boolean(this.ready && message.interactive && running && message.controller === this.clientId);
    if (this.term) { this.term.options.disableStdin = !this.controls; this.term.options.convertEol = !message.interactive; }
    this.$('terminal-control-status').textContent = !running ? `${message.status} · saved screen` : !message.interactive ? 'Batch task · output only' : this.controls ? 'You have control' : message.controller ? 'Another tab has control' : 'Ready for input';
    this.$('terminal-size').textContent = `${message.cols} × ${message.rows} · ${message.viewers || 1} viewer${message.viewers > 1 ? 's' : ''}`;
    this.$('terminal-control').hidden = !running || !message.interactive || this.controls;
    this.$('terminal-control').textContent = message.controller ? 'Take over control' : 'Take control';
    this.$('terminal-release').hidden = !this.controls;
    for (const id of ['terminal-paste', 'terminal-escape', 'terminal-interrupt', 'steering-send']) this.$(id).disabled = !this.controls;
    this.$('steering-form').hidden = !message.interactive || !running;
    this.$('terminal-stop').hidden = !running;
    this.$('terminal-stop').disabled = message.status === 'stopping';
    if (this.term && !this.controls && (this.term.cols !== message.cols || this.term.rows !== message.rows)) this.term.resize(message.cols, message.rows);
    if (this.controls && !was) this.fit();
    this.$('terminal-notice').textContent = running ? 'Closing or reconnecting this page leaves the session running. Stop ends the sandbox.' : 'This is the final terminal screen. The Transcript tab and Log download contain the captured output.';
    this.onState?.(this.id, message);
  }
  disconnect(resetLayout = true) {
    this.generation++; clearTimeout(this.retryTimer); clearInterval(this.pingTimer); clearTimeout(this.fitTimer);
    this.ready = false; this.controls = false; this.ws?.close(1000, 'Switching view'); this.ws = null; this.id = null;
    if (resetLayout) { this.$('output-panel').classList.remove('expanded'); document.body.classList.remove('terminal-expanded'); this.fullscreenLabel(); }
  }
  connect(id, retry = false) {
    if (!id) return; const attempts = retry ? this.attempts || 0 : 0;
    this.disconnect(this.id !== id); this.id = id; this.attempts = attempts; const generation = this.generation;
    this.clientId = null; this.remote = null; this.sequence = 0; this.pending = 0;
    this.$('terminal-status').textContent = retry ? 'Reconnecting…' : 'Connecting…'; this.$('terminal-dot').classList.add('offline'); this.$('terminal-latency').textContent = '';
    this.createTerminal(generation);
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/sessions/${id}/terminal`);
    ws.onmessage = event => {
      if (generation !== this.generation) return;
      let message; try { message = JSON.parse(event.data); } catch { return ws.close(1002, 'Invalid frame'); }
      if (message.type === 'snapshot') {
        this.clientId = message.clientId; this.sequence = message.sequence; this.ready = true; this.attempts = 0;
        this.term.options.convertEol = !message.interactive; this.term.resize(message.cols, message.rows);
        // xterm's serializer omits the SGR mouse encoding. Older dashboard
        // sessions are Kilo TUIs, which explicitly enable DEC mode 1006.
        const mouseEncoding = message.mouseEncoding ?? (message.interactive ? '\x1b[?1006h' : '');
        this.term.write(message.data + mouseEncoding, () => { if (generation === this.generation) { this.send({ type: 'ack', sequence: message.sequence }); this.find(false); } });
        this.update(message); this.$('terminal-status').textContent = 'Live stream'; this.$('terminal-dot').classList.remove('offline');
        if (message.interactive && ['starting', 'running'].includes(message.status) && !message.controller) this.send({ type: 'control' });
        clearInterval(this.pingTimer); this.pingTimer = setInterval(() => this.send({ type: 'ping', at: Date.now() }), 5000);
      } else if (message.type === 'output') {
        if (message.sequence <= this.sequence) return;
        if (message.sequence !== this.sequence + 1) return ws.close(4000, 'Resynchronizing screen');
        this.sequence = message.sequence; this.pending += message.data.length;
        if (this.pending > 2 * 1024 * 1024) return ws.close(4000, 'Renderer catching up');
        this.term.write(message.data, () => { if (generation === this.generation) { this.pending -= message.data.length; this.send({ type: 'ack', sequence: message.sequence }); } });
      } else if (message.type === 'state') this.update(message);
      else if (message.type === 'pong') this.$('terminal-latency').textContent = `${Math.max(0, Date.now() - message.at)} ms`;
      else if (message.type === 'error') this.notice(message.message, true);
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.ready = false; this.controls = false; clearInterval(this.pingTimer);
      if (this.remote) this.update(this.remote);
      this.$('terminal-status').textContent = 'Disconnected · reconnecting'; this.$('terminal-dot').classList.add('offline');
      this.retryTimer = setTimeout(() => this.connect(id, true), Math.min(10000, 500 * 2 ** this.attempts++));
    };
    ws.onerror = () => {}; // Close schedules a fresh screen; keystrokes are never replayed.
  }
};
