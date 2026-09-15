import type * as MuPDF from "mupdf";

type PDFObject = MuPDF.PDFObject;

/**
 * mupdf の PDFObject を扱うときの共通ヘルパ。
 *
 * ここに閉じ込めてある落とし穴:
 *  - get() が返すのは未解決の indirect 参照のことがある → 辞書操作前に resolve()
 *  - ただしストリームは indirect のまま readStream() を呼ぶ。resolve() を挟むと
 *    isStream() が false になり "object is not a stream" で落ちる。
 *  - 配列は [llx lly urx ury] の順とは限らないので必ず正規化する。
 */

export function isNil(o: PDFObject | null | undefined): boolean {
  return !o || o.isNull();
}

/** 辞書として使える形に解決する。辞書でなければ null。 */
export function dict(o: PDFObject | null | undefined): PDFObject | null {
  if (isNil(o)) return null;
  const r = o!.isIndirect() ? o!.resolve() : o!;
  return r.isDictionary() ? r : null;
}

/** 配列として解決する。配列でなければ null。 */
export function array(o: PDFObject | null | undefined): PDFObject | null {
  if (isNil(o)) return null;
  const r = o!.isIndirect() ? o!.resolve() : o!;
  return r.isArray() ? r : null;
}

export function name(o: PDFObject | null | undefined): string | null {
  if (isNil(o)) return null;
  const r = o!.isIndirect() ? o!.resolve() : o!;
  return r.isName() ? r.asName() : null;
}

export function str(o: PDFObject | null | undefined): string | null {
  if (isNil(o)) return null;
  const r = o!.isIndirect() ? o!.resolve() : o!;
  if (r.isString()) return r.asString();
  if (r.isName()) return r.asName();
  return null;
}

export function num(o: PDFObject | null | undefined): number | null {
  if (isNil(o)) return null;
  const r = o!.isIndirect() ? o!.resolve() : o!;
  return r.isNumber() ? r.asNumber() : null;
}

/**
 * ストリームの中身を読む。indirect 参照のまま渡すこと。
 * resolve() 済みのオブジェクトを渡すと落ちる。
 */
export function readStreamText(o: PDFObject | null | undefined): string | null {
  if (isNil(o)) return null;
  try {
    if (!o!.isStream()) return null;
    return o!.readStream().asString();
  } catch {
    return null;
  }
}

/** 辞書のエントリを [key, value] の配列にする。value は未解決のまま返す。 */
export function entries(d: PDFObject | null): Array<[string, PDFObject]> {
  const out: Array<[string, PDFObject]> = [];
  if (!d) return out;
  d.forEach((val, key) => {
    if (typeof key === "string") out.push([key, val]);
  });
  return out;
}

/**
 * Resources を再帰的に辿る。Form XObject の中の Resources も対象にする。
 * 循環参照で無限ループしないよう、訪問済みの indirect 番号を記録する。
 */
export function walkResources(
  res: PDFObject | null,
  visit: (kind: "Font" | "ColorSpace" | "XObject" | "ExtGState" | "Shading" | "Pattern", key: string, obj: PDFObject) => void,
  seen: Set<number> = new Set(),
  depth = 0,
): void {
  const d = dict(res);
  if (!d || depth > 12) return;

  for (const kind of ["Font", "ColorSpace", "ExtGState", "Shading", "Pattern"] as const) {
    const sub = dict(d.get(kind));
    for (const [key, val] of entries(sub)) visit(kind, key, val);
  }

  const xobjs = dict(d.get("XObject"));
  for (const [key, val] of entries(xobjs)) {
    visit("XObject", key, val);
    // Form XObject は自分の Resources を持つので降りる
    const xd = dict(val);
    if (!xd) continue;
    if (val.isIndirect()) {
      const n = val.asIndirect();
      if (seen.has(n)) continue;
      seen.add(n);
    }
    if (name(xd.get("Subtype")) === "Form") {
      walkResources(xd.get("Resources"), visit, seen, depth + 1);
    }
  }
}

/** 矩形を正規化して返す。値が取れなければ null。 */
export function rect(o: PDFObject | null | undefined): [number, number, number, number] | null {
  const a = array(o);
  if (!a || a.length < 4) return null;
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = num(a.get(i));
    if (n === null || !Number.isFinite(n)) return null;
    v.push(n);
  }
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** サブセット接頭辞 "ABCDEF+" を落とし、比較用に正規化する。 */
export function normalizeFontName(n: string): string {
  return n.replace(/^[A-Z]{6}\+/, "").trim();
}

/** 特色名の表記ゆれを吸収する。"PANTONE 186 C" と "PANTONE 186C" を同一視するため。 */
export function normalizeSpotName(n: string): string {
  return n.toUpperCase().replace(/[\s_-]+/g, "");
}
