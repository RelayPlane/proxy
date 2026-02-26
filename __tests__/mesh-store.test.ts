import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeshStore } from '../src/mesh/store.js';

describe('MeshStore', () => {
  let store: MeshStore;

  beforeEach(() => {
    store = new MeshStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('inserts and retrieves an atom', () => {
    const atom = store.insert({
      type: 'tool',
      observation: 'test observation',
      context: '{}',
      confidence: 0.8,
      fitness_score: 0.9,
      trust_tier: 'local',
      source_agent_hash: 'test',
      decay_rate: 0.99,
    });

    expect(atom.id).toBeTruthy();
    expect(atom.observation).toBe('test observation');

    const retrieved = store.getById(atom.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.observation).toBe('test observation');
  });

  it('counts atoms', () => {
    expect(store.count()).toBe(0);
    store.insert({ type: 'tool', observation: 'a', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    store.insert({ type: 'tool', observation: 'b', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    expect(store.count()).toBe(2);
  });

  it('tracks synced/unsynced atoms', () => {
    const a1 = store.insert({ type: 'tool', observation: 'a', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    const a2 = store.insert({ type: 'tool', observation: 'b', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });

    expect(store.getUnsynced()).toHaveLength(2);
    expect(store.countSynced()).toBe(0);

    store.markSynced([a1.id]);
    expect(store.getUnsynced()).toHaveLength(1);
    expect(store.countSynced()).toBe(1);
  });

  it('updates fitness score', () => {
    const atom = store.insert({ type: 'tool', observation: 'a', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    store.updateFitness(atom.id, 0.95);
    const updated = store.getById(atom.id);
    expect(updated!.fitness_score).toBe(0.95);
  });

  it('getTopByFitness returns ordered results', () => {
    store.insert({ type: 'tool', observation: 'low', context: '{}', confidence: 0.5, fitness_score: 0.1, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    store.insert({ type: 'tool', observation: 'high', context: '{}', confidence: 0.5, fitness_score: 0.9, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });
    store.insert({ type: 'tool', observation: 'mid', context: '{}', confidence: 0.5, fitness_score: 0.5, trust_tier: 'local', source_agent_hash: 'x', decay_rate: 0.99 });

    const top = store.getTopByFitness(2);
    expect(top).toHaveLength(2);
    expect(top[0]!.observation).toBe('high');
    expect(top[1]!.observation).toBe('mid');
  });

  it('manages sync meta', () => {
    expect(store.getLastPushAt('http://example.com')).toBeNull();
    store.setLastPushAt('http://example.com', '2026-01-01T00:00:00Z');
    expect(store.getLastPushAt('http://example.com')).toBe('2026-01-01T00:00:00Z');
  });
});
