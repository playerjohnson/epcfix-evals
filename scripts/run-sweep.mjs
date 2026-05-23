#!/usr/bin/env node
// EPCFix evals sweep runner.
//
// Two modes:
//   1. --api    (default) calls Gemini REST API using GEMINI_API_KEY env
//   2. --from-raw <path>  replays a JSON array of {variantId, personaId, response}
//                         (response is the raw text Gemini returned). Used to
//                         regenerate report.md offline, or to feed in responses
//                         collected via another channel (e.g. the Gemini MCP).
//
// Outputs to runs/<ISO-timestamp>/:
//   - run.json    full structured result
//   - report.md   markdown report identical to the in-browser download
//   - heatmap.txt ASCII heatmap (for log scrubbing in CI)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { personas } from "../personas.js";
import { variants } from "../variants.js";
import {
  asciiHeatmap, assembleResults, buildJudgePrompt, buildMarkdownReport,
  extractJson, gradeProgrammatic, normaliseScores,
} from "./lib/judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { mode: "api", fromRaw: null, concurrency: 4, model: "gemini-2.5-flash", commit: process.env.GITHUB_SHA?.slice(0, 7) ?? "local" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-raw") { args.mode = "from-raw"; args.fromRaw = argv[++i]; }
    else if (a === "--api") { args.mode = "api"; }
    else if (a === "--concurrency") { args.concurrency = Number(argv[++i]); }
    else if (a === "--model") { args.model = argv[++i]; }
    else if (a === "--commit") { args.commit = argv[++i]; }
  }
  return args;
}

async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

async function gatherFromApi({ concurrency, model }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const pairs = variants.flatMap(v => personas.map(p => ({ v, p })));
  const raw = await mapLimit(pairs, concurrency, async ({ v, p }) => {
    const text = await callGemini(buildJudgePrompt(p, v), apiKey, model);
    return { variantId: v.id, personaId: p.id, response: text };
  });
  return raw;
}

async function gatherFromFile(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(REPO_ROOT, "runs", stamp);

  const raw = args.mode === "from-raw"
    ? await gatherFromFile(args.fromRaw)
    : await gatherFromApi(args);

  const judgeByPair = new Map();
  for (const { variantId, personaId, response } of raw) {
    judgeByPair.set(`${variantId}::${personaId}`, normaliseScores(extractJson(response)));
  }
  const programmaticByVariant = new Map(variants.map(v => [v.id, gradeProgrammatic(v)]));
  const results = assembleResults({ variants, personas, programmaticByVariant, judgeByPair });
  const lastRunAt = new Date().toISOString();
  const report = buildMarkdownReport({
    variants, personas, results, lastRunAt,
    meta: { commit: args.commit, judge: args.mode === "from-raw" ? `replayed (${args.fromRaw})` : `${args.model} via REST` },
  });
  const ascii = asciiHeatmap({ variants, personas, results });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "run.json"), JSON.stringify({ stamp, lastRunAt, args, results, raw }, null, 2));
  await writeFile(join(outDir, "report.md"), report);
  await writeFile(join(outDir, "heatmap.txt"), ascii);

  const latestDir = join(REPO_ROOT, "runs", "latest");
  await mkdir(latestDir, { recursive: true });
  await writeFile(join(latestDir, "run.json"), JSON.stringify({ stamp, lastRunAt, args, results }, null, 2));
  await writeFile(join(latestDir, "report.md"), report);
  await writeFile(join(latestDir, "heatmap.txt"), ascii);

  process.stdout.write(`\nWrote ${outDir}\n\n${ascii}\n`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
