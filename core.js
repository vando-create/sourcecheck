// Source of Truth Checker — core engine.
// Compares an Anduin form JSON (form + embedded annotation layer) against its source PDFs.
// Isomorphic: works in the browser and in Node (pdf.js is injected).

/* ----------------------------- text utilities ----------------------------- */

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', sect: '§', bull: '•' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Anduin footnotes: <span data-title="FOOTNOTE HTML">FOOT_NOTE_HERE</span>
export function splitFootnotes(html) {
  // Two flavours in Anduin forms:
  //   <span data-title="NOTE">FOOT_NOTE_HERE</span>   -> footnote icon
  //   <span data-title="DEFINITION">Defined Term</span> -> tooltip on visible words
  const notes = [];
  if (!html) return { main: '', notes };
  const main = String(html)
    .replace(/<span[^>]*?data-title="([^"]*)"[^>]*>/g, (m, t) => { notes.push(decodeEntities(t)); return '<span>'; })
    .replace(/FOOT_NOTE_HERE/g, ' ');
  return { main, notes };
}

export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<sup[^>]*>\s*\d{1,3}\s*<\/sup>/gi, ' '); // footnote markers
  s = s.replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

// Normalize a raw word into a comparison token ('' = ignore)
export function normWord(raw) {
  let w = raw.toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[^a-z0-9]/g, '');
  if (!w) return '';
  const m = /^([a-z]{3,})(\d{1,2})$/.exec(w); // footnote marker glued to a word: "investor1"
  if (m) w = m[1];
  return w;
}

export function tokenize(text) {
  const raws = text.split(/[\s ]+|(?<=[a-z])[\/–—](?=[a-z])/i).filter(Boolean);
  const toks = [], rawOut = [];
  for (const r of raws) {
    const n = normWord(r);
    if (n) { toks.push(n); rawOut.push(r); }
  }
  return { toks, raws: rawOut };
}

/* ------------------------------ PDF extraction ----------------------------- */

// Returns { name, numPages, pages:[{width,height,lines:[{text,x0,y0,x1,y1,size,words:[{raw,x0,x1}]}]}] }
// Coordinates are normalized 0..1, origin top-left (same convention as Anduin annotation positions).
export async function extractPdf(pdfjs, data, name, onProgress, keepDoc = false) {
  const doc = await pdfjs.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      const x = it.transform[4], yBase = it.transform[5];
      const yTop = vp.height - yBase - size * 0.85;
      items.push({ str: it.str, x0: x, x1: x + (it.width || it.str.length * size * 0.5), yTop, yBot: yTop + size, size });
    }
    items.sort((a, b) => (a.yTop + a.yBot) / 2 - (b.yTop + b.yBot) / 2 || a.x0 - b.x0);
    // group into lines by vertical overlap of centers
    const lines = [];
    for (const it of items) {
      const c = (it.yTop + it.yBot) / 2;
      let line = null;
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
        const L = lines[i];
        const lc = (L.yTop + L.yBot) / 2;
        if (Math.abs(lc - c) <= Math.max(L.size, it.size) * 0.45) { line = L; break; }
      }
      if (!line) { line = { items: [], yTop: it.yTop, yBot: it.yBot, size: it.size }; lines.push(line); }
      line.items.push(it);
      line.yTop = Math.min(line.yTop, it.yTop); line.yBot = Math.max(line.yBot, it.yBot); line.size = Math.max(line.size, it.size);
    }
    const outLines = [];
    for (const L of lines) {
      L.items.sort((a, b) => a.x0 - b.x0);
      // split a "line" into separate segments when there is a big horizontal gap (columns / table cells)
      let seg = null;
      const segs = [];
      for (const it of L.items) {
        const isSup = it.size < L.size * 0.8 && /^\s*\d{1,2}\s*$/.test(it.str);
        if (isSup) continue; // superscript footnote marker
        if (seg && it.x0 - seg.x1 > L.size * 3) { segs.push(seg); seg = null; }
        if (!seg) seg = { parts: [], x0: it.x0, x1: it.x1 };
        const gap = it.x0 - seg.x1;
        const needSpace = seg.parts.length && gap > L.size * 0.18 && !/\s$/.test(seg.parts[seg.parts.length - 1].str) && !/^\s/.test(it.str);
        seg.parts.push({ str: it.str, sp: !!needSpace, x0: it.x0, x1: it.x1 });
        seg.x1 = Math.max(seg.x1, it.x1);
      }
      if (seg) segs.push(seg);
      for (const s of segs) {
        // words with approximate x positions
        const words = [];
        let text = '';
        for (const part of s.parts) {
          const str = part.str;
          const span = part.x1 - part.x0;
          const len = str.length || 1;
          for (const m of str.matchAll(/\S+/g)) {
            const wx0 = part.x0 + span * (m.index / len), wx1 = part.x0 + span * ((m.index + m[0].length) / len);
            // glue to the previous word when two text items touch without a space ("S" + "ubscription")
            if (m.index === 0 && words.length && !part.sp && !/\s$/.test(text)) {
              const w = words[words.length - 1]; w.raw += m[0]; w.x1 = wx1;
            } else words.push({ raw: m[0], x0: wx0, x1: wx1 });
          }
          text += (part.sp ? ' ' : '') + str;
        }
        if (!words.length) continue;
        outLines.push({
          text: text.replace(/\s+/g, ' ').trim(),
          x0: s.x0 / vp.width, x1: s.x1 / vp.width, y0: L.yTop / vp.height, y1: L.yBot / vp.height, size: L.size,
          words: words.map(w => ({ raw: w.raw, x0: w.x0 / vp.width, x1: w.x1 / vp.width })),
        });
      }
    }
    pages.push({ width: vp.width, height: vp.height, lines: outLines });
    page.cleanup();
    if (onProgress) await onProgress(p, doc.numPages);
  }
  if (!keepDoc) { await doc.destroy(); return { name, numPages: pages.length, pages }; }
  return { name, numPages: pages.length, pages, pdfDoc: doc };
}

