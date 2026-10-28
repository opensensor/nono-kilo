// Local-only Git/SSH integration check. No user repository or remote is changed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { defaults, createPolicyStore } from '../lib/policy.mjs';
const exec = promisify(execFile), home = os.homedir();
const root = await fs.mkdtemp(path.join(home, 'opensensor/.nono-git-check-'));
const keys = await fs.mkdtemp(path.join(home, '.ssh/opensensor-check-'));
const project = path.join(root, 'project'), remote = path.join(root, 'remote.git'), stateDir = path.join(root, 'state'), configDir = path.join(root, 'config');
let sshd, agent, sshLog = '';
try {
  for (const dir of [project, stateDir, configDir]) await fs.mkdir(dir);
  await exec('git', ['init', '-q', '-b', 'main', project]); await exec('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  await fs.writeFile(path.join(project, 'sample.txt'), 'fixture\n');
  for (const file of ['client', 'host']) await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keys, file)]);
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await fs.writeFile(path.join(keys, 'known_hosts'), `[127.0.0.1]:${port} ${await fs.readFile(path.join(keys, 'host.pub'), 'utf8')}`);
  await fs.writeFile(path.join(root, 'sshd.conf'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${keys}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${keys}/client.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${os.userInfo().username}\nLogLevel ERROR\n`);
  sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(root, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] }); sshd.stderr.on('data', b => { sshLog += b; });
  await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(sshd.exitCode, null, sshLog);
  const nono = path.join(home, '.local/bin/nono');
  const store = createPolicyStore({ home, workspace: path.dirname(root), sourceDir: path.dirname(new URL(import.meta.url).pathname), stateDir, configDir, nono, execute: exec, secretStore: { list: () => [] } });
  const s = defaults(); s.runtimes = []; s.storage = 'isolated'; s.rollback.enabled = false; s.git.authorName = 'Git permission fixture'; s.git.authorEmail = 'fixture@example.invalid';
  const run = async (script, ok = true) => {
    const p = await store.preview(project, s); const profile = path.join(root, 'policy.json'); await fs.writeFile(profile, JSON.stringify(p.profile));
    // Prepare Kilo's declared storage paths even though this check runs Bash.
    for (const dir of [...p.profile.filesystem.allow, p.profile.environment.set_vars.TMPDIR]) await fs.mkdir(dir, { recursive: true });
    let result; try { result = await exec(nono, ['run', '--profile', profile, '--allow-cwd', '--no-rollback', '--', '/bin/bash', '-c', script], { cwd: project, timeout: 30000, maxBuffer: 256000 }); result.code = 0; } catch (e) { result = e; }
    if (ok) assert.equal(result.code, 0, result.stderr); else assert.notEqual(result.code, 0, result.stdout);
    return (result.stdout || '') + (result.stderr || '');
  };
  assert.match(await run('git status --short'), /sample.txt/);
  assert.match(await run('git add sample.txt', false), /denied/);
  s.git.local = 'write'; await run('git add sample.txt && git commit -m fixture');
  assert.equal((await exec('git', ['-C', project, 'log', '-1', '--format=%ae'])).stdout.trim(), 'fixture@example.invalid');
  assert.match(await run('git push origin main', false), /denied/);
  console.log('PASS inspect, local commit permission, explicit identity, push denied by default');
  s.git.remote = `ssh://${os.userInfo().username}@127.0.0.1:${port}${remote}`;
  s.git.authentication = 'key'; s.git.privateKey = path.join(keys, 'client'); s.git.knownHosts = path.join(keys, 'known_hosts'); s.git.fetch = true; s.git.push = true;
  await run('git push origin HEAD:main'); await run('git fetch origin');
  assert.match(await run(`cat '${keys}/client'`, false), /Permission denied/);
  for (const cmd of ['git push origin HEAD:other', 'git push --force origin HEAD:main', 'git push origin HEAD:main --force', 'git push', 'git -c core.sshCommand=cat push origin HEAD:main', `ssh -p ${port} ${os.userInfo().username}@127.0.0.1 id`]) assert.match(await run(cmd, false), /denied|blocked/);
  const socket = path.join(keys, 'agent.sock');
  agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' });
  for (let n = 0; n < 50; n++) { if (await fs.stat(socket).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  await exec('ssh-add', [path.join(keys, 'client')], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
  s.git.authentication = 'agent'; s.git.agentSocket = socket;
  await run('git fetch origin'); await run('git push origin HEAD:main');
  assert.match(await run(`SSH_AUTH_SOCK='${socket}' ssh-add -L`, false), /Permission denied|denied/);
  console.log('PASS SSH agent transport works only through the brokered Git command');
  // A poisoned repo URL cannot redirect the credential-bearing SSH transport.
  await exec('git', ['-C', project, 'config', 'url.ssh://elsewhere.invalid/.insteadOf', 'ssh://']);
  assert.match(await run('git fetch origin', false), /denied|blocked/);
  console.log('PASS real local SSH fetch/push, key unreadable to agent, other branches/force/overrides/direct SSH/redirects denied');
} catch (e) { console.error(e); console.error(sshLog); process.exitCode = 1; }
finally {
  if (agent?.exitCode === null) { agent.kill('SIGTERM'); await new Promise(resolve => agent.once('exit', resolve)); }
  if (sshd?.exitCode === null) { sshd.kill('SIGTERM'); await new Promise(resolve => sshd.once('exit', resolve)); }
  // All paths below were generated by this process.
  const { projectId } = await import('../lib/policy.mjs'); await fs.rm(path.join(home, '.local/share/opensensor-kilo-projects', projectId(project)), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(keys, { recursive: true, force: true });
}
