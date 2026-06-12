#!/usr/bin/env node
// Pure-Node SVG heatmap renderer. No browser, no Playwright dep.
// Reads runs/latest/run.json (or --in <path>), writes <dir>/heatmap.svg.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { personas } from "../personas.js";
import { variants } from "../variants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { in: join(REPO_ROOT, "runs", "latest", "run.json"), out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") args.in = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.out) args.out = join(dirname(args.in), "heatmap.svg");
  return args;
}

// Match the in-browser scoreColor ramp: cream → deep green.
function scoreColor(score) {
  const t = Math.max(0, Math.min(100, score)) / 100;
  const r = Math.round(246 - t * (246 - 31));
  const g = Math.round(241 - t * (241 - 93));
  const b = Math.round(231 - t * (231 - 64));
  return `rgb(${r},${g},${b})`;
}

function textFill(score) {
  return score > 55 ? "#fffdf8" : "#0e1a2b";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

function render({ results, lastRunAt }) {
  const labelW = 200;
  const cellW = 110;
  const cellH = 44;
  const headerH = 60;
  const footerH = 36;
  const width = labelW + cellW * variants.length + 20;
  const height = headerH + cellH * personas.length + footerH + 10;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'IBM Plex Sans', system-ui, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#f6f1e7"/>`);

  parts.push(`<text x="20" y="28" font-family="'Fraunces', Georgia, serif" font-size="20" font-weight="600" fill="#0e1a2b">EPCFix hero-copy scorecard</text>`);
  parts.push(`<text x="20" y="48" font-size="11" fill="#4a5a6f">last run ${esc(new Date(lastRunAt).toUTCString())}</text>`);

  variants.forEach((v, i) => {
    const x = labelW + i * cellW + cellW / 2;
    const y = headerH - 8;
    parts.push(`<text x="${x}" y="${y}" text-anchor="middle" font-size="11" font-weight="600" fill="#0e1a2b">${esc(v.id.split("-").slice(0, 2).join("-"))}</text>`);
  });

  personas.forEach((p, rowIdx) => {
    const y = headerH + rowIdx * cellH;
    parts.push(`<text x="${labelW - 12}" y="${y + cellH / 2 + 4}" text-anchor="end" font-size="12" fill="#0e1a2b">${esc(p.id)}</text>`);
    variants.forEach((v, colIdx) => {
      const r = results.find(x => x.variantId === v.id && x.personaId === p.id);
      const score = r ? r.weightedScore : 0;
      const x = labelW + colIdx * cellW;
      parts.push(`<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="6" fill="${scoreColor(score)}" stroke="#d9cfb8" stroke-width="0.5"/>`);
      parts.push(`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 5}" text-anchor="middle" font-size="14" font-weight="600" fill="${textFill(score)}">${score}</text>`);
    });
  });

  const fy = headerH + personas.length * cellH + 20;
  parts.push(`<text x="20" y="${fy}" font-size="10" fill="#8a8275">darker green = stronger persona-fit · weighted score (0–100) per (variant × persona)</text>`);

  parts.push(`</svg>`);
  return parts.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = JSON.parse(await readFile(args.in, "utf8"));
  const svg = render({ results: run.results, lastRunAt: run.lastRunAt });
  await writeFile(args.out, svg);
  process.stdout.write(`Wrote ${args.out}\n`);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
