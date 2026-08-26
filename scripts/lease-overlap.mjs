/**
 * lease-overlap.mjs — the single canonical lease-target semantics module
 * (strategy M3: "Glob-Overlap-Semantik ist Kernprodukt, kein Detail").
 *
 * One implementation, one truth: brain-brief.mjs and git-intel.mjs delegate
 * their lease matching here, and the same code is meant to run server-side
 * before the acquire-INSERT. PURE: zero imports, no I/O, no clocks — the same
 * inputs always produce the same outputs.
 *
 * EXACT SEMANTICS (case-sensitive, byte-wise; `/` is the only separator):
 *
 *   Normalization (targets and files alike): trim whitespace, strip any
 *   leading `./` prefixes. Targets additionally lose one trailing `/`
 *   (directory form). No other rewriting — in particular backslashes are NOT
 *   converted to slashes; they are an unsupported construct (see below).
 *
 *   1. No wildcard  → EXACT-OR-SUBTREE. Target `src/auth` covers the file
 *      `src/auth` itself and everything under `src/auth/` (whole segments
 *      only: `src/auth` does NOT cover `src/auth2.ts`).
 *   2. `*`  → matches any run of characters WITHIN one path segment; it never
 *      crosses `/`. `src/*.ts` covers `src/a.ts` but NOT `src/deep/a.ts`.
 *   3. `**` as a whole segment → matches path segments:
 *        - interior (a `**` segment between others, e.g. "src", "**", "x.ts"
 *          slash-joined): ZERO or more segments — that target covers both
 *          `src/x.ts` and `src/a/b/x.ts` (standard glob / gitignore).
 *        - trailing (`src/**`): one or more segments — the subtree's contents,
 *          NOT the anchor path `src` itself (gitignore-style).
 *        - a bare `**` target covers every file.
 *      A `*`-run inside a segment with other characters (`a**b`) collapses to
 *      a single within-segment `*`.
 *   4. Wildcard pattern WITHOUT a `/` (e.g. `*.mjs`) → floating BASENAME
 *      pattern: it covers any file whose basename matches, at any depth
 *      (equivalent to a leading interior `**` segment before the pattern).
 *      To lease a subtree use `dir` or `dir/**`.
 *
 *   UNSUPPORTED constructs are REJECTED, never guessed at (plan discipline:
 *   reject the lease at creation instead of mis-checking it later):
 *   brace expansion `{a,b}`, leading negation `!`, backslash escapes `\`,
 *   the `?` wildcard, absolute (`/`-rooted) targets, and empty targets.
 *   validateTarget() reports these as {ok:false, reason}; targetMatchesFile()
 *   and targetsOverlap() throw UnsupportedPatternError for them. Character
 *   classes are NOT special: `[` and `]` are literal characters (framework
 *   route files like `app/[id]/page.tsx` are valid targets).
 *
 * API:
 *   targetMatchesFile(target, file) → boolean   does a target cover a file
 *   targetsOverlap(a, b)           → boolean   can any file satisfy both
 *                                              targets (symmetric)
 *   validateTarget(target)         → {ok:true} | {ok:false, reason}
 *
 * targetsOverlap() is a true segment-wise glob-intersection check, not a
 * sample-based heuristic: `src/**` ⊗ `src/auth/*.ts` → true,
 * `src/a/**` ⊗ `src/b/**` → false. By construction
 * targetMatchesFile(t, f) ⟹ targetsOverlap(t, f-as-exact-target).
 */

/** Thrown for lease targets outside the supported grammar. */
export class UnsupportedPatternError extends Error {
  constructor(target, reason) {
    super(`unsupported lease target '${target}': ${reason}`);
    this.name = 'UnsupportedPatternError';
    this.code = 'EUNSUPPORTED_PATTERN';
    this.target = target;
    this.reason = reason;
  }
}

/** The supported grammar, for callers that render help/error text. */
export const LEASE_TARGET_GRAMMAR = Object.freeze({
  separator: '/',
  wildcards: Object.freeze(['*', '**']),
  caseSensitive: true,
  forms: Object.freeze([
    'exact file or directory path (directory covers its whole subtree)',
    '* — any characters within one path segment',
    '** — whole segments (interior: zero or more; trailing: the subtree contents)',
    'slash-free glob (e.g. *.mjs) — matches basenames at any depth'
  ]),
  unsupported: Object.freeze([
    'brace expansion {a,b}',
    'leading negation !',
    'backslash escapes \\',
    '? wildcard',
    'absolute paths',
    'empty targets'
  ])
});

