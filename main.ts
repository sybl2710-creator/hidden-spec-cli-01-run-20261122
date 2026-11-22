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

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>(); // old -> new

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

// --- Line Matching & File helpers ---

interface FileLines {
  lines: string[];
  crlf: boolean;
  finalBreak: boolean;
}

function parseFileText(text: string): FileLines {
  if (text === '') return { lines: [], crlf: false, finalBreak: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  let content = text;
  if (finalBreak) content = content.slice(0, -br.length);
  const rawLines = content === '' ? [] : content.split(br);
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, crlf, finalBreak };
}

function serializeFile(fl: FileLines, defaultFinalBreak = true): string {
  if (fl.lines.length === 0 && !fl.finalBreak) return '';
  const br = fl.crlf ? '\r\n' : '\n';
  const needBreak = fl.finalBreak;
  return fl.lines.join(br) + (needBreak ? br : '');
}

function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(0, end);
}

function stripBoth(s: string): string {
  let start = 0;
  while (start < s.length && (s[start] === ' ' || s[start] === '\t')) start++;
  let end = s.length;
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(start, end);
}

function getLeadingWhitespace(s: string): string {
  let start = 0;
  while (start < s.length && (s[start] === ' ' || s[start] === '\t')) start++;
  return s.slice(0, start);
}

function linesMatchAtTier(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) return stripTrailing(fileLine) === stripTrailing(oLine);
  if (tier === 2) return stripBoth(fileLine) === stripBoth(oLine);
  return false;
}

