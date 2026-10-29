import { RequestError } from './core.mjs';

export const PRESETS = ['standard', 'learning', 'guided', 'review', 'restricted', 'offline'];

export function applyPreset(settings, preset) {
  if (!PRESETS.includes(preset)) throw new RequestError('Choose a supported preset.');
  const next = structuredClone(settings);
  next.projectAccess = preset === 'review' ? 'read' : 'readwrite';
  if (preset === 'review') {
    next.extraPaths = next.extraPaths.map(grant => ({ ...grant, access: 'read' }));
    next.git.local = 'read'; next.git.fetch = false; next.git.push = false; next.git.authentication = 'none';
  }
  if (preset === 'offline') { next.git.fetch = false; next.git.push = false; next.git.authentication = 'none'; }
  next.network.mode = { standard: 'unrestricted', learning: 'learning', guided: 'approval', review: 'approval', restricted: 'restricted', offline: 'blocked' }[preset];
  next.network.connectPorts = [];
  if (['standard', 'offline'].includes(preset)) next.network = { mode: next.network.mode, allowDomains: [], denyDomains: [], connectPorts: [], listenPorts: [] };
  return next;
}
