# @relayplane/proxy

Stop pinning your agents to one model. RelayPlane routes each request to
the one that fits the task.

A free, local proxy that sends every request to the right model by
complexity, so your traffic costs a fraction of running it all on the
frontier. It also meters each agent and kills runaway loops before they
burn your budget. It caught a 72,900-token agent stuck in a 21-minute loop
that produced nothing.

[![npm](https://img.shields.io/npm/v/@relayplane/proxy)](https://www.npmjs.com/package/@relayplane/proxy)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

RelayPlane is a proxy that runs on your machine. It is a drop-in
replacement for the OpenAI and Anthropic base URLs: no Docker, no
Python, no account, and nothing leaves your machine. MIT licensed, no
paid tiers, everything included.

## Quick start (30 seconds)

```bash
npm install -g @relayplane/proxy
relayplane start
```

Point Claude Code (or any tool that speaks the Anthropic or OpenAI API)
at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4100
claude
```

That is the whole setup. Open http://localhost:4100 for the live
dashboard, or run `relayplane watch` for a live cost ticker in your
terminal. Using API keys instead of Claude Code? `relayplane init`
walks you through it. 11 providers are supported, including OpenAI,
Anthropic, Google, xAI, Groq, and OpenRouter.

## What you get

- **Live cost intelligence.** Every request priced as it happens, with
  per-model and per-agent breakdowns, in a local dashboard and CLI.
- **Model routing.** Send simple work to cheap models and hard work to
  frontier models, by complexity tier or per agent. Changing models is
  a config edit, never a code change.
- **Spend guardrails.** Hard budget caps (block, downgrade, or warn),
  plus anomaly detection that catches velocity spikes, token-explosion
  loops, and repetition before they become a bill.
- **Failover.** Circuit breaker and cross-provider cascade: a 429 on
  one provider fails over instead of failing your run.
- **Local and private by default.** Passthrough is the default mode:
  your credentials and traffic stay yours. No telemetry required.

## Why we built it (and how we know it works)

We run an autonomous engineering pipeline that ships real code every
day, and all of its traffic goes through RelayPlane. Over the last four
months that is 6,000+ pipeline runs at roughly 1,900 requests a day,
routed, priced, and guarded by this proxy.

The payoff is the swap seam. When we wanted to test a cheaper coding
model, we changed two fields in one config file, watched the live cost
pane, and reverted nine hours later when the numbers said no:

```jsonc
// one role, one edit, no code changes
"coder": { "provider": "anthropic", "model": "claude-sonnet-5" }
// vs
"coder": { "provider": "opencode", "model": "openrouter/moonshotai/kimi-k3" }
```

If you run agents seriously, this is the control you are missing: one
pane for spend, one seam for swapping models, one place to say "never
spend more than this."

## How it compares

| | RelayPlane | claude-code-router | LiteLLM | OpenRouter |
|---|---|---|---|---|
| Runs locally | yes | yes | yes | no (cloud) |
| Anthropic API compatible | yes | yes | partial | no |
| Live per-agent cost pane | yes | per-request estimates | budgets (platform teams) | dashboard (cloud) |
| Spend guardrails (caps, anomaly, kill) | yes | no | budgets | no |
| Free / open source | MIT, everything | MIT | OSS + paid enterprise | 5.5% fee |

Different tools for different jobs: LiteLLM is built for platform
teams, OpenRouter is a hosted marketplace, claude-code-router focuses
on multi-agent orchestration. RelayPlane is the local cost-and-control
pane for people who run agents on their own machine.

## Auto-start with Claude Code

Add to `~/.claude/settings.json` so the proxy is always up when you open
Claude Code:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4100"
  }
}
```

In passthrough mode RelayPlane forwards your own credentials untouched,
so Claude Code keeps its own login. RelayPlane observes, routes, and
meters; it does not change your identity to the provider.

## Docs

- [Quickstart](https://relayplane.com/docs/quickstart)
- [Configuration](https://relayplane.com/docs) (routing, cascade,
  budgets, anomaly detection, cache, credential pool)
- [Claude Code integration](https://relayplane.com/docs/claude-code)
- [CLI reference](https://relayplane.com/docs/cli)
- [Changelog](https://github.com/RelayPlane/proxy/releases)

## Privacy

Passthrough by default: RelayPlane forwards your own credentials and
does not modify your traffic unless you turn routing on. The optional
mesh (shared, anonymized routing signals) can be disabled with
`relayplane mesh off`. Your prompts stay on your machine.

## License

MIT. No paid tiers. Everything in this repo is the whole product.
