import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MANIFEST, read, sha256, listIndexableFiles } from './common.mjs';

let needsIndex = false;
let old = { files: {} };
if (fs.existsSync(MANIFEST)) old = JSON.parse(read(MANIFEST));
const files = await listIndexableFiles();
const current = {};
for (const file of files) {
  current[file] = sha256(read(path.join(ROOT, file)));
  if (!old.files?.[file] || old.files[file].hash !== current[file]) needsIndex = true;
}
for (const file of Object.keys(old.files || {})) {
  if (!current[file]) needsIndex = true;
}
if (needsIndex) {
  console.log('Project Brain index is stale. Rebuilding...');
  await import('./brain-index.mjs');
} else {
  console.log('Project Brain index is up to date.');
}
