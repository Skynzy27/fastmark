// fastmark — a fast CommonMark 0.31.2 + GFM 0.29 renderer whose output is
// byte-identical to marked 18.1.3 with its defaults (gfm on, breaks off).
// Written from scratch in this session for the make.fun markdown-render-speed-02
// bounty. Behaviour was verified against marked's own 720 practice cases.
//
// Design: a block lexer (dispatch on the next line's shape, same token rules as
// the reference) feeds an inline lexer that renders straight to HTML strings
// (no inline token tree), with link reference definitions collected first.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_RE_NO_ENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_TEST_NO_ENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const MULTI_SPACE = /\s+/g;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;
const CR = /\r\n|\r/g;

// HTML block tag names (CommonMark type 6).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

/** Escape HTML chars. encode=true escapes every &; false leaves valid entities alone. */
function esc(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_RE, (c) => ESC_MAP[c]);
  } else if (ESC_TEST_NO_ENC.test(s)) {
    return s.replace(ESC_RE_NO_ENC, (c) => ESC_MAP[c]);
  }
  return s;
}

/** Decode numeric character references; a stray & becomes &amp;. Named entities pass through. */
function decodeNums(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

/** encodeURI a URL, turning %25 back into % (marked's cleanUrl). Null when it throws. */
function cleanUrl(u) {
  try {
    return encodeURI(u).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalise a link label: trim, collapse whitespace, case-fold. */
function normLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Find the index of the close paren balancing the opens in s, or -1 (none) / -2 (unclosed). */
function findParen(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

/** Strip trailing chars: t=false strips trailing `ch`; t=true strips trailing non-`ch`. */
function stripTrail(s, ch, not) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}

/** Expand tabs to spaces, to the next multiple of 4 from column `col`. */
function expandTabs(s, col) {
  let t = col || 0;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += c;
      t++;
    }
  }
  return out;
}

/** Drop trailing blank lines when there are 2 or more of them. */
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

/** Split a table row on unescaped pipes, trimming cells and fixing the edges. */
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let esc = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/** Unescape backslash-escaped punctuation in a string. */
function unescapePunct(s) {
  return s.replace(ANY_PUNCT, '$1');
}

// ---- block grammar ----
// Patterns are composed from parts the same way a grammar composes rules:
// a small string-template helper embeds one pattern inside another, dropping
// a leading ^ anchor from the embedded part (it sits inside a lookahead).

function compose(src, subs, flags) {
  let s = src;
  for (const [key, val] of subs) {
    const rep = typeof val === 'string' ? val : val.source;
    const clean = rep.replace(/(^|[^\[])(\^)/g, '$1');
    s = key instanceof RegExp ? s.replace(key, clean) : s.replace(key, clean);
  }
  return new RegExp(s, flags);
}

const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_BEGIN_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_BEGIN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const LIST_BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const LIST_BULLET_1_SRC = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const TABLE_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

const reSpace = /^(?:[ \t]*(?:\n|$))+/;
const reCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const reFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const reHr = new RegExp('^' + HR_SRC);
const reHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const reList = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const reText = /^[^\n]+/;

// Link reference definition: [label]: dest "title" (title may sit on the next line).
const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const reDef = compose('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)', [
  ['label', LABEL_SRC],
  ['title', '(?:' + TITLE_SRC + ')'],
]);

// HTML block, types 1-7.
const reHtml = compose('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', [
  ['comment', '<!--(?:-?>|[\\s\\S]*?(?:-->|$))'],
  ['tag', BLOCK_TAGS],
  ['attribute', ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?'],
], 'i');

// Setext heading: paragraph text followed by a = or - underline. The lookaheads
// keep the text from swallowing another block's first line.
const LHEADING_TMPL = '^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
function buildLheading() {
  return compose(LHEADING_TMPL, [
    [/bull/g, LIST_BULLET_SRC],
    [/blockCode/g, '(?: {4}| {0,3}\\t)'],
    [/fences/g, ' {0,3}(?:`{3,}|~{3,})'],
    [/blockquote/g, BLOCKQUOTE_SRC],
    [/heading/g, HEADING_SRC],
    [/hr/g, HR_SRC],
    [/html/g, ' {0,3}<[^\\n>]+>\\n'],
    [/table/g, TABLE_SRC],
  ]);
}
const reLheading = buildLheading();

// Table: header line, delimiter row, body rows that start no new block.
const TABLE_TMPL = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
const reTable = compose(TABLE_TMPL, [
  ['hr', HR_SRC],
  ['heading', HEADING_SRC],
  ['blockquote', BLOCKQUOTE_SRC],
  ['code', '(?: {4}| {0,3}\\t)[^\\n]'],
  ['fences', FENCES_BEGIN_SRC],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', HTML_BEGIN_SRC],
]);

// Paragraph: lines of text that stop before another block starts. In GFM only
// a bullet list or an ordered list starting with 1 can interrupt one.
// The |TABLE slot holds the table rule (a paragraph stops before a table);
// inside blockquotes the slot is dropped.
const PARA_TMPL = '^([^\\n]+(?:\\n(?!hr|heading|blockquote|fences|list|html|TABLE|[ \\t]+\\n)[^\\n]+)*)';
function buildParagraph(listSrc, tableSrc) {
  return compose(PARA_TMPL, [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['blockquote', BLOCKQUOTE_SRC],
    ['fences', FENCES_BEGIN_SRC],
    ['list', listSrc],
    ['html', HTML_BEGIN_SRC],
    ['|TABLE', tableSrc ? '|' + tableSrc : ''],
  ]);
}
const reParagraph = buildParagraph(LIST_BULLET_1_SRC, reTable.source);
const reParagraphQuote = buildParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', null);

// Blockquote: > lines, plus lazy paragraph-continuation lines.
const reBlockquote = compose('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+', [
  ['paragraph', reParagraphQuote.source],
]);

// Per-indent helper regexes for the list reader (memoised). Marked's memoiser
// builds these with the clamped index max(0, min(3, indent-1)), not the indent.
const memo = new Map();
function memoRe(key, make) {
  let r = memo.get(key);
  if (!r) { r = make(); memo.set(key, r); }
  return r;
}
const clampIndent = (n) => Math.max(0, Math.min(3, n - 1));
const listItemRe = (bullet) => memoRe('li:' + bullet, () => new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`));
const nextBulletRe = (n) => memoRe('nb:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrAtRe = (n) => memoRe('hr:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesAtRe = (n) => memoRe('fe:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}(?:\`\`\`|~~~)`));
const headingAtRe = (n) => memoRe('he:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}#{1,6}(?:\\s|$)`));
const htmlAtRe = (n) => memoRe('ht:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteAtRe = (n) => memoRe('bq:' + clampIndent(n), () => new RegExp(`^ {0,${clampIndent(n)}}>`));

// Blockquote line surgery.
const reBQStart = /^ {0,3}>/;
const reBQMarkerWS = /^( {0,3}>)([ \t]+)/gm;
const reBQSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const reBQMarker = /^ {0,3}>[ \t]?/gm;
const reCodeIndent = /^(?: {0,3}\t| {1,4})/gm;
const reLeadingWS = /^[ \t]+/;
const reNonSpace = /[^ ]/;
const reSetextLine = /^ {0,3}(?:=+|-+) *$/;
const reListNesting = /^ {1,4}(?=( {4})*[^ ])/g;
const reFenceIndentComp = /^(\s+)(?:```)/;

// ---- block lexer ----
// Tokens are plain objects. Only blockquote / list / list-item tokens keep a
// `raw` (the nested re-parse needs it); paragraph and text tokens keep the
// inline source in `src`, rendered later once all link definitions are known.

function newCtx() {
  return {
    links: Object.create(null),
    queue: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
}

function queueInline(ctx, tok) {
  ctx.queue.push(tok);
  return tok;
}

/** Fenced code: strip the indent compensation when the body opens with a fence. */
function fenceText(raw, body) {
  const m = raw.match(reFenceIndentComp);
  if (m === null) return body;
  const indent = m[1];
  return body.split('\n').map((line) => {
    const o = line.match(reLeadingWS);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, indent.length));
  }).join('\n');
}

function tokSpace(src) {
  const m = reSpace.exec(src);
  return m ? { t: 'space', raw: m[0] } : null;
}

function tokCode(src) {
  const m = reCode.exec(src);
  if (!m) return null;
  const raw = trimBlankLines(m[0]);
  const text = raw.replace(reCodeIndent, '');
  return { t: 'code', raw, text, lang: null };
}

function tokFences(src) {
  const m = reFences.exec(src);
  if (!m) return null;
  const raw = m[0];
  const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
  const text = fenceText(raw, m[3] || '');
  return { t: 'code', raw, text, lang, fenced: true };
}

function tokHeading(src, ctx) {
  const m = reHeading.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (text.endsWith('#')) {
    const stripped = stripTrail(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  const tok = { t: 'heading', depth: m[1].length, src: text, raw: stripTrail(m[0], '\n') };
  queueInline(ctx, tok);
  return tok;
}

function tokHr(src) {
  const m = reHr.exec(src);
  return m ? { t: 'hr', raw: stripTrail(m[0], '\n') } : null;
}

function tokBlockquote(src, ctx) {
  const m = reBlockquote.exec(src);
  if (!m) return null;
  const lines = stripTrail(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const out = [];
  while (lines.length > 0) {
    let inQuote = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (reBQStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
      else if (!inQuote) chunk.push(lines[p]);
      else break;
    }
    lines.splice(0, p);
    const h = chunk.join('\n');
    const u = h
      .replace(reBQMarkerWS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(reBQSetext, '\n    $1')
      .replace(reBQMarker, '');
    raw = raw ? raw + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    blockTokens(u, out, ctx, true);
    ctx.state.top = savedTop;
    if (lines.length === 0) break;
    const last = out[out.length - 1];
    if (!last) break;
    if (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'blockquote') {
      const g = last;
      const b = lines.join('\n');
      const joined = g.raw + '\n' + b.replace(reBQMarker, '');
      const f = tokBlockquote(joined, ctx);
      out[out.length - 1] = f;
      const rest = joined.substring(f.raw.length).replace(/^\n/, '');
      const rCount = rest ? rest.split('\n').length : 0;
      const taken = rCount ? lines.slice(0, -rCount) : lines;
      if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
      text = text.substring(0, text.length - g.text.length) + f.text;
      lines.splice(0, taken.length);
      if (lines.length > 0 && reBQStart.test(lines[0])) continue;
      break;
    } else if (last.t === 'list') {
      const g = last;
      const b = g.raw + '\n' + lines.join('\n');
      const f = tokList(b, ctx);
      out[out.length - 1] = f;
      const extra = f.raw.length > g.raw.length ? b.slice(g.raw.length + 1, f.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines.splice(0, extra);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, items: out };
}

function tokList(src, ctx) {
  const m = reList.exec(src);
  if (!m) return null;
  const rest0 = src;
  const bulletText = m[1].trim();
  const ordered = bulletText.length > 1;
  const list = { t: 'list', raw: '', ordered, start: ordered ? +bulletText.slice(0, -1) : '', loose: false, items: [] };
  const bulletRe = ordered ? `\\d{1,9}\\${bulletText.slice(-1)}` : `\\${bulletText}`;
  const itemRe = listItemRe(bulletRe);
  let e = src;
  let prevBlank = false;
  const startLen = src.length;
  for (; e;) {
    let emptyItem = false;
    let d = '';
    const it = itemRe.exec(e);
    if (!it || reHr.test(e)) break;
    const itemStart = startLen - e.length;
    e = e.substring(it[0].length);
    const first = it[2].split('\n', 1)[0];
    const markerLen = it[1].length;
    const content = first.replace(reLeadingWS, (v) => expandTabs(v, markerLen));
    const nextLine = e.split('\n', 1)[0];
    const isEmpty = !content.trim();
    let indent;
    if (isEmpty && BLANK_LINE.test(nextLine)) {
      e = e.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const R = indentOf(content, markerLen, isEmpty);
      indent = R.indent;
      d = R.text;
      // continuation lines
      const vRe = nextBulletRe(indent);
      const qRe = hrAtRe(indent);
      const eeRe = fencesAtRe(indent);
      const teRe = headingAtRe(indent);
      const mRe = htmlAtRe(indent);
      const neRe = blockquoteAtRe(indent);
      let emptyLine = isEmpty;
      let cur = content;
      for (; e;) {
        const line = e.split('\n', 1)[0];
        let f = line;
        let z = f.replace(reLeadingWS, (w) => expandTabs(w));
        if (eeRe.test(f) || teRe.test(f) || mRe.test(f) || neRe.test(f) || vRe.test(f) || qRe.test(f)) break;
        if (z.search(reNonSpace) >= indent || !f.trim()) {
          d += '\n' + z.slice(indent);
        } else {
          if (emptyLine || cur.replace(/\t/g, '    ').search(reNonSpace) >= 4 || eeRe.test(cur) || teRe.test(cur) || mRe.test(cur) || qRe.test(cur)) break;
          let qe = f;
          if (reSetextLine.test(f)) {
            const trial = cur + '\n' + f;
            if (reLheading.test(trial)) qe = '    ' + z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        emptyLine = !f.trim();
        e = e.substring(line.length + 1);
        cur = z.slice(indent);
      }
    }
    const itemRaw = rest0.slice(itemStart, startLen - e.length);
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (DOUBLE_BLANK.test(itemRaw)) prevBlank = true;
    }
    list.items.push({ t: 'list_item', raw: itemRaw, task: false, loose: false, text: d, tokens: [] });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = rest0.slice(0, startLen - e.length).trimEnd();
  // Lex each item's content (state.top off: items hold text tokens, not paragraphs).
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(item.text, [], ctx, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.t === 'space');
      if (spaces.length > 0 && spaces.some((g) => ANY_LINE.test(g.raw))) list.loose = true;
    }
  }
  // Task markers. A task item whose first block is text gets its marker
  // stripped and a checkbox; any other first block cancels the task.
  for (const item of list.items) {
    const first = item.tokens[0];
    item.task = /^\[[ xX]\][ \t]+\S/.test(item.text);
    if (!item.task) continue;
    if (first?.t !== 'text' && first?.t !== 'paragraph') { item.task = false; continue; }
    item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
    first.src = first.src.replace(/^\[[ xX]\][ \t]+/, '');
    for (let g = ctx.queue.length - 1; g >= 0; g--) {
      if (/^\[[ xX]\][ \t]+\S/.test(ctx.queue[g].src)) {
        ctx.queue[g].src = ctx.queue[g].src.replace(/^\[[ xX]\][ \t]+/, '');
        break;
      }
    }
    const k = /\[[ xX]\]/.exec(item.raw);
    if (k) {
      item.checked = k[0] !== '[ ]';
      item.checkbox = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const d of item.tokens) if (d.t === 'text') d.t = 'paragraph';
    }
  }
  return list;
}

/** Content indent of a list item's first line: returns {indent, text}. */
function indentOf(content, markerLen, isEmpty) {
  if (isEmpty) return { indent: markerLen + 1, text: '' };
  const idx = content.search(reNonSpace);
  let r = idx > 4 ? 1 : idx;
  return { indent: r + markerLen, text: content.slice(r) };
}

function tokHtml(src) {
  const m = reHtml.exec(src);
  if (!m) return null;
  const raw = trimBlankLines(m[0]);
  return { t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}

function tokDef(src) {
  const m = reDef.exec(src);
  if (!m) return null;
  if (!m[2].startsWith('<') && findParen(m[2]) !== -1) return null;
  const label = normLabel(m[1]);
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
  return { t: 'def', raw: stripTrail(m[0], '\n'), tag: label, href, title };
}

function tokTable(src, ctx) {
  const m = reTable.exec(src);
  if (!m || !/[:|]/.test(m[2])) return null;
  const head = splitCells(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  const body = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const table = { t: 'table', raw: stripTrail(m[0], '\n'), header: [], align: [], rows: [] };
  if (head.length !== aligns.length) return null;
  for (const a of aligns) {
    if (/^ *-+: *$/.test(a)) table.align.push('right');
    else if (/^ *:-+: *$/.test(a)) table.align.push('center');
    else if (/^ *:-+ *$/.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < head.length; i++) {
    const cell = { src: head[i], align: table.align[i], header: true };
    queueInline(ctx, cell);
    table.header.push(cell);
  }
  for (const row of body) {
    const cells = splitCells(row, head.length).map((c, p) => {
      const cell = { src: c, align: table.align[p], header: false };
      queueInline(ctx, cell);
      return cell;
    });
    table.rows.push(cells);
  }
  return table;
}

function tokLheading(src, ctx) {
  const m = reLheading.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  const tok = { t: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, src: text, raw: stripTrail(m[0], '\n') };
  queueInline(ctx, tok);
  return tok;
}

function tokParagraph(src, ctx) {
  const m = reParagraph.exec(src);
  if (!m) return null;
  let text = m[1];
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  const tok = { t: 'paragraph', raw: m[0], src: text };
  queueInline(ctx, tok);
  return tok;
}

function tokText(src, ctx) {
  const m = reText.exec(src);
  if (!m) return null;
  const tok = { t: 'text', raw: m[0], src: m[0] };
  queueInline(ctx, tok);
  return tok;
}

// ---- block token stream ----
// Dispatches on the next line's shape but tries the same rules in the same
// order the reference does (space, code, fences, heading, hr, blockquote,
// list, html, def, table, setext, paragraph, text).

function blockTokens(src, out, ctx, inQuote) {
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('block lexer made no progress at ' + JSON.stringify(src.slice(0, 40)));
    guard = src.length;
    let tok = null;
    // Blank line(s)?
    if (src[0] === '\n' || src[0] === ' ' || src[0] === '\t') {
      const nl = src.indexOf('\n');
      const firstLine = nl === -1 ? src : src.slice(0, nl);
      if (/^[ \t]*$/.test(firstLine)) {
        const m = reSpace.exec(src);
        tok = { t: 'space', raw: m[0] };
      }
    }
    if (!tok) {
      // Indented code: four spaces, or a tab after at most three spaces.
      let sp = 0;
      while (src[sp] === ' ') sp++;
      if (sp >= 4 || (sp <= 3 && src[sp] === '\t')) {
        tok = tokCode(src);
      } else {
        const ch = src[sp];
        if (ch === '`' || ch === '~') tok = tokFences(src);
        else if (ch === '#') tok = tokHeading(src, ctx);
        else if (ch === '>') tok = tokBlockquote(src, ctx);
        else if (ch === '-' || ch === '+' || ch === '*') {
          tok = tokHr(src) || tokList(src, ctx);
        } else if (ch === '_') tok = tokHr(src);
        else if (ch >= '0' && ch <= '9') tok = tokList(src, ctx);
        else if (ch === '<') tok = tokHtml(src);
        else if (ch === '[') tok = tokDef(src);
        if (!tok) tok = tokTable(src, ctx);
        if (!tok) tok = tokLheading(src, ctx);
        if (!tok) tok = ctx.state.top ? tokParagraph(src, ctx) : tokText(src, ctx);
      }
    }
    if (!tok) throw new Error('no block token at ' + JSON.stringify(src.slice(0, 40)));
    const prev = out[out.length - 1];
    if (tok.t === 'space') {
      src = src.slice(tok.raw.length);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push(tok);
      continue;
    }
    if (tok.t === 'code') {
      src = src.slice(tok.raw.length);
      if (!tok.fenced && prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        // Indented code cannot interrupt a paragraph: its text joins it.
        // Fenced code can, so it never merges.
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.src += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = prev.src;
      } else out.push(tok);
      continue;
    }
    if (tok.t === 'def') {
      src = src.slice(tok.raw.length);
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.src += '\n' + tok.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.src;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        out.push(tok);
      }
      continue;
    }
    src = src.slice(tok.raw.length);
    if (tok.t === 'paragraph' && inQuote && prev && prev.t === 'paragraph') {
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      prev.src += '\n' + tok.src;
      ctx.queue.pop();
      ctx.queue[ctx.queue.length - 1].src = prev.src;
      continue;
    }
    if (tok.t === 'text' && prev && prev.t === 'text') {
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      prev.src += '\n' + tok.src;
      ctx.queue.pop();
      ctx.queue[ctx.queue.length - 1].src = prev.src;
      continue;
    }
    out.push(tok);
  }
  ctx.state.top = true;
  return out;
}

