// EPCFix Evals — runs entirely in your browser.
// State is in-memory + a few localStorage keys (API key, last results).

import { personas } from "./personas.js";
import { variants } from "./variants.js";

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

const state = {
  provider: localStorage.getItem("epcfix-provider") || "programmatic",
  apiKey: localStorage.getItem("epcfix-key") || "",
  concurrency: Number(localStorage.getItem("epcfix-conc") || 3),
  results: JSON.parse(localStorage.getItem("epcfix-results") || "null"),
  running: false,
  progress: { done: 0, total: 0 },
  lastRunAt: localStorage.getItem("epcfix-lastrun") || null,
};

/* -------------------------------------------------------------------------- */
/*                           Programmatic grader                              */
/* -------------------------------------------------------------------------- */

const ALLOWED_JARGON = new Set(["mees", "epc", "uk", "btl", "hmo", "spv"]);
const OUTCOME_WORDS = [
  "compliant", "ready", "rating", "pass", "lettable", "exempt",
  "plan", "ranked", "address", "property", "portfolio", "retrofit",
];
const PAYBACK_TRAP_TERMS = [
  "payback", "roi", "return on investment", "break-even", "break even",
];

function countWords(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

function readingGrade(text) {
  const sentences = Math.max(1, text.split(/[.!?]+/).filter(s => s.trim()).length);
  const words = countWords(text);
  if (words === 0) return 0;
  const syllables = text.toLowerCase().split(/\s+/).reduce((sum, w) => {
    const cleaned = w.replace(/[^a-z]/g, "");
    if (!cleaned) return sum;
    const matches = cleaned.match(/[aeiouy]+/g);
    return sum + Math.max(1, matches ? matches.length : 1);
  }, 0);
  return 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
}

function jargonCount(text) {
  const tokens = text.match(/\b[A-Z]{3,}\b/g) ?? [];
  return tokens.filter(t => !ALLOWED_JARGON.has(t.toLowerCase())).length;
}

function gradeProgrammatic(v) {
  const headlineWords = countWords(v.headline);
  const subheadWords = countWords(v.subhead);
  const fullText = `${v.headline}. ${v.subhead}`;
  const lowered = fullText.toLowerCase();
  const notes = [];

  const wordCountOk = headlineWords >= 5 && headlineWords <= 14 && subheadWords >= 10 && subheadWords <= 32;
  if (!wordCountOk) notes.push(`Word count off — headline ${headlineWords}w, subhead ${subheadWords}w.`);

  const hasConcreteOutcome = OUTCOME_WORDS.some(w => lowered.includes(w));
  if (!hasConcreteOutcome) notes.push("No concrete-outcome word detected.");

  const jc = jargonCount(fullText);
  if (jc > 0) notes.push(`${jc} non-allow-listed acronym(s).`);

  const grade = Math.round(readingGrade(fullText) * 10) / 10;
  if (grade > 11) notes.push(`Reading grade ${grade} — too high for general audience.`);

  const noPaybackTrap = !PAYBACK_TRAP_TERMS.some(t => lowered.includes(t));
  if (!noPaybackTrap) notes.push("Payback/ROI framing detected (flagged as poor fit for most personas).");

  const passes = [wordCountOk, hasConcreteOutcome, jc === 0, grade <= 11, noPaybackTrap].filter(Boolean).length;

  return { wordCountOk, hasConcreteOutcome, jargonCount: jc, readingGrade: grade, noPaybackTrap, passes, notes };
}

/* -------------------------------------------------------------------------- */
/*                                Judge prompt                                */
/* -------------------------------------------------------------------------- */

function buildJudgePrompt(persona, variant) {
  return `You are a copy reviewer scoring a SaaS hero section against a specific buyer persona.
Be honest and discriminating — use the full 1–10 range. Anchor: 5 = competent but unremarkable; 8 = genuinely strong fit; 10 = best-in-class.

PERSONA: ${persona.name}
${persona.oneLiner}
Portfolio: ${persona.portfolio}
Top fears: ${persona.topFears.join(" / ")}
Top goals: ${persona.topGoals.join(" / ")}
Tone preference: ${persona.tonePreference}
Jargon tolerance: ${persona.jargonTolerance}
Receptiveness to payback/ROI framing: ${persona.paybackAppeal}

HERO COPY:
Headline: ${variant.headline}
Subhead: ${variant.subhead}
CTA button: ${variant.cta}

Respond with ONLY a single JSON object, no prose before or after, matching this exact shape:
{
  "persona_relevance": <integer 1-10>,
  "clarity": <integer 1-10>,
  "credibility": <integer 1-10>,
  "emotional_fit": <integer 1-10>,
  "action_clarity": <integer 1-10>,
  "reasoning": "<2-4 sentences calling out the single biggest strength and weakness for THIS persona>"
}`;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return JSON.parse(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error(`No JSON in response: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(first, last + 1));
}

function normaliseScores(parsed) {
  return {
    personaRelevance: parsed.persona_relevance,
    clarity: parsed.clarity,
    credibility: parsed.credibility,
    emotionalFit: parsed.emotional_fit,
    actionClarity: parsed.action_clarity,
    reasoning: parsed.reasoning,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Judge backends (BYOK)                             */
/* -------------------------------------------------------------------------- */

async function judgeWithGemini(persona, variant, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildJudgePrompt(persona, variant) }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return normaliseScores(extractJson(text));
}

function judgeStub() {
  // Used when provider=programmatic. Flat scores so weighting comes only
  // from the programmatic checks — still useful to show the heatmap.
  return Promise.resolve({
    personaRelevance: 5, clarity: 5, credibility: 5,
    emotionalFit: 5, actionClarity: 5,
    reasoning: "(programmatic-only run; LLM judge not called)",
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Runner                                    */
/* -------------------------------------------------------------------------- */

function weighted(judgeSum, progPasses) {
  return Math.round(((judgeSum + progPasses * 2) / 60) * 100);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runEval() {
  if (state.running) return;
  state.running = true;
  setButtonsDisabled(true);

  const judge = pickJudge();
  const progByVariant = new Map(variants.map(v => [v.id, gradeProgrammatic(v)]));

  const pairs = variants.flatMap(v => personas.map(p => ({ variantId: v.id, personaId: p.id })));
  state.progress = { done: 0, total: pairs.length };
  renderProgress();

  try {
    const results = await mapLimit(pairs, state.concurrency, async ({ variantId, personaId }) => {
      const v = variants.find(x => x.id === variantId);
      const p = personas.find(x => x.id === personaId);
      const prog = progByVariant.get(variantId);

      let judgeScore;
      try {
        judgeScore = await judge(p, v);
      } catch (err) {
        judgeScore = {
          personaRelevance: 0, clarity: 0, credibility: 0,
          emotionalFit: 0, actionClarity: 0,
          reasoning: `ERROR: ${err.message}`,
        };
      }

      state.progress.done++;
      renderProgress();

      const judgeSum = judgeScore.personaRelevance + judgeScore.clarity + judgeScore.credibility + judgeScore.emotionalFit + judgeScore.actionClarity;
      return { variantId, personaId, programmatic: prog, judge: judgeScore, weightedScore: weighted(judgeSum, prog.passes) };
    });

    state.results = results;
    state.lastRunAt = new Date().toISOString();
    localStorage.setItem("epcfix-results", JSON.stringify(results));
    localStorage.setItem("epcfix-lastrun", state.lastRunAt);

    renderAll();
  } finally {
    state.running = false;
    setButtonsDisabled(false);
  }
}

function pickJudge() {
  if (state.provider === "gemini") {
    if (!state.apiKey) throw new Error("Gemini API key required");
    return (p, v) => judgeWithGemini(p, v, state.apiKey);
  }
  return () => judgeStub();
}

/* -------------------------------------------------------------------------- */
/*                                 Renderers                                  */
/* -------------------------------------------------------------------------- */

function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

function setButtonsDisabled(disabled) {
  $("run").disabled = disabled;
  $("save-key").disabled = disabled;
  $("clear-key").disabled = disabled;
  $("provider").disabled = disabled;
  $("apikey").disabled = disabled;
}

function renderMeta() {
  $("meta-variants").textContent = String(variants.length);
  $("meta-personas").textContent = String(personas.length);
  $("meta-calls").textContent = String(variants.length * personas.length);
  $("meta-lastrun").textContent = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString("en-GB") : "never";
}

function renderProgress() {
  const { done, total } = state.progress;
  if (!total) { $("progress").textContent = ""; $("progress-fill").style.width = "0"; return; }
  $("progress").textContent = `${done}/${total}`;
  $("progress-fill").style.width = `${(done / total) * 100}%`;
}

function renderProviderNote() {
  const note = $("provider-note");
  note.innerHTML = "";
  if (state.provider === "gemini") {
    note.append(el("div", { class: "banner" },
      "Gemini's free tier currently allows ~15 calls/min — comfortable for a 40-call run. Get a key at aistudio.google.com/apikey. Key is stored only in this browser's localStorage."));
  } else {
    note.append(el("div", { class: "banner" },
      "Programmatic-only mode: no LLM calls, no key needed. Still catches payback-trap, reading-grade, and jargon issues. Good for daily iteration."));
  }
}

function renderKeyStatus() {
  const status = $("key-status");
  if (state.provider === "programmatic") {
    status.textContent = "not required";
    status.className = "key-status";
  } else if (state.apiKey) {
    status.textContent = `saved locally · ${state.apiKey.slice(0, 7)}…${state.apiKey.slice(-4)}`;
    status.className = "key-status saved";
  } else {
    status.textContent = "no key set";
    status.className = "key-status";
  }
}

function renderVariants() {
  const wrap = $("variants-list");
  wrap.innerHTML = "";
  for (const v of variants) {
    wrap.append(
      el("div", { class: "list-item" },
        el("div", { class: "name" }, v.name),
        el("div", { class: "copy-preview" }, v.headline),
        el("div", { class: "copy-sub" }, v.subhead),
        el("span", { class: "cta-pill" }, `[${v.cta}]`),
      )
    );
  }
}

function renderPersonas() {
  const wrap = $("personas-list");
  wrap.innerHTML = "";
  for (const p of personas) {
    wrap.append(
      el("div", { class: "list-item" },
        el("div", { class: "name" }, p.name),
        el("div", { class: "copy-sub" }, p.oneLiner),
        el("div", { class: "meta-line" }, `jargon: ${p.jargonTolerance} · payback appeal: ${p.paybackAppeal}`),
      )
    );
  }
}

function renderLeaderboard() {
  const wrap = $("leaderboard");
  wrap.innerHTML = "";
  if (!state.results) { wrap.append(el("div", { class: "empty" }, "No results yet. Run an eval above.")); return; }
  const rows = variants.map(v => {
    const rs = state.results.filter(r => r.variantId === v.id);
    const avg = Math.round(rs.reduce((s, r) => s + r.weightedScore, 0) / rs.length);
    return { v, avg };
  }).sort((a, b) => b.avg - a.avg);
  rows.forEach((row, i) => {
    wrap.append(
      el("div", { class: "leaderboard-row" },
        el("div", { class: "rank" }, String(i + 1).padStart(2, "0")),
        el("div", { class: "name" }, row.v.name),
        el("div", { class: "score" }, String(row.avg)),
        el("div", { class: "score-bar" }, el("div", { style: `width:${row.avg}%` })),
      )
    );
  });
}

function scoreColor(score) {
  // Map 0–100 to a green ramp.
  const t = Math.max(0, Math.min(100, score)) / 100;
  // Light cream → deep green
  const r = Math.round(246 - t * (246 - 31));
  const g = Math.round(241 - t * (241 - 93));
  const b = Math.round(231 - t * (231 - 64));
  return `rgb(${r},${g},${b})`;
}

function textColorForBg(score) {
  return score > 55 ? "white" : "var(--ink)";
}

function renderHeatmap() {
  const wrap = $("heatmap-wrap");
  wrap.innerHTML = "";
  if (!state.results) { wrap.append(el("div", { class: "empty" }, "No results yet.")); return; }

  const table = el("table", { class: "heatmap" });
  const thead = el("tr", {}, el("th", {}, "Persona"));
  variants.forEach(v => thead.append(el("th", { class: "var" }, v.id.split("-")[0])));
  table.append(thead);

  personas.forEach(p => {
    const row = el("tr", {}, el("td", { class: "label" }, p.id));
    variants.forEach(v => {
      const r = state.results.find(r => r.variantId === v.id && r.personaId === p.id);
      const score = r ? r.weightedScore : 0;
      row.append(el("td", { class: "cell", style: `background:${scoreColor(score)};color:${textColorForBg(score)}` }, String(score)));
    });
    table.append(row);
  });
  wrap.append(table);
}

function renderDetails() {
  const wrap = $("details");
  wrap.innerHTML = "";
  if (!state.results) { wrap.append(el("div", { class: "card" }, el("div", { class: "empty" }, "No results yet."))); return; }

  variants.forEach(v => {
    const rs = state.results.filter(r => r.variantId === v.id);
    const prog = rs[0].programmatic;
    const card = el("div", { class: "card detail" },
      el("h3", {}, v.name),
      el("div", { class: "rationale" }, v.rationale),
      el("div", { class: "copy-preview" }, v.headline),
      el("div", { class: "copy-sub" }, v.subhead),
      el("span", { class: "cta-pill" }, `[${v.cta}]`),
      el("div", { class: `prog-line ${prog.passes < 5 ? "warn" : ""}`, html:
        `Programmatic <strong>${prog.passes}/5</strong> · reading grade ${prog.readingGrade} · jargon ${prog.jargonCount} · payback-trap: <strong class="${prog.noPaybackTrap ? "ok" : "bad"}">${prog.noPaybackTrap ? "clear" : "TRIGGERED"}</strong>${prog.notes.length ? "<br><span style='opacity:0.85'>· " + prog.notes.join("<br>· ") + "</span>" : ""}`
      }),
    );

    const table = el("table", { class: "scoretable" });
    table.append(el("tr", {},
      el("th", {}, "Persona"),
      el("th", { class: "num" }, "Rel"),
      el("th", { class: "num" }, "Clr"),
      el("th", { class: "num" }, "Cred"),
      el("th", { class: "num" }, "Emo"),
      el("th", { class: "num" }, "Act"),
      el("th", { class: "num" }, "Score"),
      el("th", {}, "Reasoning"),
    ));
    personas.forEach(p => {
      const r = rs.find(x => x.personaId === p.id);
      const j = r.judge;
      table.append(el("tr", {},
        el("td", {}, p.id),
        el("td", { class: "num" }, String(j.personaRelevance)),
        el("td", { class: "num" }, String(j.clarity)),
        el("td", { class: "num" }, String(j.credibility)),
        el("td", { class: "num" }, String(j.emotionalFit)),
        el("td", { class: "num" }, String(j.actionClarity)),
        el("td", { class: "num", style: `color:${scoreColor(r.weightedScore)};font-weight:600` }, String(r.weightedScore)),
        el("td", { class: "reason" }, j.reasoning),
      ));
    });
    card.append(table);
    wrap.append(card);
  });
}

function renderAll() {
  renderMeta();
  renderProviderNote();
  renderKeyStatus();
  renderVariants();
  renderPersonas();
  renderLeaderboard();
  renderHeatmap();
  renderDetails();
  $("download").disabled = !state.results;
  $("reset").disabled = !state.results;
}

/* -------------------------------------------------------------------------- */
/*                              Report download                               */
/* -------------------------------------------------------------------------- */

function buildMarkdownReport() {
  const lines = [];
  lines.push(`# EPCFix hero copy scorecard`);
  lines.push(`Generated ${state.lastRunAt}\n`);

  const leaderboard = variants.map(v => {
    const rs = state.results.filter(r => r.variantId === v.id);
    const avg = Math.round(rs.reduce((s, r) => s + r.weightedScore, 0) / rs.length);
    return { v, avg };
  }).sort((a, b) => b.avg - a.avg);

  lines.push(`## Leaderboard\n`);
  lines.push(`| Rank | Variant | Score |`);
  lines.push(`| --- | --- | --- |`);
  leaderboard.forEach((row, i) => lines.push(`| ${i + 1} | ${row.v.name} | **${row.avg}** |`));
  lines.push(``);

  lines.push(`## Heatmap\n`);
  lines.push(`| Persona | ${variants.map(v => v.id.split("-")[0]).join(" | ")} |`);
  lines.push(`| --- | ${variants.map(() => "---").join(" | ")} |`);
  personas.forEach(p => {
    const cells = variants.map(v => {
      const r = state.results.find(r => r.variantId === v.id && r.personaId === p.id);
      return String(r.weightedScore);
    });
    lines.push(`| ${p.id} | ${cells.join(" | ")} |`);
  });
  lines.push(``);

  variants.forEach(v => {
    const rs = state.results.filter(r => r.variantId === v.id);
    const prog = rs[0].programmatic;
    lines.push(`### ${v.name}`);
    lines.push(`*${v.rationale}*\n`);
    lines.push(`> **${v.headline}**`);
    lines.push(`> ${v.subhead}`);
    lines.push(`> [${v.cta}]\n`);
    lines.push(`**Programmatic:** ${prog.passes}/5 · grade ${prog.readingGrade} · payback-trap: ${prog.noPaybackTrap ? "clear" : "TRIGGERED"}`);
    if (prog.notes.length) lines.push(prog.notes.map(n => `  - ${n}`).join("\n"));
    lines.push(``);
    lines.push(`| Persona | Rel | Clr | Cred | Emo | Act | Score | Why |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    personas.forEach(p => {
      const r = rs.find(x => x.personaId === p.id);
      const j = r.judge;
      lines.push(`| ${p.id} | ${j.personaRelevance} | ${j.clarity} | ${j.credibility} | ${j.emotionalFit} | ${j.actionClarity} | **${r.weightedScore}** | ${j.reasoning.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    });
    lines.push(``);
  });

  return lines.join("\n");
}

function downloadReport() {
  const md = buildMarkdownReport();
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const stamp = state.lastRunAt.replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url; a.download = `epcfix-scorecard-${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/*                                  Wire-up                                   */
/* -------------------------------------------------------------------------- */

function init() {
  $("provider").value = state.provider;
  $("apikey").value = state.apiKey;
  $("conc").value = String(state.concurrency);

  $("provider").addEventListener("change", e => {
    state.provider = e.target.value;
    localStorage.setItem("epcfix-provider", state.provider);
    renderProviderNote();
    renderKeyStatus();
  });

  $("save-key").addEventListener("click", () => {
    state.apiKey = $("apikey").value.trim();
    state.concurrency = Math.max(1, Math.min(10, Number($("conc").value) || 3));
    localStorage.setItem("epcfix-key", state.apiKey);
    localStorage.setItem("epcfix-conc", String(state.concurrency));
    renderKeyStatus();
  });

  $("clear-key").addEventListener("click", () => {
    state.apiKey = "";
    $("apikey").value = "";
    localStorage.removeItem("epcfix-key");
    renderKeyStatus();
  });

  $("run").addEventListener("click", () => {
    try {
      runEval();
    } catch (err) {
      alert(err.message);
    }
  });

  $("download").addEventListener("click", downloadReport);

  $("reset").addEventListener("click", () => {
    state.results = null;
    state.lastRunAt = null;
    localStorage.removeItem("epcfix-results");
    localStorage.removeItem("epcfix-lastrun");
    renderAll();
  });

  renderAll();
}

init();
