/**
 * Node から同じコアを呼ぶCLI。
 * ブラウザ版と judge ロジックを共有しているので、これがそのまま回帰テストになる。
 *
 *   npx tsx cli.ts samples/*.pdf
 *   npx tsx cli.ts --json report.json samples/real.pdf
 */
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { runPreflight } from "./src/core/run.js";
import type { Report, Severity } from "./src/core/types.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

const MARK: Record<Severity, string> = {
  reject: `${C.red}✕ REJECT${C.reset}`,
  review: `${C.yellow}▲ REVIEW${C.reset}`,
  info: `${C.cyan}· INFO  ${C.reset}`,
};

function printReport(r: Report): void {
  const v =
    r.verdict === "pass"
      ? `${C.green}PASS${C.reset}`
      : r.verdict === "review"
        ? `${C.yellow}REVIEW${C.reset}`
        : `${C.red}REJECT${C.reset}`;

  console.log(`\n${C.bold}${r.file.name}${C.reset}  →  ${v}`);
  console.log(
    `${C.dim}${r.document.pages}ページ / PDF ${r.document.pdfVersion}` +
      ` / PDF-X: ${r.document.pdfx ?? "なし"}` +
      ` / 出力インテント: ${r.document.outputIntent ?? "なし"}` +
      `${r.document.spotColors.length ? ` / 特色: ${r.document.spotColors.join(", ")}` : ""}` +
      ` / ${r.elapsedMs}ms${C.reset}`,
  );

  if (r.findings.length === 0) {
    console.log(`  ${C.green}指摘なし${C.reset}`);
    return;
  }

  for (const f of r.findings) {
    const where = f.page ? `P.${f.page}` : "全体";
    console.log(`  ${MARK[f.severity]} ${C.dim}[${where}]${C.reset} ${C.bold}${f.title}${C.reset}`);
    console.log(`           ${f.detail}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let jsonOut: string | null = null;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") jsonOut = argv[++i] ?? null;
    else files.push(argv[i]);
  }

  if (files.length === 0) {
    console.error("usage: tsx cli.ts [--json out.json] <file.pdf> [...]");
    process.exit(2);
  }

  const reports: Report[] = [];
  let worst = 0;

  for (const f of files) {
    const report = runPreflight(mupdf, new Uint8Array(readFileSync(f)), { fileName: basename(f) });
    reports.push(report);
    printReport(report);
    worst = Math.max(worst, report.verdict === "reject" ? 2 : report.verdict === "review" ? 1 : 0);
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(reports, null, 2));
    console.log(`\n${C.dim}JSON: ${jsonOut}${C.reset}`);
  }

  console.log("");
  // CI で使えるよう、reject があれば非ゼロで終了する
  process.exit(worst === 2 ? 1 : 0);
}

main();
