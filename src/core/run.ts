import type * as MuPDF from "mupdf";
import type { Finding, Profile, Report } from "./types.js";
import { verdictOf } from "./types.js";
import { DEFAULT_PROFILE, Rules } from "./profile.js";
import { dict } from "./pdfobj.js";
import { collectContentStreams, usedFontResourceKeys } from "./contentstream.js";
import { checkAnnotations, checkStructure, pageResources } from "./checks/structure.js";
import { checkBoxes, checkUniformity, type PageGeometry } from "./checks/boxes.js";
import { checkFonts, collectFonts } from "./checks/fonts.js";
import { checkColor, checkSpotCollisions, scanColor } from "./checks/color.js";
import { checkScan, scanPage } from "./checks/scan.js";

export interface RunOptions {
  fileName?: string;
  profile?: Profile;
  /** ページごとの進捗通知。UI のプログレス表示用。 */
  onProgress?: (done: number, total: number) => void;
}

/**
 * プリフライト本体。
 *
 * mupdf を引数で受け取るのは、ブラウザ（Web Worker）と Node CLI とで
 * import の仕方が違っても、このファイルを一切変えずに共有できるようにするため。
 *
 * この関数は副作用を持たない。入力は PDF のバイト列とプロファイル、
 * 出力は Report だけ。そのため Node でそのまま回帰テストに掛けられる。
 */
export function runPreflight(
  mupdf: typeof MuPDF,
  bytes: Uint8Array,
  opts: RunOptions = {},
): Report {
  const started = Date.now();
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const rules = new Rules(profile);
  const findings: Finding[] = [];

  let doc: MuPDF.PDFDocument;
  try {
    doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf") as MuPDF.PDFDocument;
  } catch (e) {
    // 開けない時点で以降のチェックは無意味。ここで打ち切る。
    return {
      file: { name: opts.fileName ?? "(unnamed)", bytes: bytes.length },
      profile: { id: profile.id, label: profile.label, version: profile.version },
      document: {
        pages: 0,
        pdfVersion: "?",
        pdfx: null,
        outputIntent: null,
        spotColors: [],
        encrypted: false,
      },
      findings: [
        {
          id: "file.unreadable",
          severity: "reject",
          title: "PDFとして読み込めません",
          detail: `ファイルが破損しているか、PDFではありません。(${String(e)})`,
        },
      ],
      verdict: "reject",
      elapsedMs: Date.now() - started,
      levels: ["L1"],
    };
  }

  try {
    const docInfo = checkStructure(doc, rules, findings);

    const total = docInfo.pages;
    const geoms: PageGeometry[] = [];
    const allSpots: string[] = [];

    for (let i = 0; i < total; i++) {
      const page = doc.loadPage(i);
      const pageNo = i + 1;

      try {
        const pageDict = dict(page.getObject());

        // --- B. ページ幾何 ---
        geoms.push(checkBoxes(page, pageNo, rules, findings));

        // --- 注釈 ---
        checkAnnotations(pageDict, pageNo, rules, findings);

        const res = pageResources(pageDict);

        // --- C. フォント（コンテンツストリームの使用実績と突き合わせ） ---
        const fonts = collectFonts(res);
        if (fonts.length > 0) {
          const content = collectContentStreams(pageDict);
          checkFonts(fonts, usedFontResourceKeys(content), pageNo, rules, findings);
        }

        // --- D. カラー（リソースレベル: 特色・JPX） ---
        const colorScan = scanColor(res);
        allSpots.push(...colorScan.spotColors);
        checkColor(colorScan, pageNo, rules, findings);

        // --- 描画ベースの走査: RGB実使用・線幅・画像解像度・ブレンドモード ---
        checkScan(scanPage(mupdf, page), pageNo, rules, findings);
      } finally {
        page.destroy?.();
      }

      opts.onProgress?.(pageNo, total);
    }

    checkUniformity(geoms, rules, findings);
    checkSpotCollisions(allSpots, rules, findings);

    const spotColors = [...new Set(allSpots)];

    return {
      file: { name: opts.fileName ?? "(unnamed)", bytes: bytes.length },
      profile: { id: profile.id, label: profile.label, version: profile.version },
      document: { ...docInfo, spotColors },
      findings: sortFindings(findings),
      verdict: verdictOf(findings),
      elapsedMs: Date.now() - started,
      levels: ["L1", "L2(部分)"],
    };
  } finally {
    doc.destroy?.();
  }
}

/** 重大度の高い順、同じ重大度ならページ順に並べる。 */
function sortFindings(findings: Finding[]): Finding[] {
  const rank = { reject: 0, review: 1, info: 2 } as const;
  return [...findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (a.page ?? 0) - (b.page ?? 0),
  );
}
