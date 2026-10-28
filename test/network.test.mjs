import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyLine, cleanNetworkEvent, parseSocketTable, decodeAddress } from '../lib/network.mjs';

test('proxy telemetry accepts quoted tracing fields and excludes credentials, paths and reasons', () => {
  const allowed = parseProxyLine('2026-10-28T05:41:28.738811Z  INFO proxy request allowed mode=connect host="example.com" port=443 method="CONNECT" decision="allow"');
  assert.equal(allowed.host, 'example.com'); assert.equal(allowed.kind, 'allow'); assert.equal(allowed.method, 'CONNECT');
  const response = parseProxyLine('2026-10-28T05:41:33Z INFO l7 proxy response mode=reverse target="fixture" method="POST" path="/secret?token=DO_NOT_RETURN" status=200', { fixture: 'http://127.0.0.1:8123/v1' });
  assert.equal(response.host, '127.0.0.1'); assert.equal(response.port, 8123); assert.equal(response.kind, 'response'); assert.equal(JSON.stringify(response).includes('secret'), false);
  const denied = parseProxyLine('2026-10-28T05:41:33Z INFO proxy request denied mode=connect host=blocked.example port=443 decision=deny reason=DO_NOT_RETURN');
  assert.equal(denied.kind, 'deny'); assert.equal(JSON.stringify(denied).includes('DO_NOT_RETURN'), false);
  assert.equal(parseProxyLine('user output, not an audit event'), null);
  assert.equal(cleanNetworkEvent({ target: 'https://user:DO_NOT_RETURN@example.com/private', decision: 'allow', timestamp_unix_ms: 1 }).host, 'example.com');
});

test('socket tables expose only selected process inodes and decode Linux IPv4 and IPv6', () => {
  const table = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 0100007F:C001 08080808:01BB 01 0000:0000 00:0000 0 1000 0 123 1\n 1: 0100007F:C002 01010101:01BB 01 0000:0000 00:0000 0 1000 0 999 1\n';
  const sockets = parseSocketTable(table, 'tcp', new Map([['123', 'kilo']])); assert.equal(sockets.length, 1); assert.equal(sockets[0].host, '8.8.8.8'); assert.equal(sockets[0].port, 443); assert.equal(sockets[0].process, 'kilo');
  assert.equal(decodeAddress('00000000000000000000000001000000', true), '0:0:0:0:0:0:0:1');
});
