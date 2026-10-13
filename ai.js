// AI triage: sends compact finding summaries to Claude and gets back a verdict per finding.
// The API key never leaves the browser except in the request to api.anthropic.com.

export const DEFAULT_MODEL = 'claude-sonnet-4-5';

const SYSTEM = `You are a senior QA reviewer on Anduin's Digitization team. Anduin turns PDF subscription documents
("sub docs") into interactive smart forms. A form is correct when every question, option, paragraph and
footnote that the investor must read carries the PDF's wording, in the right place.

An automated checker compared a form against its source PDFs and produced findings. Classify each one.

Finding kinds:
- text_mismatch: the form text was located in the PDF but some words differ (diff given as [-pdf words-|+form words+]).
- not_in_pdf: form text that could not be found in any source PDF.
- missing_in_form: PDF text on a digitized page that does not appear anywhere in the form.
- option_anchor: a form option prints into a PDF checkbox whose neighbouring text matches a different option (swapped mapping).

ACCEPTABLE (not bugs) — Anduin form design conventions:
- Wording adapted for an online form: "circle/tick/initial" -> "check/select"; "have attached" -> "wish to attach";
  "please print" -> "please enter"; "If Yes, please..." restructured into a follow-up question.
- A short bold title added before a question (e.g. "U.S. Investor Status"), numbering removed or changed by layout.
- Blanks/underscores, "Yes/No" labels, page headers/footers, signature-block labels (Name/Title/Date/By).
- Anduin-authored helper text: blue/orange messages, "Please carefully review the document below", "Check this box if
  you want to add more ...", tooltips that explain how to use the form, gating questions from the checklist.
- Fund-specific variants (e.g. a word like "Master"/"Feeder"/"Fund" that only exists in one fund's sub doc) when the
  form shows that variant to the matching fund only.
- PDF content that is shown in the form as an embedded PDF, or table layouts rebuilt as separate fields.

BUGS:
- Legal/representation wording changed, truncated, or merged so that meaning changes (missing "not", wrong threshold,
  wrong rule/section number, wrong defined term, missing clause or sentence).
- Footnote / definition text that differs from the PDF footnote, or footnote content duplicated into the label.
- Typos, leftover placeholder or internal notes, wrong fund name, wrong investor type wording.
- A PDF question, option, or footnote missing from the form; swapped Yes/No or option mappings.

Reply with ONLY a JSON array, one object per finding, in the same order:
[{"id": <number>, "verdict": "bug" | "acceptable" | "needs_review", "confidence": <0..1>,
  "reason": "<max 25 words, plain English>", "fix": "<max 20 words, what the builder should change, or empty>"}]`;

function compact(f) {
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const o = { id: f.id, kind: f.kind, where: [f.formPage, f.field].filter(Boolean).join(' / ') };
  if (f.formText) o.form = cut(f.formText, 700);
  if (f.kind === 'text_mismatch') o.diff = cut(f.diff.filter(d => d.type === 'chg').map(d => `[-${d.pdf}-|+${d.form}+]`).join(' '), 700);
  else if (f.pdfText) o.pdf = cut(f.pdfText, 700);
  if (f.siblingText) o.matchesSiblingOption = cut(f.siblingText, 120);
  if (f.note) o.checkerNote = f.note;
  return o;
}

export async function triage(findings, { apiKey, model = DEFAULT_MODEL, batchSize = 12, onBatch, signal } = {}) {
  if (!apiKey) throw new Error('Add your Anthropic API key in AI settings first.');
  const out = new Map();
  for (let i = 0; i < findings.length; i += batchSize) {
    const batch = findings.slice(i, i + batchSize);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2500,
        system: SYSTEM,
        messages: [{ role: 'user', content: 'Findings:\n' + JSON.stringify(batch.map(compact), null, 1) }],
      }),
    });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
      throw new Error('Claude API: ' + msg);
    }
    const data = await res.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    let arr = [];
    try { arr = JSON.parse(json); } catch { throw new Error('Could not parse the AI response.'); }
    for (const v of arr) if (v && typeof v.id === 'number') out.set(v.id, v);
    if (onBatch) onBatch(out, Math.min(i + batchSize, findings.length), findings.length);
  }
  return out;
}
