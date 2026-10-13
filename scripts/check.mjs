// Syntax-checks every Klip source file with `node --check`.
// ES-module pages (they use `import`) are checked as .mjs copies.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots = ['src', 'src/renderer'];
let failed = 0;
for (const dir of roots) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const file = join(dir, name);
    const isModule = /^\s*import\s/m.test(readFileSync(file, 'utf8'));
    const target = isModule ? join(tmpdir(), `klip-check-${name}.mjs`) : file;
    if (isModule) copyFileSync(file, target);
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      console.log(`ok   ${file}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${file}\n${err.stderr.toString()}`);
    } finally {
      if (isModule) rmSync(target, { force: true });
    }
  }
}
process.exit(failed ? 1 : 0);
