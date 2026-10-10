// Railway stops the old copy with SIGTERM on every deploy: the server
// finishes in-flight requests and exits 0 (no "npm error signal SIGTERM").
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { shutdown } from '../server/index.js';

describe('shutdown on SIGTERM', () => {
  it('stops listening and exits 0 once open requests finish', async () => {
    let release;
    const server = http.createServer((req, res) => { release = () => res.end('ok'); });
    await new Promise(r => server.listen(0, r));
    const { port } = server.address();
    const reply = new Promise(r => http.get({ port, agent: false }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => r(b)); }));
    await new Promise(r => setTimeout(r, 50));
    const exited = new Promise(r => shutdown(server, { exit: r, log: () => {} }));
    expect(server.listening).toBe(false);
    release();
    expect(await reply).toBe('ok');
    expect(await exited).toBe(0);
  });

  it('exits 0 after the grace period if a request hangs', async () => {
    const server = http.createServer(() => {});
    await new Promise(r => server.listen(0, r));
    const { port } = server.address();
    const req = http.get({ port, agent: false }).on('error', () => {});
    await new Promise(r => setTimeout(r, 50));
    const code = await new Promise(r => shutdown(server, { exit: r, graceMs: 100, log: () => {} }));
    expect(code).toBe(0);
    req.destroy();
    server.closeAllConnections();
  });
});