// ---- inline grammar ----
const PUNCT_SRC = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_SRC = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_SRC = '[^\\s\\p{P}\\p{S}]';
// GFM emphasis classes (marked's ht/lt): '~' is NOT punctuation — it counts as
// a word character for emphasis flanking, so '~~' does not end a closer run.
const PUNCT_GFM_SRC = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE_GFM_SRC = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_GFM_SRC = '(?:[^\\s\\p{P}\\p{S}]|~)';
const PROTOCOL_SRC = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';
const EMAIL_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_PROTO_SRC = '(?:mailto:' + EMAIL_SRC + '|xmpp:' + EMAIL_SRC + '(?:\\/[A-Za-z0-9@.]+)?)';

const reInlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const reInlineTag = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const reInlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const reInlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const rePunctuation = new RegExp('^((?![*_])' + PUNCT_SPACE_SRC + ')', 'u');
const reAnyPunct = new RegExp('\\\\(' + PUNCT_SRC + ')', 'gu');

// A link label: bracketed text, escapes, code spans, or plain chars (no brackets/backticks).
const BRACKETED_SRC = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LINK_LABEL_SRC = '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const labelSrc = LINK_LABEL_SRC.replace(/brackets/g, BRACKETED_SRC);

const reInlineLink = compose('^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)', [
  ['label', labelSrc],
  ['href', '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))'],
  ['title', '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)'],
]);
const reInlineReflink = compose('^!?\\[(label)\\]\\[(ref)\\]', [
  ['label', labelSrc],
  ['ref', REF_SRC],
]);
const reInlineNolink = compose('^!?\\[(ref)\\](?:\\[\\])?', [['ref', REF_SRC]]);

