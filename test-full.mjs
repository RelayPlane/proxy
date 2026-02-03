import { startProxy } from './dist/index.js';

const server = await startProxy({ port: 3002, verbose: true });

// Make a test call
const testCall = await fetch('http://localhost:3002/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'relayplane:cost',
    messages: [{ role: 'user', content: 'Say hi in exactly 3 words' }],
  }),
});
const result = await testCall.json();
console.log('\n=== Test Call Result ===');
console.log('Routed to:', result._relayplane?.routedTo);
console.log('Task type:', result._relayplane?.taskType);
console.log('Mode:', result._relayplane?.mode);
console.log('Duration:', result._relayplane?.durationMs + 'ms');

// Wait for async run recording
await new Promise(r => setTimeout(r, 500));

// Check /runs
const runs = await fetch('http://localhost:3002/runs');
console.log('\n=== /runs ===');
console.log(JSON.stringify(await runs.json(), null, 2));

// Check /stats
const stats = await fetch('http://localhost:3002/stats');
console.log('\n=== /stats ===');
console.log(JSON.stringify(await stats.json(), null, 2));

// Check /health
const health = await fetch('http://localhost:3002/health');
console.log('\n=== /health ===');
console.log(JSON.stringify(await health.json(), null, 2));

server.close();
process.exit(0);
