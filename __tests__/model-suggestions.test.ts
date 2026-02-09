import { describe, it, expect } from 'vitest';
import { suggestModels, buildModelNotFoundError } from '../src/utils/model-suggestions.js';

describe('suggestModels', () => {
  const availableModels = [
    'claude-sonnet-4',
    'claude-opus-4-5',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'gpt-4o',
    'gpt-4o-mini',
    'rp:best',
    'rp:fast',
    'rp:balanced',
  ];

  it('should suggest similar models for typos', () => {
    const suggestions = suggestModels('claud-sonnet', availableModels);
    expect(suggestions).toContain('claude-sonnet-4');
  });

  it('should suggest claude-sonnet-4 for "claude-sonet-4" typo', () => {
    const suggestions = suggestModels('claude-sonet-4', availableModels);
    expect(suggestions[0]).toBe('claude-sonnet-4');
  });

  it('should suggest gpt-4o for "gpt4o" typo', () => {
    const suggestions = suggestModels('gpt4o', availableModels);
    expect(suggestions).toContain('gpt-4o');
  });

  it('should return empty array for completely different strings', () => {
    const suggestions = suggestModels('totally-random-model-xyz', availableModels);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('should limit results to max parameter', () => {
    const suggestions = suggestModels('claude', availableModels, 2);
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it('should be case-insensitive', () => {
    const suggestions = suggestModels('CLAUDE-SONNET-4', availableModels);
    expect(suggestions).toContain('claude-sonnet-4');
  });

  it('should suggest rp:best for "rp:bst" typo', () => {
    const suggestions = suggestModels('rp:bst', availableModels);
    expect(suggestions).toContain('rp:best');
  });
});

describe('buildModelNotFoundError', () => {
  const availableModels = [
    'claude-sonnet-4',
    'claude-opus-4-5',
    'gpt-4o',
  ];

  it('should build error with suggestions for close match', () => {
    const error = buildModelNotFoundError('claude-sonet-4', availableModels);
    expect(error.error).toContain('claude-sonet-4');
    expect(error.error).toContain('does not exist');
    expect(error.suggestions).toBeDefined();
    expect(error.suggestions).toContain('claude-sonnet-4');
    expect(error.hint).toBe("Did you mean 'claude-sonnet-4'?");
  });

  it('should build error without suggestions for no close match', () => {
    const error = buildModelNotFoundError('totally-random-xyz-12345', availableModels);
    expect(error.error).toContain('totally-random-xyz-12345');
    expect(error.suggestions).toBeUndefined();
    expect(error.hint).toBeUndefined();
  });
});