/* ------------------------------- form parsing ------------------------------ */

const CONTENT_WIDGETS = new Set(['Paragraph', 'TextBox', 'TextArea', 'Radio', 'MultipleCheckbox', 'Dropdown', 'Country', 'State', 'Date', 'Phone', 'Email', 'Money', 'Integer', 'Percentage', 'CustomFormat', 'Group', 'Repeatable', 'MultipleSuggest', 'File', 'FileGroup', 'Signature']);

export function parseForm(json) {
  const root = json.form ? json : { form: json };
  const ns = root.form.namespaceFormSchemaMap?.[root.form.defaultNamespace || 'main'] || Object.values(root.form.namespaceFormSchemaMap || {})[0];
  if (!ns) throw new Error('Not a form JSON: namespaceFormSchemaMap missing');
  const ui = ns.uiSchema || {};
  const widgets = [];
  const walk = (node, ctx) => {
    for (const child of node.properties || []) {
      const key = child.name;
      const u = ui[key] || {};
      const type = u['ui:widget'] || (child.type === 'object' ? 'Group' : 'Unknown');
      const hidden = ctx.hidden || u['ui:invisible'] === true;
      const isPage = type === 'Page';
      const pageTitle = isPage ? (child.title || key) : ctx.pageTitle;
      const pageKey = isPage ? key : ctx.pageKey;
      const path = isPage ? [...ctx.path, child.title || key] : ctx.path;
      const w = { key, type, title: child.title, u, hidden, pageKey, pageTitle, path: path.join(' › '), order: widgets.length };
      widgets.push(w);
      if (child.properties) walk(child, { hidden, pageTitle, pageKey, path: isPage ? path : (type === 'Group' && child.title && !ctx.pageKey ? [...ctx.path, child.title] : ctx.path) });
    }
  };
  walk(ns.schema, { hidden: false, pageTitle: '', pageKey: '', path: [] });

  // annotation layer: field / option key -> positions per pdf
  const pdfs = (root.uploadedPdf || []).map(([id, info]) => {
    const pos = new Map(); // key -> [{page,x,y,w,h}]
    // Anduin annotation positions: xPos = left edge, yPos = BOTTOM edge (top-left origin), normalized
    const add = (k, p) => {
      if (!k || !p) return;
      const v = { page: p.page, x: p.xPos, y: p.yPos - p.height, w: p.width, h: p.height };
      const arr = pos.get(k) || pos.set(k, []).get(k);
      if (!arr.some(o => o.page === v.page && Math.abs(o.x - v.x) < 1e-4 && Math.abs(o.y - v.y) < 1e-4)) arr.push(v);
    };
    for (const f of info.fields || []) {
      add(f.key, f.position);
      for (const [ok, op] of f.radioOptions || []) add(ok, op);
      const opts = f.widget?.['ui:multipleOption']?.options || [];
      const ro = new Set((f.radioOptions || []).map(([k]) => k));
      if (f.widgetType === 'MultipleCheckbox') for (const [ok] of opts) if (!ro.has(ok)) add(ok, f.position);
    }
    const sigPages = new Set((info.fields || []).filter(f => f.widgetType === 'Signature').map(f => f.position?.page));
    return { id, name: info.name, fieldCount: (info.fields || []).length, pos, sigPages, fieldPages: new Set((info.fields || []).map(f => f.position?.page).filter(Boolean)) };
  });

  // which pdfs does each widget map into
  const keyPdfs = (k) => pdfs.map((p, i) => (p.pos.has(k) ? i : -1)).filter(i => i >= 0);
  for (const w of widgets) {
    const maps = [...(w.u['ui:pdfMapping'] || [])];
    for (const [, o] of w.u['ui:multipleOption']?.options || []) maps.push(...(o.pdfMappings || []));
    for (const s of w.u['ui:signature'] || []) if (s.mapping) maps.push(s.mapping);
    w.mappings = maps;
    w.pdfSet = new Set(maps.flatMap(keyPdfs));
  }
  const pagePdfs = new Map();
  for (const w of widgets) if (w.pageKey) { const s = pagePdfs.get(w.pageKey) || new Set(); w.pdfSet.forEach(i => s.add(i)); pagePdfs.set(w.pageKey, s); }

  // mapped annotation keys (used to decide which PDF pages were digitized)
  const mappedKeys = new Set(widgets.filter(w => !w.hidden).flatMap(w => w.mappings));

  // text blocks to verify
  const blocks = [];
  const pushBlock = (w, field, rawHtml, extra = {}) => {
    const { main: raw, notes } = splitFootnotes(rawHtml);
    notes.forEach((n, i) => pushBlock(w, 'footnote', n, { footnoteOf: field, footnoteIndex: i + 1, optionKey: extra.optionKey }));
    const text = htmlToText(raw).replace(/\s*\*\s*$/, '').trim();
    if (!text) return;
    const { toks, raws } = tokenize(text);
    if (!toks.length) return;
    blocks.push({ id: blocks.length, widget: w, key: w.key, type: w.type, field, text, toks, raws, ...extra });
  };
  for (const w of widgets) {
    if (w.hidden || !CONTENT_WIDGETS.has(w.type) && w.type !== 'Header') continue;
    const u = w.u;
    if (w.type === 'Header') { if (u['ui:heading']) pushBlock(w, 'heading', u['ui:heading']); continue; }
    const ft = u['ui:formattedText'];
    if (ft && !/^(Pdf|Header|Repeatable|Group|Paragraph)$/.test(ft)) pushBlock(w, 'label', ft, { well: u['ui:wellType'] || null });
    if (u['ui:description']) pushBlock(w, 'description', u['ui:description']);
    for (const [ok, o] of u['ui:multipleOption']?.options || []) {
      if (o.formattedText) pushBlock(w, 'option', o.formattedText, { optionKey: ok, optionMappings: o.pdfMappings || [] });
    }
  }
  return { widgets, pdfs, pagePdfs, mappedKeys, blocks };
}

