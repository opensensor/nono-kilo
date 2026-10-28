const $ = id => document.getElementById(id);
const state = { projects: [], sessions: [], project: '', selected: null, tab: 'output', detail: null, busy: false, sessionHash: '', authenticated: false };
let toastTimer;
let pollTimer;
const liveTerminal = new LiveTerminal({ notice: toast, onState: (id, message) => {
  const record = state.sessions.find(s => s.id === id);
  if (record && record.status !== message.status) { record.status = message.status; state.sessionHash = ''; renderSessions(); refreshDetail().catch(() => {}); }
} });

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500);
}
async function api(url, body) {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { state.authenticated = false; liveTerminal.disconnect(); if (!$('login-dialog').open) $('login-dialog').showModal(); } throw new Error(result.error || 'Request failed.'); }
  return result;
}
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (text !== undefined) el.textContent = text; return el;
}
const active = status => ['starting', 'running', 'stopping'].includes(status);
function timeLabel(value) {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function renderProjects() {
  const query = $('project-search').value.toLowerCase();
  const items = state.projects.filter(p => p.relative.toLowerCase().includes(query)).map(project => {
    const button = element('button', `project-item${state.project === project.path ? ' selected' : ''}`);
    button.setAttribute('aria-label', `Select project ${project.name}`); button.title = project.path;
    button.append(element('span', 'project-icon', '▱'), element('span', 'project-name', project.name));
    if (project.demo) button.append(element('span', 'demo-badge', 'DEMO'));
    else if (project.available === false) button.append(element('span', 'demo-badge', 'OFFLINE'));
    else if (project.external) button.append(element('span', 'demo-badge', 'DRIVE'));
    button.addEventListener('click', () => selectProject(project.path)); return button;
  });
  $('projects').replaceChildren(...items);
}
async function selectProject(project) {
  if (state.settingsDirty || state.settingsSaving) return toast('Save or discard your project settings draft before switching projects.', true);
  state.project = project; state.sessionHash = ''; localStorage.setItem('opensensor.project', project);
  $('model-search').value = '';
  const current = state.projects.find(p => p.path === project);
  $('breadcrumb').textContent = current?.name || 'Choose a project';
  $('selected-project-name').textContent = current?.name || '';
  $('scope-path').textContent = project; renderProjects(); renderSessions();
  if (!state.sessions.some(s => s.id === state.selected && (s.project === project || $('all-projects').checked))) {
    state.selected = null; const first = state.sessions.find(s => s.project === project); if (first) selectSession(first.id); else showEmpty();
  }
  $('start-task').disabled = true; $('test-sandbox').disabled = true;
  try { if (project) await loadProjectSettings(project); }
  catch (error) { $('scope-summary').replaceChildren(); $('scope-note').textContent = error.message; toast(error.message, true); }
}
function showEmpty() { liveTerminal.disconnect(); $('session-content').hidden = true; $('session-empty').hidden = false; }
function openLauncher() {
  showPage('workspace'); liveTerminal.focusView(false);
  $('session-launcher').scrollIntoView({ block: 'start', behavior: 'instant' });
  $('prompt').focus({ preventScroll: true });
}
function renderSessions() {
  $('running-count').textContent = state.sessions.filter(s => active(s.status)).length;
  $('completed-count').textContent = state.sessions.filter(s => s.status === 'completed').length;
  const list = state.sessions.filter(s => $('all-projects').checked || s.project === state.project);
  $('session-count').textContent = list.length;
  const hash = JSON.stringify(list.map(s => [s.id, s.status, s.id === state.selected]));
  if (hash === state.sessionHash) return; state.sessionHash = hash;
  if (!list.length) { $('sessions').replaceChildren(element('p', 'empty-list', 'No sessions in this project yet. Start a task or test the sandbox.')); return; }
  $('sessions').replaceChildren(...list.map(session => {
    const button = element('button', `session-item${session.id === state.selected ? ' selected' : ''}`);
    button.setAttribute('aria-label', `${session.status}: ${session.prompt}`);
    const heading = element('div', 'session-item-heading');
    heading.append(element('span', `status-pill ${session.status}`, session.status), element('time', 'session-time', timeLabel(session.startedAt)));
    button.append(heading, element('div', 'session-item-title', session.prompt), element('div', 'session-item-meta', session.kind === 'check' ? '◇ sandbox check' : `${session.interactive ? '⌘ terminal' : '↗ batch'} · ${session.projectName}`));
    button.addEventListener('click', () => selectSession(session.id)); return button;
  }));
}
async function selectSession(id) {
  state.selected = id; state.detail = null; state.sessionHash = ''; renderSessions();
  $('session-empty').hidden = true; $('session-content').hidden = false;
  $('output').textContent = 'Loading session…';
  liveTerminal.connect(id);
  try { await refreshDetail(); if (state.tab === 'network') window.loadNetwork?.(); if (state.tab === 'diff') await loadDiff(); if (state.tab === 'transcript') await loadTranscript(); } catch (error) { toast(error.message, true); }
}
async function refreshDetail() {
  const id = state.selected; if (!id) return;
  const detail = await api(`/api/sessions/${id}?output=0`); if (id !== state.selected) return;
  state.detail = detail;
  $('session-title').textContent = detail.prompt;
  $('session-subtitle').textContent = `${detail.status.toUpperCase()}  ·  ${detail.name}  ·  ${detail.model}`;
  $('stop-session').hidden = !active(detail.status);
  $('stop-session').disabled = detail.status === 'stopping';
  $('waiting').hidden = !active(detail.status);
  if (state.tab === 'transcript') await loadTranscript();
  if (state.tab === 'details') renderDetails();
}
async function loadTranscript() {
  const id = state.selected; if (!id) return;
  const detail = await api(`/api/sessions/${id}`); if (id !== state.selected) return;
  const panel = $('transcript-panel'), follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 85;
  $('output').textContent = detail.output || 'Waiting for output…'; if (follow) panel.scrollTop = panel.scrollHeight;
}
function renderDetails() {
  if (!state.detail) return;
  const s = state.detail; const dl = element('dl');
  for (const [key, value] of Object.entries({ Project: s.project, Model: s.model, Profile: s.profileName || 'opensensor-kilo-local', 'Policy revision': s.policyRevision ?? 'Legacy profile', Status: s.status, Started: new Date(s.startedAt).toLocaleString(), 'nono session': s.nonoId || 'Starting…', 'Tool prompts': s.autoApprove ? 'Auto-approve enabled' : 'Kilo defaults', 'Bound secrets': s.secretVersions?.map(s => `${s.name} · v${s.version} · ${s.mode}`).join('\n') || 'None', Task: s.prompt })) {
    dl.append(element('dt', '', key), element('dd', '', value));
  }
  $('details-panel').replaceChildren(dl);
  if (s.policy) { const details = element('details', 'session-policy'); details.append(element('summary', '', 'Policy used for this session'), element('pre', 'policy-preview', JSON.stringify(s.policy, null, 2))); $('details-panel').append(details); }
}
async function loadDiff() {
  if (!state.selected) return; const id = state.selected;
  $('diff-note').textContent = 'Reading the current working tree…';
  const result = await api(`/api/sessions/${id}/diff`); if (id !== state.selected) return;
  $('diff-note').textContent = result.note; $('git-status').textContent = result.status || 'No uncommitted files.';
  $('diff-output').textContent = result.diff || 'No tracked-file diff.';
}
async function refresh() {
  if (state.busy || !state.authenticated) return; state.busy = true;
  try {
    state.sessions = await api('/api/sessions'); renderSessions(); if (state.selected) await refreshDetail();
    $('connection-label').firstChild.textContent = 'Connected locally'; $('connection-dot').style.background = '';
  } catch { $('connection-label').firstChild.textContent = 'Connection interrupted'; $('connection-dot').style.background = '#d29b75'; }
  finally { state.busy = false; }
}
async function launch(kind) {
  const button = kind === 'check' ? $('test-sandbox') : $('start-task');
  if (!state.project) return toast('Choose a project first.', true);
  button.disabled = true;
  try {
    const model = $('model').value === 'custom' ? $('custom-model').value.trim() : $('model').value;
    const result = await api('/api/sessions', { kind, project: state.project, model, prompt: $('prompt').value, autoApprove: $('auto-approve').checked, interactive: kind !== 'check' && $('run-mode').value === 'interactive' });
    state.sessions.unshift(result); state.tab = 'output'; switchTab('output'); await selectSession(result.id); await refresh();
    toast(kind === 'check' ? 'Sandbox check started.' : 'Kilo session started.');
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  for (const name of ['output', 'transcript', 'diff', 'network', 'details']) $(`${name}-panel`).hidden = tab !== name;
  if (tab === 'output') liveTerminal.fit();
  if (tab === 'transcript') loadTranscript().catch(error => toast(error.message, true));
  if (tab === 'diff') loadDiff().catch(error => toast(error.message, true));
  if (tab === 'details') renderDetails();
  if (tab === 'network') window.loadNetwork?.();
}
$('task-form').addEventListener('submit', event => { event.preventDefault(); launch('task'); });
document.querySelectorAll('[data-open-launcher]').forEach(button => button.addEventListener('click', openLauncher));
$('run-mode').addEventListener('change', () => { $('prompt').required = $('run-mode').value === 'batch'; $('prompt').placeholder = $('prompt').required ? 'Describe the task Kilo should complete in this run.' : 'Give Kilo an initial task, or leave empty to open its interactive terminal.'; });
$('test-sandbox').addEventListener('click', () => launch('check'));
$('project-search').addEventListener('input', renderProjects);
$('all-projects').addEventListener('change', () => { state.sessionHash = ''; renderSessions(); });
$('model').addEventListener('change', () => { $('custom-model-wrap').hidden = $('model').value !== 'custom'; });
$('stop-session').addEventListener('click', async () => {
  if (!state.selected) return; $('stop-session').disabled = true;
  try { await api(`/api/sessions/${state.selected}/stop`, {}); await refresh(); toast('Session stopped.'); }
  catch (error) { toast(error.message, true); } finally { $('stop-session').disabled = false; }
});
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
for (const id of ['profile-nav', 'profile-link']) $(id).addEventListener('click', () => showPage('settings'));
$('workspace-nav').addEventListener('click', () => { showPage('workspace'); $('prompt').focus(); });
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('add-project').addEventListener('click', () => $('project-dialog').showModal());
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { const value = $('project-path').value.trim(); state.projects = await api('/api/projects', { path: value }); $('project-dialog').close(); renderProjects(); const added = state.projects.find(p => p.path === value || p.relative === value); if (added) await selectProject(added.path); toast('Project added.'); }
  catch (error) { toast(error.message, true); }
});
$('demo-prompt').addEventListener('click', async () => {
  if (state.settingsDirty || state.settingsSaving) return toast('Save or discard the settings draft first.', true);
  const demo = state.projects.find(p => p.demo); if (demo) await selectProject(demo.path);
  $('prompt').value = 'Read sensor.py and test_sensor.py. Run python3 -m unittest -v and briefly explain the temperature conversion and test results. Do not modify files or use subagents.';
  $('model').value = 'kilo/kilo-auto/free'; $('custom-model-wrap').hidden = true; $('prompt').focus();
});
$('terminal-command').addEventListener('click', async () => {
  try { const result = await api('/api/project-command', { project: state.project }); await navigator.clipboard.writeText(result.command); toast('Copied terminal command using the saved project policy. Dashboard time limits apply only to dashboard runs.'); }
  catch (error) { toast(error.message, true); }
});
$('download-log').addEventListener('click', async () => {
  if (!state.detail) return;
  try { const detail = state.detail, response = await fetch(`/api/sessions/${detail.id}/log`); if (!response.ok) throw new Error('Could not download the transcript.');
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `${detail.name}.log`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message, true); }
});
function renderModels() {
  const previous = $('model').value, query = $('model-search').value.toLowerCase();
  const groups = new Map(); $('model').replaceChildren(new Option('Kilo · free router', state.defaultModel || 'kilo/kilo-auto/free'));
  if (state.policyProject === state.project && state.policy?.settings?.provider?.enabled) $('model').append(new Option(`Project provider · ${state.policy.settings.defaultModel}`, state.policy.settings.defaultModel));
  for (const model of state.models || []) {
    if (model.id === state.defaultModel) continue;
    if (query && !`${model.id} ${model.name} ${model.providerName}`.toLowerCase().includes(query) && model.id !== previous) continue;
    let group = groups.get(model.provider); if (!group) { group = element('optgroup'); group.label = model.providerName || model.provider; groups.set(model.provider, group); $('model').append(group); }
    const option = new Option(`${model.name}${model.id === state.configuredModel ? ' · Kilo default' : ''}`, model.id); option.disabled = model.disabled; option.title = `${model.id}${model.context ? ` · ${model.context.toLocaleString()} context` : ''}`; group.append(option);
  }
  $('model').append(new Option('Custom model…', 'custom'));
  if ([...$('model').options].some(o => o.value === previous)) $('model').value = previous;
}
function applyModelCatalog(data) {
  state.models = data.models || []; state.configuredModel = data.configuredModel;
  $('model-catalog-note').textContent = `${data.configuredCount ?? state.models.length} configured + ${data.gatewayCount || 0} gateway models`;
  $('model-catalog-note').title = data.warnings?.join('\n') || 'Imported from the active config.json, kilo.json and kilo.jsonc files.';
  $('configured-models').replaceChildren(...state.models.map(model => { const option = new Option(`${model.providerName} · ${model.name}`, model.id); return option; }));
  renderModels(); if (data.warnings?.length) toast(data.warnings.join(' '), true);
}
$('model-search').addEventListener('input', renderModels);
$('refresh-models').addEventListener('click', async () => { const button = $('refresh-models'); button.disabled = true; button.textContent = 'Refreshing models…'; try { applyModelCatalog(await api('/api/models?refresh=1')); toast('Kilo config and gateway model catalog refreshed.'); } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '↻ Refresh model catalog'; } });
async function boot() {
  try {
    const access = new URLSearchParams(location.hash.slice(1)).get('access');
    if (access) { history.replaceState(null, '', location.pathname); await api('/api/auth', { token: access }); }
    const data = await api('/api/bootstrap'); state.projects = data.projects; state.sessions = data.sessions;
    state.authenticated = true; state.defaults = data.defaultSettings; $('login-dialog').close();
    $('runtime-name').textContent = data.runtime.ready ? 'nono ready' : 'Runtime unavailable';
    $('runtime-detail').textContent = `${data.runtime.nono} · Kilo ${data.runtime.kilo}`;
    $('footer-runtime').textContent = `${data.runtime.platform === 'linux' ? 'Linux · Landlock' : data.runtime.platform} · Kilo ${data.runtime.kilo}`;
    $('workspace-path').textContent = data.workspace;
    $('profile-json').textContent = JSON.stringify(data.profile, null, 2);
    state.defaultModel = data.defaultModel; applyModelCatalog(data);
    const saved = localStorage.getItem('opensensor.project');
    await selectProject(state.projects.some(p => p.path === saved) ? saved : state.projects[0]?.path || '');
    if (!state.selected && state.sessions.length) { const session = state.sessions.find(s => s.project === state.project); if (session) await selectSession(session.id); }
    await refresh(); clearInterval(pollTimer); pollTimer = setInterval(refresh, 3000);
  } catch (error) { toast(error.message, true); $('runtime-name').textContent = 'Not connected'; }
}
$('login-dialog').addEventListener('cancel', event => event.preventDefault());
$('lock-dashboard').addEventListener('click', async () => { try { await api('/api/logout', {}); state.authenticated = false; liveTerminal.disconnect(); $('login-dialog').showModal(); } catch (error) { toast(error.message, true); } });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').hidden = true;
  const token = $('access-key').value.trim(); $('access-key').value = '';
  try { await api('/api/auth', { token }); await boot(); } catch (error) { $('login-error').textContent = error.message; $('login-error').hidden = false; }
});
boot();
