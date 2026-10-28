import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPolicyStore, defaults } from '../lib/policy.mjs';
import { buildRunArgs } from '../server.mjs';

test('native agent commands keep prompts literal and require explicit Codex batch approval', () => {
  const binaries = { kilo: '/bin/kilo', claude: '/bin/claude', codex: '/bin/codex' };
  const prompt = '--help $(touch /tmp/never-run)';
  const claude = buildRunArgs({ name: 'claude-test', harness: 'claude', prompt, interactive: false, model: '', autoApprove: false }, binaries);
  assert.deepEqual(claude.slice(-6), ['/bin/claude', '--print', '--permission-prompts', 'none', '--', prompt]);
  assert.equal(claude.at(-1), prompt);
  assert.equal(claude.includes('--dangerously-skip-permissions'), false);
  const codex = buildRunArgs({ name: 'codex-test', harness: 'codex', prompt, interactive: true, model: '', autoApprove: false }, binaries);
  assert.deepEqual(codex.slice(-3), ['on-request', '--', prompt]);
  assert.equal(codex.includes('exec'), false);
  assert.throws(() => buildRunArgs({ name: 'codex-test', harness: 'codex', prompt, interactive: false, autoApprove: false }, binaries), /auto approval/);
  const batch = buildRunArgs({ name: 'codex-test', harness: 'codex', prompt, interactive: false, autoApprove: true }, binaries);
  assert.deepEqual(batch.slice(-3), ['exec', '--', prompt]);
  assert.ok(batch.includes('never'));
});

test('project policies inherit the selected registry pack and preserve old Kilo settings', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'opensensor-harness-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project'), stateDir = path.join(temp, 'state');
  await fs.mkdir(project); await fs.mkdir(stateDir);
  const store = createPolicyStore({ stateDir, configDir: path.join(temp, 'config'), workspace: temp, sourceDir: path.join(temp, 'controller'),
    execute: async () => ({ stdout: 'valid' }), nono: '/bin/nono', kilo: '/bin/kilo', claude: '/bin/claude', codex: '/bin/codex',
    secretStore: { list: () => [] }, home: temp, wsl2: true, proxyUnsupported: true });
  const base = store.defaultSettings();
  for (const [harness, pack] of [['kilo', 'default'], ['claude', 'nolabs-ai/claude'], ['codex', 'nolabs-ai/codex']]) {
    const result = await store.preview(project, { ...base, harness });
    assert.equal(result.profile.extends, pack);
    assert.equal(result.settings.harness, harness);
    assert.equal(result.profile.environment.set_vars.XDG_CONFIG_HOME, path.join(temp, 'config'));
  }
  await assert.rejects(store.preview(project, { ...base, harness: 'codex', storage: 'isolated' }), /shared runtime storage/);
  const legacy = defaults(); legacy.git.enabled = false; delete legacy.harness; delete legacy.nativeModels;
  await fs.writeFile(path.join(stateDir, 'project-settings.json'), JSON.stringify({ [project]: { revision: 2, settings: legacy, history: [] } }));
  assert.equal((await store.describe(project)).profile.extends, 'default');
  assert.equal((await store.preview(project, legacy)).settings.harness, 'kilo');
});