function findOccurrences(fileLines: string[], oLines: string[], strict: boolean, startIndex = 0, maxTier = 2): { tier: number; index: number }[] {
  if (oLines.length === 0) return [];
  const startTier = 0;
  const endTier = strict ? 0 : maxTier;

  for (let tier = startTier; tier <= endTier; tier++) {
    const matches: { tier: number; index: number }[] = [];
    for (let i = startIndex; i <= fileLines.length - oLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oLines.length; j++) {
        if (!linesMatchAtTier(fileLines[i + j]!, oLines[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matches.push({ tier, index: i });
      }
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

function applyReindent(nLines: string[], fileFirstMatchLine: string, oFirstLine: string, tier: number): string[] {
  if (tier !== 2) return [...nLines];
  const F = getLeadingWhitespace(fileFirstMatchLine);
  const P = getLeadingWhitespace(oFirstLine);
  return nLines.map((l) => {
    if (l === '' || l.trim() === '') return l;
    if (l.startsWith(P)) {
      return F + l.slice(P.length);
    }
    return l;
  });
}

// --- Format Detection ---

function detect(lines: string[]): string | null {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank >= 0) {
    if (lines[firstNonBlank]!.trim() === '*** Begin Patch') return 'v4a';
    const firstChar = lines[firstNonBlank]!.trimStart()[0];
    if (firstChar === '[' || firstChar === '{') return 'json';
  }
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- JSON Edits (Section 9) ---

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

// --- Unified Diffs (Section 6) ---

interface UnifiedHunk {
  aStart: number;
  lines: { type: ' ' | '-' | '+' | '\\'; text: string }[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedPath(raw: string): string | null {
  const t = raw.trim();
  if (t === '/dev/null') return null;
  let p = t.split('\t')[0]!.trim();
  p = p.replace(/^([ab])\//, '');
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let currentSec: UnifiedSection | null = null;

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const parts = l.slice(11).trim().split(/\s+/);
      if (parts.length < 2) throw new Exit2(`error: parse ${i + 1}`);
      const p1 = parseUnifiedPath(parts[0]!);
      const p2 = parseUnifiedPath(parts[1]!);
      currentSec = { oldPath: p1, newPath: p2, isCreate: false, isDelete: false, hunks: [] };
      sections.push(currentSec);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nextLine = lines[i + 1];
      if (nextLine === undefined || !nextLine.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      const oldP = parseUnifiedPath(l.slice(4));
      const newP = parseUnifiedPath(nextLine.slice(4));
      if (!currentSec || currentSec.hunks.length > 0) {
        currentSec = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
        sections.push(currentSec);
      } else {
        currentSec.oldPath = oldP;
        currentSec.newPath = newP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      const p = l.slice(12).trim();
      if (currentSec) currentSec.oldPath = p;
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      const p = l.slice(10).trim();
      if (currentSec) currentSec.newPath = p;
      i++;
      continue;
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) {
      if (currentSec) currentSec.isCreate = true;
      i++;
      continue;
    }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
      if (currentSec) currentSec.isDelete = true;
      i++;
      continue;
    }
    if (l.startsWith('@@ ')) {
      if (!currentSec) throw new Exit2(`error: parse ${i + 1}`);
      const m = l.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const aStart = parseInt(m[2]!, 10);
      i++;
      const hunkLines: { type: ' ' | '-' | '+' | '\\'; text: string }[] = [];
      while (i < lines.length) {
        const hl = lines[i]!;
        if (hl.startsWith('diff --git ') || (hl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
          break;
        }
        if (hl.startsWith('@@ ')) break;
        if (hl === ' ' || hl.startsWith(' ') || hl === '-' || hl.startsWith('-') || hl === '+' || hl.startsWith('+') || hl === '\\' || hl.startsWith('\\') || hl === '') {
          const type = hl === '' ? ' ' : (hl[0] as ' ' | '-' | '+' | '\\');
          const text = hl === '' ? '' : hl.slice(1);
          hunkLines.push({ type, text });
          i++;
        } else {
          break;
        }
      }
      // Trim trailing empty lines from hunk body
      while (hunkLines.length > 0 && hunkLines[hunkLines.length - 1]!.type === ' ' && hunkLines[hunkLines.length - 1]!.text === '') {
        hunkLines.pop();
      }
      currentSec.hunks.push({ aStart, lines: hunkLines });
      continue;
    }
    if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = sec.isDelete || newP === null;
    const isMove = oldP !== null && newP !== null && oldP !== newP;

    if (isCreate) {
      if (newP === null) continue;
      edits.push((tree) => {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const fileLines: string[] = [];
        let finalBreak = true;
        for (let hIdx = 0; hIdx < sec.hunks.length; hIdx++) {
          const h = sec.hunks[hIdx]!;
          for (let k = 0; k < h.lines.length; k++) {
            const hl = h.lines[k]!;
            if (hl.type === '+') {
              fileLines.push(hl.text);
              finalBreak = true;
            } else if (hl.type === '\\') {
              if (k > 0 && h.lines[k - 1]!.type === '+') {
                finalBreak = false;
              }
            }
          }
        }
        const text = fileLines.join('\n') + (finalBreak ? '\n' : '');
        tree.now.set(newP, text);
      });
    } else if (isDelete) {
      if (oldP === null) continue;
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      });
    } else {
      const targetPath = oldP ?? newP;
      if (targetPath === null) continue;
      edits.push((tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (isMove && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
        const beforeText = tree.get(targetPath);
        if (beforeText === null) throw new Fail('missing', targetPath);
        if (isMove && newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);

        const fl = parseFileText(beforeText);
        let curLines = [...fl.lines];
        let finalBreak = fl.finalBreak;

        let d = 0;
        for (const h of sec.hunks) {
          const oLines: string[] = [];
          const nLines: string[] = [];
          for (const hl of h.lines) {
            if (hl.type === ' ' || hl.type === '-') oLines.push(hl.text);
            if (hl.type === ' ' || hl.type === '+') nLines.push(hl.text);
          }

          const targetPos = h.aStart - 1 + d;
          let matchTier = 0;
          let matchIndex = 0;

          if (oLines.length > 0) {
            const occs = findOccurrences(curLines, oLines, strict, 0);
            if (occs.length === 0) throw new Fail('no-match', targetPath);
            let best = occs[0]!;
            let bestDist = Math.abs(best.index - targetPos);
            for (let idx = 1; idx < occs.length; idx++) {
              const o = occs[idx]!;
              const dist = Math.abs(o.index - targetPos);
              if (dist < bestDist || (dist === bestDist && o.index < best.index)) {
                best = o;
                bestDist = dist;
              }
            }
            matchTier = best.tier;
            matchIndex = best.index;
          } else {
            matchIndex = Math.max(0, Math.min(targetPos, curLines.length));
          }

          // Build replacement lines
          const newChunkLines: string[] = [];
          let fileMatchIdx = matchIndex;
          let oIdx = 0;
          let endsAtEof = false;

          for (let k = 0; k < h.lines.length; k++) {
            const hl = h.lines[k]!;
            if (hl.type === ' ') {
              const matchedLine = curLines[fileMatchIdx++] ?? hl.text;
              newChunkLines.push(matchedLine);
              oIdx++;
            } else if (hl.type === '-') {
              fileMatchIdx++;
              oIdx++;
            } else if (hl.type === '+') {
              let tLine = hl.text;
              if (matchTier === 2 && oLines.length > 0) {
                const F = getLeadingWhitespace(curLines[matchIndex]!);
                const P = getLeadingWhitespace(oLines[0]!);
                if (tLine !== '' && tLine.trim() !== '' && tLine.startsWith(P)) {
                  tLine = F + tLine.slice(P.length);
                }
              }
              newChunkLines.push(tLine);
            } else if (hl.type === '\\') {
              if (k > 0) {
                const prev = h.lines[k - 1]!;
                if ((prev.type === ' ' || prev.type === '+') && matchIndex + oLines.length === curLines.length) {
                  finalBreak = false;
                }
              }
            }
          }

          if (matchIndex + oLines.length === curLines.length && h.lines.some((hl) => hl.type === ' ' || hl.type === '+')) {
            // check if last line is \
            const lastL = h.lines[h.lines.length - 1];
            if (lastL?.type === '\\') {
              finalBreak = false;
            }
          }

          curLines.splice(matchIndex, oLines.length, ...newChunkLines);
          d += nLines.length - oLines.length;
        }

        const resText = serializeFile({ lines: curLines, crlf: fl.crlf, finalBreak }, fl.finalBreak);
        if (isMove && newP !== null) {
          tree.now.set(targetPath, null);
          tree.now.set(newP, resText);
          tree.moves.set(targetPath, newP);
        } else {
          tree.now.set(targetPath, resText);
        }
      });
    }
  }
  return edits;
}

// --- SEARCH/REPLACE Blocks (Section 7) ---

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastPath: string | null = null;
  let firstBlock = true;

  while (i < lines.length) {
    // Find <<<<<<< SEARCH
    let searchIdx = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        searchIdx = k;
        break;
      }
    }
    if (searchIdx < 0) break;

    // Find path before searchIdx
    let pathLine: string | null = null;
    let pathLineNum = -1;
    for (let pIdx = searchIdx - 1; pIdx >= (lastPath === null && firstBlock ? 0 : searchIdx - 20); pIdx--) {
      if (pIdx < 0) break;
      const pl = lines[pIdx]!;
      const trimmed = pl.trim();
      if (!blank(pl) && !trimmed.startsWith('```')) {
        pathLine = trimmed;
        pathLineNum = pIdx + 1;
        break;
      }
      if (pl.trimEnd().startsWith('>>>>>>> REPLACE')) break;
    }

    if (pathLine === null) {
      if (lastPath !== null) {
        pathLine = lastPath;
      } else {
        throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
    }
    lastPath = pathLine;
    firstBlock = false;

    // Find ======= and >>>>>>> REPLACE after searchIdx
    let equalsIdx = -1;
    let replaceIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      const kl = lines[k]!.trimEnd();
      if (kl === '=======') {
        equalsIdx = k;
      } else if (kl === '>>>>>>> REPLACE') {
        replaceIdx = k;
        break;
      }
    }

    if (equalsIdx < 0 || replaceIdx < 0 || equalsIdx > replaceIdx) {
      throw new Exit2(`error: parse ${searchIdx + 1}`);
    }

    const oldLines = lines.slice(searchIdx + 1, equalsIdx);
    const newLines = lines.slice(equalsIdx + 1, replaceIdx);
    const p = pathLine;

    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const text = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');
        tree.now.set(p, text);
      } else {
        const beforeText = tree.get(p);
        if (beforeText === null) throw new Fail('missing', p);
        const fl = parseFileText(beforeText);
        const occs = findOccurrences(fl.lines, oldLines, strict, 0);
        if (occs.length === 0) throw new Fail('no-match', p);
        if (occs.length > 1) throw new Fail('ambiguous', p);
        const occ = occs[0]!;

        const repLines = applyReindent(newLines, fl.lines[occ.index]!, oldLines[0]!, occ.tier);
        fl.lines.splice(occ.index, oldLines.length, ...repLines);
        tree.now.set(p, serializeFile(fl, fl.finalBreak));
      }
    });

    i = replaceIdx + 1;
  }

  return edits;
}

// --- V4A Patches (Section 8) ---

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }

  // Find last non-blank line
  let lastNonBlank = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastNonBlank = k;
      break;
    }
  }

  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const patchBody = lines.slice(firstNonBlank + 1, lastNonBlank);
  // Trim trailing blank lines from patchBody
  while (patchBody.length > 0 && blank(patchBody[patchBody.length - 1]!)) {
    patchBody.pop();
  }

  type V4ASection =
    | { type: 'add'; path: string; fileLines: string[]; lineNum: number }
    | { type: 'delete'; path: string; lineNum: number }
    | { type: 'update'; path: string; moveTo: string | null; chunks: { anchor: string | null; lines: { type: ' ' | '-' | '+' | 'eof'; text: string }[] }[]; lineNum: number };

  const sections: V4ASection[] = [];
  let sIdx = 0;

  while (sIdx < patchBody.length) {
    while (sIdx < patchBody.length && blank(patchBody[sIdx]!)) sIdx++;
    if (sIdx >= patchBody.length) break;

    const lineNum = firstNonBlank + 1 + sIdx + 1;
    const l = patchBody[sIdx]!;
    const trimmed = l.trim();

    if (trimmed.startsWith('*** Add File: ')) {
      const path = trimmed.slice(14).trim();
      sIdx++;
      const fileLines: string[] = [];
      while (sIdx < patchBody.length) {
        const bl = patchBody[sIdx]!;
        const bTrim = bl.trim();
        if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ')) {
          break;
        }
        if (bl.startsWith('+')) {
          fileLines.push(bl.slice(1));
        } else if (bl === '') {
          fileLines.push('');
        } else {
          throw new Exit2(`error: parse ${firstNonBlank + 1 + sIdx + 1}`);
        }
        sIdx++;
      }
      sections.push({ type: 'add', path, fileLines, lineNum });
    } else if (trimmed.startsWith('*** Delete File: ')) {
      const path = trimmed.slice(17).trim();
      sIdx++;
      sections.push({ type: 'delete', path, lineNum });
    } else if (trimmed.startsWith('*** Update File: ')) {
      const path = trimmed.slice(17).trim();
      sIdx++;
      let moveTo: string | null = null;
      const chunks: { anchor: string | null; lines: { type: ' ' | '-' | '+' | 'eof'; text: string }[] }[] = [];

      // Check for Move to
      while (sIdx < patchBody.length && blank(patchBody[sIdx]!)) sIdx++;
      if (sIdx < patchBody.length && patchBody[sIdx]!.trim().startsWith('*** Move to: ')) {
        moveTo = patchBody[sIdx]!.trim().slice(13).trim();
        sIdx++;
      }

      // Read chunks
      let curChunk: { anchor: string | null; lines: { type: ' ' | '-' | '+' | 'eof'; text: string }[] } | null = null;

      while (sIdx < patchBody.length) {
        const bl = patchBody[sIdx]!;
        const bTrim = bl.trim();
        if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ')) {
          break;
        }
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, lines: [] };
          chunks.push(curChunk);
          sIdx++;
          continue;
        }
        if (bl === '*** End of File') {
          if (curChunk) {
            curChunk.lines.push({ type: 'eof', text: '' });
          }
          sIdx++;
          continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (!curChunk) {
            curChunk = { anchor: null, lines: [] };
            chunks.push(curChunk);
          }
          const type = bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+');
          const text = bl === '' ? '' : bl.slice(1);
          curChunk.lines.push({ type, text });
          sIdx++;
          continue;
        }
        throw new Exit2(`error: parse ${firstNonBlank + 1 + sIdx + 1}`);
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
      sections.push({ type: 'update', path, moveTo, chunks, lineNum });
    } else {
      throw new Exit2(`error: parse ${lineNum}`);
    }
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.type === 'add') {
      edits.push((tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        const text = sec.fileLines.join('\n') + (sec.fileLines.length > 0 ? '\n' : '');
        tree.now.set(sec.path, text);
      });
    } else if (sec.type === 'delete') {
      edits.push((tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      });
    } else {
      edits.push((tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
        const beforeText = tree.get(sec.path);
        if (beforeText === null) throw new Fail('missing', sec.path);
        if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);

        const fl = parseFileText(beforeText);
        let curLines = [...fl.lines];
        let cursor = 0;

        for (const ch of sec.chunks) {
          // Check anchor if present
          if (ch.anchor !== null) {
            let foundAnchor = -1;
            for (let cIdx = cursor; cIdx < curLines.length; cIdx++) {
              if (linesMatchAtTier(curLines[cIdx]!, ch.anchor, 0) || linesMatchAtTier(curLines[cIdx]!, ch.anchor, 1) || linesMatchAtTier(curLines[cIdx]!, ch.anchor, 2)) {
                foundAnchor = cIdx;
                break;
              }
            }
            if (foundAnchor < 0) throw new Fail('no-match', sec.path);
            cursor = foundAnchor + 1;
          }

          const oLines: string[] = [];
          const nLines: string[] = [];
          let isEof = false;

          for (const cl of ch.lines) {
            if (cl.type === ' ' || cl.type === '-') oLines.push(cl.text);
            if (cl.type === ' ' || cl.type === '+') nLines.push(cl.text);
            if (cl.type === 'eof') isEof = true;
          }

          let matchTier = 0;
          let matchIndex = -1;

          if (oLines.length > 0) {
            if (isEof) {
              const occs = findOccurrences(curLines, oLines, strict, cursor);
              for (const o of occs) {
                if (o.index + oLines.length === curLines.length) {
                  matchIndex = o.index;
                  matchTier = o.tier;
                  break;
                }
              }
              if (matchIndex < 0) throw new Fail('no-match', sec.path);
            } else {
              const occs = findOccurrences(curLines, oLines, strict, cursor);
              if (occs.length === 0) throw new Fail('no-match', sec.path);
              matchIndex = occs[0]!.index;
              matchTier = occs[0]!.tier;
            }
          } else {
            // Empty O
            if (isEof) {
              matchIndex = curLines.length;
            } else {
              matchIndex = cursor;
            }
          }

          const newChunkLines: string[] = [];
          let fileMatchIdx = matchIndex;

          for (const cl of ch.lines) {
            if (cl.type === ' ') {
              newChunkLines.push(curLines[fileMatchIdx++] ?? cl.text);
            } else if (cl.type === '-') {
              fileMatchIdx++;
            } else if (cl.type === '+') {
              let tLine = cl.text;
              if (matchTier === 2 && oLines.length > 0) {
                const F = getLeadingWhitespace(curLines[matchIndex]!);
                const P = getLeadingWhitespace(oLines[0]!);
                if (tLine !== '' && tLine.trim() !== '' && tLine.startsWith(P)) {
                  tLine = F + tLine.slice(P.length);
                }
              }
              newChunkLines.push(tLine);
            }
          }

          curLines.splice(matchIndex, oLines.length, ...newChunkLines);
          cursor = matchIndex + newChunkLines.length;
        }

        const resText = serializeFile({ lines: curLines, crlf: fl.crlf, finalBreak: fl.finalBreak }, fl.finalBreak);
        if (sec.moveTo !== null) {
          tree.now.set(sec.path, null);
          tree.now.set(sec.moveTo, resText);
          tree.moves.set(sec.path, sec.moveTo);
        } else {
          tree.now.set(sec.path, resText);
        }
      });
    }
  }

  return edits;
}

// --- Main CLI Runner ---

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else edits = [];

    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: { sortKey: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;

    // Check if p is part of a move
    if (tree.moves.has(p)) {
      // old path moved to newPath
      const newPath = tree.moves.get(p)!;
      rows.push({ sortKey: newPath, line: `R ${p} -> ${newPath}` });
      continue;
    }

    // Check if p is a newPath of a move
    let isMoveNew = false;
    for (const [oldP, newP] of tree.moves.entries()) {
      if (newP === p) {
        isMoveNew = true;
        break;
      }
    }
    if (isMoveNew) {
      // handled when iterating oldP
      continue;
    }

    const type = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ sortKey: p, line: `${type} ${p}` });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => r.line);

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