// Emphasis delimiters. The left delimiter is a run of * or _ plus one following
// char (punctuation or any non-space); the right delimiter is a pattern that
// walks the text and reports each candidate closer run with its flanking.
// GFM (the default) uses the '~'-excluding punct classes for the *-delimiters
// and the ft template for the _-delimiters; the normal classes stay for del.
const reEmLDelim = compose('^(?:\\*+(?:((?!\\*)(?!openQuote)punct)|([^\\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\\s_]))?', [
  [/punct/g, PUNCT_GFM_SRC],
], 'u');
const EM_R_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_R_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const reEmRDelimAst = compose(EM_R_AST_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_GFM_SRC],
  [/punctSpace/g, PUNCT_SPACE_GFM_SRC],
  [/punct/g, PUNCT_GFM_SRC],
], 'gu');
const reEmRDelimUnd = compose(EM_R_UND_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_SRC],
  [/punctSpace/g, PUNCT_SPACE_SRC],
  [/punct/g, PUNCT_SRC],
], 'gu');

// Strikethrough delimiters (marked also accepts a single ~).
const reDelLDelim = compose('^~~?(?:((?!~)punct)|[^\\s~])', [[/punct/g, PUNCT_SRC]], 'u');
const DEL_R_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const reDelRDelim = compose(DEL_R_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_SRC],
  [/punctSpace/g, PUNCT_SPACE_SRC],
  [/punct/g, PUNCT_SRC],
], 'gu');