/* --------------------------- corpus & matching ----------------------------- */

const IGNORE_LINE = /^(confidential|page \d+( of \d+)?|[a-z]?\s?-?\s?\d+\s?-?|[ivxlc]+)$/i;

export function buildCorpus(pdfDocs) {
  // pdfDocs: [{name, pages, annotIndex}] ; returns flat token stream with back-references
  const tokens = [], refs = []; // refs[i] = {doc, page, line, word}
  const docStarts = [];
  pdfDocs.forEach((d, di) => {
    // detect repeated header/footer lines
    const counts = new Map();
    d.pages.forEach(pg => {
      const seen = new Set();
      for (const l of pg.lines) {
        if (l.y0 > 0.09 && l.y1 < 0.93) continue;
        const k = l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
        if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
      }
    });
    const minRepeat = Math.max(3, d.pages.length * 0.15);
    docStarts.push(tokens.length);
    d.pages.forEach((pg, pi) => {
      pg.lines.forEach((l, li) => {
        const edge = l.y0 <= 0.09 || l.y1 >= 0.93;
        const k = l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
        l.skip = edge && ((counts.get(k) || 0) >= minRepeat || IGNORE_LINE.test(l.text.trim()) || /page\s*\d+\s*of\s*\d+/i.test(l.text));
        if (l.skip) return;
        l.words.forEach((w, wi) => {
          const n = normWord(w.raw);
          w.tok = n;
          if (!n) return;
          w.ci = tokens.length;
          tokens.push(n); refs.push({ doc: di, page: pi, line: li, word: wi });
        });
      });
    });
  });
  docStarts.push(tokens.length);
  // de-hyphenate: "with-" + "drawal" across line breaks -> handled loosely by LCS; nothing to do
  // shingle index
  const K = 3;
  const index = new Map();
  for (let i = 0; i + K <= tokens.length; i++) {
    if (refs[i].doc !== refs[i + K - 1].doc) continue;
    const s = tokens[i] + ' ' + tokens[i + 1] + ' ' + tokens[i + 2];
    const arr = index.get(s);
    if (arr) { if (arr.length < 400) arr.push(i); } else index.set(s, [i]);
  }
  return { tokens, refs, docStarts, index, K, docs: pdfDocs };
}

// Drop small clusters of matches at either edge that are separated from the main match by a gap
// of unmatched PDF text (LCS happily matches stray "the"/"investor" in the preceding paragraph).
function trimPairs(pairs) {
  const gap = (a, b) => (b[1] - a[1]) - (b[0] - a[0]);
  let changed = true;
  while (changed && pairs.length > 3) {
    changed = false;
    let k = 0;
    while (k + 1 < pairs.length && gap(pairs[k], pairs[k + 1]) <= 4) k++;
    if (k + 1 < pairs.length && k + 1 <= 5 && k + 1 < pairs.length * 0.3) { pairs = pairs.slice(k + 1); changed = true; continue; }
    let e = pairs.length - 1;
    while (e - 1 >= 0 && gap(pairs[e - 1], pairs[e]) <= 4) e--;
    const tail = pairs.length - e;
    if (e > 0 && tail <= 5 && tail < pairs.length * 0.3) { pairs = pairs.slice(0, e); changed = true; }
  }
  return pairs;
}