/** Ordered rejection checks behind validateTarget() — first hit wins. */
const UNSUPPORTED_CHECKS = [
  [/[{}]/, 'brace expansion ({a,b}) is not supported'],
  [/^!/, 'negation (!) is not supported'],
  [/\\/, 'backslash escapes are not supported (use forward slashes)'],
  [/\?/, 'the ? wildcard is not supported'],
  [/^\//, 'absolute paths are not supported (targets are repo-relative)']
];

/** Shared normalization: trim + strip leading `./` prefixes. */
function norm(p) {
  return String(p || '').trim().replace(/^(\.\/)+/, '');
}

/**
 * PURE. Is `target` inside the supported grammar?
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function validateTarget(target) {
  const t = norm(target);
  if (!t) return { ok: false, reason: 'empty target' };
  for (const [re, reason] of UNSUPPORTED_CHECKS) {
    if (re.test(t)) return { ok: false, reason };
  }
  return { ok: true };
}

/** Normalize + validate, throwing UnsupportedPatternError on rejection. */
function requireSupported(target) {
  const v = validateTarget(target);
  if (!v.ok) throw new UnsupportedPatternError(String(target ?? ''), v.reason);
  return norm(target).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Compilation: target → alternatives of segment patterns.
//
// A compiled alternative is an array whose elements are:
//   DEEP            — matches ZERO or more whole segments (`**`)
//   token array     — one segment pattern: literal chars, with STAR standing
//                     for "any run of non-`/` characters"
// Files compile to token arrays of literal chars only, so the same
// intersection engine below serves both matching and overlap. One engine,
// one truth.
// ---------------------------------------------------------------------------

const STAR = Symbol('*'); // within-segment wildcard
const DEEP = Symbol('**'); // multi-segment wildcard (zero or more)

/** One segment pattern → tokens; runs of `*` collapse to a single STAR. */
function parseSegment(seg) {
  const tokens = [];
  for (const ch of seg) {
    if (ch === '*') {
      if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
    } else {
      tokens.push(ch);
    }
  }
  return tokens;
}

/** A literal (file-side) segment → all-literal tokens; `*` stays a character. */
function literalSegment(seg) {
  return [...seg];
}

/** `X/**`'s trailing DEEP means ≥1 segment: encode as `*` + DEEP(0+). */
const ONE_PLUS_DEEP = Object.freeze([[STAR], DEEP]);

/**
 * Compile a normalized, validated target into alternatives (arrays of
 * segment elements). A target covers a file iff ANY alternative matches it.
 */
function compileTarget(t) {
  if (!t.includes('*')) {
    // Exact-or-subtree: the path itself, or anything strictly below it.
    const segs = t.split('/').map(literalSegment);
    return [segs, [...segs, ...ONE_PLUS_DEEP]];
  }
  if (!t.includes('/')) {
    // Floating basename pattern: `*.mjs` ≡ DEEP + `*.mjs` (DEEP is
    // zero-or-more, so root-level files are covered too).
    return [[DEEP, parseSegment(t)]];
  }
  const out = [];
  const rawSegs = t.split('/');
  for (let i = 0; i < rawSegs.length; i++) {
    const seg = rawSegs[i];
    if (seg === '**') {
      if (i === rawSegs.length - 1) out.push(...ONE_PLUS_DEEP); // trailing: ≥1
      else out.push(DEEP); // interior: ≥0
    } else {
      out.push(parseSegment(seg));
    }
  }
  return [out];
}

// ---------------------------------------------------------------------------
// Intersection engine (segment level and path level).
// ---------------------------------------------------------------------------

/**
 * Can some single segment string satisfy both token patterns? Memoized DP:
 * STAR generates/absorbs any characters, literals must agree.
 */
function segmentsIntersect(a, b) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (i === a.length && j === b.length) out = true;
    else if (i < a.length && a[i] === STAR) out = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === STAR) out = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) out = false;
    else out = a[i] === b[j] && go(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

/**
 * Can some path (sequence of segments) satisfy both compiled alternatives?
 * DEEP consumes whole segments on the other side (any segment pattern is
 * satisfiable, so DEEP is always compatible with it).
 */
function pathsIntersect(p, q) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (q.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (i === p.length && j === q.length) out = true;
    else if (i < p.length && p[i] === DEEP) out = go(i + 1, j) || (j < q.length && go(i, j + 1));
    else if (j < q.length && q[j] === DEEP) out = go(i, j + 1) || (i < p.length && go(i + 1, j));
    else if (i === p.length || j === q.length) out = false;
    else out = segmentsIntersect(p[i], q[j]) && go(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * PURE. Does a lease target cover a concrete file path? Semantics per the
 * header. Throws UnsupportedPatternError for targets outside the grammar
 * (callers that must stay total catch it and treat it as "no match").
 */
export function targetMatchesFile(target, file) {
  const t = requireSupported(target);
  const f = norm(file);
  if (!f) return false;
  const fileSegs = f.split('/').map(literalSegment);
  return compileTarget(t).some((alt) => pathsIntersect(alt, fileSegs));
}

/**
 * PURE. Do two lease TARGETS overlap — i.e. can any concrete file satisfy
 * both? Segment-wise glob intersection (no sampling): `src/**` ⊗
 * `src/auth/*.ts` → true; `src/a/**` ⊗ `src/b/**` → false. Symmetric.
 * Throws UnsupportedPatternError if either side is outside the grammar,
 * so acquire-time checks reject instead of mis-checking.
 */
export function targetsOverlap(a, b) {
  const altsA = compileTarget(requireSupported(a));
  const altsB = compileTarget(requireSupported(b));
  for (const pa of altsA) {
    for (const pb of altsB) {
      if (pathsIntersect(pa, pb)) return true;
    }
  }
  return false;
}
