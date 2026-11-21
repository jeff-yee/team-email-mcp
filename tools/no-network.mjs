// Offline guard for tests on any OS: node --import <file URL of this file> ...
// Any outbound socket, TLS connection or DNS lookup throws NO_NETWORK.
// Replaces the Linux-only `unshare -rn` outside the Linux sandbox.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const refuse = (what) => { throw new Error(`NO_NETWORK: ${what} blocked by tools/no-network.mjs`); };
net.Socket.prototype.connect = function connect() { refuse('net.Socket.connect'); };
net.connect = net.createConnection = () => refuse('net.connect');
tls.connect = () => refuse('tls.connect');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  dns[k] = () => refuse(`dns.${k}`);
  if (dns.promises?.[k]) dns.promises[k] = async () => refuse(`dns.promises.${k}`);
}
globalThis.fetch = async (u) => refuse(`fetch ${String(u).slice(0, 80)}`);
