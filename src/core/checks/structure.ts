import type * as MuPDF from "mupdf";
import type { DocumentInfo, Finding } from "../types.js";
import { Rules, collect } from "../profile.js";
import { array, dict, entries, isNil, name, num, str } from "../pdfobj.js";

/**
 * A. ファイル健全性 + ドキュメントレベルの構造チェック（L1）
 */
export function checkStructure(
  doc: MuPDF.PDFDocument,
  rules: Rules,
  out: Finding[],
): Omit<DocumentInfo, "spotColors"> {
  const trailer = doc.getTrailer();
  const root = dict(trailer.get("Root"));
  const info = dict(trailer.get("Info"));

  // --- 暗号化 ---
  // needsPassword() は「開くのにパスワードが要るか」しか見ない。
  // 権限制限だけ掛かった（空パスワードで開ける）PDF は trailer の /Encrypt で捕まえる。
  const encrypted = !isNil(trailer.get("Encrypt"));
  if (encrypted) {
    collect(
      out,
      rules.finding(
        "file.encrypted",
        "暗号化されています",
        "暗号化・権限設定のあるPDFはRIPで処理できないことがあります。セキュリティ設定を解除して書き出し直してください。",
        { values: { needsPassword: doc.needsPassword() } },
      ),
    );
  }

  // --- PDFバージョン ---
  // getVersion() は 17 のような整数を返す（= PDF 1.7）
  const raw = doc.getVersion();
  const pdfVersion = raw >= 10 ? `${Math.floor(raw / 10)}.${raw % 10}` : String(raw);

  // --- PDF/X 識別情報 ---
  const pdfx = str(info?.get("GTS_PDFXVersion")) ?? null;

  // --- 出力インテント ---
  let outputIntent: string | null = null;
  const intents = array(root?.get("OutputIntents"));
  if (intents && intents.length > 0) {
    const first = dict(intents.get(0));
    outputIntent =
      str(first?.get("OutputConditionIdentifier")) ?? str(first?.get("OutputCondition")) ?? null;
  }
  if (!outputIntent) {
    collect(
      out,
      rules.finding(
        "color.output_intent_missing",
        "出力インテントがありません",
        "出力インテント（Japan Color 2001 Coated など）が指定されていないと、RIP側の既定プロファイルで色変換されます。PDF/X準拠で書き出すと自動的に付きます。",
      ),
    );
  }

  // --- JavaScript ---
  const names = dict(root?.get("Names"));
  if (!isNil(names?.get("JavaScript"))) {
    collect(
      out,
      rules.finding(
        "file.javascript",
        "JavaScriptが埋め込まれています",
        "印刷には不要な要素です。PDF/Xでは許可されません。",
      ),
    );
  }

  // --- 埋め込みファイル ---
  if (!isNil(names?.get("EmbeddedFiles"))) {
    collect(
      out,
      rules.finding(
        "file.embedded_files",
        "ファイルが添付されています",
        "PDFに別ファイルが添付されています。意図したものか確認してください。",
      ),
    );
  }

  // --- レイヤー（OCG） ---
  const ocp = dict(root?.get("OCProperties"));
  if (ocp) {
    const groups = array(ocp.get("OCGs"));
    const dflt = dict(ocp.get("D"));
    const off = array(dflt?.get("OFF"));
    collect(
      out,
      rules.finding(
        "page.optional_content",
        "レイヤー（オプショナルコンテンツ）があります",
        off && off.length > 0
          ? `既定で非表示のレイヤーが ${off.length} 件あります。非表示部分に不要な内容が残っていないか確認してください。`
          : "レイヤー構造を持っています。印刷時の表示設定が意図どおりか確認してください。",
        { values: { groups: groups?.length ?? 0, hiddenByDefault: off?.length ?? 0 } },
      ),
    );
  }

  return {
    pages: doc.countPages(),
    pdfVersion,
    pdfx,
    outputIntent,
    encrypted,
  };
}

/** 各ページの注釈を見る。印刷フラグ（bit 3 = 値4）が立っているものだけを対象にする。 */
export function checkAnnotations(
  pageDict: MuPDF.PDFObject | null,
  pageNo: number,
  rules: Rules,
  out: Finding[],
): void {
  const annots = array(pageDict?.get("Annots"));
  if (!annots) return;

  const printing: string[] = [];
  for (let i = 0; i < annots.length; i++) {
    const a = dict(annots.get(i));
    if (!a) continue;
    const subtype = name(a.get("Subtype"));
    if (subtype === "Popup" || subtype === "Link") continue;
    const flags = num(a.get("F")) ?? 0;
    // bit 3 (値 4) が Print フラグ
    if ((flags & 4) !== 0) printing.push(subtype ?? "Unknown");
  }

  if (printing.length > 0) {
    const counts = printing.reduce<Record<string, number>>((m, t) => {
      m[t] = (m[t] ?? 0) + 1;
      return m;
    }, {});
    collect(
      out,
      rules.finding(
        "page.printing_annotations",
        "印刷される注釈が残っています",
        `${Object.entries(counts)
          .map(([t, n]) => `${t} × ${n}`)
          .join(", ")}。校正コメントがそのまま印刷される可能性があります。`,
        { page: pageNo, values: counts },
      ),
    );
  }
}

/** ページ辞書から Resources を安全に取り出す（継承あり）。 */
export function pageResources(pageDict: MuPDF.PDFObject | null): MuPDF.PDFObject | null {
  if (!pageDict) return null;
  const r = pageDict.getInheritable("Resources");
  return dict(r);
}

/** デバッグ用: 辞書のキー一覧 */
export function keysOf(d: MuPDF.PDFObject | null): string[] {
  return entries(d).map(([k]) => k);
}
