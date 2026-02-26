import { describe, it, expect } from 'vitest';
import {
  checkDowngrade,
  applyDowngradeHeaders,
  DEFAULT_DOWNGRADE_CONFIG,
  DEFAULT_DOWNGRADE_MAPPING,
  type DowngradeConfig,
} from '../src/downgrade.js';

describe('Auto-Downgrade', () => {
  const config: DowngradeConfig = {
    enabled: true,
    thresholdPercent: 80,
    mapping: { ...DEFAULT_DOWNGRADE_MAPPING },
  };

  describe('checkDowngrade', () => {
    it('does not downgrade when disabled', () => {
      const result = checkDowngrade('claude-opus-4-6', 90, { ...config, enabled: false });
      expect(result.downgraded).toBe(false);
      expect(result.newModel).toBe('claude-opus-4-6');
    });

    it('does not downgrade when under threshold', () => {
      const result = checkDowngrade('claude-opus-4-6', 50, config);
      expect(result.downgraded).toBe(false);
    });

    it('downgrades opus to sonnet at threshold', () => {
      const result = checkDowngrade('claude-opus-4-6', 80, config);
      expect(result.downgraded).toBe(true);
      expect(result.originalModel).toBe('claude-opus-4-6');
      expect(result.newModel).toBe('claude-sonnet-4-6');
      expect(result.reason).toContain('80.0%');
    });

    it('downgrades sonnet to haiku', () => {
      const result = checkDowngrade('claude-sonnet-4-6', 90, config);
      expect(result.downgraded).toBe(true);
      expect(result.newModel).toBe('claude-3-5-haiku-20241022');
    });

    it('downgrades gpt-4o to gpt-4o-mini', () => {
      const result = checkDowngrade('gpt-4o', 85, config);
      expect(result.downgraded).toBe(true);
      expect(result.newModel).toBe('gpt-4o-mini');
    });

    it('downgrades o1 to o3-mini', () => {
      const result = checkDowngrade('o1', 95, config);
      expect(result.downgraded).toBe(true);
      expect(result.newModel).toBe('o3-mini');
    });

    it('downgrades gemini pro to flash', () => {
      const result = checkDowngrade('gemini-2.5-pro', 80, config);
      expect(result.downgraded).toBe(true);
      expect(result.newModel).toBe('gemini-2.0-flash');
    });

    it('does not downgrade unknown model', () => {
      const result = checkDowngrade('some-unknown-model', 90, config);
      expect(result.downgraded).toBe(false);
      expect(result.reason).toBe('no mapping available');
    });

    it('downgrades at exactly threshold', () => {
      const result = checkDowngrade('claude-opus-4-6', 80, config);
      expect(result.downgraded).toBe(true);
    });

    it('does not downgrade at 79.9%', () => {
      const result = checkDowngrade('claude-opus-4-6', 79.9, config);
      expect(result.downgraded).toBe(false);
    });

    it('works with custom threshold', () => {
      const result = checkDowngrade('claude-opus-4-6', 60, { ...config, thresholdPercent: 50 });
      expect(result.downgraded).toBe(true);
    });

    it('works with custom mapping', () => {
      const result = checkDowngrade('my-model', 90, {
        ...config,
        mapping: { 'my-model': 'my-cheaper-model' },
      });
      expect(result.downgraded).toBe(true);
      expect(result.newModel).toBe('my-cheaper-model');
    });
  });

  describe('applyDowngradeHeaders', () => {
    it('adds headers when downgraded', () => {
      const headers: Record<string, string> = {};
      applyDowngradeHeaders(headers, {
        downgraded: true,
        originalModel: 'claude-opus-4-6',
        newModel: 'claude-sonnet-4-6',
        reason: 'budget at 85%',
      });
      expect(headers['X-RelayPlane-Downgraded']).toBe('true');
      expect(headers['X-RelayPlane-Downgrade-Reason']).toBe('budget at 85%');
      expect(headers['X-RelayPlane-Original-Model']).toBe('claude-opus-4-6');
    });

    it('does not add headers when not downgraded', () => {
      const headers: Record<string, string> = {};
      applyDowngradeHeaders(headers, {
        downgraded: false,
        originalModel: 'claude-opus-4-6',
        newModel: 'claude-opus-4-6',
        reason: '',
      });
      expect(headers['X-RelayPlane-Downgraded']).toBeUndefined();
    });
  });

  describe('DEFAULT_DOWNGRADE_CONFIG', () => {
    it('has expected defaults', () => {
      expect(DEFAULT_DOWNGRADE_CONFIG.enabled).toBe(false);
      expect(DEFAULT_DOWNGRADE_CONFIG.thresholdPercent).toBe(80);
      expect(Object.keys(DEFAULT_DOWNGRADE_CONFIG.mapping).length).toBeGreaterThan(5);
    });
  });

  describe('mapping coverage', () => {
    it('covers all major expensive models', () => {
      const mapping = DEFAULT_DOWNGRADE_MAPPING;
      expect(mapping['claude-opus-4-6']).toBeDefined();
      expect(mapping['claude-sonnet-4-6']).toBeDefined();
      expect(mapping['gpt-4o']).toBeDefined();
      expect(mapping['gpt-4']).toBeDefined();
      expect(mapping['o1']).toBeDefined();
      expect(mapping['gemini-2.5-pro']).toBeDefined();
      expect(mapping['gemini-1.5-pro']).toBeDefined();
    });
  });
});
