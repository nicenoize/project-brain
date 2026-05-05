import fs from 'node:fs';
import path from 'node:path';

const MAX_IMPORT_STRINGS = 120;
const MAX_RESOLVED_IMPORTS = 80;

/**
 * Build a TypeScript Program over the repo and collect per-file:
 * - resolved internal import targets (posix paths relative to root)
 * - raw import specifiers
 * - identifier spans that resolve to symbols declared in another project file (cross-file refs)
 *
 * Opt out: BRAIN_TS_GRAPH=0. Requires optional `typescript` dependency.
 */

export async function loadTsSemanticContext(root, indexableFiles) {
  if (process.env.BRAIN_TS_GRAPH === '0') return null;
  let ts;
  try {
    const mod = await import('typescript');
    ts = mod.default ?? mod;
  } catch {
    return null;
  }

  const indexable = indexableFiles instanceof Set ? indexableFiles : new Set(indexableFiles);
  const rootNorm = path.resolve(root);

  const { compilerOptions, rootAbsPaths } = buildProgramInputs(rootNorm, indexable, ts);
  if (!rootAbsPaths?.length) return null;

  const host = ts.createCompilerHost(compilerOptions, true);
  const program = ts.createProgram(rootAbsPaths, compilerOptions, host);
  const checker = program.getTypeChecker();

  const byRel = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const rel = posixPath(path.relative(rootNorm, sf.fileName));
    if (!indexable.has(rel)) continue;
    try {
      byRel.set(rel, analyzeSourceFile(ts, program, checker, sf, rootNorm));
    } catch (error) {
      console.warn(`Project Brain: TS graph skipped for ${rel}: ${error.message || error}`);
    }
  }

  return {
    /** @param {string} relPath */
    get(relPath) {
      return byRel.get(relPath) || null;
    }
  };
}

function buildProgramInputs(rootNorm, indexable, ts) {
  const configPath = ts.findConfigFile(rootNorm, ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) {
      console.warn('Project Brain: could not read tsconfig.json; using loose TS program.');
      return looseProgram(rootNorm, indexable, ts);
    }
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath
    );
    const compilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
    const rootAbsPaths = parsed.fileNames.filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`));
    return { compilerOptions, rootAbsPaths };
  }
  return looseProgram(rootNorm, indexable, ts);
}

function looseProgram(rootNorm, indexable, ts) {
  const moduleResolution = ts.ModuleResolutionKind?.Bundler ?? ts.ModuleResolutionKind?.NodeNext ?? ts.ModuleResolutionKind.Node10;
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution,
    jsx: ts.JsxKind?.ReactJSX ?? ts.JsxKind?.React ?? 1,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true
  };
  const rootAbsPaths = [...indexable]
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(rootNorm, f))
    .filter((p) => fs.existsSync(p));
  return { compilerOptions, rootAbsPaths };
}

function analyzeSourceFile(ts, program, checker, sourceFile, rootNorm) {
  const rawImports = [];
  const resolvedImports = new Set();
  const spans = [];
  const crossFileRefs = new Set();

  const opts = program.getCompilerOptions();

  function recordResolvedModule(moduleSpecifier, fromFile) {
    rawImports.push(moduleSpecifier);
    const { resolvedModule } = ts.resolveModuleName(moduleSpecifier, fromFile, opts, ts.sys);
    if (!resolvedModule || resolvedModule.isExternalLibraryImport) return;
    if (resolvedModule.resolvedFileName.includes(`${path.sep}node_modules${path.sep}`)) return;
    const rel = posixPath(path.relative(rootNorm, resolvedModule.resolvedFileName));
    resolvedImports.add(rel);
  }

  function walk(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      recordResolvedModule(node.moduleSpecifier.text, sourceFile.fileName);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      recordResolvedModule(node.moduleSpecifier.text, sourceFile.fileName);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) recordResolvedModule(arg.text, sourceFile.fileName);
    } else if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node) || checker.getShorthandAssignmentValueSymbol(node);
      if (!sym) {
        ts.forEachChild(node, walk);
        return;
      }
      const aliased = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const decl = aliased.declarations?.[0];
      if (!decl) {
        ts.forEachChild(node, walk);
        return;
      }
      if (isExternalOrLibDeclaration(decl)) {
        ts.forEachChild(node, walk);
        return;
      }
      const declFile = decl.getSourceFile();
      if (declFile.fileName === sourceFile.fileName) {
        ts.forEachChild(node, walk);
        return;
      }
      const name = aliased.name;
      if (!name || name.startsWith('__')) {
        ts.forEachChild(node, walk);
        return;
      }
      spans.push({ start: node.getStart(sourceFile), end: node.getEnd(), name });
      crossFileRefs.add(name);
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  return {
    resolvedImports: [...resolvedImports].slice(0, MAX_RESOLVED_IMPORTS),
    rawImports: [...new Set(rawImports)].slice(0, MAX_IMPORT_STRINGS),
    spans,
    crossFileRefs
  };
}

function isExternalOrLibDeclaration(decl) {
  const file = decl.getSourceFile().fileName;
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return true;
  if (decl.getSourceFile().isDeclarationFile && file.endsWith('.d.ts')) return true;
  return false;
}

function posixPath(p) {
  return p.split(path.sep).join('/');
}
