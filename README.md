# 入稿PDFプリフライト

商業オフセット印刷向けの入稿PDFチェッカー。**ブラウザ内だけで完結**し、PDFはどこにもアップロードされません。GitHub Pages に静的ホスティングするだけで動きます。

解析エンジンは [mupdf](https://www.npmjs.com/package/mupdf)（MuPDF の WebAssembly ビルド）。

---

## 動かす

```bash
npm install
npm run dev        # 開発サーバ
npm run build      # dist/ に静的ファイルを出力
npm test           # サンプルPDFに対してCLIで実行（回帰テスト）
```

CLI は同じ判定コアを Node で呼びます。

```bash
npx tsx cli.ts path/to/file.pdf
npx tsx cli.ts --json report.json path/to/*.pdf
```

`reject` が1件でもあれば終了コード 1 を返すので、CI のゲートに使えます。

---

## 設計

### 判定は3値

`pass` / `review` / `reject` の3段階です。プリフライトは誤検知を完全には避けられないため、2値にすると「正しいデータを弾いて顧客を失う」か「基準を緩めて事故を通す」かの二択になります。`reject` はどう見ても刷れないものだけに絞り、判断が要るものは `review` に落として人間のキューに積みます。

### 実装の3階層

| 層 | 必要な処理 | 状態 |
|---|---|---|
| **L1** | オブジェクト辞書を読むだけ | 実装済み |
| **L2** | コンテンツストリーム／描画命令の解釈 | 一部実装 |
| **L3** | CMYKラスタライズ | 未実装 |

L3（総インキ量、塗り足しの実充填、白オーバープリントの実害）は `page.toPixmap(matrix, ColorSpace.DeviceCMYK, ...)` → `getPixels()` で実装できることを検証済みです。CMYK各0.9のベタで実測 359.2%（理論値360%、8bit量子化込みで一致）。

### コアは純粋関数

`src/core/run.ts` の `runPreflight(mupdf, bytes, opts) => Report` は副作用を持ちません。mupdf をインスタンスごと引数で受け取るため、ブラウザ（Web Worker）と Node CLI で **同じファイルを一切変えずに共有**しています。将来サーバーサイドのゲートが必要になっても、このコアをそのまま Node で呼ぶだけです。

---

## チェック項目

| ID | 内容 | 層 |
|---|---|---|
| `file.encrypted` | 暗号化・権限設定 | L1 |
| `file.javascript` / `file.embedded_files` | 動的要素・添付ファイル | L1 |
| `box.trim_missing` | 仕上がりサイズ未設定 | L1 |
| `box.bleed_insufficient` | 塗り足し不足（既定 3mm） | L1 |
| `box.containment` | Media ⊇ Bleed ⊇ Trim の破れ | L1 |
| `box.size_not_uniform` | ページサイズ不揃い | L1 |
| `font.not_embedded` | フォント未埋め込み | L1 |
| `font.type3` | Type3フォント | L1 |
| `color.rgb_used` | RGBでの描画（実使用ベース） | L2 |
| `color.spot_colors` | 特色の版構成 | L1 |
| `color.spot_name_collision` | 特色名の表記ゆれ | L1 |
| `color.output_intent_missing` | 出力インテント未指定 | L1 |
| `line.too_thin` | 細線・ヘアライン | L2 |
| `image.low_resolution` | 実効解像度不足 | L2 |
| `image.jpx` | JPEG2000圧縮 | L1 |
| `transparency.blend_mode` | 注意が必要なブレンドモード | L2 |
| `page.printing_annotations` | 印刷される注釈 | L1 |
| `page.optional_content` | レイヤー | L1 |

### 未実装（優先順）

1. **総インキ量（TAC）** — L3。コート紙320%。`gs -sDEVICE=inkcov` に相当するものは**ページ平均**なので使えず、画素ごとの C+M+Y+K の最大値を取る必要があります。
2. **白オーバープリント** — 印刷すると消えるのに画面では見えるため、制作側が気づけない。検出価値が突出して高い項目。Device API のコールバックに `colorParams` が来ないため、`readStream()` で生コンテンツストリームを取り ExtGState の `/OP` `/op` を追う必要があります。
3. **塗り足しの実充填** — L3。BleedBox 基準でラスタライズし、Trim 外周の帯に白以外の画素があるかを四辺独立に判定。

---

## 判定基準の調整

`profiles/offset_coated.json` を編集します。閾値と重大度はコードに埋め込んでいません。

```json
"box.bleed_insufficient": { "severity": "reject", "min_mm": 3.0, "tolerance_pt": 0.1 },
"image.low_resolution":   { "severity": "review", "review_below": 200, "reject_below": 120 }
```

紙種・印刷方式ごとにファイルを増やして切り替えてください。**数値は商業オフセット・コート紙の一般値**なので、自社の印刷条件での検証が必要です。

---

## 実装メモ（mupdf の落とし穴）

- **ストリームは indirect 参照のまま `readStream()` を呼ぶ。** `.resolve()` を挟むと `isStream()` が `false` になり「object is not a stream」で落ちます。
- **module worker + トップレベル await でメッセージが消える。** mupdf は WASM 初期化にトップレベル await を使うため、静的 import にすると評価中に届いたメッセージがハンドラ未登録の global に配送されて捨てられます。症状は「ワーカーは起動するが `onmessage` が一度も呼ばれない」。`src/worker.ts` では mupdf を動的 import にし、ハンドラを同期評価中に登録して未処理分を自前で貯めています。
- **フォントの使用判定に MuPDF のフォント名は使えない。** 代替フォントに置き換わると元の名前と一致しません（実測で Georgia が `Type3 (4 0 R)` として返る）。コンテンツストリームの `/F4 10.5 Tf` からリソース名を抜いて突き合わせています。
- **`page.getBounds(box)` は継承と `/Rotate` を適用済みの値を返す。** 自前で Pages ツリーを辿る必要はありません。ただし未定義のボックスは CropBox と同じ値が返るので、「TrimBox が無い」の判定は CropBox との一致で行います。
- **3mm = 8.5039pt。** `8.5` で丸めると正しい塗り足しのデータが 0.004pt 足りずに落ちます。許容誤差を必ず持たせてください。
- **Vite では `optimizeDeps.exclude: ["mupdf"]` が必要。** 依存の事前バンドルを通すと `.wasm` の相対解決が壊れます。
- **SharedArrayBuffer は使われていないので COOP/COEP ヘッダが不要。** これが GitHub Pages に置ける理由です（GitHub Pages はレスポンスヘッダを設定できません）。

---

## デプロイ

`main` に push すると `.github/workflows/deploy.yml` が GitHub Pages に配信します。デプロイ前にサンプルPDFへの回帰テスト（`npm test`）が走ります。

リポジトリの Settings → Pages で Source を **GitHub Actions** に設定してください。

---

## ライセンス

mupdf は AGPL-3.0 です。本アプリは全処理がクライアント側で完結し、ソースがこのリポジトリで公開されているため、AGPL の要求は構成上満たされています。**クローズドな配布や商用SaaSに転用する場合は Artifex の商用ライセンスを検討してください。**
