import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RequestError, inside } from './core.mjs';

export const gitDefaults = () => ({ enabled: true, local: 'read', systemConfig: false, globalConfig: false,
  authorName: '', authorEmail: '', fetch: false, push: false, remote: '', branches: ['main'],
  authentication: 'none', privateKey: '', knownHosts: '', agentSocket: '' });

export function parseGitRemote(value) {
  let host, user, port = 22, repository;
  const scp = value.match(/^([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+):([a-zA-Z0-9_./-]+)$/);
  if (scp) [, user, host, repository] = scp;
  else {
    let u; try { u = new URL(value); } catch { throw new RequestError('Use an SSH origin URL, such as git@github.com:opensensor/project.git.'); }
    if (u.protocol !== 'ssh:' || u.password || u.search || u.hash) throw new RequestError('Git remote access supports SSH URLs without passwords, queries or fragments.');
    host = u.hostname; user = u.username; port = Number(u.port || 22); repository = u.pathname;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(user) || !/^\/?[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(repository) || repository.split('/').some(p => p === '..' || p === '.') || repository.endsWith('/') || !Number.isInteger(port) || port < 1 || port > 65535) throw new RequestError('Use a literal SSH host, username and repository path; shell syntax and relative path components are not allowed.');
  return { host, user, port, repository, target: `${user}@${host}` };
}

export async function normalizeGit(input, { home, project, network, projectAccess, wsl2 = false }) {
  const g = { ...gitDefaults(), ...input };
  for (const key of Object.keys(g)) if (!(key in gitDefaults())) throw new RequestError(`Unsupported Git setting: ${key}`);
  for (const key of ['enabled', 'systemConfig', 'globalConfig', 'fetch', 'push']) if (typeof g[key] !== 'boolean') throw new RequestError(`Git ${key} must be on or off.`);
  if (!['read', 'write'].includes(g.local) || !['none', 'agent', 'key'].includes(g.authentication)) throw new RequestError('Choose a supported Git access and authentication mode.');
  for (const key of ['authorName', 'authorEmail', 'remote', 'privateKey', 'knownHosts', 'agentSocket']) {
    if (typeof g[key] !== 'string' || g[key].length > 500 || /[\x00-\x1f$]/.test(g[key])) throw new RequestError(`Invalid Git ${key}.`);
    g[key] = g[key].trim();
  }
  if (Boolean(g.authorName) !== Boolean(g.authorEmail)) throw new RequestError('Set both the Git author name and email, or leave both empty.');
  if (g.authorEmail && !/^[^\s<>@]+@[^\s<>@]+$/.test(g.authorEmail)) throw new RequestError('Enter a valid Git author email.');
  if (!Array.isArray(g.branches) || g.branches.length > 20 || g.branches.some(b => typeof b !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(b) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(b))) throw new RequestError('Push branches must be literal branch names, one per line; wildcards and refspecs are not allowed.');
  g.branches = [...new Set(g.branches)];
  if (!g.enabled) return g;
  if (projectAccess === 'read' && (g.local === 'write' || g.fetch || g.push)) throw new RequestError('Read-only projects require read-only Git commands with fetch and push disabled.');
  if (g.remote) parseGitRemote(g.remote);
  if (g.fetch || g.push) {
    if (network.mode === 'blocked') throw new RequestError('Remote Git operations conflict with blocked networking.');
    if (!g.remote) throw new RequestError('Set the exact SSH origin URL before enabling fetch or push.');
    const remote = parseGitRemote(g.remote);
    if (network.denyDomains.some(rule => { const [host, port] = rule.split(':'); return (!port || Number(port) === remote.port) && (host === remote.host || host.startsWith('*.') && remote.host.endsWith(host.slice(1))); })) throw new RequestError('The Git remote conflicts with a denied host.');
    if (g.push && !g.branches.length) throw new RequestError('Allow at least one explicit branch before enabling push.');
    if (g.authentication === 'none') throw new RequestError('Select an SSH agent or a specific key file for remote Git access.');
    if (wsl2 && g.authentication === 'agent') throw new RequestError('SSH agent authentication cannot be isolated on WSL2 because pathname socket mediation is unavailable. Use a dedicated key file for this repository.');
    async function sshFile(value, label) {
      let real; try { real = await fs.realpath(value); } catch { throw new RequestError(`${label} must be an existing file inside ~/.ssh.`); }
      const ssh = path.join(home, '.ssh');
      if (!inside(ssh, real) || real === ssh || inside(project, real) || !(await fs.stat(real)).isFile()) throw new RequestError(`${label} must be an individual file inside ~/.ssh, outside the project.`);
      return real;
    }
    g.knownHosts = await sshFile(g.knownHosts || path.join(home, '.ssh/known_hosts'), 'Known hosts');
    if (g.authentication === 'key') g.privateKey = await sshFile(g.privateKey, 'Private key');
    else {
      const socket = g.agentSocket || process.env.SSH_AUTH_SOCK;
      try { g.agentSocket = await fs.realpath(socket); if (!(await fs.stat(g.agentSocket)).isSocket() || inside(project, g.agentSocket)) throw new Error(); }
      catch { throw new RequestError('Choose an existing SSH agent socket outside the project, or use a key file.'); }
    }
  }
  return g;
}

const READ_COMMANDS = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'show-ref', 'for-each-ref', 'describe', 'blame', 'shortlog', 'rev-list', 'merge-base', 'check-ignore', 'check-attr', 'name-rev'];
const WRITE_COMMANDS = ['add', 'commit', 'branch', 'switch', 'checkout', 'restore', 'reset', 'rm', 'mv', 'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'tag', 'apply', 'am'];
const forms = (project, argv) => [argv, ['-C', project, ...argv], ['--no-pager', ...argv], ['--no-pager', '-C', project, ...argv]];

export async function compileGit(project, settings, { home, configDir }) {
  const g = { ...gitDefaults(), ...settings.git };
  if (!g.enabled) return null;
  // Command settings deliberately do not claim to protect raw .git writes in a
  // writable project. Linux cannot subtract .git from a writable parent grant.
  const gitDir = path.join(project, '.git');
  const helpers = ['/usr/lib/git-core', '/usr/libexec/git-core'].filter(existsSync);
  const env = { GIT_CONFIG_NOSYSTEM: g.systemConfig ? '0' : '1', GIT_CONFIG_GLOBAL: g.globalConfig ? path.join(home, '.gitconfig') : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat',
    GIT_SSH_VARIANT: 'ssh', GIT_SSH_COMMAND: 'ssh', GIT_ALLOW_PROTOCOL: 'ssh', GIT_PROTOCOL_FROM_USER: '0' };
  if (g.authorName) Object.assign(env, { GIT_AUTHOR_NAME: g.authorName, GIT_COMMITTER_NAME: g.authorName, GIT_AUTHOR_EMAIL: g.authorEmail, GIT_COMMITTER_EMAIL: g.authorEmail });
  const config = { 'core.hooksPath': '/dev/null', 'core.fsmonitor': 'false', 'core.pager': 'cat', 'core.excludesFile': '/dev/null', 'core.attributesFile': '/dev/null',
    'credential.helper': '', 'commit.gpgSign': 'false', 'tag.gpgSign': 'false', 'protocol.allow': 'never', 'protocol.ssh.allow': 'always',
    'core.sshCommand': 'ssh', 'submodule.recurse': 'false', 'fetch.recurseSubmodules': 'false', 'push.recurseSubmodules': 'no', 'remote.origin.mirror': 'false',
    ...(g.remote ? { 'remote.origin.url': g.remote, 'remote.origin.pushurl': g.remote } : {}) };
  const base = { fs_read: [project, ...helpers], fs_read_file: [], fs_write: [], exec_paths: helpers,
    environment: { allow_vars: ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_*', 'TERM'], set_vars: env },
    argv_prepend: ['--no-pager', '-C', project, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`])] };
  if (g.systemConfig && existsSync('/etc/gitconfig')) base.fs_read_file.push('/etc/gitconfig');
  if (g.globalConfig) base.fs_read_file.push(...[path.join(home, '.gitconfig'), path.join(configDir, 'git/config')].filter(existsSync));
  const allow = [], intercept = [];
  const permit = (argv, exact = false, write = []) => {
    for (const form of forms(project, argv)) {
      const match = { argv: { [exact ? 'exact' : 'prefix']: form } }; allow.push(match);
      if (write.length) intercept.push({ match, action: { type: 'passthrough' }, sandbox: { ...structuredClone(base), fs_write: write } });
    }
  };
  for (const cmd of READ_COMMANDS) permit([cmd]);
  permit(['--version'], true); permit(['remote', '-v'], true); permit(['remote', 'get-url', 'origin'], true);
  if (g.local === 'write' && settings.projectAccess !== 'read') for (const cmd of WRITE_COMMANDS) permit([cmd], false, [project]);
  const metadataWrite = existsSync(gitDir) && (await fs.stat(gitDir)).isDirectory() ? [gitDir] : [];
  if (g.fetch || g.push) {
    if (!metadataWrite.length) throw new RequestError('Remote Git permissions currently require a regular checkout with its own .git directory.');
    if (g.fetch) { permit(['fetch', 'origin'], true, metadataWrite); permit(['ls-remote', 'origin'], true); permit(['ls-remote', '--heads', 'origin'], true); }
    if (g.push) for (const branch of g.branches) for (const ref of [`HEAD:${branch}`, `HEAD:refs/heads/${branch}`, `${branch}:refs/heads/${branch}`, branch]) permit(['push', 'origin', ref], true, metadataWrite);
  }
  const commands = { git: { executable: '/usr/bin/git', can_use: [], from: { session: { sandbox: base, invocation_policy: { default: 'deny', allow } } }, intercept } };
  const credentials = {};
  if (g.fetch || g.push) {
    const remote = parseGitRemote(g.remote), file = [g.knownHosts];
    const args = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${g.knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none'];
    const useCredentials = [];
    if (g.authentication === 'key') { file.push(g.privateKey); args.push('-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-i', g.privateKey); }
    else { credentials['project-git-agent'] = { type: 'local-socket', path: g.agentSocket, mode: 'connect', env_var: 'SSH_AUTH_SOCK' }; useCredentials.push('project-git-agent'); args.push('-o', 'IdentityFile=none'); }
    const remoteCommands = [ ...(g.fetch ? ['git-upload-pack'] : []), ...(g.push ? ['git-receive-pack'] : []) ];
    const sshAllow = remoteCommands.flatMap(cmd => {
      const trailing = [...(remote.port !== 22 ? ['-p', String(remote.port)] : []), remote.target, `${cmd} '${remote.repository}'`];
      return [trailing, ['-o', 'SendEnv=GIT_PROTOCOL', ...trailing]].map(exact => ({ argv: { exact } }));
    });
    commands.git.can_use.push('ssh');
    commands.ssh = { executable: '/usr/bin/ssh', from: { session: 'deny', git: { sandbox: { fs_read_file: file, use_credentials: useCredentials,
      environment: { allow_vars: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'GIT_PROTOCOL'] }, argv_prepend: args, network: { tcp_connect_ports: [remote.port] } }, invocation_policy: { default: 'deny', allow: sshAllow } } } };
  }
  return { commands, ...(Object.keys(credentials).length ? { credentials } : {}) };
}
