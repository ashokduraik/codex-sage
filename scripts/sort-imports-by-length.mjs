/**
 * Moves static `import` declarations to the top of each JS/JSX file
 * (after shebang + file-level JSDoc) and sorts them by full statement
 * character length ascending. Named bindings in multi-line imports are
 * sorted by line length ascending.
 *
 * Does not treat `import.meta`, `import()`, or identifiers like
 * `importOriginal` as static imports.
 *
 * In test files, top-level `vi.mock` / `vi.hoisted` are barriers: imports
 * that follow them stay after the mock block (Vitest mocked-module binding).
 *
 * Usage: node scripts/sort-imports-by-length.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');
const ROOTS = ['backend/src', 'backend/tests', 'frontend/src', 'frontend/tests'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lists `.js` / `.jsx` files under `dir`.
 * @param {string} dir Absolute directory.
 * @returns {string[]}
 */
function listJsFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && /\.(js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True only for a real static `import` keyword (not import.meta / importOriginal / import()).
 * @param {string} source
 * @param {number} from
 * @returns {boolean}
 */
function isStaticImportAt(source, from) {
  if (source.slice(from, from + 6) !== 'import') {
    return false;
  }
  if (from > 0 && /[A-Za-z0-9_$]/.test(source[from - 1])) {
    return false;
  }
  const after = source[from + 6];
  if (after !== undefined && /[A-Za-z0-9_$.]/.test(after)) {
    return false;
  }
  let i = from + 6;
  while (i < source.length && /[ \t\n\r]/.test(source[i])) {
    i += 1;
  }
  if (source[i] === '(') {
    return false;
  }
  return true;
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {number}
 */
function skipString(source, i) {
  const quote = source[i];
  i += 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {number}
 */
function skipTemplate(source, i) {
  i += 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') {
      return i + 1;
    }
    if (source[i] === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === "'" || ch === '"') {
          i = skipString(source, i);
          continue;
        }
        if (ch === '`') {
          i = skipTemplate(source, i);
          continue;
        }
        if (ch === '/' && source[i + 1] === '/') {
          const nl = source.indexOf('\n', i);
          i = nl < 0 ? source.length : nl;
          continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
          const end = source.indexOf('*/', i + 2);
          i = end < 0 ? source.length : end + 2;
          continue;
        }
        if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * @param {string} source
 * @param {number} from
 * @returns {number}
 */
function findImportEnd(source, from) {
  let i = from + 6;
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && braceDepth === 0) {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/**
 * End index of a call expression starting at `(` at `openParen`.
 * @param {string} source
 * @param {number} openParen
 * @returns {number}
 */
function findCallEnd(source, openParen) {
  let i = openParen + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  while (i < source.length && /[ \t]/.test(source[i])) {
    i += 1;
  }
  if (source[i] === ';') {
    i += 1;
  }
  return i;
}

/**
 * @param {string} source
 * @param {number} from
 * @returns {boolean}
 */
function isViMockOrHoistedAt(source, from) {
  if (source.slice(from, from + 3) !== 'vi.') {
    return false;
  }
  if (from > 0 && /[A-Za-z0-9_$]/.test(source[from - 1])) {
    return false;
  }
  const rest = source.slice(from);
  return rest.startsWith('vi.mock(') || rest.startsWith('vi.hoisted(');
}

/**
 * Top-level `vi.mock` / `vi.hoisted` call ranges.
 * @param {string} source
 * @returns {{ start: number, end: number }[]}
 */
function collectViBarriers(source) {
  /** @type {{ start: number, end: number }[]} */
  const calls = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (isViMockOrHoistedAt(source, i)) {
      const paren = source.indexOf('(', i);
      const end = findCallEnd(source, paren);
      calls.push({ start: i, end });
      i = end;
      continue;
    }
    i += 1;
  }
  return calls;
}

/**
 * @param {string} source
 * @returns {{ start: number, end: number, text: string }[]}
 */
function collectImports(source) {
  /** @type {{ start: number, end: number, text: string }[]} */
  const imports = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (isStaticImportAt(source, i)) {
      const end = findImportEnd(source, i);
      imports.push({ start: i, end, text: source.slice(i, end).replace(/\s+$/, '') });
      i = end;
      continue;
    }
    i += 1;
  }
  return imports;
}

/**
 * Leading shebang + file-level `/** ... *\/` only when it starts the file.
 * @param {string} source
 * @returns {{ prefix: string, bodyStart: number }}
 */
function splitFilePrefix(source) {
  let bodyStart = 0;
  let prefix = '';
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    if (nl < 0) {
      return { prefix: source, bodyStart: source.length };
    }
    prefix = source.slice(0, nl + 1);
    bodyStart = nl + 1;
  }
  const match = source.slice(bodyStart).match(/^(\s*\/\*\*[\s\S]*?\*\/[ \t]*\n)/);
  if (match) {
    prefix += match[1];
    bodyStart += match[1].length;
  }
  return { prefix, bodyStart };
}

/**
 * @param {string} statement
 * @returns {string}
 */
function sortNamedImportLines(statement) {
  const open = statement.indexOf('{');
  const close = statement.lastIndexOf('}');
  if (open < 0 || close <= open || !statement.slice(open, close).includes('\n')) {
    return statement;
  }
  const before = statement.slice(0, open + 1);
  const inside = statement.slice(open + 1, close);
  const after = statement.slice(close);
  const lines = inside.split('\n');
  /** @type {string[]} */
  const specs = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    specs.push(trimmed.replace(/,$/, ''));
  }
  if (specs.length < 2) {
    return statement;
  }
  const indentMatch = lines.find((line) => /^\s+\S/.test(line));
  const indent = indentMatch?.match(/^(\s+)/)?.[1] ?? '  ';
  specs.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const body = `\n${specs.map((spec) => `${indent}${spec},`).join('\n')}\n`;
  return `${before}${body}${after}`;
}

