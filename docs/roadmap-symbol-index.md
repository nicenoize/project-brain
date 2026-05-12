# Roadmap: symbol-aware parsing (Phase 2)

Project Brain already indexes **exported symbols and line ranges** when the optional `typescript` package is available, using the TypeScript compiler API for supported files. A **full tree-sitter** (or multi-language AST) pipeline is **not** planned for the default skill path in the near term: it adds native binaries, grammar versioning, and CI surface area beyond what most app repos need.

## Possible future work

- Optional tree-sitter plugin for languages without TS coverage (Go, Rust, Python) with explicit opt-in and pinned grammar versions.
- Cross-repo symbol graph export for monorepos with multiple roots.
- Stronger “definition only” retrieval modes keyed off AST scopes instead of heuristics.

Until then, use **`npm run brain:symbol`** / **`brain:impact`** for symbol-centric lookup and expand `.project-brain/eval.json` when retrieval misses a known definition.
