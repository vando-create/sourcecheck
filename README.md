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

## Benchmark on a real form

SourceCheck was run on a pre-testing export of a real 4-sub-doc fund form (about 1,800 widgets, 190-page sub docs) and compared with the bugs QA and DS logged in ClickUp during testing.

- 134 tickets in total. 28 were about content, meaning wording, footnotes, missing text or swapped mappings. The others covered logic rules, layout, supporting documents and client change requests, which SourceCheck does not check.
- **SourceCheck flagged the affected widget for 27 of those 28 content tickets.** That includes a Yes/No pair whose PDF boxes were inverted, footnotes using the U.S. definition in the non-U.S. sub docs, and a text block shared by four funds that matched only one fund's sub doc.
- Full run time was about 15 seconds in the browser.

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
4. Variants   a text that matches one sub doc but differs from another is flagged unless another
              form element carries the other wording (fund-specific variants)
5. Anchors    for each option's mapped checkbox, read the PDF text beside the box. If it matches a
              sibling option better than the option itself, report a swapped mapping.
6. AI triage  (optional) Claude classifies findings using Anduin's form-design conventions
```

Everything except the optional AI call runs **locally in the browser**. Files are never uploaded. The AI step sends only short snippets and diffs to the Anthropic API using the key you enter (stored in your browser only if you tick *remember*).

## Using it

1. Export the form JSON from Form Builder (it already includes the annotation layer, so no separate annotation export is needed).
2. Open the app, drop the JSON and all source PDFs. Each PDF is auto-matched to its annotated PDF by name, and you can change the match.
3. **Run check.** Filter by type, severity, PDF or verdict. Click a finding to see the word diff and the highlighted PDF page.
4. Mark findings **Bug** / **Acceptable**, run **AI triage**, then **Export** (CSV, a ClickUp-ready table, or full JSON). **Copy for ClickUp** on a finding produces a ready-to-paste ticket.

Keyboard: `j` / `k` (or ↓ / ↑) move through findings.

## Tech

- Vanilla JS (ES modules), no build step. Public demo on Vercel; internal deployment via Docker on Dokploy
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
- Fund-aware matching: read the form rules to know exactly which fund sees which variant
- Pull the form and annotation directly by Form Version ID (like White Tree), and ship as a White Tree tool
- Built-in benchmark mode: score findings against a form's ClickUp bug list

## Self-hosting for client documents (Dokploy)

The public Vercel demo loads PDF.js from a CDN and offers AI triage. For real client files, deploy the Docker image instead:

- PDF.js is bundled into the image and Google Fonts are removed, so the page makes **no third-party requests**
- A strict Content-Security-Policy (`connect-src 'self'`) blocks the browser from sending data anywhere else, even if a script tried
- AI triage is **off** by default (`AI_ENABLED=false`). Turning it on only allows `https://api.anthropic.com`, and only with InfoSec approval
- Files are still processed only in the user's browser. The server stores nothing, so no database is needed
- Two sign-ins protect the internal app: Anduin's Cloudflare Access (all `*.anduincapital.dev` addresses) and a dedicated Google sign-in gate ([oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/)) that only admits `@anduintransact.com` accounts. The app container has no public address; only the gate does

**Internal app:** https://sourcecheck.anduincapital.dev (Anduin sign-in required)

**Dokploy setup** (two Applications in one project):

1. `sourcecheck`: Provider `GitHub` (via a Dokploy GitHub App installed on this repo only; branch `main`), Build Type `Dockerfile`, **no domain**. Autodeploy is on, so every push to `main` redeploys it in about a minute.
2. `sourcecheck-auth`: Provider `Docker`, image `quay.io/oauth2-proxy/oauth2-proxy:v7.6.0`, Domain `sourcecheck.anduincapital.dev` on container port `4180`. Environment:

```
OAUTH2_PROXY_PROVIDER=google
OAUTH2_PROXY_CLIENT_ID=<Google OAuth client ID>
OAUTH2_PROXY_CLIENT_SECRET=<Google OAuth client secret>
OAUTH2_PROXY_COOKIE_SECRET=<python3 -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())">
OAUTH2_PROXY_REDIRECT_URL=https://sourcecheck.anduincapital.dev/oauth2/callback
OAUTH2_PROXY_EMAIL_DOMAINS=anduintransact.com
OAUTH2_PROXY_UPSTREAMS=http://<sourcecheck app name in Dokploy>:80/
OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180
OAUTH2_PROXY_REVERSE_PROXY=true
OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true
OAUTH2_PROXY_COOKIE_SECURE=true
OAUTH2_PROXY_COOKIE_SAMESITE=lax
OAUTH2_PROXY_COOKIE_EXPIRE=12h
OAUTH2_PROXY_COOKIE_NAME=_sourcecheck_auth
```

The Google OAuth client lives in a Google Cloud project under the anduintransact.com organization, with the consent screen set to **Internal** (only Workspace accounts can sign in) and the redirect URI above. Secrets are entered only in Dokploy, never in this repo.

A plain webhook to Dokploy's deploy URL does not work, because the Dokploy server is also behind Cloudflare Access; only the signed GitHub App endpoint is reachable from GitHub.

| Env var | Default | Meaning |
|---|---|---|
| `AI_ENABLED` | `false` | `true` shows AI triage and allows connections to `api.anthropic.com` |
| `ENVIRONMENT_LABEL` | `Internal · client files stay in your browser` | Subtitle shown in the header |

Local test: `docker build -t sourcecheck . && docker run -p 8080:80 sourcecheck`

## Privacy

Do not commit client documents to this repository. The demo fund is entirely fictional.

---

Built by Van Do for the Anduin Digitization Hackathon 2026.
