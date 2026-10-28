(() => {
  let groups = [], busy = false, signature = '', historySignature = '';
  const labels = { 'allow-once': 'Allowed once', 'allow-session': 'Allowed for session', deny: 'Denied for session', expired: 'Expired · denied', cancelled: 'Cancelled' };
  function render(data) {
    const pending = data?.pending || [], hash = JSON.stringify([state.selected, pending]);
    $('session-approvals').hidden = pending.length === 0;
    if (hash !== signature) {
      signature = hash;
      const heading = element('div', 'approval-heading');
      heading.append(element('strong', '', 'Network access needs your decision'), element('span', '', 'Runtime clock paused'));
      const note = element('p', 'approval-note', 'Allow once opens one connection; HTTPS can carry multiple requests over it. Decisions apply only to this sandbox session.');
      $('session-approvals').replaceChildren(heading, note, ...pending.map(request => {
        const card = element('article', 'approval-request');
        const target = element('div', 'approval-target');
        target.append(element('strong', '', `${request.host}:${request.port}`), element('span', '', `Outbound connection · expires ${timeLabel(request.expiresAt)}`));
        const actions = element('div', 'approval-actions'); const id = state.selected;
        for (const [decision, label] of [['allow-once', 'Allow once'], ['allow-session', 'Allow for session'], ['deny', 'Deny']]) {
          const button = element('button', `button ${decision === 'deny' ? 'danger' : 'secondary'}`, label);
          button.onclick = async () => {
            actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try {
              const result = await api(`/api/sessions/${id}/approvals/${request.id}`, { decision });
              toast(`${labels[decision]}: ${request.host}:${request.port}`);
              if (state.selected === id) { signature = ''; render(result); }
            } catch (error) { toast(error.message, true); signature = ''; }
            finally { actions.querySelectorAll('button').forEach(b => { b.disabled = false; }); load(); }
          };
          actions.append(button);
        }
        card.append(target, actions); return card;
      }));
      liveTerminal.fit();
    }
    const history = data?.history || [], nextHistory = JSON.stringify([state.selected, history]);
    if (historySignature !== nextHistory) {
      historySignature = nextHistory;
      const panel = $('network-approval-history'); panel.replaceChildren();
      if (history.length) {
        const details = element('details'); details.open = true;
        details.append(element('summary', '', `Network decisions · ${history.length}`));
        const list = element('div', 'approval-history-list');
        for (const row of history.slice(-20).reverse()) {
          const entry = element('div', 'approval-history-row');
          entry.append(element('time', '', timeLabel(row.decidedAt)), element('strong', '', `${row.host}:${row.port}`), element('span', '', labels[row.decision] || row.decision));
          entry.title = row.reason; list.append(entry);
        }
        details.append(list); panel.append(details);
      }
    }
  }
  async function load() {
    if (!state.authenticated || busy || document.hidden) return;
    busy = true; const id = state.selected;
    try {
      const [all, selected] = await Promise.all([api('/api/approvals'), id ? api(`/api/sessions/${id}/approvals`) : null]);
      groups = all;
      const count = groups.reduce((n, g) => n + g.pending.length, 0);
      $('approval-alert').hidden = !count;
      $('approval-alert').textContent = `${count} network ${count === 1 ? 'request' : 'requests'} waiting`;
      if (id === state.selected) render(selected);
    } catch { /* Existing connection indicator reports failures; requests stay pending. */ }
    finally { busy = false; }
  }
  $('approval-alert').onclick = async () => {
    const group = groups.find(g => g.session === state.selected) || groups[0]; if (!group) return;
    const session = state.sessions.find(s => s.id === group.session); if (!session) return;
    await selectProject(session.project); if (state.project !== session.project) return;
    showPage('workspace'); await selectSession(session.id); await load();
    $('session-approvals').scrollIntoView({ block: 'nearest' });
  };
  window.loadApprovals = load;
  window.clearApprovalView = () => { signature = ''; historySignature = ''; $('session-approvals').hidden = true; $('network-approval-history').replaceChildren(); };
  setInterval(load, 1000); document.addEventListener('visibilitychange', load);
})();
