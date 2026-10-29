import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../lib/policy.mjs';
import { applyPreset, PRESETS } from '../lib/presets.mjs';

test('workspace presets change only access controls and preserve agent configuration', () => {
  const base = defaults(); base.harness = 'codex'; base.network.allowDomains = ['api.example.com'];
  base.network.mode = 'restricted'; base.extraPaths = [{ path: '/tmp/reference', access: 'readwrite' }];
  base.git.local = 'write'; base.git.fetch = true; base.git.authentication = 'key';
  for (const preset of PRESETS) {
    const next = applyPreset(base, preset);
    assert.equal(next.harness, 'codex');
    assert.equal(next.projectAccess, preset === 'review' ? 'read' : 'readwrite');
    assert.equal(next.network.mode, { standard: 'unrestricted', learning: 'learning', guided: 'approval', review: 'approval', restricted: 'restricted', offline: 'blocked' }[preset]);
  }
  const review = applyPreset(base, 'review');
  assert.equal(review.extraPaths[0].access, 'read'); assert.equal(review.git.local, 'read'); assert.equal(review.git.fetch, false);
  assert.equal(base.git.local, 'write'); assert.equal(base.extraPaths[0].access, 'readwrite');
  assert.deepEqual(applyPreset(base, 'restricted').network.allowDomains, ['api.example.com']);
  assert.deepEqual(applyPreset(base, 'offline').network.allowDomains, []);
  assert.throws(() => applyPreset(base, 'anything'), /supported preset/);
});
