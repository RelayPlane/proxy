/**
 * RelayPlane Proxy Launcher
 *
 * Entry point spawned as a child process by ProcessManager.
 * Starts a standalone HTTP server with /health endpoint.
 *
 * @packageDocumentation
 */

import * as http from 'node:http';
import { handleHealthRequest } from './health.js';

const port = parseInt(process.env['RELAYPLANE_PROXY_PORT'] ?? process.env['RELAYPLANE_PORT'] ?? '4100', 10);
const host = process.env['RELAYPLANE_PROXY_HOST'] ?? '127.0.0.1';

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0] ?? '';

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
    handleHealthRequest(res);
    return;
  }

  // For now, all other requests get a minimal response.
  // The full proxy logic (standalone-proxy.ts) can be wired in later.
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, host, () => {
  console.log(`RelayPlane proxy launcher listening on http://${host}:${port}`);
});

// Graceful shutdown
function shutdown() {
  console.log('RelayPlane proxy launcher shutting down...');
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
