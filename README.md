# EPCFix Evals — static site edition

A landlord-persona scorecard for your hero copy. **Runs entirely in the browser.**
No Node, no server, no build step. Host it free on GitHub Pages.

## What you get

- A page that scores every hero variant against 8 UK landlord personas on
  5 judge dimensions (1–10 each) plus 5 deterministic checks.
- A leaderboard, a persona × variant heatmap, and per-variant detail with the
  judge's reasoning per persona.
- A "download report.md" button so each run is auditable.
- Your API key is stored in your browser's localStorage. It never touches
  any server other than the LLM provider you choose.

## Two ways to run it

| Provider | Cost | Notes |
| --- | --- | --- |
| **Programmatic only** | Free | No key needed. Catches the payback trap, reading-grade and jargon issues. Good for daily iteration. |
| **Google Gemini 2.5 Flash** | Free tier | ~15 calls/min on the free tier — comfortable for a 40-call run. [Get a key here.](https://aistudio.google.com/apikey) |

## Deploy to GitHub Pages

1. Create a new public repo (e.g. `epcfix-evals`).
2. Drop these four files at the repo root:
   - `index.html`
   - `app.js`
   - `personas.js`
   - `variants.js`
3. Push to `main`.
4. In the repo → **Settings → Pages**, set **Source** to "Deploy from branch",
   pick `main` and `/ (root)`, save.
5. Wait ~30 seconds. Visit `https://<your-username>.github.io/epcfix-evals/`.

That's it. To iterate on copy: edit `variants.js`, commit, push. Pages rebuilds
automatically and the new variants appear on next page load.

## Local dev

You need to serve over HTTP (ES modules don't work over `file://`):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Editing personas & variants

`personas.js` and `variants.js` are plain ES modules. Add an entry to the
exported array, give it an `id` no other entry uses, push. The UI picks it up.

A persona looks like:

```js
{
  id: "letting-agent",
  name: "James, 33 — Letting Agent",
  oneLiner: "Branch manager for an independent agent…",
  portfolio: "80 managed units across diverse landlord clients.",
  topFears: ["…", "…", "…"],
  topGoals: ["…", "…", "…"],
  tonePreference: "Professional, B2B, hints at competitive edge.",
  jargonTolerance: "high",
  paybackAppeal: "high",
}
```

A variant looks like:

```js
{
  id: "v6-something",
  name: "V6 — Some new angle",
  rationale: "Why this version exists, what it's testing.",
  headline: "…",
  subhead: "…",
  cta: "…",
}
```

## Reusing for HygieneFix or AsbestosCheck

Fork the repo, change personas (food businesses, asbestos surveyors), change
variants, change the payback-trap check in `app.js` to the equivalent
learning you've encoded for that product. The rest is domain-agnostic.

## Security notes

**This is BYOK (Bring Your Own Key).** Your API key sits in your browser's
localStorage and is sent directly to the LLM provider's API. That means:

- ✅ Fine for your own laptop / personal browser profile.
- ❌ Don't paste a high-value production key. Use a separate, restricted key
  for this if your provider supports it.
- ❌ Don't run this on a shared computer without clearing the key after.

The "Clear" button wipes the key from localStorage immediately.

## Why this exists

Lifted from the `eval-driven-agent-development` workshop in
[anthropics/cwc-workshops](https://github.com/anthropics/cwc-workshops).
The pattern: every copy or prompt change is measured against a fixed eval
suite *before* it ships, so you stop learning the hard way that "payback
period" was the wrong frame for landlords.
