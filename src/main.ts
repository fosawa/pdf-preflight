import type { Report, Severity, Verdict } from "./core/types.js";
import type { WorkerRequest, WorkerResponse } from "./worker.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`element not found: ${sel}`);
  return el;
};

const drop = $<HTMLElement>("#drop");
const fileInput = $<HTMLInputElement>("#file");
const status = $<HTMLElement>("#status");
const statusText = $<HTMLElement>("#status-text");
const results = $<HTMLElement>("#results");

// mupdf の WASM は数MBある。起動を待たせないよう Worker は最初の投入時に作る。
let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function analyze(file: File): Promise<Report> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const w = getWorker();

    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.kind === "ready") return;
      if (msg.id !== id) return;
      if (msg.kind === "progress") {
        statusText.textContent = `${file.name} — ${msg.done} / ${msg.total} ページ`;
        return;
      }
      w.removeEventListener("message", onMessage);
      if (msg.kind === "result") resolve(msg.report);
      else reject(new Error(msg.message));
    };

    w.addEventListener("message", onMessage);
    file
      .arrayBuffer()
      .then((bytes) => {
        const req: WorkerRequest = { id, fileName: file.name, bytes };
        // bytes は転送して所有権を渡す（コピーを作らない）
        w.postMessage(req, [bytes]);
      })
      .catch(reject);
  });
}

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "PASS",
  review: "REVIEW",
  reject: "REJECT",
};

const SEV_CLASS: Record<Severity, string> = {
  reject: "b-reject",
  review: "b-review",
  info: "b-info",
};

const SEV_LABEL: Record<Severity, string> = {
  reject: "REJECT",
  review: "REVIEW",
  info: "INFO",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function renderReport(report: Report): HTMLElement {
  const card = el("article", "card");

  // --- ヘッダ ---
  const head = el("div", `card-head v-${report.verdict}`);
  head.append(el("span", "card-name", report.file.name));
  const badgeClass =
    report.verdict === "reject" ? "b-reject" : report.verdict === "review" ? "b-review" : "b-pass";
  head.append(el("span", `badge ${badgeClass}`, VERDICT_LABEL[report.verdict]));
  card.append(head);

  // --- メタ情報 ---
  const d = report.document;
  const meta = el("div", "card-meta");
  const bits = [
    `${d.pages}ページ`,
    `PDF ${d.pdfVersion}`,
    `PDF/X: ${d.pdfx ?? "なし"}`,
    `出力インテント: ${d.outputIntent ?? "なし"}`,
    d.spotColors.length ? `特色: ${d.spotColors.join(", ")}` : null,
    formatBytes(report.file.bytes),
    `${report.elapsedMs}ms`,
  ].filter((b): b is string => b !== null);
  for (const b of bits) meta.append(el("span", undefined, b));
  card.append(meta);

  // --- 指摘 ---
  if (report.findings.length === 0) {
    const ok = el("p", "ok", "✓ このプロファイルの基準では指摘はありません。");
    card.append(ok);
  } else {
    const list = el("ul", "findings");
    for (const f of report.findings) {
      const li = el("li", "finding");
      li.append(el("span", `badge ${SEV_CLASS[f.severity]}`, SEV_LABEL[f.severity]));

      const title = el("div", "f-title");
      title.append(document.createTextNode(f.title));
      title.append(el("span", "f-page", f.page ? `P.${f.page}` : "ドキュメント全体"));
      li.append(title);

      const detail = el("p", "f-detail", f.detail);
      if (f.values) {
        const v = el(
          "span",
          "f-values",
          Object.entries(f.values)
            .map(([k, val]) => `${k}=${val}`)
            .join("  "),
        );
        detail.append(el("br"), v);
      }
      li.append(detail);
      list.append(li);
    }
    card.append(list);
  }

  // --- JSON出力 ---
  const foot = el("div", "card-foot");
  const btn = el("button", "btn", "JSONをダウンロード");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = report.file.name.replace(/\.pdf$/i, "") + ".preflight.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  foot.append(btn);
  card.append(foot);

  return card;
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (pdfs.length === 0) {
    statusText.textContent = "PDFファイルを選んでください。";
    status.hidden = false;
    return;
  }

  results.replaceChildren();
  status.hidden = false;

  for (const file of pdfs) {
    statusText.textContent = `${file.name} を解析中…`;
    try {
      const report = await analyze(file);
      results.append(renderReport(report));
    } catch (e) {
      const card = el("article", "card");
      const head = el("div", "card-head v-reject");
      head.append(el("span", "card-name", file.name));
      head.append(el("span", "badge b-reject", "ERROR"));
      card.append(head);
      card.append(el("p", "ok", `解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
      results.append(card);
    }
  }

  status.hidden = true;
}

// --- イベント配線 ---
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files) void handleFiles(fileInput.files);
});

for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (dt?.files) void handleFiles(dt.files);
});

// ページ全体へのドロップも拾う（ドロップゾーンを外しても事故らないように）
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
