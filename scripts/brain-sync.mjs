import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, MANIFEST, read, sha256, listIndexableFiles } from './common.mjs';

let needsIndex = false;
let old = { files: {} };
if (fs.existsSync(MANIFEST)) old = JSON.parse(read(MANIFEST));

const files = await listIndexableFiles();
const current = {};
const changed = [];
const deleted = [];

for (const file of files) {
  current[file] = sha256(read(path.join(ROOT, file)));
  if (!old.files?.[file] || old.files[file].hash !== current[file]) {
    needsIndex = true;
    changed.push(file);
  }
}

for (const file of Object.keys(old.files || {})) {
  if (!current[file]) {
    needsIndex = true;
    deleted.push(file);
  }
}

if (needsIndex) {
  console.log(`Project Brain index is stale. Rebuilding delta (${changed.length} changed, ${deleted.length} deleted)...`);
  const result = spawnSync(process.execPath, [new URL('./brain-index.mjs', import.meta.url).pathname], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BRAIN_CHANGED_FILES: changed.join('\n'),
      BRAIN_DELETED_FILES: deleted.join('\n')
    }
  });
  process.exit(result.status || 0);
} else {
  console.log('Project Brain index is up to date.');
}
