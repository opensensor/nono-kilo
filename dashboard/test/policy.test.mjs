import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPolicyStore, defaults } from '../lib/policy.mjs';
import { createSecretStore } from '../lib/secrets.mjs';
import { RedactingStream, redactionValues } from '../lib/redaction.mjs';
import { createAuth } from '../lib/auth.mjs';

async function fixture(t, { wsl2 = false, kilo } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'workspace/project'), stateDir = path.join(root, 'state'), configDir = path.join(root, 'config');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(stateDir); await fs.mkdir(configDir);
  const values = new Map();
  const secrets = createSecretStore(stateDir, async r => { if (r.action === 'put') { values.set(r.id, r.value); return { ok: true }; } if (r.action === 'get') return { value: values.get(r.id) }; if (r.action === 'delete') { values.delete(r.id); return { ok: true }; } });
  const store = createPolicyStore({ stateDir, configDir, workspace: path.join(root, 'workspace'), sourceDir: path.join(root, 'controller'), home: root, nono: '/fake', kilo, execute: async () => ({ stdout: '{}' }), secretStore: secrets, wsl2, proxyUnsupported: wsl2 });
  return { root, project, stateDir, configDir, secrets, store, values };
}

test('saved policies enforce restrictions, preserve revisions and reject stale writes', async t => {
  const f = await fixture(t); const s = defaults(); s.projectAccess = 'read'; s.network.mode = 'blocked'; s.storage = 'isolated';
  const saved = await f.store.save(f.project, s, 0);
  assert.equal(saved.revision, 1); assert.equal(saved.profile.workdir.access, 'read'); assert.equal(saved.profile.network.block, true);
  assert.equal(saved.profile.security.capability_elevation, false);
  assert.equal(saved.profile.linux.af_unix_mediation, 'pathname');
  assert.equal(saved.profile.filesystem.allow.some(p => p === path.join(f.configDir, 'kilo')), false);
  assert.equal(saved.profile.environment.allow_vars.includes('OPENAI_API_KEY'), false);
  const launched = await f.store.launch(f.project);
  s.projectAccess = 'readwrite'; const next = await f.store.save(f.project, s, 1);
  assert.equal(next.history.at(-1).settings.projectAccess, 'read');
  const old = JSON.parse(await fs.readFile(path.join(f.configDir, 'nono/profiles', launched.profileName + '.json')));
  assert.equal(old.workdir.access, 'read');
  await assert.rejects(f.store.save(f.project, s, 1), /another window/);
});

test('standalone Kilo executable is readable inside the generated profile', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-binary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, '.kilo/bin/kilo');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, 'fixture');
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state'), configDir = path.join(root, 'config');
  await fs.mkdir(project); await fs.mkdir(stateDir); await fs.mkdir(configDir);
  const store = createPolicyStore({ stateDir, configDir, workspace: root, sourceDir: path.join(root, 'controller'), home: root, nono: '/fake', kilo: binary, execute: async () => ({ stdout: '{}' }), secretStore: createSecretStore(stateDir, async () => ({})), wsl2: true });
  const policy = await store.preview(project, store.defaultSettings());
  assert.deepEqual(policy.profile.filesystem.read, [path.dirname(binary)]);
});

test('WSL2 profiles disable unsupported pathname Unix-socket mediation', async t => {
  const f = await fixture(t, { wsl2: true });
  const settings = f.store.defaultSettings();
  assert.equal(settings.git.enabled, false);
  const policy = await f.store.save(f.project, settings, 0);
  assert.equal(policy.profile.linux.af_unix_mediation, 'off');
  assert.equal(policy.profile.command_policies, undefined);
  settings.git.enabled = true;
  await assert.rejects(f.store.preview(f.project, settings), /unavailable on WSL2/);
  settings.git.enabled = false; settings.network.mode = 'approval';
  await assert.rejects(f.store.preview(f.project, settings), /cannot enforce proxy-only networking/);
  settings.network.mode = 'blocked';
  assert.equal((await f.store.preview(f.project, settings)).profile.network.block, true);
});

