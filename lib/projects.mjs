import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RequestError, inside } from './core.mjs';

export async function validateProject(input, workspace) {
  if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f]/.test(input) || input.length > 8192) throw new RequestError('Enter a project directory.');
  const base = await fs.realpath(workspace);
  const requested = path.resolve(base, input.trim());
  let real;
  try { real = await fs.realpath(requested); } catch { throw new RequestError('Project directory is unavailable. Check the path and make sure its drive is mounted.'); }
  // Relative paths stay in the workspace. Outside projects need an explicit absolute path.
  if (!inside(base, real) && (!path.isAbsolute(input.trim()) || inside(base, requested))) throw new RequestError('Use an absolute path to add a project outside the workspace.');
  const home = os.homedir();
  const broad = ['/', home, base, '/home', '/run', '/run/media', `/run/media/${os.userInfo().username}`, '/mnt', '/media', '/tmp', '/var', '/opt'];
  const protectedTrees = ['/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var/lib', '/var/run',
    ...['.config', '.local', '.ssh', '.gnupg', '.codex', '.agents', '.password-store', '.nvm', '.npm', '.cargo', '.rustup', '.bun', '.pyenv'].map(p => path.join(home, p))];
  if (broad.includes(real) || protectedTrees.some(root => inside(root, real)) || (inside('/run', real) && !inside('/run/media', real)) || real.split(path.sep).includes('.git')) throw new RequestError('Choose an individual project directory, not a system, credential, home or workspace root.');
  if (!(await fs.stat(real)).isDirectory()) throw new RequestError('The project must be a directory.');
  // Mount roots can contain many unrelated projects. Require a specific directory below one.
  try {
    const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const roots = mounts.split('\n').map(line => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8))));
    if (roots.includes(real)) throw new RequestError('Choose a project folder on the drive, not the entire mounted drive.');
  } catch (error) { if (error instanceof RequestError) throw error; }
  return real;
}

export function projectMetadata(project, workspace, available = true) {
  const external = !inside(workspace, project);
  return { path: project, name: path.basename(project), relative: external ? project : path.relative(workspace, project),
    external, available, location: external ? path.dirname(project) : 'Workspace', demo: path.basename(project) === 'nono-kilo-demo' };
}
