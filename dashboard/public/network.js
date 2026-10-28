(() => {
  let data, selected = '', paused = false, pending = false, loadedSession;
  const svg = (tag, attrs = {}, text) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); if (text !== undefined) el.textContent = text; return el; };
  const key = d => `${d.host}:${d.port}`;
  const clock = time => new Date(time).toLocaleTimeString([], { hour12: false });
  const matches = d => (!selected || key(d) === selected) && key(d).toLowerCase().includes($('network-search').value.toLowerCase());
  const select = d => { selected = selected === key(d) ? '' : key(d); render(); };
  function render() {
    if (!data) return;
    $('network-panel').classList.toggle('network-paused', paused);
    $('network-live').textContent = paused ? 'View paused' : data.live ? '● Live · 2s sampling' : 'Session history';
    $('network-pause').textContent = paused ? 'Resume view' : 'Pause view';
    $('network-clear').hidden = !selected;
    $('network-metrics').replaceChildren(...[
      ['Active sockets', data.connections.length], ['Destinations seen', data.destinations.length], ['Proxy allowed', data.totals.allowed], ['Proxy blocked', data.totals.denied]
    ].map(([label, count]) => { const cell = element('div'); cell.append(element('strong', '', String(count)), element('span', '', label)); return cell; }));
    const kind = $('network-filter').value;
    const destinations = data.destinations.filter(matches).filter(d => kind === 'all' || d[{ deny: 'denied', allow: 'allowed', response: 'responses' }[kind]]);
    $('network-destinations').replaceChildren(...destinations.map(d => {
      const button = element('button', `network-destination${selected === key(d) ? ' selected' : ''}`);
      button.setAttribute('aria-pressed', String(selected === key(d))); button.title = key(d);
      button.append(element('strong', '', key(d)), element('span', '', `${d.connections} socket${d.connections === 1 ? '' : 's'} · ${d.allowed} allowed · ${d.denied} blocked`));
      button.onclick = () => select(d); return button;
    }));
    if (!destinations.length) $('network-destinations').append(element('p', 'empty-list', 'No matching destinations observed.'));
    renderGraph(destinations.slice(0, 8)); renderTimeline();
    const events = data.events.filter(matches).filter(e => $('network-filter').value === 'all' || e.kind === $('network-filter').value);
    $('network-event-count').textContent = `· ${events.length} shown`;
    $('network-event-rows').replaceChildren(...events.map(e => {
      const row = element('tr'); const action = element('td', `net-${e.kind}`, { allow: 'Allowed', deny: 'Blocked', response: 'Response' }[e.kind]);
      row.append(element('td', '', clock(e.at)), element('td', 'network-host', key(e)), action, element('td', '', `${e.method || '—'} · ${e.mode || 'proxy'}`), element('td', '', e.status || '—')); return row;
    }));
    $('network-empty-events').hidden = events.length > 0;
    $('network-empty-events').textContent = data.mode === 'unrestricted' ? 'Direct traffic has no proxy request log. Observed connections appear above.' : 'No matching proxy events recorded yet.';
    const notes = ['Connection sampling can miss short-lived traffic. IP addresses are shown when no hostname was observed.'];
    if (!data.coverage.sockets) notes.push(data.live ? 'Live socket sampling is unavailable for this session.' : 'This session has no live sockets.');
    if (!data.coverage.proxy) notes.push('No live proxy trace was captured for this session.');
    if (data.mode === 'unrestricted') notes.push('Unrestricted traffic has no proxy allow/deny decisions.');
    notes.push('HTTPS tunnels do not expose individual requests. Request bodies, headers and URL paths are not displayed.');
    if (data.truncated) notes.push('History was capped; only retained observations are shown.');
    $('network-coverage').textContent = notes.join(' ');
  }
  function renderGraph(destinations) {
    const graph = $('network-graph'), height = Math.max(320, destinations.length * 60 + 30), center = height / 2;
    graph.setAttribute('viewBox', `0 0 800 ${height}`); graph.replaceChildren();
    graph.append(svg('circle', { cx: 130, cy: center, r: 62, class: 'network-agent-halo' }), svg('circle', { cx: 130, cy: center, r: 48, class: 'network-agent' }),
      svg('text', { x: 130, y: center - 4, 'text-anchor': 'middle', class: 'network-node-title' }, 'Kilo session'), svg('text', { x: 130, y: center + 17, 'text-anchor': 'middle', class: 'network-node-subtitle' }, 'nono sandbox'));
    if (!destinations.length) graph.append(svg('text', { x: 440, y: center, 'text-anchor': 'middle', class: 'network-node-subtitle' }, data.live ? 'Watching for connections…' : 'No captured connections'));
    destinations.forEach((d, i) => {
      const y = (i + 0.5) * height / destinations.length, connected = data.connections.some(c => key(c) === key(d));
      const color = d.denied && !d.allowed && !d.connections ? 'deny' : d.allowed || d.responses ? 'allow' : 'observed';
      graph.append(svg('path', { d: `M180,${center} C300,${center} 330,${y} 450,${y}`, class: `network-edge ${color}${connected && data.live ? ' flowing' : ''}` }));
      const group = svg('g', { role: 'button', tabindex: 0, 'aria-label': `Filter ${key(d)}`, class: 'network-graph-destination' });
      group.append(svg('title', {}, `${key(d)} · ${d.allowed} allowed · ${d.denied} blocked`), svg('rect', { x: 450, y: y - 23, width: 330, height: 46, rx: 8, class: `network-node ${color}` }),
        svg('circle', { cx: 466, cy: y, r: 4, class: `network-dot ${color}` }), svg('text', { x: 480, y: y - 2, class: 'network-node-title' }, d.host.length > 35 ? d.host.slice(0, 32) + '…' : d.host),
        svg('text', { x: 480, y: y + 14, class: 'network-node-subtitle' }, `Port ${d.port} · ${connected ? 'connected now' : d.denied && !d.allowed ? 'blocked by proxy' : 'observed earlier'}`));
      group.onclick = () => select(d); group.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(d); } }; graph.append(group);
    });
  }
  function renderTimeline() {
    const graph = $('network-timeline'); graph.replaceChildren(); const points = data.samples.slice(-180);
    if (!points.length) { graph.append(svg('text', { x: 10, y: 40, class: 'network-node-subtitle' }, 'Connection samples will appear while the session is running.')); return; }
    const max = Math.max(1, ...points.map(p => p.active));
    graph.append(svg('line', { x1: 0, y1: 65, x2: 900, y2: 65, class: 'network-axis' }));
    graph.append(svg('polyline', { points: points.map((p, i) => `${i * 890 / Math.max(1, points.length - 1) + 5},${65 - p.active * 55 / max}`).join(' '), class: 'network-sparkline' }));
    $('network-timeline-note').textContent = `${clock(points[0].at)} – ${clock(points.at(-1).at)} · peak ${max} · 2s samples`;
  }
  async function load() {
    if (pending || !state.selected || !state.authenticated || state.tab !== 'network' || document.hidden || state.page && state.page !== 'workspace') return;
    if (loadedSession !== state.selected) {
      loadedSession = state.selected; data = null; selected = ''; paused = false;
      for (const id of ['network-metrics', 'network-graph', 'network-destinations', 'network-event-rows', 'network-timeline']) $(id).replaceChildren();
      for (const id of ['network-event-count', 'network-timeline-note', 'network-coverage']) $(id).textContent = '';
      $('network-clear').hidden = true; $('network-live').textContent = 'Loading…';
    }
    if (paused) return; const id = state.selected; pending = true;
    try { const result = await api(`/api/sessions/${id}/network`); if (id !== state.selected) return; data = result; render(); }
    catch (error) { $('network-coverage').textContent = error.message; $('network-live').textContent = 'Disconnected'; }
    finally { pending = false; }
  }
  $('network-pause').onclick = () => { paused = !paused; render(); if (!paused) load(); };
  $('network-clear').onclick = () => { selected = ''; render(); };
  $('network-search').oninput = render; $('network-filter').onchange = render;
  $('network-export').onclick = () => {
    if (!data) return; const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${data.session}-network.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.loadNetwork = load; setInterval(load, 2000);
})();
