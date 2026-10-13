// Runs the engine on the fictional demo and checks that every seeded issue is found.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import assert from 'assert/strict';
import { extractPdf, parseForm, analyze, autoAssign } from '../core.js';

const dir = new URL('../demo/', import.meta.url);
const form = parseForm(JSON.parse(fs.readFileSync(new URL('northwind-demo-form.json', dir), 'utf8')));
const { PDF_NAME: name, PDF_BASE64 } = await import('../demo/northwind-pdf.js');
const doc = await extractPdf(pdfjs, new Uint8Array(Buffer.from(PDF_BASE64, 'base64')), name);
doc.annotIndex = autoAssign(form, [name])[0];
assert.equal(doc.annotIndex, 0, 'PDF should auto-match its annotation layer');
const { findings } = analyze(form, [doc]);
const has = (kind, pred) => findings.some(f => f.kind === kind && pred(f));
const chg = f => (f.diff || []).filter(d => d.type === 'chg').map(d => d.pdf + '->' + d.form).join(' ');

const checks = [
  ['swapped Yes/No mapping', has('option_anchor', f => f.formKey === 'usperson')],
  ['Regulation D -> S', has('text_mismatch', f => f.formKey === 'accredited_intro' && chg(f).includes('D->S'))],
  ['$200,000 -> $300,000', has('text_mismatch', f => chg(f).includes('$200,000->$300,000'))],
  ['edited footnote', has('text_mismatch', f => f.field === 'footnote' && chg(f).includes('Rule 902'))],
  ['missing AML paragraph', has('missing_in_form', f => /anti-money laundering/.test(f.pdfText))],
  ['form-only helper text', has('not_in_pdf', f => f.formKey === 'helper')],
  ['acceptable wording change flagged at most medium', has('text_mismatch', f => f.formKey === 'attach' && f.severity !== 'high')],
];
let failed = 0;
for (const [label, ok] of checks) { console.log(ok ? '✓' : '✗', label); if (!ok) failed++; }
console.log(`${checks.length - failed}/${checks.length} seeded issues detected, ${findings.length} findings total`);
process.exit(failed ? 1 : 0);