/**
 * @param {{ text: string }[]} imports
 * @returns {string}
 */
function formatImportBlock(imports) {
  if (imports.length === 0) {
    return '';
  }
  const sorted = imports
    .map((imp) => sortNamedImportLines(imp.text))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return `${sorted.join('\n')}\n`;
}

/**
 * After removing imports, find how far the leading vi.mock/vi.hoisted run extends.
 * @param {string} body
 * @returns {number} End offset within `body`.
 */
function leadingViSectionEnd(body) {
  let i = 0;
  let lastEnd = 0;
  let sawVi = false;
  while (i < body.length) {
    while (i < body.length && /[ \t\n\r]/.test(body[i])) {
      i += 1;
    }
    if (i >= body.length) {
      break;
    }
    if (body.startsWith('//', i)) {
      const nl = body.indexOf('\n', i);
      i = nl < 0 ? body.length : nl + 1;
      continue;
    }
    if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      i = end < 0 ? body.length : end + 2;
      continue;
    }
    if (isViMockOrHoistedAt(body, i)) {
      const paren = body.indexOf('(', i);
      i = findCallEnd(body, paren);
      lastEnd = i;
      sawVi = true;
      continue;
    }
    break;
  }
  return sawVi ? lastEnd : 0;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function rewriteFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const imports = collectImports(source);
  if (imports.length === 0) {
    return false;
  }

  const { prefix } = splitFilePrefix(source);
  const barriers = collectViBarriers(source);
  const firstBarrier = barriers.length > 0 ? barriers[0].start : null;
  const preImports = firstBarrier == null ? imports : imports.filter((imp) => imp.start < firstBarrier);
  const postImports = firstBarrier == null ? [] : imports.filter((imp) => imp.start >= firstBarrier);

  let without = source;
  for (const imp of [...imports].sort((a, b) => b.start - a.start)) {
    without = `${without.slice(0, imp.start)}${without.slice(imp.end)}`;
  }
  without = without.replace(/\r\n/g, '\n');

  let body = without;
  if (prefix && body.startsWith(prefix)) {
    body = body.slice(prefix.length);
  }
  body = body.replace(/^\s*\n+/, '');
  body = body.replace(/\n{3,}/g, '\n\n');

  const preBlock = formatImportBlock(preImports);
  const postBlock = formatImportBlock(postImports);

  let next;
  if (postImports.length === 0) {
    next = `${prefix}${preBlock}${body ? `\n${body.replace(/^\n+/, '')}` : ''}`;
  } else {
    const viEnd = leadingViSectionEnd(body);
    if (viEnd === 0) {
      // Barriers were removed with imports somehow — keep post imports after pre.
      next = `${prefix}${preBlock}\n${postBlock}${body ? `\n${body.replace(/^\n+/, '')}` : ''}`;
    } else {
      const before = body.slice(0, viEnd).replace(/\s+$/, '');
      const after = body.slice(viEnd).replace(/^\s*\n+/, '');
      next = `${prefix}${preBlock}\n${before}\n\n${postBlock}${after ? `\n${after}` : ''}`;
    }
  }

  next = next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');

  const normalizedOriginal = source.replace(/\s+$/, '\n');
  if (next === normalizedOriginal) {
    return false;
  }
  if (!CHECK_ONLY) {
    fs.writeFileSync(filePath, next, 'utf8');
  }
  return true;
}

const files = ROOTS.flatMap((root) => listJsFiles(path.join(REPO_ROOT, root))).sort();
let changedCount = 0;
for (const file of files) {
  // Some mock-barrier layouts need a second normalize pass to settle blanks.
  const first = rewriteFile(file);
  const second = CHECK_ONLY ? false : rewriteFile(file);
  if (first || second) {
    changedCount += 1;
    console.log(`${CHECK_ONLY ? 'would change' : 'updated'}: ${path.relative(REPO_ROOT, file)}`);
  }
}
console.log(
  CHECK_ONLY
    ? `${changedCount} file(s) need import reorder`
    : `Updated ${changedCount} file(s) of ${files.length}`,
);
process.exit(CHECK_ONLY && changedCount > 0 ? 1 : 0);
