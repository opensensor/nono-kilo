const lines = value => value.split('\n').map(s => s.trim()).filter(Boolean);
const ports = value => value.split(/[\s,]+/).filter(Boolean).map(Number);
state.vault = [];
state.settingsDirty = false;
function showPage(page) {
  for (const name of ['workspace', 'settings', 'secrets']) $(`${name}-content`).hidden = name !== page;
  for (const [id, name] of [['workspace-nav', 'workspace'], ['profile-nav', 'settings'], ['secrets-nav', 'secrets']]) $(id).classList.toggle('active', page === name);
  state.page = page;
  if (page === 'secrets') refreshVault().catch(error => toast(error.message, true));
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function dirty() { state.settingsDirty = true; $('settings-status').textContent = 'Unsaved draft'; $('settings-status').className = 'unsaved'; }
function clean() { state.settingsDirty = false; $('settings-status').textContent = 'All changes saved'; $('settings-status').className = ''; }
function settingsError(message = '') { $('settings-error').textContent = message; $('settings-error').hidden = !message; }
function settingsTab(tab) {
  document.querySelectorAll('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  document.querySelectorAll('[data-settings-tab]').forEach(button => { button.classList.toggle('active', button.dataset.settingsTab === tab); button.setAttribute('aria-current', button.dataset.settingsTab === tab ? 'page' : 'false'); });
}
function field(label, control) { const wrap = element('label', 'dynamic-field', label); wrap.append(control); return wrap; }
function input(value = '', placeholder = '') { const control = element('input'); control.value = value; control.placeholder = placeholder; return control; }
function select(options, value) { const control = element('select'); options.forEach(([label, value]) => control.append(new Option(label, value))); control.value = value; return control; }
function removeButton(row, label) { const button = element('button', 'icon-button', '×'); button.type = 'button'; button.setAttribute('aria-label', label); button.onclick = () => { row.remove(); dirty(); }; return button; }
function addGrant(grant = { path: '', access: 'read' }) {
  const row = element('div', 'grant-row');
  row.append(field('Path', input(grant.path, '/path/to/data')), field('Access', select([['Read only', 'read'], ['Read + write', 'readwrite']], grant.access)), removeButton(row, 'Remove path grant'));
  $('grants-list').append(row);
}
function addBinding(binding = {}) {
  const row = element('div', 'binding-card');
  const heading = element('div', 'card-heading'); heading.append(element('strong', '', 'Credential binding'), removeButton(row, 'Remove secret binding'));
  const first = element('div', 'field-grid');
  const secret = select(state.vault.map(s => [`${s.name}${s.enabled ? '' : ' · disabled'}`, s.id]), binding.secretId || state.vault[0]?.id);
  secret.dataset.field = 'secretId';
  const mode = select([['Environment variable', 'env'], ['Credential proxy', 'proxy']], binding.mode || 'env'); mode.dataset.field = 'mode';
  first.append(field('Stored secret', secret), field('Delivery', mode));
  const variable = input(binding.env || '', 'OPENAI_API_KEY'); variable.dataset.field = 'env';
  const proxy = element('div', 'proxy-fields');
  const controls = [
    ['Route name', 'route', input(binding.route || '', 'provider')],
    ['Upstream URL', 'upstream', input(binding.upstream || '', 'https://api.example.com')],
    ['Credential header', 'header', input(binding.header || 'Authorization')],
    ['Credential format', 'format', select([['Bearer token', 'Bearer {}'], ['Raw value', '{}']], binding.format || 'Bearer {}')]
  ];
  for (const [label, name, control] of controls) { control.dataset.field = name; proxy.append(field(label, control)); }
  const endpoints = element('textarea', 'compact-textarea'); endpoints.dataset.field = 'endpoints'; endpoints.value = (binding.endpoints || []).map(r => `${r.method} ${r.path}`).join('\n'); endpoints.placeholder = 'POST /v1/chat/completions\nGET /v1/models';
  proxy.append(field('Allowed endpoints (optional)', endpoints));
  const help = element('p', 'field-help'); proxy.append(help);
  const update = () => { proxy.hidden = mode.value !== 'proxy'; const route = row.querySelector('[data-field=route]').value || 'ROUTE'; help.textContent = `Requires restricted networking. Point the client at ${route.toUpperCase()}_BASE_URL; ${variable.value || 'YOUR_API_KEY'} receives a placeholder token. Empty endpoint rules allow all paths on this upstream.`; };
  row.append(heading, first, field('Environment variable', variable), proxy);
  row.addEventListener('input', update); row.addEventListener('change', update); $('bindings-list').append(row); update();
}
function fillSettings(s) {
  $('s-model').value = s.defaultModel; $('s-auto').checked = s.autoApprove; $('s-storage').value = s.storage;
  const p = s.provider || state.defaults.provider;
  $('s-provider-enabled').checked = p.enabled; $('s-provider-id').value = p.id; $('s-provider-model').value = p.model;
  $('s-provider-url').value = p.baseURL; $('s-provider-secret').value = p.secretEnv; $('s-provider-route').value = p.proxyRoute;
  $('s-provider-context').value = p.context; $('s-provider-output').value = p.output;
  const g = { ...state.defaults.git, ...s.git };
  $('s-git-enabled').checked = g.enabled; $('s-git-local').value = g.local;
  for (const [id, key] of [['system','systemConfig'],['global','globalConfig'],['fetch','fetch'],['push','push']]) $(`s-git-${id}`).checked = g[key];
  for (const [id, key] of [['name','authorName'],['email','authorEmail'],['remote','remote'],['auth','authentication'],['key','privateKey'],['hosts','knownHosts'],['agent','agentSocket']]) $(`s-git-${id}`).value = g[key];
  $('s-git-branches').value = g.branches.join('\n');
  $('s-access').value = s.projectAccess; $('grants-list').replaceChildren(); s.extraPaths.forEach(addGrant);
  $('s-deny').value = s.denyPaths.join('\n'); document.querySelectorAll('[name=runtime]').forEach(c => { c.checked = s.runtimes.includes(c.value); });
  $('s-network').value = s.network.mode; $('s-domains').value = s.network.allowDomains.join('\n'); $('s-deny-domains').value = s.network.denyDomains.join('\n');
  $('s-connect').value = s.network.connectPorts.join(', '); $('s-listen').value = s.network.listenPorts.join(', ');
  $('s-inherit').value = s.environment.inherit.join('\n'); $('s-env').value = Object.entries(s.environment.variables).map(([k, v]) => `${k}=${v}`).join('\n');
  $('bindings-list').replaceChildren(); s.secrets.forEach(addBinding);
  $('s-timeout').value = s.limits.timeoutMinutes; $('s-memory').value = s.limits.memoryMB; $('s-processes').value = s.limits.maxProcesses;
  $('s-gpu').checked = s.allowGpu; $('s-rollback').checked = s.rollback.enabled; $('s-exclude').value = s.rollback.exclude.join('\n');
  conditionalFields(); settingsError();
}
function captureSettings() {
  const variables = {};
  for (const line of lines($('s-env').value)) { const index = line.indexOf('='); if (index < 1) throw new Error('Use NAME=value for each environment variable.'); const key = line.slice(0, index).trim(); if (Object.hasOwn(variables, key)) throw new Error(`Duplicate variable: ${key}`); variables[key] = line.slice(index + 1); }
  const bindings = [...$('bindings-list').children].map(row => {
    const get = name => row.querySelector(`[data-field=${name}]`).value.trim();
    const binding = { secretId: get('secretId'), mode: get('mode'), env: get('env') };
    if (binding.mode === 'proxy') Object.assign(binding, { route: get('route'), upstream: get('upstream'), header: get('header'), format: get('format'), endpoints: lines(get('endpoints')).map(line => { const match = line.match(/^(\S+)\s+(\S+)$/); if (!match) throw new Error('Endpoint rules use METHOD /path, one per line.'); return { method: match[1].toUpperCase(), path: match[2] }; }) });
    return binding;
  });
  return { schemaVersion: 1, defaultModel: $('s-model').value.trim(), autoApprove: $('s-auto').checked, storage: $('s-storage').value, projectAccess: $('s-access').value,
    extraPaths: [...$('grants-list').children].map(row => ({ path: row.querySelector('input').value.trim(), access: row.querySelector('select').value })), denyPaths: lines($('s-deny').value), runtimes: [...document.querySelectorAll('[name=runtime]:checked')].map(c => c.value),
    network: { mode: $('s-network').value, allowDomains: lines($('s-domains').value), denyDomains: lines($('s-deny-domains').value), connectPorts: ports($('s-connect').value), listenPorts: ports($('s-listen').value) },
    environment: { inherit: lines($('s-inherit').value), variables }, secrets: bindings,
    git: { enabled: $('s-git-enabled').checked, local: $('s-git-local').value, systemConfig: $('s-git-system').checked, globalConfig: $('s-git-global').checked,
      authorName: $('s-git-name').value.trim(), authorEmail: $('s-git-email').value.trim(), fetch: $('s-git-fetch').checked, push: $('s-git-push').checked,
      remote: $('s-git-remote').value.trim(), branches: lines($('s-git-branches').value), authentication: $('s-git-auth').value,
      privateKey: $('s-git-key').value.trim(), knownHosts: $('s-git-hosts').value.trim(), agentSocket: $('s-git-agent').value.trim() },
    provider: { enabled: $('s-provider-enabled').checked, id: $('s-provider-id').value.trim(), model: $('s-provider-model').value.trim(), baseURL: $('s-provider-url').value.trim(), secretEnv: $('s-provider-secret').value.trim(), proxyRoute: $('s-provider-route').value.trim(), context: Number($('s-provider-context').value), output: Number($('s-provider-output').value) },
    limits: { timeoutMinutes: Number($('s-timeout').value), memoryMB: Number($('s-memory').value), maxProcesses: Number($('s-processes').value) }, allowGpu: $('s-gpu').checked,
    rollback: { enabled: $('s-rollback').checked, exclude: lines($('s-exclude').value) } };
}
function conditionalFields() {
  $('git-fields').hidden = !$('s-git-enabled').checked;
  document.querySelector('[name=runtime][value=git]').disabled = $('s-git-enabled').checked;
  $('git-key-field').hidden = $('s-git-auth').value !== 'key'; $('git-agent-field').hidden = $('s-git-auth').value !== 'agent';
  const provider = $('s-provider-enabled').checked;
  $('provider-fields').hidden = !provider; $('provider-direct').hidden = Boolean($('s-provider-route').value.trim()); $('s-model').disabled = provider;
  if (provider && $('s-provider-id').value && $('s-provider-model').value) $('s-model').value = `${$('s-provider-id').value.trim()}/${$('s-provider-model').value.trim()}`;
  const mode = $('s-network').value;
  $('network-rules').hidden = !['restricted', 'approval'].includes(mode);
  $('network-note').textContent = { unrestricted: 'The agent can reach the internet and local network. Filesystem restrictions still apply.', blocked: 'No network connections. Remote AI models will not work in this mode; use it for local boundary checks and offline commands.', restricted: 'Only allowed domains, credential routes and explicit ports are reachable. An empty rule set blocks outbound connections.', approval: 'New destinations wait for your decision in the dashboard. Allow once permits one connection; Allow for session remembers that exact host and port until the session ends. Deny blocks that destination for this session. Requests expire after 5 minutes. The runtime clock pauses while a decision is pending. Saved allow rules and credential routes proceed automatically; saved deny rules stay blocked. Direct TCP ports bypass these prompts. Unix sockets such as Docker still require separate sandbox permissions. Applies to new dashboard sessions.' }[mode];
  $('storage-note').textContent = $('s-storage').value === 'shared' ? 'Uses your existing Kilo login, settings, session data and provider credentials. These files are readable and writable by this project’s agent.' : 'Creates separate config, data, cache and state directories. Existing Kilo login and providers are not copied. Supply provider credentials through secret bindings or configure this project’s Kilo storage.';
}
function renderPolicySummary() {
  const record = state.policy; if (!record) return; const s = record.settings;
  $('scope-summary').replaceChildren(...Object.entries({ 'Selected project': s.projectAccess === 'read' ? 'Read only' : 'Read + write', 'Kilo storage': s.storage === 'shared' ? 'Shared login & config' : 'Separate per project', 'Network': { unrestricted: 'Allowed', restricted: 'Restricted', approval: 'Ask on new destinations', blocked: 'Blocked' }[s.network.mode], 'Bound secrets': `${s.secrets.length} explicit bindings`, 'Run time limit': `${s.limits.timeoutMinutes} minutes`, 'Access escalation': 'Disabled' }).map(([key, value]) => { const row = element('div'); row.append(element('dt', '', key), element('dd', '', value)); return row; }));
  $('scope-note').textContent = `Policy ${record.revision ? `revision ${record.revision}` : 'defaults'} · ${s.extraPaths.length} extra path grants. ${s.storage === 'shared' ? 'Includes existing Kilo provider credentials.' : 'Existing machine credentials are not copied.'}`;
  $('settings-project').textContent = state.project; $('settings-revision').textContent = record.revision ? `Revision ${record.revision}` : 'Unsaved defaults';
  $('policy-preview').textContent = JSON.stringify(record.profile, null, 2); state.preview = record.profile;
  $('policy-history').replaceChildren(...(record.history || []).slice().reverse().map(r => new Option(`Revision ${r.revision}${r.updatedAt ? ` · ${new Date(r.updatedAt).toLocaleString()}` : ' · initial defaults'}`, r.revision)));
  $('restore-policy').disabled = !(record.history || []).length;
  renderModels();
  const option = [...$('model').options].find(o => o.value === s.defaultModel);
  $('model').value = option ? s.defaultModel : 'custom'; $('custom-model').value = s.defaultModel; $('custom-model-wrap').hidden = Boolean(option); $('auto-approve').checked = s.autoApprove;
}
async function loadProjectSettings(project) {
  state.policyProject = null; $('save-settings').disabled = true;
  const [policy, vault] = await Promise.all([api(`/api/project-settings?project=${encodeURIComponent(project)}`), api('/api/secrets')]);
  if (project !== state.project) return;
  state.policy = policy; state.policyProject = project; state.vault = vault.secrets; fillSettings(policy.settings); clean(); renderPolicySummary(); $('save-settings').disabled = false;
  $('start-task').disabled = false; $('test-sandbox').disabled = false;
}
async function refreshVault() {
  const [vault, audit] = await Promise.all([api('/api/secrets'), api('/api/audit')]); state.vault = vault.secrets;
  $('keyring-status').textContent = vault.status.available && !vault.status.locked ? 'System keyring connected · unlocked' : vault.status.locked ? 'System keyring locked or unavailable' : 'System keyring unavailable';
  $('new-secret').disabled = !vault.status.available || vault.status.locked;
  $('vault-list').replaceChildren(...vault.secrets.map(secret => {
    const card = element('article', 'card secret-card'); const content = element('div');
    const title = element('div', 'secret-title'); title.append(element('h2', '', secret.name), element('span', `status-pill ${secret.enabled ? 'completed' : 'stopped'}`, secret.enabled ? 'Enabled' : 'Disabled')); content.append(title);
    content.append(element('p', '', secret.description || 'No description'), element('p', 'secret-meta', `Version ${secret.version} · Updated ${new Date(secret.updatedAt).toLocaleString()} · ${secret.projects.length ? secret.projects.map(p => p.name).join(', ') : 'Not bound to a project'}`));
    const actions = element('div', 'secret-actions');
    const rotate = element('button', 'button secondary', 'Rotate'); rotate.onclick = () => openSecret(secret);
    const toggle = element('button', 'button secondary', secret.enabled ? 'Disable' : 'Enable'); toggle.onclick = async () => { toggle.disabled = true; try { await api(`/api/secrets/${secret.id}/enabled`, { enabled: !secret.enabled }); await refreshVault(); } catch (e) { toast(e.message, true); toggle.disabled = false; } };
    const remove = element('button', 'text-button delete-secret', 'Delete'); remove.disabled = Boolean(secret.projects.length); remove.title = secret.projects.length ? 'Remove project bindings before deleting' : 'Permanently delete this credential';
    remove.onclick = async () => { if (!confirm(`Delete “${secret.name}” from the system keyring?`)) return; try { await api(`/api/secrets/${secret.id}/delete`, {}); await refreshVault(); toast('Secret deleted.'); } catch (e) { toast(e.message, true); } };
    actions.append(rotate, toggle, remove); card.append(content, actions); return card;
  }));
  if (!vault.secrets.length) $('vault-list').append(element('div', 'card vault-empty', 'No stored secrets yet. Add a credential, then bind it in a project’s settings.'));
  $('audit-list').replaceChildren(...audit.filter(a => !a.event.startsWith('session.')).slice(0, 12).map(a => { const row = element('div', 'audit-row'); row.append(element('span', '', a.event.replaceAll('.', ' · ')), element('span', '', a.name || (a.project ? a.project.split('/').at(-1) : 'Credential')), element('time', '', new Date(a.at).toLocaleString())); return row; }));
  if (!$('audit-list').children.length) $('audit-list').append(element('p', 'empty-list', 'Configuration changes will appear here. Secret values are never recorded.'));
}
function openSecret(secret) {
  $('secret-form').reset(); $('secret-id').value = secret?.id || ''; $('secret-name').value = secret?.name || ''; $('secret-description').value = secret?.description || '';
  $('secret-dialog-title').textContent = secret ? `Rotate ${secret.name}` : 'Add a secret'; $('secret-error').hidden = true; $('secret-dialog').showModal();
}
document.querySelectorAll('[data-settings-tab]').forEach(button => button.onclick = () => settingsTab(button.dataset.settingsTab));
$('settings-form').addEventListener('input', dirty); $('settings-form').addEventListener('change', dirty);
$('s-network').addEventListener('change', conditionalFields); $('s-storage').addEventListener('change', conditionalFields);
for (const id of ['s-git-enabled', 's-git-auth', 's-provider-enabled', 's-provider-id', 's-provider-model', 's-provider-route']) $(id).addEventListener('input', conditionalFields);
$('add-grant').onclick = () => { addGrant(); dirty(); };
$('add-binding').onclick = () => { if (!state.vault.length) return toast('Add a stored secret in Secrets, then bind it here.', true); addBinding(); dirty(); };
$('secrets-nav').onclick = () => showPage('secrets'); $('manage-secrets').onclick = () => showPage('secrets'); $('refresh-vault').onclick = () => refreshVault().catch(e => toast(e.message, true));
$('new-secret').onclick = () => openSecret();
$('secret-dialog').addEventListener('close', () => { $('secret-value').value = ''; });
$('secret-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-secret').disabled = true; $('secret-error').hidden = true;
  const body = { id: $('secret-id').value || undefined, name: $('secret-name').value, value: $('secret-value').value, description: $('secret-description').value };
  $('secret-value').value = '';
  try { await api('/api/secrets', body); $('secret-dialog').close(); await refreshVault(); toast(body.id ? 'Secret rotated for future sessions.' : 'Secret stored. Bind it in project settings to use it.'); }
  catch (error) { $('secret-error').textContent = error.message; $('secret-error').hidden = false; } finally { body.value = ''; $('save-secret').disabled = false; }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.policyProject !== state.project) return settingsError('Wait for this project’s settings to finish loading.');
  state.settingsSaving = true; $('save-settings').disabled = true; settingsError();
  try { const record = await api('/api/project-settings', { project: state.project, revision: state.policy.revision, settings: captureSettings() }); state.policy = record; fillSettings(record.settings); clean(); renderPolicySummary(); toast(`Saved project policy revision ${record.revision}. Applies to new sessions.`); }
  catch (error) { settingsError(error.message); } finally { state.settingsSaving = false; $('save-settings').disabled = false; }
});
$('discard-settings').onclick = async () => { try { await loadProjectSettings(state.project); toast('Draft discarded; loaded saved settings.'); } catch (e) { settingsError(e.message); } };
$('apply-preset').onclick = () => {
  const s = structuredClone(state.defaults); const preset = $('s-preset').value;
  if (preset === 'review') s.projectAccess = 'read'; if (preset === 'offline') s.network.mode = 'blocked';
  fillSettings(s); dirty(); toast('Preset loaded as a draft. Review the settings and save.');
};
$('validate-policy').onclick = async () => {
  settingsError(); $('validate-policy').disabled = true;
  try { const result = await api('/api/project-settings/validate', { project: state.project, settings: captureSettings() }); state.preview = result.profile; $('policy-preview').textContent = JSON.stringify(result.profile, null, 2); toast('Draft validated by nono. Save to apply to new sessions.'); }
  catch (e) { settingsError(e.message); } finally { $('validate-policy').disabled = false; }
};
$('export-policy').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.preview, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${state.project.split('/').at(-1)}-nono-policy.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('restore-policy').onclick = () => { const previous = state.policy.history.find(r => r.revision === Number($('policy-history').value)); if (previous) { fillSettings(previous.settings); dirty(); toast(`Revision ${previous.revision} loaded as a draft. Save to create a new revision.`); } };
window.addEventListener('beforeunload', event => { if (state.settingsDirty) { event.preventDefault(); event.returnValue = ''; } });

$('import-git-context').onclick = async () => {
  const project = state.project; $('import-git-context').disabled = true;
  try {
    const g = await api(`/api/git-context?project=${encodeURIComponent(project)}`); if (project !== state.project) return;
    for (const [id, key] of [['name','authorName'],['email','authorEmail'],['remote','remote'],['hosts','knownHosts'],['agent','agentSocket']]) if (g[key]) $(`s-git-${id}`).value = g[key];
    dirty(); toast('Git identity and origin copied into the draft. Review and save to apply.');
  } catch (error) { settingsError(error.message); } finally { $('import-git-context').disabled = false; }
};
