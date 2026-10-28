import os from 'node:os';

const authority = (host, port) => `${host.includes(':') ? `[${host}]` : host.toLowerCase()}:${port}`;

// Accept only names belonging to this server, not every Host header whose
// Origin happens to agree. The latter would allow DNS rebinding attacks.
export function dashboardOrigin(req, server) {
  const bound = server.address(); if (!bound || typeof bound === 'string') return null;
  const names = new Set(['localhost', '127.0.0.1', '::1', bound.address]);
  if (['0.0.0.0', '::'].includes(bound.address)) {
    for (const addresses of Object.values(os.networkInterfaces())) for (const { address } of addresses || []) names.add(address);
    const hostname = os.hostname().toLowerCase(); names.add(hostname);
    if (!hostname.includes('.')) names.add(`${hostname}.local`);
  }
  const hosts = new Set([...names].map(name => authority(name, bound.port)));
  const host = req.headers.host?.toLowerCase();
  if (!host || !hosts.has(host)) return null;
  const origin = `http://${host}`;
  return req.headers.origin && req.headers.origin !== origin ? null : origin;
}
