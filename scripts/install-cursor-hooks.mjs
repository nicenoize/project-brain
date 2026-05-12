import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCanonical = fs.existsSync(path.join(ROOT, 'SKILL.md')) && fs.existsSync(path.join(ROOT, 'scripts', 'brain-compact.mjs'));
const skillRoot = isCanonical ? ROOT : path.join(ROOT, 'skills', 'project-brain');

const templatePath = path.join(skillRoot, 'templates', 'cursor', 'hooks.json');
const targetDir = path.join(ROOT, '.cursor');
const targetHooks = path.join(targetDir, 'hooks.json');

if (!fs.existsSync(templatePath)) {
  console.error('Missing template:', templatePath);
  process.exit(1);
}

const incoming = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

function mergeHooks(existing, add) {
  const out = { version: existing.version || add.version || 1, hooks: { ...(existing.hooks || {}) } };
  const keys = new Set([...Object.keys(out.hooks), ...Object.keys(add.hooks || {})]);
  const keyOf = (h) => `${h.command || ''}::${h.matcher || ''}::${h.type || 'command'}`;
  for (const k of keys) {
    const a = out.hooks[k] || [];
    const b = (add.hooks && add.hooks[k]) || [];
    if (!b.length) {
      out.hooks[k] = a;
      continue;
    }
    const seen = new Set(a.map(keyOf));
    const merged = [...a];
    for (const h of b) {
      if (!seen.has(keyOf(h))) {
        seen.add(keyOf(h));
        merged.push(h);
      }
    }
    out.hooks[k] = merged;
  }
  return out;
}

fs.mkdirSync(targetDir, { recursive: true });

let merged = incoming;
if (fs.existsSync(targetHooks)) {
  try {
    const existing = JSON.parse(fs.readFileSync(targetHooks, 'utf8'));
    merged = mergeHooks(existing, incoming);
    console.log('Merged Project Brain entries into existing .cursor/hooks.json');
  } catch (e) {
    console.warn('Could not parse existing .cursor/hooks.json; skipping merge:', e.message || e);
    merged = incoming;
  }
} else {
  console.log('Created .cursor/hooks.json with Project Brain compact hooks');
}

fs.writeFileSync(targetHooks, JSON.stringify(merged, null, 2) + '\n');

const rulesSrc = path.join(skillRoot, 'templates', 'cursor', 'rules', 'project-brain-compact.mdc');
const rulesDir = path.join(targetDir, 'rules');
if (fs.existsSync(rulesSrc)) {
  fs.mkdirSync(rulesDir, { recursive: true });
  const rulesDest = path.join(rulesDir, 'project-brain-compact.mdc');
  if (!fs.existsSync(rulesDest)) {
    fs.copyFileSync(rulesSrc, rulesDest);
    console.log('Installed .cursor/rules/project-brain-compact.mdc');
  }
}

console.log('Cursor hooks install complete.');
