#!/usr/bin/env node

const PROXY_URL = 'http://127.0.0.1:3001';

async function callProxy(endpoint) {
  try {
    const response = await fetch(`${PROXY_URL}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(`Proxy error: ${error.message}`);
  }
}

function formatStats(stats) {
  const { 
    totalRuns,
    tokens,
    costs,
    modelDistribution,
  } = stats;

  let output = `**RelayPlane Statistics**\n`;
  output += `• **Requests:** ${totalRuns || 0} total\n\n`;

  if (tokens && (tokens.input > 0 || tokens.output > 0)) {
    output += `**📊 Token Usage**\n`;
    output += `• **Input:** ${(tokens.input || 0).toLocaleString()} tokens\n`;
    output += `• **Output:** ${(tokens.output || 0).toLocaleString()} tokens\n`;
    output += `• **Total:** ${(tokens.total || 0).toLocaleString()} tokens\n\n`;
  }

  if (costs && costs.actualUsd > 0) {
    output += `**💰 Cost Analysis**\n`;
    output += `• **Actual Cost:** $${costs.actualUsd}\n`;
    output += `• **Opus Baseline:** $${costs.opusBaselineUsd}\n`;
    output += `• **Savings:** $${costs.savingsUsd} (${costs.savingsPercent})\n\n`;
  }

  if (modelDistribution && Object.keys(modelDistribution).length > 0) {
    output += `**Models Used:**\n`;
    for (const [model, data] of Object.entries(modelDistribution)) {
      const shortModel = model.split('/')[1]?.replace(/^claude-/, '').replace(/-\d+.*$/, '') || model;
      let line = `• ${shortModel}: ${data.count} reqs`;
      if (data.tokens) {
        line += ` (${(data.tokens.input || 0).toLocaleString()}/${(data.tokens.output || 0).toLocaleString()} tokens)`;
      }
      if (data.costUsd !== undefined && data.costUsd > 0) {
        line += ` $${data.costUsd}`;
      }
      output += line + '\n';
    }
  }

  if (!tokens && !costs && (!modelDistribution || Object.keys(modelDistribution).length === 0)) {
    output += `\n_No requests tracked yet. Start using the proxy to see statistics._`;
  }

  return output;
}

function formatStatus(status) {
  const { enabled, mode, modelOverrides, uptimeMs } = status;
  
  let output = `**RelayPlane Status**\n`;
  output += `• **Enabled:** ${enabled ? '✅' : '❌'}\n`;
  if (uptimeMs) {
    const mins = Math.floor(uptimeMs / 60000);
    const secs = Math.floor((uptimeMs % 60000) / 1000);
    output += `• **Uptime:** ${mins}m ${secs}s\n`;
  }
  if (mode) {
    output += `• **Mode:** ${mode}\n`;
  }

  if (modelOverrides && Object.keys(modelOverrides).length > 0) {
    output += `\n**Model Overrides:**\n`;
    for (const [from, to] of Object.entries(modelOverrides)) {
      output += `• ${from} → ${to}\n`;
    }
  }

  return output;
}

async function switchMode(mode) {
  const validModes = ['auto', 'cost', 'fast', 'quality'];
  if (!validModes.includes(mode)) {
    return `❌ Invalid mode. Use: ${validModes.join(', ')}`;
  }
  return `Switch to **${mode}** mode:\n\`/model relayplane/${mode}\``;
}

function listModels() {
  return `**Available RelayPlane Models:**

• **relayplane/auto** - Smart cascade routing (starts cheap, escalates if needed)
• **relayplane/cost** - Always use cheapest model (Haiku)
• **relayplane/fast** - Fastest response model (Haiku) 
• **relayplane/quality** - Best quality model (Opus/Sonnet 4)

**Switch with:** \`/model <model-name>\``;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: /relayplane <stats|status|switch|models>');
    return;
  }

  const command = args[0];
  
  try {
    switch (command) {
      case 'stats':
        const stats = await callProxy('/stats');
        console.log(formatStats(stats));
        break;
        
      case 'status':
        const health = await callProxy('/health');
        console.log(formatStatus(health));
        break;
        
      case 'switch':
        if (args.length < 2) {
          console.log('Usage: /relayplane switch <auto|cost|fast|quality>');
          return;
        }
        console.log(await switchMode(args[1]));
        break;
        
      case 'models':
        console.log(listModels());
        break;
        
      default:
        console.log('Unknown command. Use: stats, status, switch, models');
    }
  } catch (error) {
    console.log(`❌ ${error.message}`);
  }
}

main().catch(console.error);
