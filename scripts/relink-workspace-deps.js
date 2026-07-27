#!/usr/bin/env node
'use strict';

/**
 * Self-heals @relayplane/* workspace-package symlinks inside this package's
 * own node_modules after every build.
 *
 * Why this exists: this repo's dispatcher runs ephemeral precheck worktrees
 * that share this repo's node_modules (gate-isolated-run.sh symlinks a new
 * worktree's node_modules back to the canonical checkout's, to save disk).
 * When one of those worktrees runs its own `pnpm install`, pnpm rewrites the
 * nested @relayplane/* symlinks under packages/proxy/node_modules relative
 * to that worktree's own location. Once the worktree is pruned, those links
 * go dangling and the standalone proxy (run directly via `node dist/cli.js`,
 * e.g. by the relayplane-proxy systemd service) fails at startup with
 * MODULE_NOT_FOUND for @relayplane/core. Re-running this after every build
 * guarantees a freshly built dist is always paired with working links,
 * regardless of what any other worktree did to the shared node_modules.
 */

const fs = require('fs');
const path = require('path');

const proxyRoot = path.join(__dirname, '..');
const packagesRoot = path.join(proxyRoot, '..');
const pkg = require(path.join(proxyRoot, 'package.json'));

const scopedDeps = Object.keys({
  ...(pkg.dependencies || {}),
  ...(pkg.optionalDependencies || {}),
}).filter((name) => name.startsWith('@relayplane/'));

const nodeModulesScope = path.join(proxyRoot, 'node_modules', '@relayplane');
fs.mkdirSync(nodeModulesScope, { recursive: true });

for (const scopedName of scopedDeps) {
  const shortName = scopedName.slice('@relayplane/'.length);
  const siblingDir = path.join(packagesRoot, shortName);
  if (!fs.existsSync(path.join(siblingDir, 'package.json'))) {
    // Not a local workspace package (or not present in this checkout) --
    // leave whatever pnpm already resolved (e.g. a real npm install) alone.
    continue;
  }

  const linkPath = path.join(nodeModulesScope, shortName);
  const relativeTarget = path.relative(nodeModulesScope, siblingDir);

  let existingTarget = null;
  try {
    existingTarget = fs.readlinkSync(linkPath);
  } catch {
    // Not a symlink yet (missing, or a real directory) -- fall through and
    // (re)create it below.
  }

  if (existingTarget === relativeTarget && fs.existsSync(linkPath)) continue;

  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
  console.log(`[relink-workspace-deps] fixed @relayplane/${shortName} -> ${relativeTarget}`);
}