const reAutolink = compose('^<(scheme:[^\\s\\x00-\\x1f<>]*|email)>', [
  ['scheme', '[a-zA-Z][a-zA-Z0-9+.-]{1,31}'],
  ['email', '[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])'],
]);
const reUrl = compose('^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email', [
  ['emailProtocol', EMAIL_PROTO_SRC],
  ['protocol', PROTOCOL_SRC],
  ['email', '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])'],
]);
const reBackpedal = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Plain text: one run up to the next inline construct.
const reInlineText = compose('^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*_~]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))', [
  [/emailProtocol/g, '(?:mailto|xmpp):'],
  ['protocol', PROTOCOL_SRC],
  ['wwwStart', '(?<![^\\s*_~(])www\\.'],
]);

// Masking patterns for the emphasis search: code spans / links / tags are
// blanked to same-length filler so delimiters inside them do not count.
const reAnyPunctOutsideCode = compose('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(punct)', [
  [/punct/g, PUNCT_SRC],
], 'gu');
const reBlockSkip = compose('link|(?<!`)()(code)|html', [
  ['link', '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\)\\(]|\\((?:\\\\[\\s\\S]|[^\\)\\(])*\\))*\\)'],
  ['code', '(?<b>`+)[^`]+\\k<b>(?!`)'],
  ['html', '<(?! )[^<>]*?>'],
], 'g');
const LABEL_SEARCH_SRC = '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const REF_SEARCH_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const reReflinkSearch = compose('reflink|nolink(?!\\()', [
  ['reflink', '^!?\\[(' + LABEL_SEARCH_SRC.replace(/brackets/g, BRACKETED_SRC) + ')\\]\\[(' + REF_SEARCH_SRC + ')\\]'],
  ['nolink', '^!?\\[(' + REF_SEARCH_SRC + ')\\](?:\\[\\])?'],
], 'g');

