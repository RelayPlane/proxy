import { startProxy } from './dist/index.js';

const server = await startProxy({ port: 3002 });
console.log('Server started');

// Test /health
const health = await fetch('http://localhost:3002/health');
console.log('GET /health:', await health.json());

// Test /stats
const stats = await fetch('http://localhost:3002/stats');
console.log('GET /stats:', await stats.json());

// Test /runs
const runs = await fetch('http://localhost:3002/runs');
console.log('GET /runs:', await runs.json());

// Make a test call to generate a run
const testCall = await fetch('http://localhost:3002/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'relayplane:cost',
    messages: [{ role: 'user', content: 'Say hi' }],
  }),
});
const result = await testCall.json();
console.log('Test call routed to:', result._relayplane?.routedTo);

// Check /runs again
const runs2 = await fetch('http://localhost:3002/runs');
console.log('GET /runs after call:', await runs2.json());

server.close();
process.exit(0);
