import type * as MuPDF from "mupdf";
import { array, dict, isNil, name, readStreamText } from "./pdfobj.js";

/**
 * ページのコンテンツストリームを集める。
 * /Contents は単一ストリームか配列。Form XObject は自前のストリームを持つので降りる。
 *
 * ここで集めた生テキストは、
 *   - 実際に使われているフォントのリソース名（Tf オペランド）
 *   - オーバープリント設定（gs / ExtGState 参照）
 * の抽出に使う。どちらも Device API のコールバックには出てこない情報。
 */
export function collectContentStreams(pageDict: MuPDF.PDFObject | null): string {
  if (!pageDict) return "";
  const parts: string[] = [];
  const seen = new Set<number>();

  const readInto = (obj: MuPDF.PDFObject | null): void => {
    if (isNil(obj)) return;
    const arr = array(obj);
    if (arr) {
      for (let i = 0; i < arr.length; i++) readInto(arr.get(i));
      return;
    }
    const text = readStreamText(obj);
    if (text) parts.push(text);
  };

  readInto(pageDict.get("Contents"));

  // Form XObject を再帰的に辿る
  const descend = (resources: MuPDF.PDFObject | null, depth: number): void => {
    const res = dict(resources);
    if (!res || depth > 12) return;
    const xobjs = dict(res.get("XObject"));
    if (!xobjs) return;

    xobjs.forEach((val) => {
      if (val.isIndirect()) {
        const n = val.asIndirect();
        if (seen.has(n)) return;
        seen.add(n);
      }
      const d = dict(val);
      if (!d || name(d.get("Subtype")) !== "Form") return;
      const text = readStreamText(val);
      if (text) parts.push(text);
      descend(d.get("Resources"), depth + 1);
    });
  };

  descend(pageDict.getInheritable("Resources"), 0);

  return parts.join("\n");
}

/**
 * `/F4 10.5 Tf` の形から、実際に選択されたフォントのリソース名を抜く。
 *
 * リソース辞書を舐めるだけだと、配置されているが描画に使われていないフォントまで
 * 未埋め込みとして報告してしまう。MuPDF が返すフォント名は代替フォントに
 * 置き換わると元の名前と一致しないため、リソース名で突き合わせるのが確実。
 */
export function usedFontResourceKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const re = /\/([^\s/<>[\]()]+)\s+[-\d.]+\s+Tf/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) keys.add(m[1]);
  return keys;
}

/** `/GS0 gs` の形から、実際に適用された ExtGState のリソース名を抜く。 */
export function usedExtGStateKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const re = /\/([^\s/<>[\]()]+)\s+gs\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) keys.add(m[1]);
  return keys;
}

/** ページ内に文字描画があるか（Tj / TJ / ' / " のいずれか）。 */
export function hasTextOperators(content: string): boolean {
  return /\b(Tj|TJ)\b|['"]\s*$/m.test(content);
}
