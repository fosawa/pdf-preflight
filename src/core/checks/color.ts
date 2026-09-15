import type * as MuPDF from "mupdf";
import type { Finding } from "../types.js";
import { Rules, collect } from "../profile.js";
import { array, dict, name, normalizeSpotName, num, str, walkResources } from "../pdfobj.js";

/**
 * D. カラー（L1 リソースレベル）
 *
 * 注意: ここで見ているのは「リソースとして定義されているか」であって
 * 「実際に描画で使われたか」ではない。正確な使用判定は L2（Device 走査）の
 * 担当。RGB については誤検知を避けるため、実使用の確認が取れるまでは
 * リソース単位の指摘に留めている。
 */

export interface ColorScan {
  spotColors: string[];
  rgbResources: string[];
  jpxImages: number;
}

export function scanColor(resources: MuPDF.PDFObject | null): ColorScan {
  const spot = new Map<string, string>(); // 正規化名 -> 生の名前
  const rgb = new Set<string>();
  let jpx = 0;

  const inspectColorSpace = (obj: MuPDF.PDFObject, key: string): void => {
    const direct = name(obj);
    if (direct) {
      if (direct === "DeviceRGB" || direct === "CalRGB") rgb.add(`${key}:${direct}`);
      return;
    }

    const arr = array(obj);
    if (!arr || arr.length === 0) return;
    const family = name(arr.get(0));
    if (!family) return;

    switch (family) {
      case "Separation": {
        const n = str(arr.get(1));
        if (n && n !== "All" && n !== "None") spot.set(normalizeSpotName(n), n);
        break;
      }
      case "DeviceN": {
        const names = array(arr.get(1));
        if (names) {
          for (let i = 0; i < names.length; i++) {
            const n = str(names.get(i));
            if (n && n !== "All" && n !== "None") spot.set(normalizeSpotName(n), n);
          }
        }
        break;
      }
      case "ICCBased": {
        // ストリームの /N が成分数。3 なら RGB 系。
        const streamRef = arr.get(1);
        const d = dict(streamRef);
        if ((num(d?.get("N")) ?? 0) === 3) rgb.add(`${key}:ICCBased(N=3)`);
        break;
      }
      case "Lab":
      case "CalRGB":
        rgb.add(`${key}:${family}`);
        break;
      case "Indexed": {
        // base 色空間を再帰的に見る。ここの見落としが典型的なRGB混入の穴。
        const base = arr.get(1);
        if (base) inspectColorSpace(base, `${key}[Indexed base]`);
        break;
      }
      default:
        break;
    }
  };

  walkResources(resources, (kind, key, obj) => {
    if (kind === "ColorSpace") {
      inspectColorSpace(obj, key);
      return;
    }
    if (kind === "XObject") {
      const x = dict(obj);
      if (!x || name(x.get("Subtype")) !== "Image") return;

      const cs = x.get("ColorSpace");
      if (cs) inspectColorSpace(cs, `画像 ${key}`);

      // 圧縮方式。/Filter は名前または配列。
      const filterName = name(x.get("Filter"));
      const filterArr = array(x.get("Filter"));
      const filters = filterName
        ? [filterName]
        : filterArr
          ? Array.from({ length: filterArr.length }, (_, i) => name(filterArr.get(i)) ?? "")
          : [];
      if (filters.includes("JPXDecode")) jpx++;
    }
  });

  return { spotColors: [...spot.values()], rgbResources: [...rgb], jpxImages: jpx };
}

export function checkColor(scan: ColorScan, pageNo: number, rules: Rules, out: Finding[]): void {
  // --- RGB混入 ---
  if (scan.rgbResources.length > 0) {
    collect(
      out,
      rules.finding(
        "color.rgb_resource",
        "RGBのカラースペースが含まれています",
        `${scan.rgbResources.slice(0, 6).join(", ")}${scan.rgbResources.length > 6 ? " ほか" : ""}。CMYKに変換してから入稿してください。PDF/X-4はRGBを許容するため、規格チェックだけでは検出されません。`,
        { page: pageNo, values: { count: scan.rgbResources.length } },
      ),
    );
  }

  // --- 特色 ---
  if (scan.spotColors.length > 0) {
    const allowed = rules.list("color.spot_colors", "allowed").map(normalizeSpotName);
    const unexpected =
      allowed.length > 0
        ? scan.spotColors.filter((s) => !allowed.includes(normalizeSpotName(s)))
        : scan.spotColors;

    if (unexpected.length > 0) {
      collect(
        out,
        rules.finding(
          "color.spot_colors",
          "特色（スポットカラー）が使われています",
          `${unexpected.join(", ")}。版構成が発注内容と一致しているか確認してください。`,
          { page: pageNo, values: { spots: unexpected.join(", "), count: unexpected.length } },
        ),
      );
    }
  }

  // --- JPEG2000 ---
  if (scan.jpxImages > 0) {
    collect(
      out,
      rules.finding(
        "image.jpx",
        "JPEG2000圧縮の画像があります",
        `${scan.jpxImages}点。古いRIPで処理できないことがあります。`,
        { page: pageNo, values: { count: scan.jpxImages } },
      ),
    );
  }
}

/**
 * 特色名の表記ゆれ検出。
 * "PANTONE 186 C" と "PANTONE 186C" は別版として処理されるため、
 * 正規化すると同じになる組が複数あれば事故の疑いが濃い。
 */
export function checkSpotCollisions(allSpots: string[], rules: Rules, out: Finding[]): void {
  const byNormalized = new Map<string, Set<string>>();
  for (const s of allSpots) {
    const k = normalizeSpotName(s);
    if (!byNormalized.has(k)) byNormalized.set(k, new Set());
    byNormalized.get(k)!.add(s);
  }

  const collisions = [...byNormalized.values()].filter((v) => v.size > 1);
  if (collisions.length > 0) {
    collect(
      out,
      rules.finding(
        "color.spot_name_collision",
        "特色名の表記ゆれがあります",
        `${collisions.map((c) => [...c].join(" / ")).join("、")}。同じ色のつもりでも別々の版として出力されます。`,
        { values: { groups: collisions.length } },
      ),
    );
  }
}
