/**
 * db-shared: cross-project edges where ≥ 2 projects share a database.
 *
 * Signals (any one suffices):
 *   - same migration directory referenced (high confidence — same schema)
 *   - shared DATABASE_URL / *_DB_URL / *_DSN env key (medium)
 *
 * Migration-dir signal: detect canonical layouts per language —
 *   migrations/, prisma/migrations/, db/migrate/, alembic/versions/,
 *   migrations.sql, supabase/migrations/.
 * If two projects both have a migration dir of the same shape AND share
 * a `DATABASE_URL` (env-var detector facts), classify as high.
 *
 * Uses facts.envKeysByProject (from env-var.mjs) so it must run after.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'db-shared';
const DB_ENV_RX = /^(DATABASE_URL|.*_DB_URL|.*_DSN|.*_CONNECTION_STRING)$/;
const MIGRATION_DIRS = [
  'migrations', 'prisma/migrations', 'db/migrate', 'alembic/versions', 'supabase/migrations'
];

async function* detect(ctx) {
  const envKeysByProject = ctx.facts.get('envKeysByProject') || new Map();
  const migrationsByProject = new Map(); // project -> abs migration dir or null

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    for (const rel of MIGRATION_DIRS) {
      const abs = path.join(projAbs, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        migrationsByProject.set(project.name, { dir: abs, kind: rel });
        break;
      }
    }
  }

  // Pair projects sharing a DB env key.
  const dbKeys = new Map(); // key -> Set(project)
  for (const [project, keys] of envKeysByProject) {
    for (const key of keys) {
      if (!DB_ENV_RX.test(key)) continue;
      if (!dbKeys.has(key)) dbKeys.set(key, new Set());
      dbKeys.get(key).add(project);
    }
  }

  const emitted = new Set();
  for (const [key, projectSet] of dbKeys) {
    if (projectSet.size < 2) continue;
    const projects = [...projectSet].sort();
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const a = projects[i], b = projects[j];
        // Confidence high when both have migration dirs of the same kind.
        const aMig = migrationsByProject.get(a);
        const bMig = migrationsByProject.get(b);
        const sameMigKind = aMig && bMig && aMig.kind === bMig.kind;
        const confidence = sameMigKind ? 'high' : 'medium';
        const key2 = `${a}|${b}|${confidence}`;
        if (emitted.has(key2)) continue;
        emitted.add(key2);
        yield {
          from: a, to: b, kind: 'db-shared',
          evidence: [
            ...(aMig ? [`${path.relative(ctx.ROOT, aMig.dir)}/`] : []),
            ...(bMig ? [`${path.relative(ctx.ROOT, bMig.dir)}/`] : [])
          ],
          confidence,
          meta: { envKey: key, migrationsShape: sameMigKind ? aMig.kind : null }
        };
      }
    }
  }
}

export default { name: NAME, detect };
