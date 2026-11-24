// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does all ten
// sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection, three-tier line
// matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit made, in order, so the output can print `R <old> -> <new>` for them. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- SPEC.md section 5: matching lines ----------

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's lines under its own line break, and whether it ends with one. */
function fileModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where old occurs in lines at this tier; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which old occurs at least once. */
function firstTier(lines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NLine {
  text: string;
  context: boolean;
  /** Index of this line in O, when it is a context line. */
  oIndex: number;
}

/** The lines to write in place of the matched O. A context line is written as the file's own matched line, never
 * the patch's. At tier 2 every other line is re-indented: O's first line's leading spaces and tabs are replaced by
 * the file's first matched line's. At tiers 0 and 1 the lines of N are written as they are. */
function buildReplacement(fl: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  const f = tier === 2 && o.length > 0 ? leadWs(fl[at] ?? '') : '';
  for (const item of n) {
    if (item.context) {
      out.push(fl[at + item.oIndex]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

// ---------- SPEC.md section 6: unified diffs ----------

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context-or-`+` line. */
  noNlAfterN: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNlAfterPlus: boolean;
}

function buildHunk(a: number, rawBody: string[]): Hunk {
  const body = [...rawBody];
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  let lastN = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    const c = l.length === 0 ? '' : l[0]!;
    if (c === ' ') {
      const t = l.slice(1);
      const oi = o.length;
      o.push(t);
      n.push({ text: t, context: true, oIndex: oi });
      lastN = k;
    } else if (c === '-') {
      o.push(l.slice(1));
    } else if (c === '+') {
      n.push({ text: l.slice(1), context: false, oIndex: -1 });
      lastN = k;
      lastPlus = k;
    } else if (c === '\\') {
      // A `\` line refers to the body line before it; it carries no line of its own.
    } else {
      const oi = o.length;
      o.push('');
      n.push({ text: '', context: true, oIndex: oi });
      lastN = k;
    }
  }
  const isBackslash = (idx: number): boolean => idx >= 0 && idx < body.length && body[idx]!.startsWith('\\');
  return { a, o, n, noNlAfterN: lastN >= 0 && isBackslash(lastN + 1), noNlAfterPlus: lastPlus >= 0 && isBackslash(lastPlus + 1) };
}

interface Section {
  pair: [string | null, string | null] | null;
  renameFrom: string | null;
  renameTo: string | null;
  git: [string, string] | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function parseGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length).trimEnd();
  const m = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (!m || m[1] === '' || m[2] === '') return null;
  return [m[1]!, m[2]!];
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let m = fileModel(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), m.lines.length);
      const nLines = h.n.map((x) => x.text);
      const newLines = [...m.lines.slice(0, pos), ...nLines, ...m.lines.slice(pos)];
      const atEnd = pos === m.lines.length;
      m = { lines: newLines, br: m.br, final: atEnd ? !h.noNlAfterN : m.final };
      d += h.n.length;
      continue;
    }
    const found = firstTier(m.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const repl = buildReplacement(m.lines, at, h.o, h.n, found.tier);
    const newLines = [...m.lines.slice(0, at), ...repl, ...m.lines.slice(at + h.o.length)];
    const runsToEnd = at + h.o.length === m.lines.length;
    m = { lines: newLines, br: m.br, final: runsToEnd ? !h.noNlAfterN : m.final };
    d += h.n.length - h.o.length;
  }
  return joinModel(m);
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pair !== null ? s.pair[0] : s.renameFrom !== null ? s.renameFrom : s.git !== null ? s.git[0] : null;
  const newP = s.pair !== null ? s.pair[1] : s.renameTo !== null ? s.renameTo : s.git !== null ? s.git[1] : null;
  const isCreate = s.newFile || oldP === null;
  const isDelete = s.delFile || newP === null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusNoNl = false;
      for (const h of s.hunks) {
        if (h.n.some((x) => !x.context)) lastPlusNoNl = h.noNlAfterPlus;
        for (const x of h.n) if (!x.context) plus.push(x.text);
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, s.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = oldP!;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hasPair = false;
  let hasHunks = false;
  let inBody = false;
  let bodyLines: string[] = [];
  let curA = 0;

  const finishHunk = (): void => {
    if (cur !== null && inBody) {
      cur.hunks.push(buildHunk(curA, bodyLines));
      hasHunks = true;
    }
    inBody = false;
    bodyLines = [];
  };
  const finishSection = (): void => {
    finishHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
    hasPair = false;
    hasHunks = false;
  };
  const newSection = (): Section => {
    const s: Section = { pair: null, renameFrom: null, renameTo: null, git: null, newFile: false, delFile: false, hunks: [] };
    cur = s;
    hasPair = false;
    hasHunks = false;
    return s;
  };
  const hunkHeader = (line: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return m ? parseInt(m[1]!, 10) : null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      const isBreak = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      const c = line.length === 0 ? '' : line[0]!;
      if (!isBreak && (c === ' ' || c === '-' || c === '+' || c === '\\' || c === '')) {
        bodyLines.push(line);
        i++;
        continue;
      }
      finishHunk();
    }
    if (line.startsWith('diff --git ')) {
      const g = parseGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      newSection().git = g;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkHeader(line);
      if (a === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inBody = true;
      bodyLines = [];
      curA = a;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !hasHunks && !hasPair) {
        cur.pair = [stripAB(headerPath(line)), stripAB(headerPath(lines[i + 1]!))];
        hasPair = true;
      } else {
        finishSection();
        const s = newSection();
        s.pair = [stripAB(headerPath(line)), stripAB(headerPath(lines[i + 1]!))];
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !hasHunks) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && !hasHunks) {
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
      }
    }
    i++;
  }
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq === -1 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq !== -1 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const { path, old, nw } = b;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (old.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      const m = fileModel(text);
      const found = firstTier(m.lines, old, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const at = found.pos[0]!;
      const nLines: NLine[] = nw.map((t) => ({ text: t, context: false, oIndex: -1 }));
      const repl = buildReplacement(m.lines, at, old, nLines, found.tier);
      const newLines = [...m.lines.slice(0, at), ...repl, ...m.lines.slice(at + old.length)];
      tree.now.set(path, joinModel({ lines: newLines, br: m.br, final: m.final }));
    };
  });
}

