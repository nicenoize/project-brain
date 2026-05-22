/**
 * brain:projects — list discovered fleet projects with their kinds and
 * cross-project edge counts (in/out). Reads from the indexed store; no
 * detector run.
 */
import { ROOT, takeFlag } from './common.mjs';
import { openStore } from './store.mjs';
import { openEmbedder } from './embed.mjs';
import { discoverProjects } from './projects.mjs';

const args = process.argv.slice(2);
const json = takeFlag(args, '--json');
const helpFlag = takeFlag(args, '--help') || takeFlag(args, '-h');

if (helpFlag) {
  console.log('Usage: npm run brain:projects -- [--json]');
  process.exit(0);
}

const projects = discoverProjects(ROOT);
if (!projects.length) {
  console.error('No projects discovered. Run inside a fleet root (or single-project repo).');
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
const records = await store.getAll();
await store.close();

const edgesIn = new Map();
const edgesOut = new Map();
for (const r of records) {
  if (r.type !== 'cross-project-edge') continue;
  edgesOut.set(r.edgeFrom, (edgesOut.get(r.edgeFrom) || 0) + 1);
  edgesIn.set(r.edgeTo, (edgesIn.get(r.edgeTo) || 0) + 1);
}

const rows = projects.map(p => ({
  name: p.name,
  kinds: p.kinds,
  git: p.git,
  hasReadme: p.hasReadme,
  edgesIn: edgesIn.get(p.name) || 0,
  edgesOut: edgesOut.get(p.name) || 0
}));

if (json) {
  console.log(JSON.stringify({ fleet: projects.map(p => p.name), projects: rows }, null, 2));
  process.exit(0);
}

console.log(`# Fleet projects (${rows.length})`);
const widths = {
  name: Math.max(7, ...rows.map(r => r.name.length)),
  kinds: Math.max(5, ...rows.map(r => r.kinds.join(',').length))
};
console.log(`${pad('name', widths.name)}  ${pad('kinds', widths.kinds)}  git    edges (in/out)`);
console.log(`${pad('----', widths.name)}  ${pad('-----', widths.kinds)}  -----  --------------`);
for (const r of rows) {
  console.log(`${pad(r.name, widths.name)}  ${pad(r.kinds.join(','), widths.kinds)}  ${r.git ? ' yes  ' : ' no   '}  ${r.edgesIn} / ${r.edgesOut}`);
}

function pad(s, w) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, w - s.length));
}
