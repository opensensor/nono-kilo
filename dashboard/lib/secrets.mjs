import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, atomicJSON, RequestError } from './core.mjs';

const helper = fileURLToPath(new URL('../scripts/keyring.py', import.meta.url));
export function keyringCall(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helper], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new RequestError('The system keyring did not respond. Unlock it in your desktop password manager.', 503)); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 200000) { child.kill(); finish(new RequestError('Invalid keyring response.', 503)); } });
    child.on('error', () => finish(new RequestError('Could not access the system keyring.', 503)));
    child.on('close', () => {
      try { const result = JSON.parse(output); output = ''; if (result.error) finish(new RequestError(result.error, 503)); else finish(null, result); }
      catch { finish(new RequestError('Could not access the system keyring.', 503)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export function createSecretStore(stateDir, call = keyringCall) {
  const file = path.join(stateDir, 'secret-metadata.json');
  const load = () => readJSON(file, []);
  return {
    list: load,
    async status() { try { return await call({ action: 'status' }); } catch { return { available: false, locked: true, backend: 'Secret Service' }; } },
    async save(body) {
      if (typeof body.name !== 'string' || !/^[\w .:@/-]{1,80}$/.test(body.name.trim())) throw new RequestError('Use a secret name of 1–80 letters, digits, spaces or . : @ / - _.');
      if (typeof body.value !== 'string' || body.value.length < 8 || body.value.length > 16384 || body.value.includes('\0')) throw new RequestError('Secret values must contain 8–16,384 characters without NUL bytes.');
      const records = load();
      const previous = body.id ? records.find(s => s.id === body.id) : null;
      if (body.id && !previous) throw new RequestError('Secret not found.', 404);
      if (records.some(s => s.name === body.name.trim() && s.id !== body.id)) throw new RequestError('A secret with that name already exists.');
      const id = previous?.id || randomBytes(16).toString('hex');
      await call({ action: 'put', id, name: body.name.trim(), value: body.value });
      const record = { id, name: body.name.trim(), description: String(body.description || '').slice(0, 300), enabled: previous?.enabled ?? true,
        createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), version: (previous?.version || 0) + 1 };
      atomicJSON(file, [...records.filter(s => s.id !== id), record]);
      return record;
    },
    async setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new RequestError('Enabled must be true or false.');
      const records = load(); const record = records.find(s => s.id === id);
      if (!record) throw new RequestError('Secret not found.', 404);
      record.enabled = enabled; record.updatedAt = new Date().toISOString(); atomicJSON(file, records); return record;
    },
    async remove(id) {
      const records = load(); if (!records.some(s => s.id === id)) throw new RequestError('Secret not found.', 404);
      await call({ action: 'delete', id }); atomicJSON(file, records.filter(s => s.id !== id));
    },
    async resolve(ids) {
      const records = load(); const values = new Map();
      for (const id of new Set(ids)) {
        const record = records.find(s => s.id === id);
        if (!record?.enabled) throw new RequestError(`A bound secret is missing or disabled. Update the project's Secrets settings.`, 409);
        const result = await call({ action: 'get', id });
        if (typeof result.value !== 'string' || !result.value) throw new RequestError('A bound secret is missing from the system keyring.', 503);
        values.set(id, result.value);
      }
      return values;
    }
  };
}
