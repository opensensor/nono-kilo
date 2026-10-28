import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readJSON, atomicJSON, RequestError } from './core.mjs';
import path from 'node:path';

const COOKIE = 'opensensor_session';
const DAY = 24 * 60 * 60;
export function createAuth(stateDir) {
  const file = path.join(stateDir, 'browser-access.json');
  let auth = readJSON(file, null);
  if (!auth) { auth = { key: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() }; atomicJSON(file, auth); }
  // Keep random keys as the default, but allow a locally configured unlock key.
  if (typeof auth.key !== 'string' || !auth.key.trim() || auth.key.length > 256 || /[\x00-\x1f\x7f]/.test(auth.key)) throw new Error('Invalid dashboard browser access key.');
  const same = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
  const signature = payload => createHmac('sha256', auth.key).update(payload).digest('base64url');
  return {
    login(token) {
      if (typeof token !== 'string' || !same(token, auth.key)) throw new RequestError('Invalid dashboard access key.', 401);
      const payload = Buffer.from(JSON.stringify({ expires: Math.floor(Date.now() / 1000) + DAY, nonce: randomBytes(16).toString('hex') })).toString('base64url');
      return `${COOKIE}=${payload}.${signature(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DAY}`;
    },
    check(req) {
      const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!token) return false;
      const parts = token.split('.'); if (parts.length !== 2 || !same(signature(parts[0]), parts[1])) return false;
      try { return JSON.parse(Buffer.from(parts[0], 'base64url')).expires > Date.now() / 1000; } catch { return false; }
    },
    logout: () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  };
}
