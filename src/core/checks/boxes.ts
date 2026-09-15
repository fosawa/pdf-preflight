import type * as MuPDF from "mupdf";
import type { Finding } from "../types.js";
import { mmToPt, ptToMm } from "../types.js";
import { Rules, collect } from "../profile.js";

/**
 * B. ページ幾何（L1）── 断裁事故を止める
 *
 * mupdf の page.getBounds(box) を使う。これは Pages ツリーからの継承と
 * /Rotate の適用を済ませた値を返すので、自前で辿る必要がない。
 * 未定義のボックスは MediaBox（または CropBox）と同じ値が返ってくるため、
 * 「TrimBox が無い」の判定は CropBox との一致で行う。
 */

type Box = [number, number, number, number];

const W = (b: Box) => b[2] - b[0];
const H = (b: Box) => b[3] - b[1];
const same = (a: Box, b: Box, tol = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

export interface PageGeometry {
  page: number;
  trim: Box;
  bleed: Box;
  media: Box;
  /** 四辺の塗り足し量 [左, 下, 右, 上]（pt） */
  bleedMargins: [number, number, number, number];
  hasExplicitTrim: boolean;
}

export function checkBoxes(
  page: MuPDF.PDFPage,
  pageNo: number,
  rules: Rules,
  out: Finding[],
): PageGeometry {
  const media = page.getBounds("MediaBox") as Box;
  const crop = page.getBounds("CropBox") as Box;
  const trimRaw = page.getBounds("TrimBox") as Box;
  const artRaw = page.getBounds("ArtBox") as Box;
  const bleed = page.getBounds("BleedBox") as Box;

  // TrimBox が未定義だと CropBox と同値が返る。その場合 ArtBox を代替として見る。
  const trimDefined = !same(trimRaw, crop);
  const artDefined = !same(artRaw, crop);
  const hasExplicitTrim = trimDefined || artDefined;
  const trim: Box = trimDefined ? trimRaw : artDefined ? artRaw : crop;

  if (!hasExplicitTrim) {
    collect(
      out,
      rules.finding(
        "box.trim_missing",
        "仕上がりサイズ（TrimBox）が未設定です",
        "TrimBoxもArtBoxも定義されていないため、どこで断裁すべきかデータから判断できません。面付できないので差し替えが必要です。",
        {
          page: pageNo,
          values: {
            mediaWidthMm: +ptToMm(W(media)).toFixed(2),
            mediaHeightMm: +ptToMm(H(media)).toFixed(2),
          },
        },
      ),
    );
  }

  // --- 包含関係 MediaBox ⊇ BleedBox ⊇ TrimBox ---
  const contains = (outer: Box, inner: Box, tol = 0.01) =>
    outer[0] <= inner[0] + tol &&
    outer[1] <= inner[1] + tol &&
    outer[2] >= inner[2] - tol &&
    outer[3] >= inner[3] - tol;

  if (!contains(bleed, trim) || !contains(media, bleed)) {
    collect(
      out,
      rules.finding(
        "box.containment",
        "ボックスの包含関係が壊れています",
        "MediaBox ⊇ BleedBox ⊇ TrimBox の関係が成立していません。ボックス設定を見直してください。",
        {
          page: pageNo,
          values: { media: media.join(","), bleed: bleed.join(","), trim: trim.join(",") },
        },
      ),
    );
  }

  // --- 塗り足し量 ---
  const margins: [number, number, number, number] = [
    trim[0] - bleed[0], // 左
    trim[1] - bleed[1], // 下
    bleed[2] - trim[2], // 右
    bleed[3] - trim[3], // 上
  ];

  const minMm = rules.num("box.bleed_insufficient", "min_mm", 3.0);
  const tolPt = rules.num("box.bleed_insufficient", "tolerance_pt", 0.1);
  const requiredPt = mmToPt(minMm) - tolPt;

  const labels = ["左", "下", "右", "上"];
  const short = margins
    .map((m, i) => ({ side: labels[i], mm: ptToMm(m) }))
    .filter((_, i) => margins[i] < requiredPt);

  if (short.length > 0 && hasExplicitTrim) {
    collect(
      out,
      rules.finding(
        "box.bleed_insufficient",
        "塗り足しが不足しています",
        `${short.map((s) => `${s.side} ${s.mm.toFixed(2)}mm`).join(" / ")}（必要: ${minMm}mm）。断裁位置のずれで白フチが出ます。`,
        {
          page: pageNo,
          values: {
            leftMm: +ptToMm(margins[0]).toFixed(3),
            bottomMm: +ptToMm(margins[1]).toFixed(3),
            rightMm: +ptToMm(margins[2]).toFixed(3),
            topMm: +ptToMm(margins[3]).toFixed(3),
            requiredMm: minMm,
          },
        },
      ),
    );
  }

  return { page: pageNo, trim, bleed, media, bleedMargins: margins, hasExplicitTrim };
}

/**
 * 全ページのTrimBoxサイズが揃っているか。
 * 最頻サイズを基準にして、そこから外れたページを指摘する。
 */
export function checkUniformity(geoms: PageGeometry[], rules: Rules, out: Finding[]): void {
  if (geoms.length < 2) return;

  const key = (g: PageGeometry) => `${W(g.trim).toFixed(1)}x${H(g.trim).toFixed(1)}`;
  const counts = new Map<string, number>();
  for (const g of geoms) counts.set(key(g), (counts.get(key(g)) ?? 0) + 1);

  if (counts.size === 1) return;

  const [majority] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const odd = geoms.filter((g) => key(g) !== majority[0]);

  collect(
    out,
    rules.finding(
      "box.size_not_uniform",
      "ページサイズが揃っていません",
      `基準サイズ ${majority[0].replace("x", " × ")}pt に対し、${odd.length}ページが異なります（P.${odd
        .slice(0, 8)
        .map((g) => g.page)
        .join(", ")}${odd.length > 8 ? " ほか" : ""}）。見開きページの混在も確認してください。`,
      {
        values: {
          sizes: [...counts.entries()].map(([k, n]) => `${k}pt × ${n}p`).join(" / "),
        },
      },
    ),
  );
}
