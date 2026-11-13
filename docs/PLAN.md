# Eraser Panda — 實作計畫與進度 (Plan & Status)

> **接手的 agent 請先讀這份檔案與 `AGENTS.md`。** 每個里程碑完成 = 一個 PR，合併進 `main` 後再開下一個。
> 狀態：✅ 完成　🚧 進行中　⬜ 未開始

## 1. 技術架構

```
┌─────────────────────────── 單一 HTML（vite-plugin-singlefile 內嵌全部 JS/CSS）──────────────────────────┐
│ UI (Preact)                                                                                             │
│   DropZone → FileList → FindingsPanel（勾選/例外/一鍵全刪）→ Preview（處理前/後）→ Download / ZIP / Report │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ core/  （與格式無關）                                                                                    │
│   rules.ts      預設關鍵字庫 + 使用者規則（字串 / regex / 整字 / 大小寫）                                 │
│   normalize.ts  全形→半形、大小寫、空白折疊，並保留「正規化字元 → 原始字元」的索引對照                       │
│   matcher.ts    在一段文字上找出所有命中區間                                                               │
│   segments.ts   ★ 跨片段比對：多個片段（Word run / PDF 繪字指令）串接後比對，再把命中區間映射回各片段          │
│   types.ts      Finding / ScanResult / FormatHandler 介面                                                 │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ formats/ooxml  docx / xlsx / pptx：fflate 解壓 → DOMParser → 各 part 掃描/刪除 → 只重寫有變動的 part       │
│ formats/pdf    pdf-lib（物件模型/存檔）+ 自寫內容串流 lexer/直譯器（字型解碼、字寬補位、座標）             │
│                pdf.js 只負責畫面預覽渲染                                                                  │
│ formats/text   txt / csv / md                                                                            │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ verify/        對輸出檔重新掃描 + 原始位元組（含解壓串流）掃描 → 殘留報告                                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 核心介面（`src/core/types.ts`）

```ts
interface FormatHandler {
  id: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'text';
  scan(input: Uint8Array, rules: CompiledRules): Promise<ScanResult>;          // 找出所有 Finding
  apply(input: Uint8Array, rules: CompiledRules, removeIds: Set<string>): Promise<Uint8Array>; // 產出新檔
}
```

- `apply()` 會用同一份規則重新掃描，因此 Finding 的 `id` 必須是 **由位置決定的穩定 ID**（例如 `word/header1.xml#p3@12-24`），同一份輸入 + 同一份規則永遠得到同一組 ID。
- 原始檔只讀，不會被改寫；輸出一律是新的 `Uint8Array`。

### 關鍵設計決策

| 決策 | 選擇 | 理由 |
|------|------|------|
| PDF 刪字 | 自寫內容串流編輯（依字形解碼比對，移除字形並以 `TJ` 位移補位） | 真刪除、可處理旋轉浮水印；MuPDF 是 AGPL 且其「區域式」redaction 對斜放浮水印會誤刪內文 |
| PDF 預覽 | pdf.js（Apache-2.0），以 fake worker 內嵌執行 | `file://` 下無法載入外部 worker |
| Office 解析 | fflate + 原生 DOMParser | 輕量；未修改的 part 原 bytes 保留 |
| UI | Preact + TypeScript | 小（~4KB）、React 寫法人人會 |
| 打包 | Vite + vite-plugin-singlefile | 產出單一 HTML，可離線、可 `file://` |
| 網路 | CSP `connect-src 'none'` | 以技術手段保證檔案不外流 |
| 測試 | Vitest（happy-dom）+ Playwright E2E；fixtures 由 `scripts/` 產生 | 環境已有 LibreOffice / python-docx / openpyxl / reportlab |

## 2. 里程碑

| # | 里程碑 | 內容 | 狀態 |
|---|--------|------|------|
| M0 | 專案骨架 | 需求/計畫/交接文件、Vite+TS+Preact、單檔 HTML 打包、CSP、拖曳區、CI | ✅ |
| M1 | 比對核心 | 預設關鍵字庫、正規化、整字/regex、跨片段映射、穩定 ID | ⬜ |
| M2 | OOXML 引擎 | docx/xlsx/pptx 全 part 文字掃描與刪除（含頁首頁尾、浮水印、文字方塊、註解、母片、圖表、Excel 頁首頁尾代碼與公式）；core/app/custom props、MSIP、LabelInfo、customXml；rels/Content_Types 清理 | ⬜ |
| M3 | UI v1（Office 可用） | 檔案清單、發現清單（依類型/位置分組、勾選例外、一鍵全刪、只取消內文）、文字片段預覽、下載 `_clean` 檔 | ⬜ |
| M4 | PDF 基礎 | pdf-lib 載入、Info/XMP/MSIP 移除、圖章/註解/書籤/表單、孤兒物件 GC、pdf.js 頁面預覽 | ⬜ |
| M5 | PDF 內文刪除 | 內容串流 lexer/直譯器、字型解碼（ToUnicode、WinAnsi/Differences、CID）、命中字形移除 + 字寬補位、Form XObject、Watermark Artifact、座標 → 預覽高亮 | ⬜ |
| M6 | Logo | PDF 圖片 XObject 定位與跨頁重複偵測、Office 頁首/母片圖片、上傳樣本感知雜湊比對、刪除並清理 | ⬜ |
| M7 | 預覽強化 | PDF 高亮 + 處理前/後對照；docx/xlsx/pptx 視覺化預覽 | ⬜ |
| M8 | 信任與批次 | 輸出驗證（殘留 0）、稽核報告 JSON/CSV、多檔 ZIP、設定匯出/匯入 | ⬜ |
| M9 | 強化與發佈 | Playwright E2E（含「零網路請求」）、Web Worker、加密/舊格式/損毀檔訊息、中英切換、`release/EraserPanda.html` | ⬜ |

每個里程碑的細項與完成紀錄寫在下方「進度日誌」。

## 3. 進度日誌

### M0 專案骨架
- [x] `docs/REQUIREMENTS.md`、`docs/PLAN.md`、`AGENTS.md`
- [x] Vite + TS + Preact + 單檔打包（`dist/index.html` ≈ 28 KB）+ CSP `connect-src 'none'`
- [x] 拖曳區（整個視窗皆可放）/ 選檔；格式偵測以 magic bytes 為準（含舊格式、加密檔的人話錯誤訊息）
- [x] Vitest（happy-dom）+ `e2e/smoke.cjs`（file:// 開啟、零網路請求、零 console error）+ GitHub Actions CI
