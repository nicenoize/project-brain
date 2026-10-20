import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePackageDeps } from '../scripts/common.mjs';

test('mergePackageDeps leaves typescript alone when the project already depends on it', () => {
  const dev = mergePackageDeps({ devDependencies: { typescript: '^7.0.2', 'fast-glob': '^3.3.2' } });
  assert.equal(dev.optionalDependencies.typescript, undefined, 'a dev dependency typescript must not get a second, optional pin');
  const prod = mergePackageDeps({ dependencies: { typescript: '^7.0.2' } });
  assert.equal(prod.optionalDependencies.typescript, undefined);
});

test('mergePackageDeps adds no empty dependencies block', () => {
  const pkg = mergePackageDeps({ devDependencies: { 'fast-glob': '^3.3.2', typescript: '^7.0.2' } });
  assert.equal('dependencies' in pkg, false, 'nothing to add, so no "dependencies": {} either');
});

test('mergePackageDeps still adds what a project without them needs', () => {
  const pkg = mergePackageDeps({});
  assert.equal(pkg.dependencies['fast-glob'], '^3.3.2');
  assert.equal(pkg.optionalDependencies.typescript, '^5.6.0');
  assert.equal(pkg.optionalDependencies['@lancedb/lancedb'], '^0.9.0');
});
