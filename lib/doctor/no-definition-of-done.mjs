import fs from 'node:fs';
import path from 'node:path';
import { parseMasterplanYaml } from '../config.mjs';

const ID = 'no-definition-of-done';

export function check(repoRoot, opts = {}) {
  const configPath = path.join(repoRoot, '.masterplan.yaml');
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [{ id: ID, severity: 'PASS', summary: 'no repo-local .masterplan.yaml', fix: null }];
    }
    return [{ id: ID, severity: 'WARN', summary: `cannot read ${configPath}: ${err.message}`, fix: null }];
  }
  let parsed;
  try {
    parsed = parseMasterplanYaml(content);
  } catch (err) {
    return [{ id: ID, severity: 'WARN', summary: `unparseable .masterplan.yaml: ${err.message}`, fix: null }];
  }
  if (parsed.done === 'none') {
    return [{ id: ID, severity: 'PASS', summary: 'done: none declared', fix: null }];
  }
  if (parsed.done && typeof parsed.done === 'object') {
    return [{ id: ID, severity: 'PASS', summary: 'definition of done declared', fix: null }];
  }
  return [{
    id: ID, severity: 'WARN',
    summary: 'repo has .masterplan.yaml but no definition of done (done: block)',
    fix: 'add a done: block (release/install/user_only/live_check groups) or done: none',
  }];
}
