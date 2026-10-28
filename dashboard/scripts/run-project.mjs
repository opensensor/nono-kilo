// Local terminal entrypoint. Resolve bound keyring values at launch, never in a
// copied shell command or a profile on disk. Proxy credentials remain isolated.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createPolicyStore } from '../lib/policy.mjs';
import { createSecretStore } from '../lib/secrets.mjs';
import { validateProject, buildRunArgs } from '../server.mjs';
import { inside } from '../lib/core.mjs';
try {
  const home = os.homedir(), workspace = process.env.OPENSENSOR_WORKSPACE || path.join(home, 'opensensor');
  const stateDir = process.env.OPENSENSOR_DASHBOARD_STATE || path.join(home, '.local/state/nono-kilo-dashboard');
  const configDir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const nono = process.env.OPENSENSOR_NONO || path.join(home, '.local/bin/nono'), kilo = process.env.OPENSENSOR_KILO || 'kilo';
  const project = await validateProject(await fs.realpath(process.argv[2]), workspace);
  const policies = createPolicyStore({ stateDir, configDir, workspace, sourceDir: fileURLToPath(new URL('..', import.meta.url)), execute: promisify(execFile), nono, kilo, secretStore: createSecretStore(stateDir) });
  const policy = await policies.launch(project);
  const env = { ...process.env, ...policy.supervisorEnv, KILO_DISABLE_AUTOUPDATE: 'true', TERM: process.env.TERM || 'xterm-256color' };
  env.PATH = (env.PATH || '/usr/bin:/bin').split(path.delimiter).filter(p => !policies.protectedRoots.some(root => inside(root, path.resolve(p)))).join(path.delimiter);
  const args = buildRunArgs({ name: `kilo-cli-${Date.now().toString(36)}`, interactive: true, model: policy.settings.defaultModel, autoApprove: policy.settings.autoApprove, profileName: policy.profileName, settings: policy.settings }, kilo);
  const child = spawn(nono, args, { cwd: project, env, stdio: 'inherit' });
  child.on('error', () => { console.error('Could not start the installed nono executable.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.status ? error.message : 'Could not start this project. Check its saved settings and local runtime.'); process.exitCode = 1; }
