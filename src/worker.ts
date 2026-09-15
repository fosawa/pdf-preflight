/// <reference lib="webworker" />
import { runPreflight } from "./core/run.js";
import type * as MuPDFNS from "mupdf";
import type { Profile, Report } from "./core/types.js";

export type WorkerRequest = {
  id: number;
  fileName: string;
  bytes: ArrayBuffer;
  profile?: Profile;
};

export type WorkerResponse =
  | { kind: "ready" }
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "result"; report: Report }
  | { id: number; kind: "error"; message: string };

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

/**
 * mupdf は WASM の初期化にトップレベル await を使う。
 *
 * これを静的 import にすると、モジュール評価が await で中断している間に
 * 届いたメッセージが「ハンドラ未登録の global」に配送されて捨てられる。
 * module worker + トップレベル await の既知の落とし穴で、症状は
 * 「ワーカーは起動するが onmessage が一度も呼ばれない」。
 *
 * そのため mupdf は動的 import にして、ハンドラの登録を
 * 同期評価のうちに済ませ、初期化完了までのメッセージは自前で貯める。
 * （core 側は mupdf を import type でしか参照していないので、
 *   実行時に mupdf を読み込むのはこのファイルだけ）
 */
let mupdf: typeof MuPDFNS | null = null;
const pending: WorkerRequest[] = [];

function handle(req: WorkerRequest): void {
  if (!mupdf) return;
  const { id, fileName, bytes, profile } = req;
  try {
    const report = runPreflight(mupdf, new Uint8Array(bytes), {
      fileName,
      profile,
      onProgress: (done, total) => post({ id, kind: "progress", done, total }),
    });
    post({ id, kind: "result", report });
  } catch (e) {
    post({ id, kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

// ハンドラは同期的に登録する。ここが await より後ろに来てはいけない。
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  if (mupdf) handle(ev.data);
  else pending.push(ev.data);
};

void import("mupdf")
  .then((mod) => {
    mupdf = mod;
    post({ kind: "ready" });
    while (pending.length > 0) handle(pending.shift()!);
  })
  .catch((e) => {
    post({ id: -1, kind: "error", message: `mupdf の読み込みに失敗しました: ${String(e)}` });
  });
