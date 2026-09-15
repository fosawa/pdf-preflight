import type * as MuPDF from "mupdf";
import type { Finding } from "../types.js";
import { ptToMm } from "../types.js";
import { Rules, collect } from "../profile.js";

/**
 * Device を1回走らせて、実際に描画されたものだけを集める。
 *
 * リソース辞書を舐める方式と違って「置いてあるだけで使われていない」ものを
 * 拾わないのが利点。RGB混入の判定はこちらが正。
 * コンテンツストリーム中に直接書かれた `rg` / `sc` オペレータも、
 * Device 経由なら DeviceRGB として観測できる。
 */

export interface PageScan {
  /** 実際に描画に使われたカラースペース名 */
  colorSpaces: Set<string>;
  /** 最小の実効線幅（pt）。描画が無ければ Infinity。 */
  minStrokeWidthPt: number;
  /** 配置された画像 */
  images: Array<{ px: [number, number]; dpi: [number, number]; colorSpace: string }>;
  /** 使われたブレンドモード（Normal 以外） */
  blendModes: Set<string>;
}

export function scanPage(mupdf: typeof MuPDF, page: MuPDF.PDFPage): PageScan {
  const colorSpaces = new Set<string>();
  const blendModes = new Set<string>();
  const images: PageScan["images"] = [];
  let minStrokeWidthPt = Infinity;

  const csName = (cs: MuPDF.ColorSpace | null | undefined): string => {
    if (!cs) return "None";
    // toString() は "[ColorSpace DeviceRGB]" 形式
    const m = /\[ColorSpace (.+)\]/.exec(String(cs));
    return m ? m[1] : String(cs);
  };

  /** 行列から縦横のスケールを分解する。回転・スキューが掛かっていても正しく出る。 */
  const scaleOf = (ctm: MuPDF.Matrix): [number, number] => [
    Math.hypot(ctm[0], ctm[1]),
    Math.hypot(ctm[2], ctm[3]),
  ];

  const dev = new mupdf.Device({
    fillPath(_p, _e, _ctm, cs) {
      colorSpaces.add(csName(cs));
    },
    strokePath(_p, stroke, ctm, cs) {
      colorSpaces.add(csName(cs));
      const [sx, sy] = scaleOf(ctm);
      const scale = Math.sqrt(Math.abs(sx * sy)) || 1;
      const w = stroke.getLineWidth() * scale;
      // 線幅 0 は「出力機の最小幅」を意味する指定なので別途扱う。
      // ここでは 0 も含めて最小値として記録する。
      if (Number.isFinite(w)) minStrokeWidthPt = Math.min(minStrokeWidthPt, w);
    },
    fillText(_t, _ctm, cs) {
      colorSpaces.add(csName(cs));
    },
    strokeText(_t, _s, _ctm, cs) {
      colorSpaces.add(csName(cs));
    },
    fillImage(image, ctm) {
      const [sx, sy] = scaleOf(ctm);
      const w = image.getWidth();
      const h = image.getHeight();
      images.push({
        px: [w, h],
        dpi: [sx > 0 ? (w / sx) * 72 : 0, sy > 0 ? (h / sy) * 72 : 0],
        colorSpace: csName(image.getColorSpace()),
      });
    },
    fillImageMask(_i, _ctm, cs) {
      colorSpaces.add(csName(cs));
    },
    beginGroup(_area, _cs, _iso, _knockout, blendmode) {
      if (blendmode && blendmode !== "Normal") blendModes.add(blendmode);
    },
  });

  try {
    page.run(dev, mupdf.Matrix.identity);
  } finally {
    dev.close();
  }

  return { colorSpaces, minStrokeWidthPt, images, blendModes };
}

const RGB_LIKE = new Set(["DeviceRGB", "CalRGB", "Lab"]);

export function checkScan(scan: PageScan, pageNo: number, rules: Rules, out: Finding[]): void {
  // --- RGB混入（実使用ベース） ---
  const rgb = [...scan.colorSpaces].filter((c) => RGB_LIKE.has(c));
  if (rgb.length > 0) {
    collect(
      out,
      rules.finding(
        "color.rgb_used",
        "RGBで描画されている要素があります",
        `${rgb.join(", ")} が実際の描画に使われています。CMYKに変換してから入稿してください。PDF/X-4はRGBを許容するため、規格チェックだけでは検出されません。`,
        { page: pageNo, values: { colorSpaces: [...scan.colorSpaces].join(", ") } },
      ),
    );
  }

  // --- 細線 ---
  if (Number.isFinite(scan.minStrokeWidthPt)) {
    const minMm = rules.num("line.too_thin", "min_mm", 0.1);
    const mm = ptToMm(scan.minStrokeWidthPt);
    if (mm < minMm) {
      collect(
        out,
        rules.finding(
          "line.too_thin",
          scan.minStrokeWidthPt === 0 ? "線幅0の線があります" : "細すぎる線があります",
          scan.minStrokeWidthPt === 0
            ? "線幅0（ヘアライン）は出力機によって太さが変わります。実寸を指定してください。"
            : `最小 ${mm.toFixed(3)}mm（基準: ${minMm}mm）。刷版で飛ぶ可能性があります。`,
          { page: pageNo, values: { minWidthMm: +mm.toFixed(4), thresholdMm: minMm } },
        ),
      );
    }
  }

  // --- 画像の実効解像度 ---
  const reviewBelow = rules.num("image.low_resolution", "review_below", 200);
  const rejectBelow = rules.num("image.low_resolution", "reject_below", 120);
  const low = scan.images.filter((i) => Math.min(i.dpi[0], i.dpi[1]) < reviewBelow);
  if (low.length > 0) {
    const worst = Math.min(...low.map((i) => Math.min(i.dpi[0], i.dpi[1])));
    collect(
      out,
      rules.finding(
        worst < rejectBelow ? "image.very_low_resolution" : "image.low_resolution",
        "画像の解像度が不足しています",
        `${low.length}点。最低 ${worst.toFixed(0)}dpi（推奨 300dpi以上、要確認 ${reviewBelow}dpi未満）。` +
          `回転・拡大が掛かっている場合は配置後の実効値で判定しています。`,
        {
          page: pageNo,
          values: {
            count: low.length,
            worstDpi: +worst.toFixed(1),
            detail: low
              .slice(0, 5)
              .map((i) => `${i.px[0]}×${i.px[1]}px → ${Math.min(...i.dpi).toFixed(0)}dpi`)
              .join(" / "),
          },
        },
      ),
    );
  }

  // --- ブレンドモード ---
  const allowed = new Set(rules.list("transparency.blend_mode", "allowed"));
  const risky = [...scan.blendModes].filter((b) => !allowed.has(b));
  if (risky.length > 0) {
    collect(
      out,
      rules.finding(
        "transparency.blend_mode",
        "注意が必要なブレンドモードが使われています",
        `${risky.join(", ")}。RIPによって分割結果が変わることがあります。`,
        { page: pageNo, values: { modes: risky.join(", ") } },
      ),
    );
  }
}