// ---------- SPEC.md section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNum: number;
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
}

function addVBodyLine(ch: VChunk, l: string): void {
  const c = l.length === 0 ? '' : l[0]!;
  if (c === ' ') {
    const t = l.slice(1);
    const oi = ch.o.length;
    ch.o.push(t);
    ch.n.push({ text: t, context: true, oIndex: oi });
  } else if (c === '-') {
    ch.o.push(l.slice(1));
  } else if (c === '+') {
    ch.n.push({ text: l.slice(1), context: false, oIndex: -1 });
  } else {
    const oi = ch.o.length;
    ch.o.push('');
    ch.n.push({ text: '', context: true, oIndex: oi });
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const lineNum = i + 1;
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ') || l2.trim() === '*** End Patch') break;
      raw.push({ text: l2, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, lineNum, moveTo: null, chunks: [], addLines });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      sections.push({ kind, path, lineNum, moveTo: null, chunks: [], addLines: [] });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkCount = 0;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const l2 = r.text;
        if (l2.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          pushCur();
          continue;
        }
        if (l2.startsWith('@@')) {
          pushCur();
          const anchorText = l2.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, o: [], n: [] };
          chunkCount++;
          continue;
        }
        if (l2.startsWith('***')) throw new Exit2(`error: parse ${r.num}`);
        const c = l2.length === 0 ? '' : l2[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '') {
          if (cur === null) {
            if (chunkCount === 0) {
              cur = { anchor: null, eof: false, o: [], n: [] };
              chunkCount++;
            } else {
              throw new Exit2(`error: parse ${r.num}`);
            }
          }
          addVBodyLine(cur, l2);
          continue;
        }
        if (blank(l2)) continue;
        throw new Exit2(`error: parse ${r.num}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNum}`);
      sections.push({ kind, path, lineNum, moveTo, chunks, addLines: [] });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vSectionEdit(s, strict));
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let m = fileModel(text);
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        let foundAt = -1;
        for (let t = 0; t <= maxTier && foundAt < 0; t++) {
          for (let k = cursor; k < m.lines.length; k++) {
            if (lineEq(m.lines[k]!, anchor, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', s.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? m.lines.length : cursor;
        const nLines = ch.n.map((x) => x.text);
        const newLines = [...m.lines.slice(0, pos), ...nLines, ...m.lines.slice(pos)];
        m = { lines: newLines, br: m.br, final: m.final };
        cursor = pos + nLines.length;
        continue;
      }
      let found: { tier: number; at: number } | null = null;
      for (let t = 0; t <= maxTier && found === null; t++) {
        const occ = occurrences(m.lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === m.lines.length));
        if (occ.length > 0) found = { tier: t, at: occ[0]! };
      }
      if (found === null) throw new Fail('no-match', s.path);
      const repl = buildReplacement(m.lines, found.at, ch.o, ch.n, found.tier);
      const newLines = [...m.lines.slice(0, found.at), ...repl, ...m.lines.slice(found.at + ch.o.length)];
      m = { lines: newLines, br: m.br, final: m.final };
      cursor = found.at + repl.length;
    }
    const out = joinModel(m);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const noD = new Set<string>();
  const noA = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      noD.add(mv.old);
      noA.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && noD.has(p)) continue;
    if (was === null && now !== null && noA.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
