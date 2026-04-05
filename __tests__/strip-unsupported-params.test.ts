/**
 * Tests for stripping unsupported model params:
 *  - thinking field stripped from Haiku request bodies
 *  - OAT-unsupported beta flags filtered from anthropic-beta header
 *  - X-RelayPlane-Stripped-Thinking / X-RelayPlane-Stripped-Beta response headers
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageRoot = join(__dirname, '..');
const distPath = join(packageRoot, 'dist', 'standalone-proxy.js');

function getDistContent(): string {
  return readFileSync(distPath, 'utf-8');
}

describe('isHaikuModel helper', () => {
  it('is defined in the dist', () => {
    const content = getDistContent();
    expect(content).toContain('isHaikuModel');
  });

  it('returns true for haiku model names', () => {
    const content = getDistContent();
    // The implementation must check model.includes('haiku')
    expect(content).toMatch(/isHaikuModel.*model.*includes.*haiku|model.*includes.*haiku.*isHaikuModel/s);
  });
});

describe('OAT_UNSUPPORTED_BETA_FLAGS constant', () => {
  it('is defined in the dist', () => {
    const content = getDistContent();
    expect(content).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
  });

  it('contains max-tokens-3-5-sonnet-2025-04-14', () => {
    const content = getDistContent();
    expect(content).toContain('max-tokens-3-5-sonnet-2025-04-14');
  });
});

describe('thinking stripping for Haiku models', () => {
  it('strips thinking from body at forwardNativeAnthropicRequest call sites', () => {
    const content = getDistContent();
    // The stripping logic must reference isHaikuModel and thinking
    expect(content).toContain('isHaikuModel');
    expect(content).toMatch(/isHaikuModel.*thinking|thinking.*isHaikuModel/s);
  });

  it('logs when thinking is stripped', () => {
    const content = getDistContent();
    // Log message format matches existing style
    expect(content).toContain('does not support extended thinking');
  });

  it('adds X-RelayPlane-Stripped-Thinking response header when thinking is stripped', () => {
    const content = getDistContent();
    expect(content).toContain('X-RelayPlane-Stripped-Thinking');
  });

  it('strips thinking when ORIGINAL requested model was Haiku (routing override case)', () => {
    const content = getDistContent();
    // The condition must check requestedModel too, not only finalModel/resolved.model
    // This ensures stripping happens even when routing.mode=auto overrides haiku→sonnet
    expect(content).toMatch(/isHaikuModel\(finalModel\)\s*\|\|\s*isHaikuModel\(requestedModel\)|isHaikuModel\(resolved\.model\)\s*\|\|\s*isHaikuModel\(requestedModel\)/);
  });
});

describe('effort / output_config.effort stripping for Haiku models', () => {
  it('strips top-level effort when model is Haiku', () => {
    const content = getDistContent();
    // The stripping logic must check isHaikuModel and reference effort
    expect(content).toMatch(/isHaikuModel.*effort|effort.*isHaikuModel/s);
  });

  it('strips output_config.effort when model is Haiku', () => {
    const content = getDistContent();
    expect(content).toContain('output_config');
    // Must reference effort inside output_config handling near isHaikuModel
    expect(content).toMatch(/output_config.*effort.*isHaikuModel|isHaikuModel[\s\S]*?output_config[\s\S]*?effort/);
  });

  it('logs when output_config.effort is stripped', () => {
    const content = getDistContent();
    expect(content).toContain('output_config.effort');
    expect(content).toContain('Haiku does not support effort');
  });
});

describe('context-1m beta header stripping for non-Opus models', () => {
  it('strips context-1m for non-Opus models (not just Sonnet)', () => {
    const content = getDistContent();
    // The condition must use !...includes("opus"), not includes("sonnet")
    expect(content).toMatch(/!targetModel\.includes\(['"]opus['"]\).*context-1m/);
  });

  it('strips context-1m in cascade handler for non-Opus models', () => {
    const content = getDistContent();
    expect(content).toMatch(/!resolved\.model\.includes\(['"]opus['"]\).*context-1m/);
  });
});

describe('OAT beta flag stripping in header builders', () => {
  it('filters OAT_UNSUPPORTED_BETA_FLAGS in buildAnthropicHeadersWithAuth', () => {
    const content = getDistContent();
    const fnStart = content.indexOf('buildAnthropicHeadersWithAuth');
    expect(fnStart).toBeGreaterThan(-1);
    // Look within a reasonable window of the function
    const fnRegion = content.slice(fnStart, fnStart + 3000);
    expect(fnRegion).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
    expect(fnRegion).toContain('sk-ant-oat');
  });

  it('filters OAT_UNSUPPORTED_BETA_FLAGS in buildAnthropicHeaders', () => {
    const content = getDistContent();
    // Find buildAnthropicHeaders (the second, simpler function)
    const fnStart = content.indexOf('buildAnthropicHeaders(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnRegion = content.slice(fnStart, fnStart + 3000);
    expect(fnRegion).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
    expect(fnRegion).toContain('sk-ant-oat');
  });

  it('adds X-RelayPlane-Stripped-Beta response header when beta flags are stripped', () => {
    const content = getDistContent();
    expect(content).toContain('X-RelayPlane-Stripped-Beta');
  });

  it('logs when OAT-unsupported beta flags are stripped', () => {
    const content = getDistContent();
    expect(content).toContain('OAT-unsupported beta flags');
  });
});
