/**
 * プリフライトコアの型定義。
 * このディレクトリ配下は DOM にも Node にも依存しない。
 * ブラウザ（Web Worker）と Node CLI の両方から同じコードを呼ぶ。
 */

/** 判定の重大度。2値ではなく3値にするのが設計上の要点。 */
export type Severity = "reject" | "review" | "info";

/** ドキュメント全体の判定。findings の最大 severity から導出する。 */
export type Verdict = "pass" | "review" | "reject";

export interface Finding {
  /** 安定した識別子。プロファイルの rules キーと対応する。例: "bleed.insufficient" */
  id: string;
  severity: Severity;
  /** 人間向けの短い見出し */
  title: string;
  /** 何がどうだったかの説明。数値は必ずここに入れる。 */
  detail: string;
  /** 1始まりのページ番号。ドキュメント全体の指摘は undefined。 */
  page?: number;
  /** 機械可読な実測値。閾値調整の判断材料になるので必ず残す。 */
  values?: Record<string, string | number | boolean>;
}

export interface DocumentInfo {
  pages: number;
  pdfVersion: string;
  /** GTS_PDFXVersion の値。無ければ null。 */
  pdfx: string | null;
  outputIntent: string | null;
  /** Separation / DeviceN で見つかった特色名（正規化前の生の名前） */
  spotColors: string[];
  encrypted: boolean;
}

export interface ProfileInfo {
  id: string;
  label: string;
  version: string;
}

export interface Report {
  file: { name: string; bytes: number };
  profile: ProfileInfo;
  document: DocumentInfo;
  findings: Finding[];
  verdict: Verdict;
  elapsedMs: number;
  /** 実行したチェックの層。将来 L2 / L3 を足したときに何が走ったか分かるようにする。 */
  levels: string[];
}

/** 1ルールの設定。severity は必須、それ以外はルールごとに自由。 */
export interface RuleConfig {
  severity: Severity;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface Profile {
  id: string;
  label: string;
  version: string;
  rules: Record<string, RuleConfig>;
}

/** 単位換算。1pt = 1/72 inch。 */
export const PT_PER_MM = 72 / 25.4; // 2.834645669...
export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt / PT_PER_MM;

export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, review: 1, reject: 2 };

export function verdictOf(findings: Finding[]): Verdict {
  let worst = 0;
  for (const f of findings) worst = Math.max(worst, SEVERITY_ORDER[f.severity]);
  return worst === 2 ? "reject" : worst === 1 ? "review" : "pass";
}
