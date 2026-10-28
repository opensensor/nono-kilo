const $ = id => document.getElementById(id);
const state = { projects: [], sessions: [], project: '', selected: null, tab: 'output', detail: null, busy: false, sessionHash: '' };
let toastTimer;

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500);
}
async function api(url, body) {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenSensor-Client': 'dashboard' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
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
    button.addEventListener('click', () => selectProject(project.path)); return button;
  });
  $('projects').replaceChildren(...items);
}
function selectProject(project) {
  state.project = project; state.sessionHash = ''; localStorage.setItem('opensensor.project', project);
  const current = state.projects.find(p => p.path === project);
  $('breadcrumb').textContent = current?.name || 'Choose a project';
  $('selected-project-name').textContent = current?.name || '';
  $('scope-path').textContent = project; renderProjects(); renderSessions();
  if (!state.sessions.some(s => s.id === state.selected && (s.project === project || $('all-projects').checked))) {
    state.selected = null; const first = state.sessions.find(s => s.project === project); if (first) selectSession(first.id); else showEmpty();
  }
}
function showEmpty() { $('session-content').hidden = true; $('session-empty').hidden = false; }
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
    button.append(heading, element('div', 'session-item-title', session.prompt), element('div', 'session-item-meta', session.kind === 'check' ? '◇ sandbox check' : session.projectName));
    button.addEventListener('click', () => selectSession(session.id)); return button;
  }));
}
async function selectSession(id) {
  state.selected = id; state.detail = null; state.sessionHash = ''; renderSessions();
  $('session-empty').hidden = true; $('session-content').hidden = false;
  $('output').textContent = 'Loading session…';
  try { await refreshDetail(); if (state.tab === 'diff') await loadDiff(); } catch (error) { toast(error.message, true); }
}
async function refreshDetail() {
  const id = state.selected; if (!id) return;
  const detail = await api(`/api/sessions/${id}`); if (id !== state.selected) return;
  state.detail = detail;
  $('session-title').textContent = detail.prompt;
  $('session-subtitle').textContent = `${detail.status.toUpperCase()}  ·  ${detail.name}  ·  ${detail.model}`;
  $('stop-session').hidden = !active(detail.status);
  $('stop-session').disabled = detail.status === 'stopping';
  $('waiting').hidden = !active(detail.status);
  const panel = $('output-panel'); const follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 85 || $('output').textContent === 'Loading session…';
  const content = detail.output || (active(detail.status) ? 'Starting Kilo inside nono…\n' : 'No output was captured for this session.');
  if ($('output').textContent !== content) { $('output').textContent = content; if (follow) panel.scrollTop = panel.scrollHeight; }
  if (state.tab === 'details') renderDetails();
}
function renderDetails() {
  if (!state.detail) return;
  const s = state.detail; const dl = element('dl');
  for (const [key, value] of Object.entries({ Project: s.project, Model: s.model, Profile: 'opensensor-kilo-local', Status: s.status, Started: new Date(s.startedAt).toLocaleString(), 'nono session': s.nonoId || 'Starting…', 'Tool prompts': s.autoApprove ? 'Auto-approve enabled' : 'Kilo defaults', Task: s.prompt })) {
    dl.append(element('dt', '', key), element('dd', '', value));
  }
  $('details-panel').replaceChildren(dl);
}
async function loadDiff() {
  if (!state.selected) return; const id = state.selected;
  $('diff-note').textContent = 'Reading the current working tree…';
  const result = await api(`/api/sessions/${id}/diff`); if (id !== state.selected) return;
  $('diff-note').textContent = result.note; $('git-status').textContent = result.status || 'No uncommitted files.';
  $('diff-output').textContent = result.diff || 'No tracked-file diff.';
}
async function refresh() {
  if (state.busy) return; state.busy = true;
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
    const result = await api('/api/sessions', { kind, project: state.project, model, prompt: $('prompt').value, autoApprove: $('auto-approve').checked });
    state.sessions.unshift(result); state.tab = 'output'; switchTab('output'); await selectSession(result.id); await refresh();
    toast(kind === 'check' ? 'Sandbox check started.' : 'Kilo session started.');
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  for (const name of ['output', 'diff', 'details']) $(`${name}-panel`).hidden = tab !== name;
  if (tab === 'diff') loadDiff().catch(error => toast(error.message, true));
  if (tab === 'details') renderDetails();
}
$('task-form').addEventListener('submit', event => { event.preventDefault(); launch('task'); });
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
for (const id of ['profile-nav', 'profile-link']) $(id).addEventListener('click', () => $('profile-dialog').showModal());
$('workspace-nav').addEventListener('click', () => $('prompt').focus());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('add-project').addEventListener('click', () => $('project-dialog').showModal());
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { state.projects = await api('/api/projects', { path: $('project-path').value }); $('project-dialog').close(); renderProjects(); toast('Project added.'); }
  catch (error) { toast(error.message, true); }
});
$('demo-prompt').addEventListener('click', () => {
  const demo = state.projects.find(p => p.demo); if (demo) selectProject(demo.path);
  $('prompt').value = 'Read sensor.py and test_sensor.py. Run python3 -m unittest -v and briefly explain the temperature conversion and test results. Do not modify files or use subagents.';
  $('model').value = 'kilo/kilo-auto/free'; $('custom-model-wrap').hidden = true; $('prompt').focus();
});
$('terminal-command').addEventListener('click', async () => {
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  try { await navigator.clipboard.writeText(`cd ${quote(state.project)}\nnono-kilo`); toast('Terminal command copied.'); }
  catch { toast(`Run nono-kilo from ${state.project}.`); }
});
$('download-log').addEventListener('click', () => {
  if (!state.detail) return;
  const url = URL.createObjectURL(new Blob([state.detail.output || 'No captured output.'], { type: 'text/plain' }));
  const link = document.createElement('a'); link.href = url; link.download = `${state.detail.name}.log`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function boot() {
  try {
    const data = await api('/api/bootstrap'); state.projects = data.projects; state.sessions = data.sessions;
    $('runtime-name').textContent = data.runtime.ready ? 'nono ready' : 'Runtime unavailable';
    $('runtime-detail').textContent = `${data.runtime.nono} · Kilo ${data.runtime.kilo}`;
    $('footer-runtime').textContent = `${data.runtime.platform === 'linux' ? 'Linux · Landlock' : data.runtime.platform} · Kilo ${data.runtime.kilo}`;
    $('workspace-path').textContent = data.workspace;
    $('profile-json').textContent = JSON.stringify(data.profile, null, 2);
    if (data.configuredModel && data.configuredModel !== data.defaultModel) $('model').append(new Option(`Configured · ${data.configuredModel}`, data.configuredModel));
    $('model').append(new Option('Custom model…', 'custom'));
    const saved = localStorage.getItem('opensensor.project');
    selectProject(state.projects.some(p => p.path === saved) ? saved : state.projects[0]?.path || '');
    if (!state.selected && state.sessions.length) { const session = state.sessions.find(s => s.project === state.project); if (session) await selectSession(session.id); }
    await refresh(); setInterval(refresh, 1500);
  } catch (error) { toast(error.message, true); $('runtime-name').textContent = 'Not connected'; }
}
boot();