function lcsAlign(a, b) {
  // returns pairs [[i,j],...] of matched indices (classic DP), a = query, b = window
  const n = a.length, m = b.length;
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * W + j] > dp[i * W + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// Find best location of query tokens in the corpus, restricted to allowed docs (Set of doc idx or null)
export function locate(corpus, q, allowedDocs, all = false) {
  const { tokens, refs, index, K, docStarts } = corpus;
  const n = q.length;
  if (n < 1) return all ? [] : null;
  const votes = new Map(), docOf = new Map();
  if (n >= K) {
    for (let i = 0; i + K <= n; i++) {
      const hits = index.get(q[i] + ' ' + q[i + 1] + ' ' + q[i + 2]);
      if (!hits || hits.length > 150) continue;
      for (const h of hits) {
        if (allowedDocs && !allowedDocs.has(refs[h].doc)) continue;
        const start = Math.max(0, h - i);
        const b = Math.floor(start / 12);
        votes.set(b, (votes.get(b) || 0) + 1);
        docOf.set(b, refs[h].doc);
      }
    }
  } else {
    // short query: exact sequence search
    for (let h = 0; h + n <= tokens.length; h++) {
      if (tokens[h] !== q[0]) continue;
      if (allowedDocs && !allowedDocs.has(refs[h].doc)) continue;
      let ok = true; for (let k = 1; k < n; k++) if (tokens[h + k] !== q[k]) { ok = false; break; }
      if (ok) { votes.set(Math.floor(h / 12), (votes.get(Math.floor(h / 12)) || 0) + n); docOf.set(Math.floor(h / 12), refs[h].doc); }
    }
  }
  if (!votes.size) return all ? [] : null;
  // merge adjacent buckets and take top candidates
  const cand = [...votes.entries()].map(([b, v]) => [b, v + (votes.get(b - 1) || 0) * 0.5 + (votes.get(b + 1) || 0) * 0.5]);
  cand.sort((x, y) => y[1] - x[1]);
  let best = null;
  const found = [];
  for (const [b] of cand.slice(0, all ? 10 : 4)) {
    const center = b * 12;
    const doc = docOf.get(b);
    const lo = Math.max(docStarts[doc], center - 24);
    const hi = Math.min(docStarts[doc + 1], center + Math.ceil(n * 1.35) + 30);
    const win = tokens.slice(lo, hi);
    if (n * win.length > 4_000_000) continue;
    const pairs = trimPairs(lcsAlign(q, win));
    if (!pairs.length) continue;
    const s = pairs[0][1], e = pairs[pairs.length - 1][1];
    const spanLen = e - s + 1;
    const L = pairs.length;
    const score = (2 * L) / (n + spanLen);
    const coverage = L / n;
    const r = { start: lo + s, end: lo + e, pairs: pairs.map(([i, j]) => [i, lo + j]), score, coverage, doc };
    if (all && !found.some(f => f.start <= r.end && r.start <= f.end)) found.push(r);
    if (!best || score * coverage > best.score * best.coverage) best = r;
  }
  return all ? found : best;
}

/* ------------------------------ diff utilities ----------------------------- */

const ACCEPTABLE_SUBS = [
  [['circle', 'circled', 'initial', 'initialed', 'tick', 'ticked', 'mark', 'marked', 'place', 'x', 'an', 'a'], ['check', 'checked', 'select', 'selected', 'the', 'a']],
  [['below', 'above', 'following', 'herein', 'hereto', 'attached'], ['below', 'above', 'following', 'herein', 'hereto', 'attached']],
  [['box', 'boxes', 'space', 'spaces', 'blank', 'line', 'lines'], ['box', 'boxes', 'option', 'options', 'field', 'fields', 'question']],
  [['print', 'type', 'insert', 'write', 'enter', 'fill', 'complete'], ['print', 'type', 'insert', 'write', 'enter', 'fill', 'complete', 'provide', 'please']],
];
const FILLER = new Set(['o', 'yes', 'no', 'true', 'false', 'na', 'n', 'a', 'please', 'specify', 'or', 'and', 'i', 'ii', 'iii', 'iv', 'v', 'b', 'c', 'd', 'e', 'f', 'if']);
function isAcceptablePair(formW, pdfW) {
  if (!formW.length && pdfW.length && pdfW.every(t => FILLER.has(t) || /^\d{1,3}$/.test(t))) return true;
  if (!pdfW.length && formW.length && formW.every(t => FILLER.has(t) || /^\d{1,3}$/.test(t))) return true;
  if (formW.length <= 2 && pdfW.length <= 2) {
    for (const [A, B] of ACCEPTABLE_SUBS) {
      const ok1 = pdfW.every(t => A.includes(t)) && formW.every(t => B.includes(t));
      const ok2 = formW.every(t => A.includes(t)) && pdfW.every(t => B.includes(t));
      if ((ok1 || ok2) && (pdfW.length || formW.length)) return true;
    }
  }
  return false;
}

// Build diff ops between a block and its matched corpus span.
export function buildDiff(block, corpus, m, coveredBy) {
  const ops = [];
  const { pairs } = m;
  let qi = 0, ci = m.start;
  const push = (type, formIdx, pdfIdx) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) { last.form.push(...formIdx); last.pdf.push(...pdfIdx); }
    else ops.push({ type, form: [...formIdx], pdf: [...pdfIdx] });
  };
  const flushGap = (qTo, cTo) => {
    const fIdx = []; for (let i = qi; i < qTo; i++) fIdx.push(i);
    const pIdx = []; for (let j = ci; j < cTo; j++) pIdx.push(j);
    if (fIdx.length || pIdx.length) push('chg', fIdx, pIdx);
  };
  // leading form-only tokens (before first match)
  for (const [i, j] of pairs) {
    flushGap(i, j);
    push('eq', [i], [j]);
    qi = i + 1; ci = j + 1;
  }
  flushGap(block.toks.length, m.end + 1);
  // classify change ops
  let significant = 0, critical = false;
  const formOnly = new Map(), pdfOnly = new Map();
  const bump = (M, t) => M.set(t, (M.get(t) || 0) + 1);
  for (const op of ops) if (op.type === 'chg') { op.form.forEach(i => bump(formOnly, block.toks[i])); op.pdf.forEach(j => bump(pdfOnly, corpus.tokens[j])); }
  const containedIn = (toks, M) => { const c = new Map(); for (const t of toks) { c.set(t, (c.get(t) || 0) + 1); if (c.get(t) > (M.get(t) || 0)) return false; } return true; };
  for (const op of ops) {
    if (op.type !== 'chg') continue;
    const fT = op.form.map(i => block.toks[i]);
    const pT = op.pdf.map(j => corpus.tokens[j]);
    if (fT.join('') === pT.join('')) { op.type = 'ok'; continue; } // spacing / punctuation only
    if (fT.length + pT.length >= 2 && ((!pT.length && containedIn(fT, pdfOnly)) || (!fT.length && containedIn(pT, formOnly)))) { op.type = 'moved'; continue; }
    // pdf-only run that belongs to another form block (footnote / page break interruption)
    if (!fT.length && pT.length && coveredBy) {
      const owned = op.pdf.filter(j => (coveredBy[j] >= 0 && coveredBy[j] !== block.id) || FILLER.has(corpus.tokens[j]) || /^\d{1,3}$/.test(corpus.tokens[j])).length;
      if (owned / pT.length > 0.6) { op.type = 'skip'; continue; }
    }
    if (isAcceptablePair(fT, pT)) { op.type = 'ok'; continue; }
    // changes to numbers, negations or single-letter references (Regulation D vs S) carry legal meaning
    const both = fT.length && pT.length;
    if ([...fT, ...pT].some(t => NEGATIONS.has(t) || (/\d/.test(t) && t.length >= 3)) || (both && fT.length <= 3 && pT.length <= 3 && [...fT, ...pT].some(t => t.length === 1 && /[a-z]/.test(t)))) critical = true;
    // short title added in front of the question (e.g. "U.S. Investor Status") — common form design practice
    if (op === ops[0] && !pT.length && fT.length <= 7) { op.type = 'title'; continue; }
    significant += Math.max(fT.length, pT.length);
  }
  return { ops, significant, critical };
}
const NEGATIONS = new Set(['not', 'never', 'none', 'except', 'unless', 'without', 'nor', 'neither', 'cannot', 'excluding']);

