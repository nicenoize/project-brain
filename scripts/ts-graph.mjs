import fs from 'node:fs';
import path from 'node:path';

const MAX_IMPORT_STRINGS = 120;
const MAX_RESOLVED_IMPORTS = 80;

/**
 * TypeScript program + checker for the repo (tsconfig or loose).
 * Opt out: BRAIN_TS_GRAPH=0. Requires optional `typescript` dependency.
 */

export async function loadTypeScriptModule() {
  if (process.env.BRAIN_TS_GRAPH === '0') return null;
  try {
    const mod = await import('typescript');
    return mod.default ?? mod;
  } catch {
    console.warn(
      'Project Brain: optional package `typescript` is not installed; compiler-backed graph and `brain:impact` TS references are disabled. Add it with: npm i -D typescript'
    );
    return null;
  }
}

/**
 * @returns {Promise<{ ts: any, program: import('typescript').Program, checker: import('typescript').TypeChecker, rootNorm: string, rootAbsPaths: string[], compilerOptions: import('typescript').CompilerOptions, indexable: Set<string> } | null>}
 */
export async function createBrainProgram(root, indexableFiles) {
  const ts = await loadTypeScriptModule();
  if (!ts) return null;
  const indexable = indexableFiles instanceof Set ? indexableFiles : new Set(indexableFiles);
  const rootNorm = path.resolve(root);
  const { compilerOptions, rootAbsPaths } = buildProgramInputs(rootNorm, indexable, ts);
  if (!rootAbsPaths?.length) return null;
  const host = ts.createCompilerHost(compilerOptions, true);
  const program = ts.createProgram(rootAbsPaths, compilerOptions, host);
  const checker = program.getTypeChecker();
  return { ts, program, checker, rootNorm, rootAbsPaths, compilerOptions, indexable };
}

export async function loadTsSemanticContext(root, indexableFiles) {
  const core = await createBrainProgram(root, indexableFiles);
  if (!core) return null;
  const { ts, program, checker, rootNorm, indexable } = core;
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
    get(relPath) {
      return byRel.get(relPath) || null;
    }
  };
}

/**
 * Workspace-accurate find-all-references for a symbol name (LanguageService).
 * @returns {Promise<{ definitions: Array<{ file: string, line: number, column: number }>, usages: Array<{ file: string, line: number, column: number }> } | null>}
 */
export async function findTsWorkspaceReferences(root, indexableFiles, symbolName) {
  const core = await createBrainProgram(root, indexableFiles);
  if (!core) return null;
  const { ts, program, checker, rootNorm, rootAbsPaths, compilerOptions } = core;
  const service = createBrainLanguageService(ts, rootNorm, compilerOptions, rootAbsPaths);
  const seeds = collectDefinitionSeeds(ts, program, checker, symbolName);
  if (!seeds.length) return { definitions: [], usages: [] };

  const definitions = new Map();
  const usages = new Map();

  const addUsage = (fileName, pos) => {
    if (!isProjectSource(rootNorm, fileName)) return;
    const rel = posixPath(path.relative(rootNorm, fileName));
    const sf = program.getSourceFile(fileName);
    if (!sf) return;
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, pos);
    const key = `${rel}:${line + 1}:${character + 1}`;
    usages.set(key, { file: rel, line: line + 1, column: character + 1 });
  };

  for (const { fileName, pos } of seeds) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, pos);
    const rel = posixPath(path.relative(rootNorm, fileName));
    definitions.set(`${rel}:${line + 1}:${character + 1}`, {
      file: rel,
      line: line + 1,
      column: character + 1
    });

    const refs = service.findReferences(fileName, pos);
    if (!refs) continue;
    for (const group of refs) {
      for (const ref of group.references || []) {
        if (!ref.isDefinition) addUsage(ref.fileName, ref.textSpan.start);
      }
    }
  }

  const defList = [...definitions.values()].sort(compareLocation);
  const defKeys = new Set(defList.map((d) => `${d.file}:${d.line}:${d.column}`));
  const usageList = [...usages.values()]
    .filter((u) => !defKeys.has(`${u.file}:${u.line}:${u.column}`))
    .sort(compareLocation);
  return { definitions: defList, usages: usageList };
}

function compareLocation(a, b) {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

function createBrainLanguageService(ts, rootNorm, compilerOptions, rootAbsPaths) {
  const servicesHost = {
    getScriptFileNames: () => [...rootAbsPaths],
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      if (!ts.sys.fileExists(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName));
    },
    getCurrentDirectory: () => rootNorm,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) =>
      (typeof ts.getDefaultLibFilePath === 'function' ? ts.getDefaultLibFilePath(opts) : ts.getDefaultLibFileName(opts)),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getProjectVersion: () => '0'
  };
  const registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, rootNorm);
  return ts.createLanguageService(servicesHost, registry);
}

function collectDefinitionSeeds(ts, program, checker, symbolName) {
  const seeds = [];
  const seen = new Set();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;
    function visit(node) {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        const skipImportName =
          ts.isImportSpecifier(node.parent) || (ts.isImportClause(node.parent) && node.parent.name === node);
        if (!skipImportName) {
          const sym = checker.getSymbolAtLocation(node) || checker.getShorthandAssignmentValueSymbol(node);
          if (sym) {
            const decl = sym.valueDeclaration || sym.declarations?.[0];
            if (decl && decl.name === node && !ts.isImportSpecifier(decl)) {
              const key = `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
              if (!seen.has(key)) {
                seen.add(key);
                seeds.push({ fileName: sourceFile.fileName, pos: node.getStart(sourceFile) });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return seeds;
}

function isProjectSource(rootNorm, fileName) {
  const norm = path.normalize(fileName);
  const root = path.normalize(rootNorm + path.sep);
  return norm.startsWith(root) && !norm.includes(`${path.sep}node_modules${path.sep}`);
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
