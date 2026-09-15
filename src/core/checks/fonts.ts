import type * as MuPDF from "mupdf";
import type { Finding } from "../types.js";
import { Rules, collect } from "../profile.js";
import { array, dict, isNil, name, normalizeFontName, str, walkResources } from "../pdfobj.js";

/**
 * C. フォント（L1）
 *
 * 誤検知対策がこのチェックの本体:
 *   リソース辞書を舐めるだけだと「配置されているが実際には描画に使われていない
 *   フォント」まで未埋め込みとして報告してしまい、制作者が「そんなフォントは
 *   使っていない」と困惑する。誤検知の最大の発生源。
 *
 *   MuPDF の Font.getName() で突き合わせる案は使えない。代替フォントに
 *   置き換わると元の名前と一致しないため（実測で Georgia が Type3 や
 *   LiberationSerif として返る）。
 *
 *   そこでコンテンツストリームの `/F4 10.5 Tf` からリソース名を抜き、
 *   リソース辞書のキーと突き合わせる。これなら確実。
 */

export interface FontEntry {
  resourceKey: string;
  baseFont: string;
  subtype: string;
  embedded: boolean;
  type3: boolean;
}

export function collectFonts(resources: MuPDF.PDFObject | null): FontEntry[] {
  const found: FontEntry[] = [];
  const seenKeys = new Set<string>();

  walkResources(resources, (kind, key, obj) => {
    if (kind !== "Font") return;
    const f = dict(obj);
    if (!f) return;

    const subtype = name(f.get("Subtype")) ?? "Unknown";
    const baseFont = normalizeFontName(str(f.get("BaseFont")) ?? `(${subtype})`);

    // Type0 は実体が DescendantFonts 側にある
    let holder = f;
    if (subtype === "Type0") {
      const d0 = dict(array(f.get("DescendantFonts"))?.get(0));
      if (d0) holder = d0;
    }

    const fd = dict(holder.get("FontDescriptor"));
    const hasFile =
      !!fd &&
      (!isNil(fd.get("FontFile")) || !isNil(fd.get("FontFile2")) || !isNil(fd.get("FontFile3")));

    const type3 = subtype === "Type3";
    // Type3 はグリフ描画手続きがPDF内にあるので「埋め込み済み」として扱う
    const embedded = hasFile || type3;

    const id = `${key}|${baseFont}|${subtype}`;
    if (seenKeys.has(id)) return;
    seenKeys.add(id);
    found.push({ resourceKey: key, baseFont, subtype, embedded, type3 });
  });

  return found;
}

export function checkFonts(
  fonts: FontEntry[],
  usedKeys: Set<string>,
  pageNo: number,
  rules: Rules,
  out: Finding[],
): void {
  // 使用実績が1件も取れなかった場合（コンテンツストリームが読めない等）は
  // 誤検知を避けるため全件を対象にする。
  const used = (f: FontEntry) => usedKeys.size === 0 || usedKeys.has(f.resourceKey);

  const missing = fonts.filter((f) => !f.embedded && used(f));
  if (missing.length > 0) {
    const list = [...new Set(missing.map((f) => `${f.baseFont} (${f.subtype})`))];
    collect(
      out,
      rules.finding(
        "font.not_embedded",
        "フォントが埋め込まれていません",
        `${list.join(", ")}。RIP側の代替フォントに置き換わり、文字組みが変わります。標準14書体も埋め込みが必要です。`,
        { page: pageNo, values: { fonts: list.join(", "), count: list.length } },
      ),
    );
  }

  const t3 = fonts.filter((f) => f.type3 && used(f));
  if (t3.length > 0) {
    collect(
      out,
      rules.finding(
        "font.type3",
        "Type3フォントが使われています",
        `${t3.length}件。Type3はアウトラインではなく描画手続きの集合なので、小さいサイズで潰れることがあります。一部のPDF書き出しで意図せず生成されます。`,
        { page: pageNo, values: { count: t3.length, keys: t3.map((f) => f.resourceKey).join(", ") } },
      ),
    );
  }
}
