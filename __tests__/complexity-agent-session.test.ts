/**
 * classifyComplexity must route by the ACTUAL task, not by how big the agent
 * session has grown. In an agent loop (Claude Code, OpenClaw, aider) the
 * context is 100K+ tokens and the history is long regardless of whether the
 * current ask is trivial or hard. The ambient session size must not force
 * everything to complex/elite (which over-spent on Opus/Fable).
 */
import { describe, it, expect } from 'vitest';
import { classifyComplexity } from '../src/standalone-proxy.js';

type Msg = { role: string; content: string };

/** Build a large multi-turn session ending in `lastUserText`. */
function agentSession(turns: number, tokensPerTurn: number, lastUserText: string): Msg[] {
  const filler = 'x'.repeat(tokensPerTurn * 4); // ~tokensPerTurn tokens
  const msgs: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: filler });
  }
  msgs.push({ role: 'user', content: lastUserText });
  return msgs;
}

describe('classifyComplexity: ambient session size does not dominate', () => {
  it('a trivial ask inside a huge 120K-token / 120-message session is NOT elite', () => {
    const messages = agentSession(120, 1000, 'thanks, looks good');
    const result = classifyComplexity(messages);
    expect(result).not.toBe('elite');
    // With the pre-fix +7 floor this landed on complex; now it should be low.
    expect(['simple', 'moderate']).toContain(result);
  });

  it('a trivial one-line ask in a long session is not forced to complex', () => {
    const messages = agentSession(60, 1000, 'continue');
    const result = classifyComplexity(messages);
    expect(['simple', 'moderate']).toContain(result);
  });

  it('a genuinely hard architecture+implementation ask scores high on content alone (complex or elite), no ambient needed', () => {
    const hard =
      'Architect and implement a distributed microservice system. First analyze ' +
      'the tradeoffs, then design the data model and refactor the auth layer. ' +
      'Compare JWT and mutual TLS and evaluate scalability and cost.';
    const result = classifyComplexity([{ role: 'user', content: hard }]);
    // Content-driven: this is a hard task, so it lands on the premium tier
    // purely from its own signals (architecture + implement + analyze + steps).
    expect(['complex', 'elite']).toContain(result);
  });

  it('a real multi-part coding task reaches complex on content regardless of session size', () => {
    const task = 'Implement and debug the distributed cache layer with proper error handling.';
    // short session
    expect(classifyComplexity([{ role: 'user', content: task }])).toBe('complex');
    // same task inside a huge session stays at least complex (content-driven), never forced to elite
    const inSession = classifyComplexity(agentSession(120, 1000, task));
    expect(['complex', 'elite']).toContain(inSession);
    expect(inSession).toBe('complex');
  });

  it('a genuinely large one-shot prompt is still caught via last-message size', () => {
    // single message, no multi-turn ambient, but a large detailed prompt
    const big = 'Please review and refactor this module. ' + 'code and logic here. '.repeat(400);
    const result = classifyComplexity([{ role: 'user', content: big }]);
    expect(['complex', 'elite']).toContain(result);
  });
});
