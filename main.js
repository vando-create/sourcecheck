import { parseForm, extractPdf, analyze, autoAssign } from './core.js';
import { triage, DEFAULT_MODEL } from './ai.js';

// Deployment config (config.js). The self-hosted build serves PDF.js from ./vendor/ and can turn AI off.
const CFG = window.SC_CONFIG || {};
const PDFJS_BASE = new URL(CFG.pdfjsBase || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/', location.href).href;
const pdfjs = await import(PDFJS_BASE + 'pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
const AI_ENABLED = CFG.aiEnabled !== false;

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('sc:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sc:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('sc:' + k); } catch {} },
};

const KIND = {
  text_mismatch: { label: 'Text differs', cls: 't-mis', short: 'Differs' },
  missing_in_form: { label: 'Missing in form', cls: 't-miss', short: 'Missing' },
  not_in_pdf: { label: 'Form-only text', cls: 't-only', short: 'Form-only' },
  option_anchor: { label: 'Swapped mapping', cls: 't-anchor', short: 'Swapped' },
};
const FIELD = { label: 'Question / paragraph', option: 'Option label', footnote: 'Footnote / tooltip', heading: 'Header', description: 'Description' };

const S = {
  formFile: null, formJson: null, form: null,
  pdfs: [], // {file, name, annotIndex}
  docs: [], report: null,
  ai: new Map(), mine: {},
  filter: { kind: '', sev: new Set(['high', 'medium', 'low']), q: '', pdf: '', verdict: '' },
  selected: null, shown: 200,
  aiCfg: { key: store.get('aiKey', ''), model: store.get('aiModel', DEFAULT_MODEL), remember: !!store.get('aiKey', '') },
};

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ----------------------------------- setup ----------------------------------- */

function bindDrop(zone, input, onFiles) {
  zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { onFiles([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
}

async function loadForm(file) {
  try {
    const json = JSON.parse(await file.text());
    const form = parseForm(json);
    S.formFile = file; S.formJson = json; S.form = form;
    const vis = form.widgets.filter(w => !w.hidden).length;
    $('#form-card').hidden = false;
    $('#form-card').innerHTML = `<div class="fname">${esc(file.name)}</div>
      <div class="stats"><span>${form.widgets.length.toLocaleString()} widgets (${vis.toLocaleString()} visible)</span><span>${form.blocks.length.toLocaleString()} text blocks</span><span>${form.pdfs.length} annotated PDFs</span></div>
      <ul>${form.pdfs.map(p => `<li>${esc(p.name)} <span class="muted">· ${p.fieldCount} fields</span></li>`).join('')}</ul>`;
    $('#drop-form').classList.add('compact');
    $('#drop-form .drop-title').textContent = 'Replace form JSON';
    reassign();
  } catch (e) {
    console.error(e);
    toast('That file is not a Form Builder JSON export: ' + e.message, 5000);
  }
}

function addPdfs(files) {
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) continue;
    if (S.pdfs.some(p => p.name === f.name && p.file.size === f.size)) continue;
    S.pdfs.push({ file: f, name: f.name, annotIndex: -1, manual: false });
  }
  reassign();
}

function reassign() {
  if (S.form) {
    const auto = autoAssign(S.form, S.pdfs.map(p => p.name));
    S.pdfs.forEach((p, i) => { if (!p.manual) p.annotIndex = auto[i]; });
  }
  renderPdfTable();
  updateRun();
}

function renderPdfTable() {
  const box = $('#pdf-table');
  box.hidden = !S.pdfs.length;
  const opts = (sel) => `<option value="-1">${S.form ? 'No annotation (text only)' : 'Load the form JSON to match'}</option>` + (S.form ? S.form.pdfs.map((p, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>↔ ${esc(p.name)}</option>`).join('') : '');
  box.innerHTML = S.pdfs.map((p, i) => `<div class="pdf-row"><div class="fname">${esc(p.name)} <span class="muted">· ${(p.file.size / 1048576).toFixed(1)} MB</span></div><button class="rm" data-rm="${i}" title="Remove" aria-label="Remove ${esc(p.name)}">×</button><select class="select" data-as="${i}">${opts(p.annotIndex)}</select></div>`).join('');
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { S.pdfs.splice(+b.dataset.rm, 1); reassign(); });
  box.querySelectorAll('[data-as]').forEach(s => s.onchange = () => { const p = S.pdfs[+s.dataset.as]; p.annotIndex = +s.value; p.manual = true; });
  if (S.pdfs.length) { $('#drop-pdf').classList.add('compact'); $('#drop-pdf .drop-title').textContent = 'Add more PDFs'; }
}

function updateRun() {
  const ok = S.form && S.pdfs.length;
  $('#btn-run').disabled = !ok;
  $('#run-hint').textContent = !S.form ? 'Add the form JSON.' : !S.pdfs.length ? 'Add at least one source PDF.' :
    `${S.pdfs.length} PDF${S.pdfs.length > 1 ? 's' : ''} · ${S.pdfs.filter(p => p.annotIndex >= 0).length} matched to the annotation layer`;
}

async function run() {
  const prog = $('#progress'); prog.hidden = false;
  const bar = $('#prog-bar'), sub = $('#prog-sub'), title = $('#prog-title');
  try {
    for (const d of S.docs) d.pdfDoc?.destroy?.();
    S.docs = [];
    // estimate total pages for a smooth bar
    let done = 0, total = 0;
    const tasks = [];
    for (const p of S.pdfs) {
      const data = new Uint8Array(await p.file.arrayBuffer());
      tasks.push({ p, data });
    }
    total = S.pdfs.length * 100;
    for (let i = 0; i < tasks.length; i++) {
      const { p, data } = tasks[i];
      title.textContent = `Reading PDF ${i + 1} of ${tasks.length}`;
      const d = await extractPdf(pdfjs, data, p.name, async (pg, n) => {
        bar.style.width = ((i + pg / n) / tasks.length * 92).toFixed(1) + '%';
        sub.textContent = `${p.name} · page ${pg} / ${n}`;
        if (pg % 8 === 0) await new Promise(r => setTimeout(r));
      }, true);
      d.annotIndex = p.annotIndex;
      S.docs.push(d);
    }
    title.textContent = 'Comparing form and PDFs…'; sub.textContent = `${S.form.blocks.length.toLocaleString()} form text blocks`;
    bar.style.width = '96%';
    await new Promise(r => setTimeout(r, 30));
    S.report = analyze(S.form, S.docs);
    bar.style.width = '100%';
    S.ai = new Map(Object.entries(store.get('ai:' + formSig(), {})).map(([k, v]) => [+k, v]));
    S.mine = store.get('mine:' + formSig(), {});
    showResults();
  } catch (e) {
    console.error(e);
    toast('Something went wrong: ' + e.message, 6000);
  } finally {
    prog.hidden = true;
  }
}

function formSig() { return (S.formFile?.name || 'form') + ':' + (S.formFile?.size || 0) + ':' + S.pdfs.map(p => p.file.size).join(','); }
function fSig(f) { return [f.kind, f.formKey, f.field, f.optionKey, f.loc?.pdf, f.loc?.page, (f.formText || f.pdfText || '').slice(0, 60)].join('|'); }

/* ---------------------------------- results ---------------------------------- */

function showResults() {
  $('#setup').hidden = true; $('#results').hidden = false; $('#btn-new').hidden = false;
  S.selected = null; S.shown = 200;
  renderSummary(); renderToolbar(); renderList();
  const first = filtered()[0]; if (first) select(first.id);
}

function renderSummary() {
  const f = S.report.findings, sum = S.report.summary;
  const n = (k, sev) => f.filter(x => x.kind === k && (!sev || sev.includes(x.severity))).length;
  const cards = [
    { kind: '', k: 'All findings', n: f.filter(x => x.severity !== 'info').length, s: `${sum.blocksChecked.toLocaleString()} text blocks checked · ${(sum.ms / 1000).toFixed(1)}s` },
    { kind: 'text_mismatch', k: KIND.text_mismatch.label, n: n('text_mismatch'), s: `${n('text_mismatch', ['high'])} high severity` },
    { kind: 'missing_in_form', k: KIND.missing_in_form.label, n: n('missing_in_form'), s: `${n('missing_in_form', ['high', 'medium'])} on question pages` },
    { kind: 'not_in_pdf', k: KIND.not_in_pdf.label, n: n('not_in_pdf'), s: `${n('not_in_pdf', ['medium'])} look rewritten` },
    { kind: 'option_anchor', k: KIND.option_anchor.label, n: n('option_anchor'), s: n('option_anchor') ? 'check these first' : 'no swapped options' },
  ];
  $('#summary').innerHTML = cards.map(c => `<button class="card ${S.filter.kind === c.kind ? 'active' : ''}" data-kind="${c.kind}">
    <div class="k">${c.kind ? `<span class="tag ${KIND[c.kind].cls}">${KIND[c.kind].short}</span>` : ''}${esc(c.k)}</div><div class="n">${c.n}</div><div class="s">${esc(c.s)}</div></button>`).join('');
  $('#summary').querySelectorAll('.card').forEach(c => c.onclick = () => {
    S.filter.kind = c.dataset.kind;
    if (S.filter.kind === 'not_in_pdf') S.filter.sev.add('info');
    renderSummary(); renderToolbar(); S.shown = 200; renderList();
  });
}

function renderToolbar() {
  const sevs = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['info', 'Info']];
  $('#sev-chips').innerHTML = sevs.map(([k, l]) => `<button class="chip ${S.filter.sev.has(k) ? 'on' : ''}" data-sev="${k}"><span class="sev sev-${k}"></span>${l}</button>`).join('');
  $('#sev-chips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    const k = c.dataset.sev; S.filter.sev.has(k) ? S.filter.sev.delete(k) : S.filter.sev.add(k); renderToolbar(); S.shown = 200; renderList();
  });
  const pdfNames = S.docs.map(d => d.name);
  $('#f-pdf').innerHTML = `<option value="">All PDFs</option>` + pdfNames.map(n => `<option value="${esc(n)}" ${S.filter.pdf === n ? 'selected' : ''}>${esc(n.replace(/\.pdf$/i, '').slice(-48))}</option>`).join('');
}

function verdictOf(f) { return S.ai.get(f.id)?.verdict || ''; }

function filtered() {
  const q = S.filter.q.trim().toLowerCase();
  return S.report.findings.filter(f => {
    if (S.filter.kind && f.kind !== S.filter.kind) return false;
    if (!S.filter.sev.has(f.severity)) return false;
    if (S.filter.pdf && f.loc?.pdf !== S.filter.pdf && !(f.also || []).some(l => l.pdf === S.filter.pdf)) return false;
    const v = S.filter.verdict;
    if (v) {
      const mine = S.mine[fSig(f)];
      if (v === 'none' && verdictOf(f)) return false;
      if (v === 'mine-bug' && mine !== 'bug') return false;
      if (v === 'mine-ok' && mine !== 'ok') return false;
      if (['bug', 'acceptable', 'needs_review'].includes(v) && verdictOf(f) !== v) return false;
    }
    if (q) {
      const hay = [f.formText, f.pdfText, f.formKey, f.formPage, f.optionKey, f.loc?.pdf, 'p' + f.loc?.page].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function whereOf(f) {
  if (f.kind === 'missing_in_form') return `${shortPdf(f.loc?.pdf)} · p.${f.loc?.page}${f.also?.length ? ` +${f.also.length} more` : ''}`;
  return (f.formPage || '').split(' › ').slice(-2).join(' › ') || f.formKey;
}
const shortPdf = (n) => (n || '').replace(/\.pdf$/i, '').replace(/^.*?(\(?U-[AB]\)?.*)$/i, '$1').slice(0, 40);

function renderList() {
  const items = filtered();
  const list = $('#list');
  const slice = items.slice(0, S.shown);
  list.innerHTML = `<div class="list-head"><span>${items.length} finding${items.length === 1 ? '' : 's'}</span><span>${S.ai.size ? `${[...S.ai.values()].filter(v => v.verdict === 'bug').length} AI-flagged bugs` : ''}</span></div>` +
    slice.map(f => {
      const v = verdictOf(f), mine = S.mine[fSig(f)];
      const text = f.kind === 'missing_in_form' ? f.pdfText : f.formText;
      return `<div class="item ${S.selected === f.id ? 'sel' : ''} ${v === 'acceptable' || mine === 'ok' ? 'dim' : ''}" data-id="${f.id}" tabindex="0">
        <div class="row1"><span class="sev sev-${f.severity}" title="${f.severity}"></span><span class="tag ${KIND[f.kind].cls}">${KIND[f.kind].short}</span><span class="where">${esc(whereOf(f))}</span>
          <span class="marks">${v ? `<span class="v v-${v}">${v === 'needs_review' ? 'review' : v === 'acceptable' ? 'ok' : 'bug'}</span>` : ''}${mine ? `<span class="v ${mine === 'bug' ? 'v-bug' : 'v-acceptable'}">✓ ${mine}</span>` : ''}</span></div>
        <div class="txt">${esc((text || '').slice(0, 220))}</div></div>`;
    }).join('') +
    (items.length > slice.length ? `<div class="list-more"><button class="btn sm" id="more">Show ${Math.min(200, items.length - slice.length)} more</button></div>` : '') +
    (!items.length ? `<div class="empty" style="padding:30px;text-align:center;color:var(--text-3)">No findings match these filters.</div>` : '');
  list.querySelectorAll('.item').forEach(el => {
    el.onclick = () => select(+el.dataset.id);
    el.onkeydown = (e) => { if (e.key === 'Enter') select(+el.dataset.id); };
  });
  const more = $('#more'); if (more) more.onclick = () => { S.shown += 200; renderList(); };
}

function select(id) {
  S.selected = id;
  document.querySelectorAll('.item.sel').forEach(e => e.classList.remove('sel'));
  document.querySelector(`.item[data-id="${id}"]`)?.classList.add('sel');
  renderDetail(S.report.findings.find(f => f.id === id));
}

function diffHtml(f) {
  return f.diff.map(op => {
    if (op.type === 'eq') return esc(op.form) + ' ';
    if (op.type === 'chg') return (op.pdf ? `<del title="In the PDF, not in the form">${esc(op.pdf)}</del> ` : '') + (op.form ? `<ins title="In the form, not in the PDF">${esc(op.form)}</ins> ` : '');
    const why = { ok: 'Accepted wording change', title: 'Title added by the form', moved: 'Same words, different order', skip: 'Belongs to another form element (footnote / page break)' }[op.type];
    return `<span class="soft" title="${why}: PDF “${esc(op.pdf)}” → form “${esc(op.form)}”">${esc(op.form || op.pdf)}</span> `;
  }).join('');
}

function renderDetail(f) {
  const el = $('#detail');
  if (!f) { el.innerHTML = '<div class="empty">Select a finding to see the comparison.</div>'; return; }
  const ai = S.ai.get(f.id), mine = S.mine[fSig(f)];
  const titles = { text_mismatch: 'Form wording differs from the PDF', missing_in_form: 'PDF text not found in the form', not_in_pdf: 'Form text not found in the PDFs', option_anchor: 'Option prints into the wrong checkbox' };
  const meta = [];
  if (f.formPage) meta.push(`<span>Form: ${esc(f.formPage)}</span>`);
  if (f.formKey) meta.push(`<span>Widget <code title="Click to copy" data-copy="${esc(f.formKey)}">${esc(f.formKey)}</code> · ${esc(f.widgetType || '')}${f.field ? ' · ' + esc(FIELD[f.field] || f.field) : ''}</span>`);
  if (f.optionKey) meta.push(`<span>Option <code data-copy="${esc(f.optionKey)}">${esc(f.optionKey)}</code></span>`);
  if (f.loc) meta.push(`<span>PDF: ${esc(shortPdf(f.loc.pdf))} · page ${f.loc.page}</span>`);
  let body = '';
  if (ai) body += `<div class="ai-box ${ai.verdict}"><b>AI: ${ai.verdict === 'bug' ? 'Likely bug' : ai.verdict === 'acceptable' ? 'Acceptable adaptation' : 'Needs a human look'}${ai.confidence != null ? ` · ${Math.round(ai.confidence * 100)}%` : ''}</b>${esc(ai.reason || '')}${ai.fix ? `<div class="muted" style="margin-top:4px">Fix: ${esc(ai.fix)}</div>` : ''}</div>`;
  if (f.note) body += `<div class="note">${esc(f.note)}</div>`;
  if (f.kind === 'text_mismatch') {
    body += `<div class="blk"><h4>Form text compared with the PDF</h4><div class="diff">${diffHtml(f)}</div>
      <div class="legend"><span><del>PDF only</del></span><span><ins>Form only</ins></span><span class="soft" style="border-bottom:1px dotted">accepted / moved</span><span>${f.changed} word${f.changed === 1 ? '' : 's'} differ · similarity ${Math.round(f.score * 100)}%</span></div></div>`;
  } else if (f.kind === 'missing_in_form') {
    body += `<div class="blk"><h4>PDF text (${f.words} words)</h4><div class="quote">${esc(f.pdfText)}</div></div>`;
    if (f.also?.length) body += `<div class="blk"><h4>Same text also missing in</h4><div class="muted">${f.also.map(l => `${esc(shortPdf(l.pdf))} p.${l.page}`).join(' · ')}</div></div>`;
  } else if (f.kind === 'not_in_pdf') {
    body += `<div class="blk"><h4>Form text</h4><div class="quote">${esc(f.formText)}</div></div>`;
    if (f.pdfText) body += `<div class="blk"><h4>Closest PDF text (${Math.round((f.bestScore || 0) * 100)}% match)</h4><div class="quote">${esc(f.pdfText)}</div></div>`;
  } else if (f.kind === 'option_anchor') {
    body += `<div class="blk"><h4>Form option</h4><div class="quote">${esc(f.formText)}</div></div>
      <div class="blk"><h4>PDF text next to the mapped box</h4><div class="quote">${esc(f.pdfText)}</div></div>`;
  }
  if (f.loc) body += `<div class="blk"><h4>Source PDF</h4><div class="pdfview"><div class="pdfbar"><span>${esc(f.loc.pdf)}</span><span class="spacer"></span><button class="btn sm" data-pg="-1">‹</button><span id="pg-lbl">p.${f.loc.page}</span><button class="btn sm" data-pg="1">›</button></div><div class="pdfscroll" id="pdfscroll"><div class="pdfpage" id="pdfpage"></div></div></div></div>`;
  el.innerHTML = `<div class="d-head"><div class="d-title"><span class="sev sev-${f.severity}"></span><span class="tag ${KIND[f.kind].cls}">${KIND[f.kind].label}</span><h3>${titles[f.kind]}</h3></div>
    <div class="d-meta">${meta.join('')}</div>
    <div class="d-actions"><button class="btn sm danger ${mine === 'bug' ? 'on' : ''}" data-mark="bug">${mine === 'bug' ? '✓ ' : ''}Bug</button><button class="btn sm ok ${mine === 'ok' ? 'on' : ''}" data-mark="ok">${mine === 'ok' ? '✓ ' : ''}Acceptable</button>
      <button class="btn sm" data-act="ai">Ask AI</button><button class="btn sm" data-act="clickup">Copy for ClickUp</button></div></div>
    <div class="d-body">${body}</div>`;
  el.scrollTop = 0;
  el.querySelectorAll('[data-copy]').forEach(c => c.onclick = () => copy(c.dataset.copy, 'Copied ' + c.dataset.copy));
  el.querySelectorAll('[data-mark]').forEach(b => b.onclick = () => {
    const sig = fSig(f); S.mine[sig] = S.mine[sig] === b.dataset.mark ? undefined : b.dataset.mark;
    if (!S.mine[sig]) delete S.mine[sig];
    store.set('mine:' + formSig(), S.mine); renderDetail(f); renderList();
  });
  el.querySelector('[data-act="clickup"]').onclick = () => copy(clickupText(f), 'Copied: paste it into a ClickUp task');
  const askAI = el.querySelector('[data-act="ai"]');
  if (AI_ENABLED) askAI.onclick = () => runAI([f]); else askAI.remove();
  if (f.loc) {
    let page = f.loc.page;
    const draw = () => { $('#pg-lbl').textContent = 'p.' + page; renderPage(f, page); };
    el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { const d = S.docs[f.loc.doc]; page = Math.min(d.numPages, Math.max(1, page + +b.dataset.pg)); draw(); });
    draw();
  }
}

let renderTask = null;
async function renderPage(f, pageNo) {
  const host = $('#pdfpage'); if (!host) return;
  const d = S.docs[f.loc.doc];
  if (!d?.pdfDoc) { host.innerHTML = '<div class="note">PDF preview unavailable.</div>'; return; }
  try {
    renderTask?.cancel?.();
    const page = await d.pdfDoc.getPage(pageNo);
    const width = host.clientWidth || 700;
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    host.innerHTML = ''; host.appendChild(canvas);
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    await renderTask.promise;
    const boxes = [];
    const add = (hs, cls) => (hs || []).filter(h => h.doc === f.loc.doc && h.page === pageNo).forEach(h => h.boxes.forEach(b => boxes.push({ ...b, cls })));
    add(f.highlights, f.kind === 'option_anchor' ? 'box' : '');
    add(f.changedHighlights, 'chg');
    for (const b of boxes) {
      const div = document.createElement('div');
      div.className = 'hl ' + b.cls;
      Object.assign(div.style, { left: (b.x0 * 100) + '%', top: (b.y0 * 100) + '%', width: ((b.x1 - b.x0) * 100) + '%', height: ((b.y1 - b.y0) * 100) + '%' });
      host.appendChild(div);
    }
    const firstHl = host.querySelector('.hl');
    const sc = $('#pdfscroll');
    if (sc) sc.scrollTop = firstHl ? Math.max(0, firstHl.offsetTop - sc.clientHeight * 0.35) : 0;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn(e);
  }
}

function clickupText(f) {
  const where = f.formPage ? `[${f.formPage}]` : `[${shortPdf(f.loc?.pdf)} p.${f.loc?.page}]`;
  const title = `${where} ${KIND[f.kind].label}${f.formKey ? ` – ${f.formKey}` : ''}`;
  const lines = [title, ''];
  if (f.kind === 'text_mismatch') {
    lines.push('Differences (PDF → form):');
    f.diff.filter(d => d.type === 'chg').forEach(d => lines.push(`• PDF: “${d.pdf || '—'}” → Form: “${d.form || '—'}”`));
    lines.push('', `Form text: ${f.formText}`);
  } else {
    if (f.formText) lines.push(`Form text: ${f.formText}`);
    if (f.pdfText) lines.push(`PDF text: ${f.pdfText.slice(0, 1200)}`);
  }
  if (f.loc) lines.push(`Source: ${f.loc.pdf}, page ${f.loc.page}`);
  const ai = S.ai.get(f.id); if (ai) lines.push(`AI: ${ai.verdict} – ${ai.reason}${ai.fix ? ' Fix: ' + ai.fix : ''}`);
  return lines.join('\n');
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(msg || 'Copied'); }
}

/* ------------------------------------- AI ------------------------------------- */

function openAISettings() {
  $('#ai-key').value = S.aiCfg.key; $('#ai-model').value = S.aiCfg.model; $('#ai-remember').checked = S.aiCfg.remember;
  $('#dlg-ai').showModal();
}
$('#dlg-ai').addEventListener('close', () => {
  if ($('#dlg-ai').returnValue !== 'save') return;
  S.aiCfg = { key: $('#ai-key').value.trim(), model: $('#ai-model').value.trim() || DEFAULT_MODEL, remember: $('#ai-remember').checked };
  store.set('aiModel', S.aiCfg.model);
  if (S.aiCfg.remember) store.set('aiKey', S.aiCfg.key); else store.del('aiKey');
  toast('AI settings saved');
  if (S._pendingAI) { const p = S._pendingAI; S._pendingAI = null; runAI(p); }
});

async function runAI(list) {
  if (!S.aiCfg.key) { S._pendingAI = list; openAISettings(); return; }
  const todo = list.filter(f => !S.ai.has(f.id) || list.length === 1);
  if (!todo.length) { toast('All of these already have an AI verdict.'); return; }
  if (todo.length > 120 && !confirm(`Send ${todo.length} findings to Claude? This makes about ${Math.ceil(todo.length / 12)} API calls.`)) return;
  const btn = $('#btn-ai-run'); btn.disabled = true;
  try {
    await triage(todo, {
      apiKey: S.aiCfg.key, model: S.aiCfg.model,
      onBatch: (res, done, total) => {
        for (const [id, v] of res) S.ai.set(id, v);
        btn.textContent = `AI triage ${done}/${total}`;
        store.set('ai:' + formSig(), Object.fromEntries(S.ai));
        renderList(); if (S.selected) renderDetail(S.report.findings.find(f => f.id === S.selected));
      },
    });
    const bugs = todo.filter(f => S.ai.get(f.id)?.verdict === 'bug').length;
    toast(`AI reviewed ${todo.length} finding${todo.length === 1 ? '' : 's'}: ${bugs} likely bug${bugs === 1 ? '' : 's'}.`, 4000);
  } catch (e) {
    toast(e.message, 7000);
  } finally {
    btn.disabled = false; btn.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>AI triage';
  }
}

/* ----------------------------------- export ----------------------------------- */

function exportRows() {
  return filtered().map(f => {
    const ai = S.ai.get(f.id) || {};
    return {
      id: f.id, severity: f.severity, kind: KIND[f.kind].label, my_verdict: S.mine[fSig(f)] || '', ai_verdict: ai.verdict || '', ai_reason: ai.reason || '', ai_fix: ai.fix || '',
      form_page: f.formPage || '', widget: f.formKey || '', field: f.field || '', option: f.optionKey || '',
      pdf: f.loc?.pdf || '', pdf_page: f.loc?.page || '',
      differences: f.kind === 'text_mismatch' ? f.diff.filter(d => d.type === 'chg').map(d => `PDF "${d.pdf}" -> form "${d.form}"`).join(' | ') : '',
      form_text: f.formText || '', pdf_text: (f.pdfText || '').slice(0, 2000),
    };
  });
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function doExport(kind) {
  const rows = exportRows();
  const base = (S.formFile?.name || 'form').replace(/\.json$/i, '') + '-sourcecheck';
  if (kind === 'csv') {
    const cols = Object.keys(rows[0] || { id: 1 });
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    download(base + '.csv', '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n'), 'text/csv');
  } else if (kind === 'json') {
    download(base + '.json', JSON.stringify({ summary: S.report.summary, findings: S.report.findings.map(f => ({ ...f, ai: S.ai.get(f.id) || null })) }, null, 1), 'application/json');
  } else if (kind === 'md') {
    const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
    const md = ['| # | Severity | Type | Where | Form text | PDF / difference | AI |', '|---|---|---|---|---|---|---|',
      ...rows.map(r => `| ${r.id} | ${r.severity} | ${r.kind} | ${cell(r.form_page || (r.pdf + ' p.' + r.pdf_page))} | ${cell(r.form_text)} | ${cell(r.differences || r.pdf_text)} | ${cell(r.ai_verdict ? r.ai_verdict + ': ' + r.ai_reason : '')} |`)].join('\n');
    copy(md, `Copied ${rows.length} rows as a table`);
  }
}

/* ------------------------------------ wiring ------------------------------------ */

bindDrop($('#drop-form'), $('#in-form'), (fs) => fs[0] && loadForm(fs[0]));
bindDrop($('#drop-pdf'), $('#in-pdf'), addPdfs);
$('#btn-run').onclick = run;
$('#btn-demo').onclick = async () => {
  try {
    const formRes = await fetch('demo/northwind-demo-form.json');
    const form = new File([await formRes.blob()], 'northwind-demo-form.json', { type: 'application/json' });
    const { PDF_NAME, PDF_BASE64 } = await import('./demo/northwind-pdf.js');
    const bytes = Uint8Array.from(atob(PDF_BASE64), ch => ch.charCodeAt(0));
    const pdf = new File([bytes], PDF_NAME, { type: 'application/pdf' });
    S.pdfs = [];
    await loadForm(form); addPdfs([pdf]);
    run();
  } catch (e) { toast('Could not load the demo files: ' + e.message, 5000); }
};
$('#btn-ai-settings').onclick = openAISettings;
$('#btn-new').onclick = () => { $('#results').hidden = true; $('#setup').hidden = false; $('#btn-new').hidden = true; };
$('#q').oninput = (e) => { S.filter.q = e.target.value; S.shown = 200; renderList(); };
$('#f-pdf').onchange = (e) => { S.filter.pdf = e.target.value; renderList(); };
$('#f-verdict').onchange = (e) => { S.filter.verdict = e.target.value; renderList(); };
$('#btn-ai-run').onclick = () => {
  const list = filtered().filter(f => f.severity !== 'info');
  if (!list.length) { toast('No findings in the current filter.'); return; }
  runAI(list);
};
$('#btn-export').onclick = (e) => { e.stopPropagation(); $('#export-pop').hidden = !$('#export-pop').hidden; };
$('#export-pop').querySelectorAll('button').forEach(b => b.onclick = () => { $('#export-pop').hidden = true; doExport(b.dataset.x); });
document.addEventListener('click', () => ($('#export-pop').hidden = true));
document.addEventListener('keydown', (e) => {
  if ($('#results').hidden || !S.report || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = filtered(); const i = items.findIndex(f => f.id === S.selected);
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
  if (next) { e.preventDefault(); select(next.id); document.querySelector(`.item[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
});
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.selected && !$('#results').hidden) renderDetail(S.report.findings.find(f => f.id === S.selected)); }, 250); });

// deployment options
if (!AI_ENABLED) {
  ['#btn-ai-settings', '#btn-ai-run'].forEach(sel => $(sel).remove());
  document.body.classList.add('no-ai');
}
if (CFG.environmentLabel) $('.brand-tag').textContent = CFG.environmentLabel;
