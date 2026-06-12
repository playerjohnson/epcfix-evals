// Shared judge logic. Mirrors app.js so the browser run and CI run
// produce identical scores. Pure module: no I/O, no network.

const ALLOWED_JARGON = new Set(["mees", "epc", "uk", "btl", "hmo", "spv"]);
const OUTCOME_WORDS = [
  "compliant", "ready", "rating", "pass", "lettable", "exempt",
  "plan", "ranked", "address", "property", "portfolio", "retrofit",
];
const PAYBACK_TRAP_TERMS = [
  "payback", "roi", "return on investment", "break-even", "break even",
];

export function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function readingGrade(text) {
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

export function jargonCount(text) {
  const tokens = text.match(/\b[A-Z]{3,}\b/g) ?? [];
  return tokens.filter(t => !ALLOWED_JARGON.has(t.toLowerCase())).length;
}

export function gradeProgrammatic(v) {
  const headlineWords = countWords(v.headline);
  const subheadWords = countWords(v.subhead);
  const fullText = `${v.headline}. ${v.subhead}`;
  const lowered = fullText.toLowerCase();
  const notes = [];

  const wordCountOk = headlineWords >= 5 && headlineWords <= 14
    && subheadWords >= 10 && subheadWords <= 32;
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

export function buildJudgePrompt(persona, variant) {
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

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return JSON.parse(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error(`No JSON in response: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(first, last + 1));
}

export function normaliseScores(parsed) {
  return {
    personaRelevance: parsed.persona_relevance,
    clarity: parsed.clarity,
    credibility: parsed.credibility,
    emotionalFit: parsed.emotional_fit,
    actionClarity: parsed.action_clarity,
    reasoning: parsed.reasoning,
  };
}

export function weighted(judgeSum, progPasses) {
  return Math.round(((judgeSum + progPasses * 2) / 60) * 100);
}

export function assembleResults({ variants, personas, programmaticByVariant, judgeByPair }) {
  const results = [];
  for (const v of variants) {
    const prog = programmaticByVariant.get(v.id);
    for (const p of personas) {
      const judge = judgeByPair.get(`${v.id}::${p.id}`);
      const judgeSum = judge.personaRelevance + judge.clarity + judge.credibility
        + judge.emotionalFit + judge.actionClarity;
      results.push({
        variantId: v.id,
        personaId: p.id,
        programmatic: prog,
        judge,
        weightedScore: weighted(judgeSum, prog.passes),
      });
    }
  }
  return results;
}

export function buildMarkdownReport({ variants, personas, results, lastRunAt, meta = {} }) {
  const lines = [];
  lines.push(`# EPCFix hero copy scorecard`);
  lines.push(`Generated ${lastRunAt}${meta.commit ? ` · commit \`${meta.commit}\`` : ""}${meta.judge ? ` · judge: ${meta.judge}` : ""}\n`);

  const leaderboard = variants.map(v => {
    const rs = results.filter(r => r.variantId === v.id);
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
      const r = results.find(r => r.variantId === v.id && r.personaId === p.id);
      return String(r.weightedScore);
    });
    lines.push(`| ${p.id} | ${cells.join(" | ")} |`);
  });
  lines.push(``);

  variants.forEach(v => {
    const rs = results.filter(r => r.variantId === v.id);
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

export function asciiHeatmap({ variants, personas, results }) {
  const header = "persona".padEnd(20) + variants.map(v => v.id.split("-")[0].padStart(5)).join("");
  const rows = personas.map(p => {
    const cells = variants.map(v => {
      const r = results.find(r => r.variantId === v.id && r.personaId === p.id);
      return String(r.weightedScore).padStart(5);
    });
    return p.id.padEnd(20) + cells.join("");
  });
  return [header, ...rows].join("\n");
}