test('network approval profiles fail closed without a live controller gate', async t => {
  const f = await fixture(t), s = defaults(); s.network.mode = 'approval';
  const saved = await f.store.save(f.project, s, 0);
  assert.equal(saved.profile.network.block, true);
  await assert.rejects(f.store.launch(f.project), /dashboard/);
  const launched = await f.store.launch(f.project, undefined, { networkApproval: async () => '127.0.0.1:49999' });
  assert.equal(launched.profile.network.block, false);
  assert.equal(launched.profile.network.upstream_proxy, '127.0.0.1:49999');
  assert.deepEqual(launched.profile.network.no_proxy, []);
  assert.deepEqual(launched.profile.network.upstream_bypass, []);
  assert.deepEqual(launched.profile.network.connect_port, []);
  assert.equal(launched.profile.security.capability_elevation, false);
});

test('unsafe grants, host controls and accidental network widening are rejected', async t => {
  const f = await fixture(t);
  for (const grant of [f.root, f.stateDir, f.configDir, '/proc']) {
    const s = defaults(); s.extraPaths = [{ path: grant, access: 'read' }]; await assert.rejects(f.store.preview(f.project, s), /overlaps/);
  }
  await fs.symlink(f.stateDir, path.join(f.project, 'escape'));
  const symlink = defaults(); symlink.extraPaths = [{ path: 'escape', access: 'readwrite' }]; await assert.rejects(f.store.preview(f.project, symlink), /overlaps/);
  const readOnly = defaults(); readOnly.projectAccess = 'read'; readOnly.extraPaths = [{ path: f.project, access: 'readwrite' }]; await assert.rejects(f.store.preview(f.project, readOnly), /conflicts/);
  const runtime = path.join(f.root, '.nvm/lib/node_modules'); await fs.mkdir(runtime, { recursive: true });
  const writeRuntime = defaults(); writeRuntime.extraPaths = [{ path: runtime, access: 'readwrite' }]; await assert.rejects(f.store.preview(f.project, writeRuntime), /runtime installations/);
  const blocked = defaults(); blocked.network.mode = 'blocked'; blocked.network.allowDomains = ['example.com']; await assert.rejects(f.store.preview(f.project, blocked), /restricted/);
  const empty = defaults(); empty.network.mode = 'restricted'; assert.equal((await f.store.preview(f.project, empty)).profile.network.block, true);
  const portDomain = defaults(); portDomain.network.mode = 'restricted'; portDomain.network.allowDomains = ['example.com:443']; await assert.rejects(f.store.preview(f.project, portDomain), /without ports/);
  for (const name of ['PATH', 'LD_PRELOAD', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS']) { const s = defaults(); s.environment.variables[name] = '/tmp/unsafe'; await assert.rejects(f.store.preview(f.project, s), /reserved/); }
  const key = defaults(); key.environment.variables.OPENAI_API_KEY = 'a-fixture'; await assert.rejects(f.store.preview(f.project, key), /Secrets/);
  const hooks = { ...defaults(), session_hooks: { pre: 'echo unsafe' } }; await assert.rejects(f.store.preview(f.project, hooks), /Unsupported/);
});

test('secrets store only metadata, rotate in keyring, and bind as references', async t => {
  const f = await fixture(t); const value = randomBytes(24).toString('hex');
  const secret = await f.secrets.save({ name: 'Fixture key', value });
  assert.equal(JSON.stringify(secret).includes(value), false);
  assert.equal((await fs.readFile(path.join(f.stateDir, 'secret-metadata.json'), 'utf8')).includes(value), false);
  assert.equal((await f.secrets.resolve([secret.id])).get(secret.id), value);
  const s = defaults(); s.secrets = [{ secretId: secret.id, env: 'TEST_API_KEY', mode: 'env' }];
  const policy = await f.store.save(f.project, s, 0);
  assert.equal(policy.profile.env_credentials[`keyring://opensensor-nono-dashboard/${secret.id}`], 'TEST_API_KEY');
  assert.equal(JSON.stringify(policy).includes(value), false);
  const snapshot = await f.store.launch(f.project, await f.secrets.resolve([secret.id]));
  assert.deepEqual(Object.values(snapshot.supervisorEnv), [value]);
  assert.equal(JSON.stringify(snapshot.profile).includes(value), false);
  assert.equal(snapshot.supervisorEnv.TEST_API_KEY, value);
  assert.ok(snapshot.profile.environment.allow_vars.includes('TEST_API_KEY'));
  assert.deepEqual(snapshot.profile.env_credentials, {});
  assert.deepEqual(snapshot.profile.environment.deny_vars, ['OPENSENSOR_SUPERVISOR_*']);
  const rotated = await f.secrets.save({ id: secret.id, name: 'Fixture key', value: 'rotated-fixture-value' }); assert.equal(rotated.version, 2);
  await f.secrets.setEnabled(secret.id, false); await assert.rejects(f.secrets.resolve([secret.id]), /disabled/);
  s.network.mode = 'restricted'; s.secrets = [{ secretId: secret.id, mode: 'proxy', env: 'TEST_API_KEY', route: 'test', upstream: 'https://example.com', header: 'Authorization', format: 'Bearer {}', endpoints: [{ method: 'POST', path: '/v1/test' }] }];
  const proxy = await f.store.preview(f.project, s); assert.deepEqual(proxy.profile.network.credentials, ['test']); assert.equal(proxy.profile.network.custom_credentials.test.endpoint_rules[0].path, '/v1/test');
  assert.deepEqual(proxy.profile.network.allow_domain, ['example.com']);
  s.secrets[0].upstream = 'http://127.0.0.1:54321/v1'; assert.deepEqual((await f.store.preview(f.project, s)).profile.network.allow_domain, ['127.0.0.1']);
  s.network.mode = 'unrestricted'; await assert.rejects(f.store.preview(f.project, s), /restricted/);
  await f.secrets.remove(secret.id); assert.equal(f.values.has(secret.id), false);
});

test('streaming log masking handles every chunk boundary and common encodings', () => {
  const value = 'test-secret-ü/with+symbols'; const secrets = redactionValues([value]);
  const message = `before ${value} middle ${encodeURIComponent(value)} after ${Buffer.from(value).toString('base64')} tail`;
  const bytes = Buffer.from(message);
  for (let split = 0; split <= bytes.length; split++) {
    let captured = ''; const stream = new RedactingStream(secrets, text => { captured += text; });
    stream.push(bytes.subarray(0, split)); stream.push(bytes.subarray(split)); stream.end();
    assert.equal(captured, 'before [REDACTED] middle [REDACTED] after [REDACTED] tail');
  }
  let captured = ''; const stream = new RedactingStream(secrets, text => { captured += text; });
  for (const b of bytes) stream.push(Buffer.from([b])); stream.end(); assert.equal(captured.includes(value), false); assert.equal(captured.includes('[REDACTED]'), true);
});

test('Git permissions default to inspection, scope write sandboxes and validate remote authority', async t => {
  const f = await fixture(t), s = defaults();
  const read = (await f.store.preview(f.project, s)).profile.command_policies.commands.git;
  assert.equal(read.from.session.invocation_policy.default, 'deny');
  assert.equal(read.from.session.sandbox.fs_write.length, 0);
  assert.equal(read.from.session.invocation_policy.allow.some(r => r.argv.prefix?.[0] === 'commit'), false);
  s.git.local = 'write'; const write = (await f.store.preview(f.project, s)).profile.command_policies.commands.git;
  assert.deepEqual(write.intercept.find(r => r.match.argv.prefix?.[0] === 'commit').sandbox.fs_write, [f.project]);
  assert.equal(write.from.session.sandbox.fs_write.length, 0, 'inspect commands keep a read-only sandbox');
  s.git.authorName = 'Fixture'; await assert.rejects(f.store.preview(f.project, s), /both/); s.git.authorEmail = 'fixture@example.invalid';
  s.git.push = true; await assert.rejects(f.store.preview(f.project, s), /exact SSH/);
  s.git.remote = 'git@github.com:opensensor/repo.git'; await assert.rejects(f.store.preview(f.project, s), /SSH agent or/);
  s.git.branches = ['main*']; await assert.rejects(f.store.preview(f.project, s), /literal branch/);
  s.git.branches = ['main']; s.network.mode = 'blocked'; await assert.rejects(f.store.preview(f.project, s), /blocked networking/);
  const env = defaults(); env.environment.variables.GIT_SSH_COMMAND = 'anything'; await assert.rejects(f.store.preview(f.project, env), /reserved/);
});

test('project providers use trusted runtime configuration with references only', async t => {
  const f = await fixture(t); const secret = await f.secrets.save({ name: 'Provider key', value: 'harmless-key-for-provider' });
  const s = defaults(); s.network.mode = 'restricted'; s.secrets = [{ secretId: secret.id, mode: 'proxy', env: 'EXAMPLE_KEY', route: 'example', upstream: 'https://example.com/v1', header: 'Authorization', format: 'Bearer {}', endpoints: [] }];
  s.provider = { ...s.provider, enabled: true, id: 'custom', model: 'model-1', proxyRoute: 'example' };
  const generated = await f.store.preview(f.project, s);
  assert.equal(generated.settings.defaultModel, 'custom/model-1');
  const config = JSON.parse(generated.profile.environment.set_vars.KILO_CONFIG_CONTENT);
  assert.equal(config.provider.custom.options.baseURL, '{env:EXAMPLE_BASE_URL}');
  assert.equal(config.provider.custom.options.apiKey, '{env:EXAMPLE_KEY}');
  assert.equal(JSON.stringify(generated).includes('harmless-key-for-provider'), false);
  s.network.denyDomains = ['example.com']; await assert.rejects(f.store.preview(f.project, s), /conflicts/);
  s.network.denyDomains = []; s.provider.proxyRoute = 'missing'; await assert.rejects(f.store.preview(f.project, s), /matching/);
});

test('browser authentication rejects forged, expired and malformed cookies', async t => {
  const f = await fixture(t); const auth = createAuth(f.stateDir);
  const key = JSON.parse(await fs.readFile(path.join(f.stateDir, 'browser-access.json'))).key;
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.throws(() => auth.login('wrong'), /Invalid/);
  const cookie = auth.login(key).split(';')[0]; assert.equal(auth.check({ headers: { cookie } }), true);
  assert.equal(auth.check({ headers: { cookie: cookie + 'x' } }), false);
  assert.equal(auth.check({ headers: { cookie: 'opensensor_session=a.b.c' } }), false);
  assert.equal(auth.check({ headers: {} }), false);
});

test('locally configured unlock keys persist and rotating them invalidates old cookies', async t => {
  const f = await fixture(t), file = path.join(f.stateDir, 'browser-access.json');
  const original = createAuth(f.stateDir), config = JSON.parse(await fs.readFile(file));
  const previousCookie = original.login(config.key).split(';')[0];
  await fs.writeFile(file, JSON.stringify({ ...config, key: 'test' }));
  const auth = createAuth(f.stateDir);
  const cookie = auth.login('test').split(';')[0];
  assert.equal(createAuth(f.stateDir).check({ headers: { cookie } }), true);
  assert.equal(auth.check({ headers: { cookie: previousCookie } }), false);
  assert.equal(auth.check({ headers: { cookie: cookie + 'x' } }), false);
  assert.throws(() => auth.login(config.key), /Invalid/);
  assert.throws(() => auth.login(''), /Invalid/);
  for (const key of ['', '   ', 'test\n', null, 123, 'x'.repeat(257)]) {
    await fs.writeFile(file, JSON.stringify({ ...config, key }));
    assert.throws(() => createAuth(f.stateDir), /Invalid/);
  }
});
