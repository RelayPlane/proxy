import { rmSync } from 'node:fs';
import { join } from 'node:path';

// cli-surface.test.ts asserts the CLI test HOME (.test-home-cli) behaves like
// a fresh install on every run. Since that directory is written to by the
// suite itself (e.g. "cap set --day 50"), a leftover copy from a prior local
// or verifier run makes later runs order/history-dependent instead of
// deterministic. Wipe it once before the suite starts.
export default function setup() {
  rmSync(join(__dirname, '.test-home-cli'), { recursive: true, force: true });
}
