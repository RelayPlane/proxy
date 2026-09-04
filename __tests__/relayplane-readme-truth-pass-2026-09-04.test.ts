import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Acceptance test for "RelayPlane README truth pass" (task
// relayplane-readme-truth-pass-2026-09-04): salvage the
// feat/relayplane-readme-rewrite-2026-08-16 branch (caa0f015), land the
// clean README from notes/relayplane-revision-2026-08-16.md section 4 onto
// packages/proxy/README.md (the confirmed npm/GitHub publish source, see
// .github/workflows/release-proxy.yml), extract the deep config reference
// into packages/proxy/docs/, and remove every Pro/pricing string.
//
// This currently FAILS: the README has not been rebased onto the
// section-4 draft (it still opens with the old "@relayplane/proxy" /
// "Stop pinning your agents to one model" pitch, and its Docs section
// still points at relayplane.com instead of the local docs/ pages), and
// packages/proxy/docs/ does not exist yet.

const PROXY_ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(PROXY_ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(path.join(PROXY_ROOT, rel));

describe('packages/proxy/README.md truth pass (relayplane-readme-truth-pass-2026-09-04)', () => {
  it('opens with the section-4 draft pitch', () => {
    const content = read('README.md');
    expect(content.startsWith('# RelayPlane\n')).toBe(true);
    expect(content).toContain(
      'One local endpoint for every model your AI agents use.'
    );
  });

  it('contains zero Pro/paid-tier or pricing strings', () => {
    const content = read('README.md');
    expect(content.match(/\bPro\b/g)).toBeNull();
    expect(content.match(/\bPricing\b/gi)).toBeNull();
    expect(content).not.toContain('relayplane.com/pricing');
    expect(content).not.toContain('relayplane.com/pro');
    expect(content).not.toContain('Cost Guardrails (Pro)');
  });

  it('links to the extracted local docs/ pages, not relayplane.com', () => {
    const content = read('README.md');
    expect(content).toContain('docs/configuration.md');
    expect(content).toContain('docs/claude-code.md');
    expect(content).toContain('docs/cli.md');
    expect(content).toContain('docs/privacy.md');
  });
});

describe('packages/proxy/docs/ extraction (relayplane-readme-truth-pass-2026-09-04)', () => {
  it('creates docs/configuration.md with the routing/budget/cache reference', () => {
    expect(exists('docs/configuration.md')).toBe(true);
    const content = read('docs/configuration.md');
    expect(content).toContain('Budget');
  });

  it('creates docs/claude-code.md with the auto-start hook details', () => {
    expect(exists('docs/claude-code.md')).toBe(true);
    const content = read('docs/claude-code.md');
    expect(content).toContain('Claude Code');
  });

  it('creates docs/cli.md with the CLI reference', () => {
    expect(exists('docs/cli.md')).toBe(true);
  });

  it('creates docs/privacy.md documenting passthrough-by-default and mesh opt-out', () => {
    expect(exists('docs/privacy.md')).toBe(true);
    const content = read('docs/privacy.md');
    expect(content).toContain('relayplane mesh off');
  });

  it('none of the extracted docs pages contain Pro/pricing strings', () => {
    for (const doc of [
      'docs/configuration.md',
      'docs/claude-code.md',
      'docs/cli.md',
      'docs/privacy.md',
    ]) {
      const content = read(doc);
      expect(content.match(/\bPro\b/g)).toBeNull();
      expect(content).not.toContain('relayplane.com/pricing');
    }
  });
});

describe('npm publish source of truth (relayplane-readme-truth-pass-2026-09-04)', () => {
  it('confirms packages/proxy is synced to the public repo and npm on push to main', () => {
    const repoRoot = path.resolve(PROXY_ROOT, '..', '..');
    const workflowPath = path.join(
      repoRoot,
      '.github',
      'workflows',
      'release-proxy.yml'
    );
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain('packages/proxy/**');
  });

  it('records the publish source-of-truth finding in a docs/ note the PR can cite', () => {
    expect(exists('docs/publish-source-of-truth.md')).toBe(true);
    const content = read('docs/publish-source-of-truth.md');
    expect(content).toContain('release-proxy.yml');
    expect(content.toLowerCase()).not.toContain('separate checkout');
  });
});
