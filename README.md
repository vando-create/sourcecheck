# SourceCheck: is the form the PDF?

**Content QA for Anduin Digitization.** SourceCheck compares a smart form (the Form Builder JSON export) with the PDF sub docs it was built from. It lines up every question, option, paragraph and footnote with the PDF text, then reports:

| Finding | What it catches | Example |
|---|---|---|
| **Text differs** | Form wording that was found in the PDF but changed | "Regulation D" built as "Regulation S"; $200,000 built as $300,000; an edited footnote |
| **Missing in form** | PDF text on a digitized page that no form element carries | A representation paragraph that was never built |
| **Form-only text** | Form text that is in none of the source PDFs | Custom language, or a rewrite to verify against the checklist |
| **Swapped mapping** | A checkbox option that prints next to *another* option's text in the PDF | "Yes" in the form prints an X in the PDF's "No" box |

An optional **AI triage** step sends the findings to Claude, which labels each one as a *likely bug*, an *acceptable form adaptation* (e.g. "circle" → "check", an added question title) or *needs review*, with a one-line reason and a suggested fix.

**Live app:** https://sourcecheck-rho.vercel.app/ (click **Try the demo**: a fictional fund with 7 planted issues)

---

## Why

UI testing in the Digitization testing procedure (Testing 1) is about 4 points of effort per medium-hard form, and most of it is reading the form next to the PDF: checking that wording is copied exactly, every footnote is present, and each item sits on the right page. White Tree's *UI Bugs Detector* already checks the form **on its own** (spelling, styles, subtitles, polarity). Nothing checks the form **against its source**. SourceCheck covers that gap.

On a real 4-sub-doc, 190-page-per-book fund form (1,800 widgets) the full check runs in about 15 seconds in the browser. On its first run it found a Yes/No pair whose PDF boxes were inverted in one sub doc.

## How it works

```
form.json ──► parse widgets, labels, options, footnotes (data-title spans)
          └─► annotation layer (uploadedPdf → field positions per PDF page)
PDFs ──────► PDF.js text extraction → words with page + position
             (headers/footers removed, footnote markers dropped)

1. Locate     each form text block in every PDF: 3-gram voting, then word-level LCS alignment
2. Diff       aligned pairs word by word. Accepted adaptations, re-ordered text and
              interruptions by other blocks (footnotes, page breaks) are filtered out.
              Changed numbers, negations and single-letter references raise severity.
3. Coverage   PDF words on digitized pages (pages with mapped fields) not covered by any form block
4. Anchors    for each option's mapped checkbox, read the PDF text beside the box. If it matches a
              sibling option better than the option itself, report a swapped mapping.
5. AI triage  (optional) Claude classifies findings using Anduin's form-design conventions
```

Everything except the optional AI call runs **locally in the browser**. Files are never uploaded. The AI step sends only short snippets and diffs to the Anthropic API using the key you enter (stored in your browser only if you tick *remember*).

## Using it

1. Export the form JSON from Form Builder (it already includes the annotation layer, so no separate annotation export is needed).
2. Open the app, drop the JSON and all source PDFs. Each PDF is auto-matched to its annotated PDF by name, and you can change the match.
3. **Run check.** Filter by type, severity, PDF or verdict. Click a finding to see the word diff and the highlighted PDF page.
4. Mark findings **Bug** / **Acceptable**, run **AI triage**, then **Export** (CSV, a ClickUp-ready table, or full JSON). **Copy for ClickUp** on a finding produces a ready-to-paste ticket.

Keyboard: `j` / `k` (or ↓ / ↑) move through findings.

## Tech

- Vanilla JS (ES modules), no build step, hosted on GitHub Pages
- [PDF.js](https://mozilla.github.io/pdf.js/) for text extraction and page rendering
- Claude (Anthropic Messages API) for AI triage
- `core.js` is isomorphic: the same engine runs in Node for tests

## Run locally

```bash
npm install        # dev dependency: pdfjs-dist (for tests)
npm test           # runs the engine on the demo and checks all 7 planted issues are found
npm start          # serves the app at http://localhost:8080
```

`tools/make_demo.py` regenerates the fictional demo (requires `reportlab`).

## Roadmap

- **Revision impact:** diff sub doc v1 against v2 and use the form↔PDF alignment map to list the widgets that must change
- Checklist import: verify custom language, gating questions and disabled-page tooltips against the checklist sheet
- Fund-aware matching: compare each fund-specific variant only with its own sub doc
- Pull the form and annotation directly by Form Version ID (like White Tree), and ship as a White Tree tool
- Benchmark mode: score findings against a form's ClickUp bug list

## Privacy

Do not commit client documents to this repository. The demo fund is entirely fictional.

---

Built by Van Do for the Anduin Digitization Hackathon 2026.
