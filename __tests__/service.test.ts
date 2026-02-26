import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('Service file', () => {
  const assetPath = join(__dirname, '..', 'assets', 'relayplane-proxy.service');

  it('ships a systemd service file in assets/', () => {
    expect(existsSync(assetPath)).toBe(true);
  });

  it('has required hardening directives', () => {
    const content = readFileSync(assetPath, 'utf8');
    expect(content).toContain('Restart=always');
    expect(content).toContain('RestartSec=5');
    expect(content).toContain('WatchdogSec=30');
    expect(content).toContain('StandardOutput=journal');
    expect(content).toContain('StandardError=journal');
    expect(content).toContain('Environment=NODE_ENV=production');
    expect(content).toContain('Type=notify');
  });

  it('has Install section with WantedBy', () => {
    const content = readFileSync(assetPath, 'utf8');
    expect(content).toContain('[Install]');
    expect(content).toContain('WantedBy=multi-user.target');
  });
});