/* ------------------------------- analysis ---------------------------------- */

export function nameSimilarity(a, b) {
  const t = s => new Set(s.toLowerCase().replace(/\.pdf$/, '').split(/[^a-z0-9]+/).filter(x => x && !['fortress', 'lending', 'holdings', 'fund', 'the', 'pdf'].includes(x)));
  const A = t(a), B = t(b);
  let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
  return inter / Math.max(1, Math.min(A.size, B.size)) - Math.abs(A.size - B.size) * 0.01;
}

export function autoAssign(form, pdfNames) {
  // returns array: for each uploaded pdf name -> annotation index (or -1)
  return pdfNames.map(n => {
    let best = -1, bs = 0.5;
    form.pdfs.forEach((p, i) => { const s = nameSimilarity(n, p.name); if (s > bs) { bs = s; best = i; } });
    return best;
  });
}

export function analyze(form, pdfDocs, opts = {}) {
  const minBlockTokens = opts.minBlockTokens ?? 4;
  const minMissingRun = opts.minMissingRun ?? 8;
  const t0 = Date.now();
  const corpus = buildCorpus(pdfDocs);
  // map annotation index -> doc idx
  const annotToDoc = new Map();
  pdfDocs.forEach((d, di) => { if (d.annotIndex >= 0) annotToDoc.set(d.annotIndex, di); });
  const allowedFor = (b) => {
    const w = b.widget;
    let set = w.pdfSet.size ? w.pdfSet : (form.pagePdfs.get(w.pageKey) || new Set());
    const docs = new Set([...set].map(a => annotToDoc.get(a)).filter(x => x !== undefined));
    return docs.size ? docs : null;
  };

  const findings = [];
  const coveredBy = new Int32Array(corpus.tokens.length).fill(-1);
  const results = [];

  // pass 1: locate every block in every PDF (the same paragraph usually exists in several sub-docs)
  const nDocs = pdfDocs.length;
  const better = (x, y) => x && (!y || x.score * x.coverage > y.score * y.coverage);
  for (const b of form.blocks) {
    if (b.toks.length < minBlockTokens) continue;
    const allowed = allowedFor(b);
    let best = null, bestAllowed = null;
    const perDoc = new Map();
    for (let di = 0; di < nDocs; di++) {
      const ms = locate(corpus, b.toks, new Set([di]), true);
      if (!ms.length) continue;
      for (const x of ms) if (x.coverage >= 0.6 && x.score >= 0.5) for (let j = x.start; j <= x.end; j++) if (coveredBy[j] < 0) coveredBy[j] = b.id;
      const m = ms.reduce((a, c) => (better(c, a) ? c : a), null);
      if (better(m, best)) best = m;
      if ((!allowed || allowed.has(di)) && better(m, bestAllowed)) bestAllowed = m;
      if (!allowed || allowed.has(di)) perDoc.set(di, m);
    }
    // prefer the PDF(s) this widget is mapped into, unless another PDF matches much better
    let m = bestAllowed && bestAllowed.coverage >= 0.6 ? bestAllowed : best;
    if (bestAllowed && best && best !== bestAllowed && best.score * best.coverage - bestAllowed.score * bestAllowed.coverage < 0.05) m = bestAllowed;
    results.push({ b, m, perDoc });
  }

  // pass 1b: short labels ("(Name)", "Yes", "Tax Documents") — mark them covered on the pages their widget prints to
  const docPagesOf = (w) => {
    const out = new Map();
    for (const k of w.mappings) for (let di = 0; di < nDocs; di++) {
      const a = pdfDocs[di].annotIndex; if (a < 0) continue;
      for (const p of form.pdfs[a].pos.get(k) || []) { const set = out.get(di) || out.set(di, new Set()).get(di); set.add(p.page); set.add(p.page - 1); set.add(p.page + 1); }
    }
    return out;
  };
  const pageTokenStarts = new Map(); // "doc:page" -> [start, end)
  for (let j = 0; j < corpus.tokens.length; j++) { const r = corpus.refs[j]; const k = r.doc + ':' + (r.page + 1); const v = pageTokenStarts.get(k); if (v) v[1] = j + 1; else pageTokenStarts.set(k, [j, j + 1]); }
  const widgetPages = new Map();
  for (const b of form.blocks) {
    if (b.toks.length >= minBlockTokens) continue;
    let dp = widgetPages.get(b.widget); if (!dp) { dp = docPagesOf(b.widget); widgetPages.set(b.widget, dp); }
    for (const [di, pages] of dp) for (const pg of pages) {
      const rng = pageTokenStarts.get(di + ':' + pg); if (!rng) continue;
      for (let j = rng[0]; j + b.toks.length <= rng[1]; j++) {
        let ok = true; for (let k = 0; k < b.toks.length; k++) if (corpus.tokens[j + k] !== b.toks[k]) { ok = false; break; }
        if (ok) for (let k = 0; k < b.toks.length; k++) if (coveredBy[j + k] < 0) coveredBy[j + k] = b.id;
      }
    }
  }

  const refText = (s, e) => {
    const out = [];
    for (let j = s; j <= e; j++) { const r = corpus.refs[j]; out.push(pdfDocs[r.doc].pages[r.page].lines[r.line].words[r.word].raw); }
    return out.join(' ');
  };
  const locOf = (j) => { const r = corpus.refs[j]; const d = pdfDocs[r.doc]; const l = d.pages[r.page].lines[r.line]; return { doc: r.doc, pdf: d.name, page: r.page + 1, y: l.y0 }; };
  const boxesOf = (idxs) => {
    const byPage = new Map();
    for (const j of idxs) {
      const r = corpus.refs[j]; const l = pdfDocs[r.doc].pages[r.page].lines[r.line]; const w = l.words[r.word];
      const key = r.doc + ':' + r.page;
      const arr = byPage.get(key) || byPage.set(key, []).get(key);
      arr.push({ x0: w.x0, x1: w.x1, y0: l.y0, y1: l.y1 });
    }
    return [...byPage.entries()].map(([k, boxes]) => { const [doc, page] = k.split(':').map(Number); return { doc, page: page + 1, boxes }; });
  };

  // Per-PDF comparison. A form text must match EVERY sub doc it prints into, unless another form
  // element (e.g. a fund-specific variant) carries that sub doc's wording exactly.
  const okMatch = (x) => x && x.coverage >= 0.6 && x.score >= 0.5;
  const exactBy = new Int32Array(corpus.tokens.length).fill(-1);
  for (const r of results) {
    r.docDiffs = [];
    for (const [di, md] of r.perDoc) {
      if (!okMatch(md)) continue;
      const d = buildDiff(r.b, corpus, md, coveredBy);
      r.docDiffs.push({ di, m: md, ...d });
      if (!d.significant) for (let j = md.start; j <= md.end; j++) if (exactBy[j] < 0) exactBy[j] = r.b.id;
    }
  }
  const shortName = (di) => pdfDocs[di].name.replace(/\.pdf$/i, '');
  let matched = 0;
  for (const { b, m, docDiffs } of results) {
    const base = { formKey: b.key, widgetType: b.type, field: b.field, formPage: b.widget.path || b.widget.pageTitle, formText: b.text, optionKey: b.optionKey };
    const minCov = b.toks.length < 10 ? 0.75 : 0.5;
    if (!m || m.coverage < minCov || m.score < 0.45) {
      const partial = m && m.coverage >= 0.35 && b.toks.length >= 12;
      findings.push({ ...base, kind: 'not_in_pdf', severity: partial && !b.well ? 'medium' : 'info', bestScore: m ? +(m.score * m.coverage).toFixed(2) : 0, pdfText: m && m.coverage > 0.3 ? refText(m.start, m.end) : '', loc: m && m.coverage > 0.3 ? locOf(m.start) : null, highlights: m && m.coverage > 0.3 ? boxesOf(range(m.start, m.end)) : [], note: b.well ? `Custom ${b.well} message — not expected in the PDF; verify against the checklist.` : partial ? `Only ${Math.round(m.coverage * 100)}% of this text appears in the PDF — it may have been rewritten or mixed with other content.` : 'Form-only text (instruction / custom language). Verify against the checklist.' });
      continue;
    }
    matched++;
    let cands = docDiffs.length ? docDiffs : [{ di: m.doc, m, ...buildDiff(b, corpus, m, coveredBy) }];
    const exact = cands.filter(x => !x.significant);
    // a differing sub doc is fine if another form element reproduces its wording exactly
    const unresolved = cands.filter(x => {
      if (!x.significant) return false;
      if (!exact.length) return true; // matches no sub doc word for word
      let other = 0; for (let j = x.m.start; j <= x.m.end; j++) if (exactBy[j] >= 0 && exactBy[j] !== b.id) other++;
      return other / (x.m.end - x.m.start + 1) < 0.8;
    });
    if (!unresolved.length) continue;
    unresolved.sort((a, c) => a.significant - c.significant);
    const pick = unresolved[0];
    const { ops, significant, critical } = pick;
    const mm = pick.m;
    const diff = ops.map(op => ({ type: op.type, form: op.form.map(i => b.raws[i]).join(' '), pdf: op.pdf.map(j => { const r = corpus.refs[j]; return pdfDocs[r.doc].pages[r.page].lines[r.line].words[r.word].raw; }).join(' ') }));
    const changedPdf = ops.filter(o => o.type === 'chg').flatMap(o => o.pdf);
    const sev = critical || significant >= 8 || (significant >= 4 && significant / b.toks.length > 0.3) ? 'high' : significant >= 3 ? 'medium' : 'low';
    const variants = unresolved.slice(1).map(x => ({ pdf: pdfDocs[x.di].name, page: corpus.refs[x.m.start].page + 1, changed: x.significant }));
    let note;
    if (exact.length) note = `Matches ${exact.map(x => shortName(x.di)).join(', ')} word for word, but differs from ${unresolved.map(x => shortName(x.di)).join(', ')} — and no other form element carries that sub doc's wording. Check that each fund sees its own version.`;
    else if (variants.length) note = `Also differs from ${variants.map(v => shortName(pdfDocs.findIndex(d => d.name === v.pdf))).join(', ')}.`;
    findings.push({ ...base, kind: 'text_mismatch', severity: sev, changed: significant, score: +mm.score.toFixed(3), pdfText: refText(mm.start, mm.end), loc: locOf(mm.start), diff, highlights: boxesOf(range(mm.start, mm.end)), changedHighlights: boxesOf(changedPdf), fundVariant: exact.length > 0, variants, note });
  }

  // pass 2: PDF content not covered by any form block (only on digitized pages)
  for (let di = 0; di < pdfDocs.length; di++) {
    const d = pdfDocs[di];
    const annot = d.annotIndex >= 0 ? form.pdfs[d.annotIndex] : null;
    const scopePages = new Set();
    if (annot) {
      for (const [k, arr] of annot.pos) if (form.mappedKeys.has(k)) arr.forEach(p => scopePages.add(p.page));
    }
    if (opts.pageScope?.[di]) { scopePages.clear(); opts.pageScope[di].forEach(p => scopePages.add(p)); }
    const s = corpus.docStarts[di], e = corpus.docStarts[di + 1];
    // per-page uncovered ratio (a page that is almost entirely absent is usually an embedded PDF)
    const pageTot = new Map(), pageUnc = new Map();
    for (let j = s; j < e; j++) { const pg = corpus.refs[j].page + 1; pageTot.set(pg, (pageTot.get(pg) || 0) + 1); if (coveredBy[j] < 0) pageUnc.set(pg, (pageUnc.get(pg) || 0) + 1); }
    let runStart = -1;
    const medSize = new Map();
    const pageMedian = (pg) => {
      if (!medSize.has(pg)) { const sz = d.pages[pg - 1].lines.filter(l => !l.skip).map(l => l.size).sort((a, b) => a - b); medSize.set(pg, sz[Math.floor(sz.length / 2)] || 10); }
      return medSize.get(pg);
    };
    const isFootnoteRun = (a, b) => {
      for (let j = a; j < b; j++) { const r = corpus.refs[j]; const l = d.pages[r.page].lines[r.line]; if (l.y0 < 0.55 || l.size >= pageMedian(r.page + 1) * 0.93) return false; }
      return true;
    };
    const flush = (endIdx) => {
      if (runStart < 0) return;
      const len = endIdx - runStart;
      if (len >= 3 && len < minMissingRun && isFootnoteRun(runStart, endIdx)) {
        findings.push({ kind: 'missing_in_form', severity: 'medium', pdfText: refText(runStart, endIdx - 1), loc: locOf(runStart), words: len, highlights: boxesOf(range(runStart, endIdx - 1)), formPage: '', formText: '', note: 'Short PDF footnote that no form element carries.' });
      } else if (len >= minMissingRun) {
        const text = refText(runStart, endIdx - 1);
        const letters = text.replace(/[^a-z]/gi, '').length;
        const pg = corpus.refs[runStart].page + 1;
        const ratio = (pageUnc.get(pg) || 0) / (pageTot.get(pg) || 1);
        let severity = len >= 25 ? 'high' : 'medium', note = 'This PDF text was not found anywhere in the form.';
        if (annot?.sigPages.has(pg) && /(signature|in witness|executed|\bby:|name:|title:|date:)/i.test(text)) { severity = 'low'; note = 'Signature page — the signing block is normally handled by the e-signature flow.'; }
        else if (ratio > 0.85) { severity = 'low'; note = `${Math.round(ratio * 100)}% of this page is absent from the form — it is probably shown as an embedded PDF.`; }
        if (letters > 25) findings.push({ kind: 'missing_in_form', severity, pdfText: text, loc: locOf(runStart), words: len, highlights: boxesOf(range(runStart, endIdx - 1)), formPage: '', formText: '', note });
      }
      runStart = -1;
    };
    for (let j = s; j < e; j++) {
      const r = corpus.refs[j];
      const inScope = scopePages.has(r.page + 1);
      if (!inScope || coveredBy[j] >= 0) { flush(j); continue; }
      if (runStart >= 0 && corpus.refs[j - 1].page !== r.page) flush(j);
      if (runStart < 0) runStart = j;
    }
    flush(e);
  }

  // pass 3: option anchors — the PDF text beside each mapped checkbox should read like THIS option,
  // not like a sibling option (catches swapped / inverted mappings such as Yes<->No).
  const byWidget = new Map();
  for (const b of form.blocks) if (b.field === 'option' && b.optionMappings?.length) (byWidget.get(b.key) || byWidget.set(b.key, []).get(b.key)).push(b);
  for (const [, opts] of byWidget) {
    if (opts.length < 2) continue;
    for (const b of opts) {
      for (const mk of b.optionMappings) {
        for (let di = 0; di < pdfDocs.length; di++) {
          const d = pdfDocs[di];
          if (d.annotIndex < 0) continue;
          const pos = form.pdfs[d.annotIndex].pos.get(mk);
          if (!pos) continue;
          for (const p of pos) {
            const own = anchorCheck(b.toks, d, p, corpus);
            if (!own) continue;
            let bestSib = null;
            for (const o of opts) {
              if (o === b || o.toks.join(' ') === b.toks.join(' ')) continue;
              const r = anchorCheck(o.toks, d, p, corpus);
              if (r && (!bestSib || r.score > bestSib.score)) bestSib = { ...r, o };
            }
            if (bestSib && bestSib.score >= 0.75 && bestSib.score - own.score >= 0.35) {
              findings.push({ kind: 'option_anchor', severity: 'high', formKey: b.key, widgetType: b.type, field: 'option', optionKey: b.optionKey, formPage: b.widget.path, formText: b.text, pdfText: own.near, siblingText: bestSib.o.text, loc: { doc: di, pdf: d.name, page: p.page, y: p.y }, highlights: [{ doc: di, page: p.page, boxes: [{ x0: p.x, x1: p.x + p.w, y0: p.y, y1: p.y + p.h }] }], note: `Form option “${b.text.slice(0, 60)}” prints into the PDF box “${mk}”, but the text beside that box matches the option “${bestSib.o.text.slice(0, 60)}”. The mapping looks swapped.` });
            }
          }
        }
      }
    }
  }

  // merge identical "missing" runs that occur in several sub-docs into one finding
  const merged = [], seenMissing = new Map();
  for (const f of findings) {
    if (f.kind !== 'missing_in_form') { merged.push(f); continue; }
    const key = tokenize(f.pdfText).toks.slice(0, 40).join(' ');
    const prev = seenMissing.get(key);
    if (prev) { prev.also.push(f.loc); prev.alsoHighlights.push(...f.highlights); continue; }
    f.also = []; f.alsoHighlights = [];
    seenMissing.set(key, f); merged.push(f);
  }
  findings.length = 0; findings.push(...merged);

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  findings.forEach((f, i) => { f.id = i + 1; });
  const count = k => findings.filter(f => f.kind === k).length;
  return {
    summary: {
      blocksChecked: results.length, blocksMatched: matched, pdfs: pdfDocs.map(d => ({ name: d.name, pages: d.numPages, annotation: d.annotIndex >= 0 ? form.pdfs[d.annotIndex].name : null })),
      textMismatch: count('text_mismatch'), notInPdf: count('not_in_pdf'), missingInForm: count('missing_in_form'), optionAnchor: count('option_anchor'), ms: Date.now() - t0,
    },
    findings,
  };
}

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function anchorCheck(toks, doc, p, corpus) {
  const page = doc.pages[p.page - 1];
  if (!page) return null;
  const cy = p.y + p.h / 2;
  // candidate lines vertically overlapping the box
  const lines = page.lines.filter(l => !l.skip && Math.abs((l.y0 + l.y1) / 2 - cy) <= Math.max(p.h, l.y1 - l.y0) * 0.75);
  if (!lines.length) return null;
  // nearest word to the right of the box (label after box: "[ ] Yes"), penalising vertical offset
  let startCi = -1, bestR = Infinity, leftCi = -1, bestL = Infinity;
  for (const l of lines) {
    const dy = Math.abs((l.y0 + l.y1) / 2 - cy);
    for (const w of l.words) {
      if (w.ci === undefined) continue;
      const dxR = w.x0 - (p.x + p.w);
      if (dxR >= -0.006 && dxR < 0.045) { const c = dxR + dy * 3; if (c < bestR) { bestR = c; startCi = w.ci; } }
      const dxL = p.x - w.x1;
      if (dxL >= -0.006 && dxL < 0.03) { const c = dxL + dy * 3; if (c < bestL) { bestL = c; leftCi = w.ci; } }
    }
  }
  if (startCi < 0 && leftCi < 0) return null; // no label adjacent to the box (e.g. table with column headers)
  const q = toks.slice(0, 8);
  const n = q.length;
  const scoreAt = (s, dir) => {
    if (s < 0) return { cov: 0, text: '' };
    if (n <= 3) {
      const lo = dir > 0 ? s : s - n + 1;
      const seg = corpus.tokens.slice(Math.max(0, lo), lo + n);
      const ok = seg.length > 0 && seg[0] === q[0] && (n === 1 || corpus.tokens.slice(Math.max(0, lo), lo + n + 2).filter(t => q.includes(t)).length >= n - 1);
      const ctx = corpus.tokens.slice(Math.max(0, dir > 0 ? s : s - 4), dir > 0 ? s + 8 : s + 1).join(' ');
      return { cov: ok ? 1 : 0, text: ctx };
    }
    const lo = dir > 0 ? s : Math.max(0, s - n - 3), hi = dir > 0 ? Math.min(corpus.tokens.length, s + n + 6) : s + 1;
    const win = corpus.tokens.slice(lo, hi);
    const pairs = lcsAlign(q, win);
    const firstOk = dir > 0 ? (win[0] === q[0] || (pairs.length && pairs[0][1] <= 2)) : true;
    return { cov: pairs.length / n * (firstOk ? 1 : 0.7), text: win.slice(0, Math.min(win.length, 14)).join(' ') };
  };
  const right = scoreAt(startCi, 1);
  const left = n <= 3 ? scoreAt(leftCi, -1) : { cov: 0, text: '' };
  const best = Math.max(right.cov, left.cov);
  if (startCi < 0 && leftCi < 0) return null;
  const threshold = n <= 3 ? 0.99 : 0.6;
  const near = (right.cov >= left.cov ? right.text : left.text) || right.text || left.text;
  return { bad: best < threshold, near, score: best };
}
