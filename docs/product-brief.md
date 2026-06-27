# Product Brief — RelayPlane: "Bring Your Own Engines" for Claude Code

**One-liner:** Claude Code as the cockpit; bring your own engines. Keep the
world-class Claude Code harness as your coding orchestration shell, but route the
token-hungry agent/subagent work to cheaper quality models (MiniMax M3, DeepSeek
V4 Pro, GLM) — under the same roof, without leaving the shell you already live in.

## The insight

Claude Code's moat is the **harness**, not the model: the agent loop, tool-use,
file editing, permissions, hooks, skills, MCP, subagent teams, the UX. That
harness is separable from the model doing the tokens. RelayPlane exploits the gap:
run the **smartest model you can afford as the orchestrator** (Opus/Sonnet — cheap
in aggregate because it sips tokens at high leverage) and push the **high-volume
fan-out down to cheap workers** (MiniMax/DeepSeek/GLM). The cost asymmetry is
maximized precisely in an agent-fleet workload — which is exactly what Claude
Code's subagent teams generate.

This is **additive to Anthropic, not adversarial**: the orchestrator still bills
Claude. We help users do *more* inside Claude Code than their quota would
otherwise allow.

## Proof it works (live fork telemetry)

| | Requests | Cost | $/req |
|---|---|---|---|
| `claude-opus-4-8` (orchestrator) | 584 | $14.88 | $0.025 |
| `minimax/MiniMax-M3` (workers) | 1582 | $8.45 | **$0.0053** |

Workers did **3× the volume at ~⅕ the unit cost**, at 99.3% success. Had those
1582 worker calls run on Opus, that's ~**$40 instead of $8.45** — and quota would
have been exhausted far sooner.

## Target users

- **Primary — the cost-conscious Claude Code power user.** A strong solo AI
  engineer / indie hacker who lives in Claude Code, feels the token bill or hits
  quota, is comfortable running a local proxy + managing keys, and wants to keep
  Claude as the smart orchestrator while offloading bulk work to cheaper models —
  *without losing visibility into the cost/quality tradeoff.*
- **Secondary — the pre-platform small AI team (2–5).** Wants a self-hosted
  gateway with per-agent cost attribution before paying for Helicone/LangSmith/
  Portkey.
- **Anti-personas (not yet):** multi-tenant teams / production app traffic (no
  real auth; LAN bind exposes provider keys), and non-technical users (CLI + .env).

## The product underneath the router

A router is a commodity. The defensible layer is **task-to-model policy +
verification + a scoreboard**:

1. **Task-to-model fit** — learn which task classes survive cheap models
   (mechanical edits, test scaffolding, search/summarization, docs) vs. which must
   stay on Claude (architecture, subtle concurrency/security bugs).
2. **Claude-as-verifier** — the orchestrator gates worker output; cheap draft,
   Claude reviews the diff before it lands. Turns "cheap but risky" into "cheap and
   checked."
3. **Verified savings** — the north-star scoreboard the policy layer produces.

## North-star metric

> **Verified Savings Rate** = (Opus-baseline cost − actual cost) ÷ Opus-baseline
> cost, **discounted by quality-retries** (work that bounced back to Claude doesn't
> count as saved).

It captures all three things users care about in one number: are you saving money,
is the cheap work good enough, and is delegation actually firing.

## Why now / moat

Frontier-adjacent open/cheap models (MiniMax M3, DeepSeek V4) crossed the
"good-enough-for-bulk-coding" line while costing an order of magnitude less, *and*
Claude Code forwards arbitrary `vendor/model` slugs verbatim. The wedge is
operating at the **agent-orchestration layer inside the best coding harness** — a
sharper, stickier position than generic API routing (OpenRouter/LiteLLM/Portkey).

## Roadmap (3 milestones)

1. **Delegation integrity** — make the cheap-routing provably correct and visible
   (no silent leak to Opus; fix cosmetic mislabels; verified savings on the
   dashboard).
2. **Claude-as-verifier** — orchestrator quality gate on delegated diffs.
3. **Policy engine** — declarative task-class → model rules with cost/quality
   guardrails and automatic fallback.

## Key risks

- **Platform coupling (existential).** Rests on undocumented Claude Code
  slug-forwarding + OAuth passthrough. *Mitigation:* keep the policy/observability
  layer harness-portable (Cline, Cursor, OpenCode, raw Agent SDK) — Claude Code is
  the first cockpit, not the only one.
- **Silent quality degradation.** Cheap model emits plausible-but-wrong code.
  *Mitigation:* Claude-as-verifier as a first-class feature.
- **Protocol drift tax.** "Anthropic-compatible" endpoints lag the real Messages
  API (thinking blocks, tool formats, cache control, beta flags).
- **Provenance.** Mixed-model runs need per-step model attribution to debug.
