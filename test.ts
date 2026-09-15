/**
 * 回帰テスト。
 *
 * 「指摘が出ないこと」ではなく「期待どおりの指摘が出ること」を検証する。
 * サンプルPDFは意図的に問題を含んでいるので、判定が REJECT であること自体が正解。
 *
 *   npx tsx test.ts
 *
 * Phase 0 で過去の差し戻しPDFを集めたら、ここに CASES を足していく。
 * 「正常に刷れたデータ」も同数入れること（誤検知の検証にはそちらが重要）。
 */
import * as mupdf from "mupdf";
import { readFileSync } from "node:fs";
import { runPreflight } from "./src/core/run.js";
import type { Verdict } from "./src/core/types.js";

interface Case {
  file: string;
  note: string;
  verdict: Verdict;
  /** 必ず検出されるべき指摘ID */
  expect: string[];
  /** 検出されてはいけない指摘ID（誤検知の防止） */
  reject?: string[];
}

const CASES: Case[] = [
  {
    file: "samples/real.pdf",
    note: "Chromium で書き出した一般的なWeb由来PDF。印刷入稿としては問題だらけ。",
    verdict: "reject",
    expect: [
      "box.trim_missing", // 仕上がりサイズが無い
      "color.rgb_used", // RGBで描画されている（リソース走査では捕まらない）
      "color.output_intent_missing",
      "font.type3", // Chromium は Type3 を生成する
      "line.too_thin", // 0.013mm のヘアライン
    ],
    reject: [
      "file.encrypted",
      "font.not_embedded", // Type3 は埋め込み済み扱い。ここが出たら誤検知
    ],
  },
  {
    file: "samples/cmyk-tac360.pdf",
    note: "TrimBox/BleedBox が正しく、塗り足しちょうど3mm。TAC は 360% だが L3 未実装。",
    verdict: "review",
    expect: ["color.output_intent_missing"],
    reject: [
      // 3mm = 8.5039pt。許容誤差を持たせていないとここが誤検知する。
      "box.bleed_insufficient",
      "box.trim_missing",
      "box.containment",
      "color.rgb_used",
    ],
  },
];

let failed = 0;
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const ng = (m: string) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failed++;
};

for (const c of CASES) {
  console.log(`\n\x1b[1m${c.file}\x1b[0m  \x1b[2m${c.note}\x1b[0m`);

  const report = runPreflight(mupdf, new Uint8Array(readFileSync(c.file)), { fileName: c.file });
  const ids = new Set(report.findings.map((f) => f.id));

  if (report.verdict === c.verdict) ok(`verdict = ${report.verdict}`);
  else ng(`verdict = ${report.verdict} (期待: ${c.verdict})`);

  for (const id of c.expect) {
    if (ids.has(id)) ok(`検出: ${id}`);
    else ng(`検出されるべき指摘が出ていない: ${id}`);
  }

  for (const id of c.reject ?? []) {
    if (!ids.has(id)) ok(`誤検知なし: ${id}`);
    else ng(`誤検知: ${id} が出ている`);
  }
}

console.log(
  failed === 0
    ? `\n\x1b[32m全テスト通過\x1b[0m (${CASES.length} ファイル)\n`
    : `\n\x1b[31m${failed} 件失敗\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