/** Last index in `s` where a closer run of each delimiter could start. */
function lastClosers(s) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const before = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    while (j < n && s[j] === c) j++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (c === '~') del = i;
      else em[c] = i;
    }
    i = j - 1;
  }
  return { em, del };
}

/** The masked string emphasis searches run on: link labels/destinations and
 * code spans become same-length filler, escaped punctuation becomes '+'. */
function maskForEmphasis(src, links, ctx) {
  let t = src;
  if (links && src.includes('[')) {
    const search = reReflinkSearch;
    const replaceRef = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(search, replaceRef) + '][' + 'a'.repeat(m.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(search, replaceRef);
  }
  reAnyPunctOutsideCode.lastIndex = 0;
  t = t.replace(reAnyPunctOutsideCode, (m, ticks, punct) => {
    if (punct) return '+'.repeat(m.length);
    if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
    return m;
  });
  reBlockSkip.lastIndex = 0;
  t = t.replace(reBlockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}

/** Does `s` hold a link (inline or reference) that would resolve? */
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  reBlockSkip.lastIndex = 0;
  for (const m of s.matchAll(reBlockSkip)) {
    if (reInlineLink.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  reReflinkSearch.lastIndex = 0;
  for (const m of s.matchAll(reReflinkSearch)) {
    const text = m[0];
    const o = text.lastIndexOf('[');
    if (text.charAt(0) === '!') continue;
    if (!Object.hasOwn(links, normLabel(text.slice(o + 1, -1)))) continue;
    if (o > 1 && linkInText(text.slice(1, o - 1), links)) continue;
    return true;
  }
  return false;
}

// ---- inline lexer (renders straight to HTML, no inline token tree) ----
// Mirrors marked's inline loop: escape, tag, link, reflink, emStrong,
// codespan, br, del, autolink, url, then plain text. The `textOnly` mode
// renders with the plain-text renderer (used for image alt text).
const RE_OUTPUT_LINK = /\\([\[\]])/g;
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const RE_NON_SPACE = /[^ ]/;
const RE_START_SPACE = /^ /;
const RE_END_SPACE = / $/;
const RE_NEWLINE_G = /\n/g;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;

/** Does the label contain an HTML tag or autolink running past its end? */
function labelHasTag(a, e, t) {
  if (!e.includes('<')) return false;
  for (let s = 0; s < e.length; s++) {
    if (e[s] === '\\') { s++; continue; }
    if (e[s] === '`') {
      const i = reInlineCode.exec(e.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (e[s] !== '<') continue;
    const r = a.slice(t + s);
    const o = reInlineTag.exec(r) || reAutolink.exec(r);
    if (o) {
      if (o[0].length > e.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

/** Build a link or image from a regex match and a {href, title} definition. */
function makeLink(a, def, raw, links, ctx, textOnly) {
  const r = def.href;
  const o = def.title || null;
  const i = a[1].replace(RE_OUTPUT_LINK, '$1');
  const l = a[0].charAt(0) === '!';
  const p = ctx.state.inLink;
  const h = ctx.state.linkEmitted;
  const u = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const d = inlineHtml(i, links, ctx, l || textOnly);
  const k = ctx.state.linkEmitted;
  ctx.state.linkEmitted = h;
  ctx.state.inLink = p;
  if (!l) {
    if (k) { ctx.state.inRawBlock = u; return null; }
    ctx.state.linkEmitted = true;
  }
  if (l) {
    // Image: alt text is the label rendered as plain text.
    const n = d;
    const href = cleanUrl(r);
    if (href === null) return { len: raw.length, html: esc(n, false), textOnly: n };
    let out = '<img src="' + esc(href, false) + '" alt="' + esc(n, false) + '"';
    if (o) out += ' title="' + esc(o, false) + '"';
    out += '>';
    return { len: raw.length, html: out, textOnly: n };
  }
  if (textOnly) return { len: raw.length, html: d, textOnly: d };
  const href = cleanUrl(r);
  if (href === null) return { len: raw.length, html: d, textOnly: d };
  let out = '<a href="' + esc(href, false) + '"';
  if (o) out += ' title="' + esc(o, false) + '"';
  out += '>' + d + '</a>';
  return { len: raw.length, html: out, textOnly: d };
}

function tokInlineLink(e, links, ctx, textOnly) {
  if (ctx.state.linkParenPossible === false) return null;
  const t = reInlineLink.exec(e);
  if (!t) return null;
  const n = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(e, t[1], n)) return null;
  const s = t[2].trim();
  if (RE_START_ANGLE.test(s)) {
    if (!RE_END_ANGLE.test(s)) return null;
    const l = stripTrail(s.slice(0, -1), '\\', false);
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findParen(t[2]);
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = stripTrail(t[0].slice(0, -1), '\\', false);
  if ((t[0].length - r.length) % 2 === 0) return null;
  let o = t[2];
  const i = t[3] ? t[3].slice(1, -1) : '';
  o = o.trim();
  if (RE_START_ANGLE.test(o)) o = o.slice(1, -1);
  return makeLink(t, {
    href: o && o.replace(reAnyPunct, '$1'),
    title: i && i.replace(reAnyPunct, '$1'),
  }, t[0], links, ctx, textOnly);
}

function tokInlineReflink(e, links, ctx, textOnly) {
  const n = reInlineReflink.exec(e) || reInlineNolink.exec(e);
  if (!n) return null;
  const s = n[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(e, n[1], s)) return null;
  const r = links[normLabel(n[2] || n[1])];
  if (!r) {
    const o = n[0].charAt(0);
    return { len: 1, html: o, textOnly: o, isText: true };
  }
  return makeLink(n, r, n[0], links, ctx, textOnly);
}

function tokEmStrong(e, t, prev, closers, links, ctx, textOnly) {
  const s = reEmLDelim.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prev === r;
  const i = t.length - e.length;
  let l = i;
  while (l > 0 && t[l - 1] === r) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!rePunctuation.exec(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : !!rePunctuation.exec(n);
  if (s[4] && RE_UNICODE_ALNUM.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? reEmRDelimAst : reEmRDelimUnd;
    const v = closers.em[r];
    const Q = i + k;
    if (v < Q) return null;
    const tt = t.slice(-e.length + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let match;
    while ((match = A.exec(tt)) !== null && !(match.index > ee)) {
      g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      b = [...g].length;
      if (match[3] || match[4]) { m += b; continue; }
      else if (match[5] || match[6] || R) {
        if (o && (match[5] || match[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...match[0]][0].length;
      const M = e.slice(0, k + match.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        const inner = inlineHtml(U, links, ctx, textOnly);
        return { len: M.length, html: textOnly ? inner : '<em>' + inner + '</em>', textOnly: inner };
      }
      const ne = M.slice(2, -2);
      const inner = inlineHtml(ne, links, ctx, textOnly);
      return { len: M.length, html: textOnly ? inner : '<strong>' + inner + '</strong>', textOnly: inner };
    }
  }
  return null;
}

function tokDel(e, t, prev, closers, links, ctx, textOnly) {
  const s = reDelLDelim.exec(e);
  if (!s) return null;
  if (!(s[1] || '') || !prev || rePunctuation.exec(prev)) {
    const o = [...s[0]].length - 1;
    let i, l, p = o;
    const h = reDelRDelim;
    const u = closers.del;
    const d = t.length - e.length + o;
    if (u < d) return null;
    const tt = t.slice(-e.length + o);
    const k = u - d;
    h.lastIndex = 0;
    let m;
    while ((m = h.exec(tt)) !== null && !(m.index > k)) {
      i = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!i) continue;
      l = [...i].length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...m[0]][0].length;
      const b = e.slice(0, o + m.index + g + l);
      const inner = inlineHtml(b.slice(o, -o), links, ctx, textOnly);
      return { len: b.length, html: textOnly ? inner : '<del>' + inner + '</del>', textOnly: inner };
    }
  }
  return null;
}

function tokUrl(e, textOnly) {
  const t = reUrl.exec(e);
  if (!t) return null;
  let n, s;
  if (t[2] === '@') {
    n = t[0];
    s = 'mailto:' + n;
  } else {
    let r;
    do {
      r = t[0];
      t[0] = reBackpedal.exec(t[0])?.[0] ?? '';
    } while (r !== t[0]);
    n = t[0];
    s = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  if (textOnly) return { len: t[0].length, html: n, textOnly: n };
  const text = esc(n, true);
  const href = cleanUrl(s);
  if (href === null) return { len: t[0].length, html: text, textOnly: n };
  return { len: t[0].length, html: '<a href="' + esc(href, true) + '">' + text + '</a>', textOnly: n };
}

/** Render one inline source to HTML (or plain text when textOnly). */
function inlineHtml(src, links, ctx, textOnly) {
  const savedParen = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = savedParen && src.includes(')');
  const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskForEmphasis(src, links, ctx) : src;
  const closers = lastClosers(masked);
  let out = '';
  let e = src;
  const t = masked;
  let r = '';
  let s = false;
  let guard = Infinity;
  while (e) {
    if (e.length >= guard) break;
    guard = e.length;
    if (!s) r = '';
    s = false;
    let m = reInlineEscape.exec(e);
    if (m) {
      out += textOnly ? m[1] : esc(m[1], false);
      e = e.substring(m[0].length);
      continue;
    }
    m = reInlineTag.exec(e);
    if (m) {
      const tag = m[0];
      if (!ctx.state.inLink && RE_START_A_TAG.test(tag)) ctx.state.inLink = true;
      else if (ctx.state.inLink && RE_END_A_TAG.test(tag)) ctx.state.inLink = false;
      if (!ctx.state.inRawBlock && RE_START_PRE.test(tag)) ctx.state.inRawBlock = true;
      else if (ctx.state.inRawBlock && RE_END_PRE.test(tag)) ctx.state.inRawBlock = false;
      out += tag;
      e = e.substring(tag.length);
      continue;
    }
    let res = tokInlineLink(e, links, ctx, textOnly);
    if (res) {
      out += textOnly ? res.textOnly : res.html;
      e = e.substring(res.len);
      continue;
    }
    res = tokInlineReflink(e, links, ctx, textOnly);
    if (res) {
      out += textOnly ? res.textOnly : res.html;
      e = e.substring(res.len);
      if (res.isText) {
        if (res.html.slice(-1) !== '_') r = res.html.slice(-1);
        s = true;
      }
      continue;
    }
    res = tokEmStrong(e, t, r, closers, links, ctx, textOnly);
    if (res) {
      out += textOnly ? res.textOnly : res.html;
      e = e.substring(res.len);
      continue;
    }
    m = reInlineCode.exec(e);
    if (m) {
      let n = m[2].replace(RE_NEWLINE_G, ' ');
      if (RE_NON_SPACE.test(n) && RE_START_SPACE.test(n) && RE_END_SPACE.test(n)) n = n.substring(1, n.length - 1);
      out += textOnly ? n : '<code>' + esc(n, true) + '</code>';
      e = e.substring(m[0].length);
      continue;
    }
    m = reInlineBr.exec(e);
    if (m) {
      if (!textOnly) out += '<br>';
      e = e.substring(m[0].length);
      continue;
    }
    res = tokDel(e, t, r, closers, links, ctx, textOnly);
    if (res) {
      out += textOnly ? res.textOnly : res.html;
      e = e.substring(res.len);
      continue;
    }
    m = reAutolink.exec(e);
    if (m) {
      let n, href;
      if (m[2] === '@') { n = m[1]; href = 'mailto:' + n; } else { n = m[1]; href = n; }
      if (textOnly) {
        out += n;
      } else {
        const text = esc(n, true);
        const url = cleanUrl(href);
        out += url === null ? text : '<a href="' + esc(url, true) + '">' + text + '</a>';
      }
      e = e.substring(m[0].length);
      continue;
    }
    if (!ctx.state.inLink) {
      res = tokUrl(e, textOnly);
      if (res) {
        out += textOnly ? res.textOnly : res.html;
        e = e.substring(res.len);
        continue;
      }
    }
    m = reInlineText.exec(e);
    if (m) {
      const raw = m[0];
      e = e.substring(raw.length);
      if (raw.slice(-1) !== '_') r = raw.slice(-1);
      s = true;
      if (textOnly) out += ctx.state.inRawBlock ? raw : decodeNums(raw);
      else out += ctx.state.inRawBlock ? raw : esc(decodeNums(raw), false);
      continue;
    }
    break;
  }
  ctx.state.linkParenPossible = savedParen;
  return out;
}

// ---- block renderers ----
function renderListItem(item, ctx) {
  if (item.checkbox && item.loose && item.tokens[0] && (item.tokens[0].t === 'paragraph' || item.tokens[0].t === 'text')) {
    // Loose task item: the checkbox renders inside the first paragraph.
    const first = item.tokens[0];
    const firstHtml = first.t === 'paragraph'
      ? '<p>' + item.checkbox + (first.html || '') + '</p>\n'
      : item.checkbox + (first.html || '');
    return '<li>' + firstHtml + renderTokens(item.tokens.slice(1), ctx) + '</li>\n';
  }
  if (item.checkbox && item.loose) {
    // Loose task item whose first block is not a paragraph: checkbox in its own paragraph.
    return '<li><p>' + item.checkbox + '</p>\n' + renderTokens(item.tokens, ctx) + '</li>\n';
  }
  return '<li>' + (item.checkbox || '') + renderTokens(item.tokens, ctx) + '</li>\n';
}

function renderTokens(tokens, ctx) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + tok.depth + '>' + (tok.html || '') + '</h' + tok.depth + '>\n';
        break;
      case 'code': {
        const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0];
        const r = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        const body = esc(r, true);
        out += lang
          ? '<pre><code class="language-' + esc(lang, false) + '">' + body + '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.items, ctx) + '</blockquote>\n';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + (tok.html || '') + '</p>\n';
        break;
      case 'text':
        out += tok.html || '';
        break;
      case 'list': {
        let s = '';
        for (const item of tok.items) s += renderListItem(item, ctx);
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + s + '</' + tag + '>\n';
        break;
      }
      case 'table': {
        let headerCells = '';
        for (const cell of tok.header) {
          headerCells += (cell.align ? '<th align="' + cell.align + '">' : '<th>') + (cell.html || '') + '</th>\n';
        }
        let bodyRows = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) {
            cells += (cell.align ? '<td align="' + cell.align + '">' : '<td>') + (cell.html || '') + '</td>\n';
          }
          bodyRows += '<tr>\n' + cells + '</tr>\n';
        }
        const tbody = bodyRows ? '<tbody>' + bodyRows + '</tbody>' : '';
        out += '<table>\n<thead>\n<tr>\n' + headerCells + '</tr>\n</thead>\n' + tbody + '</table>\n';
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Parse Markdown to HTML, byte-identical to marked 18.1.3 defaults. */
function parse(markdown) {
  const src = String(markdown).replace(CR, '\n');
  const ctx = newCtx();
  const tokens = blockTokens(src, [], ctx, false);
  for (const tok of ctx.queue) {
    ctx.state.inRawBlock = false;
    tok.html = inlineHtml(tok.src, ctx.links, ctx, false);
  }
  return renderTokens(tokens, ctx);
}

export { parse };
