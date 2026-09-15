import type { Finding, Profile, RuleConfig, Severity } from "./types.js";
import defaultProfile from "../../profiles/offset_coated.json";

export const DEFAULT_PROFILE = defaultProfile as Profile;

/**
 * ルール設定へのアクセサ。
 * 「ルールが無効」「閾値が未設定」を呼び出し側に散らかさないためのラッパ。
 */
export class Rules {
  constructor(private readonly profile: Profile) {}

  private cfg(id: string): RuleConfig | null {
    const r = this.profile.rules[id];
    if (!r) return null;
    if (r.enabled === false) return null;
    return r;
  }

  enabled(id: string): boolean {
    return this.cfg(id) !== null;
  }

  num(id: string, key: string, fallback: number): number {
    const v = this.cfg(id)?.[key];
    return typeof v === "number" ? v : fallback;
  }

  list(id: string, key: string): string[] {
    const v = this.cfg(id)?.[key];
    return Array.isArray(v) ? v.map(String) : [];
  }

  severity(id: string): Severity {
    return this.cfg(id)?.severity ?? "info";
  }

  /**
   * 指摘を1件作る。ルールが無効なら null を返すので、
   * 呼び出し側は push(...) の前に判定を書かなくてよい。
   */
  finding(
    id: string,
    title: string,
    detail: string,
    opts: { page?: number; values?: Finding["values"] } = {},
  ): Finding | null {
    if (!this.enabled(id)) return null;
    return {
      id,
      severity: this.severity(id),
      title,
      detail,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.values ? { values: opts.values } : {}),
    };
  }
}

/** null を落としながら push するための小道具。 */
export function collect(out: Finding[], ...items: (Finding | null)[]): void {
  for (const i of items) if (i) out.push(i);
}
