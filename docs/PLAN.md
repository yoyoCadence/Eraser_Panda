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
| M1 | 比對核心 | 預設關鍵字庫、正規化、整字/regex、跨片段映射、穩定 ID | ✅ |
| M2 | OOXML 引擎 | docx/xlsx/pptx 全 part 文字掃描與刪除（含頁首頁尾、浮水印、文字方塊、註解、母片、圖表、Excel 頁首頁尾代碼與公式）；core/app/custom props、MSIP、LabelInfo、customXml；rels/Content_Types 清理 | ✅ |
| M3 | UI v1（Office 可用） | 檔案清單、發現清單（依類型/位置分組、勾選例外、一鍵全刪、只取消內文）、文字片段預覽、下載 `_clean` 檔 | ✅ |
| M4 | PDF 基礎 | pdf-lib 載入、Info/XMP/MSIP 移除、圖章/註解/書籤/表單、孤兒物件 GC、pdf.js 頁面預覽 | ✅ |
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

### M1 比對核心
- [x] `core/normalize.ts`：逐 code point NFKC + 大小寫摺疊 + 空白折疊 + 去除零寬字元，保留正規化 → 原始索引對照
- [x] `core/rules.ts`：預設字庫（英 / 繁 / 簡 / 日 / 韓），刻意排除 Internal、Private、General、Public、單字「密」等高誤判字；`userRule()` 自訂規則；穩定 rule id
- [x] `core/matcher.ts`：字面規則 → regex（片語內空白可有可無、CJK 字距空白容忍、整字邊界不含 CJK）；使用者 regex；重疊命中取聯集（最長規則命名）
- [x] `core/segments.ts`：跨片段比對（Word run / PDF 繪字指令）→ 每片段刪除區間；virtual 片段（推測空白）不參與刪除；上下文片段；`wholeUnit`（整段只有標籤 → 高信心）
- 已知取捨：英文整字比對下 `time-sensitive` 會命中 `sensitive`（連字號是邊界），交給使用者例外處理

### M2 OOXML 引擎（`src/formats/ooxml/`）
- [x] `package.ts`：fflate 解壓、延遲解析、**只重寫 dirty part**（其餘 bytes 原封不動，有測試）、rels 解析、`removePart()` 同步清 rels + Content_Types、固定 zip 時間戳（可重現輸出）
- [x] `units.ts`：TextUnit（一段可比對文字 + 各片段在 XML 的位置）→ Candidate（Finding + 刪除動作）；同一單元的多個刪除一次套用
- [x] `docx.ts`：內文 / 頁首 / 頁尾 / 註腳 / 章節附註 / 註解 / 建置組塊；跨 run 比對；文字方塊；追蹤修訂刪除文字（`w:delText`）；VML WordArt 浮水印（整個物件移除）；**欄位結果被改動時自動 unlink**（避免 DOCPROPERTY 重新帶回標籤或顯示錯誤）
- [x] `xlsx.ts`：共用字串（標示 Sheet!A1 位置）、inline 字串、**公式只動字串常值**（不碰 `'Sheet'!A1` 參照）、公式快取結果、頁首頁尾代碼解析（`&L &C &R &"字型" &12 &K &&`）、註解、討論串註解、繪圖文字、圖表、樞紐快取；工作表名稱 **只回報不改名**
- [x] `pptx.ts`：投影片 / 母片 / 版面配置 / 備忘稿 / 頁尾 placeholder / SmartArt / 註解 / 圖表
- [x] `drawingml.ts`：通用 a:p 段落、圖表標題與 strCache 快取字串
- [x] `metadata.ts`：core（標題/主旨/關鍵字/描述/類別/狀態）、**身分資訊**（作者/上次修改者/公司/管理者）、app.xml 其他文字、custom.xml（MSIP_Label_* 依 GUID 合併為一項、分級名稱屬性、命中字眼的屬性；無關屬性保留）、`docMetadata/LabelInfo.xml`、customXml（SharePoint 分級欄位）、**文件縮圖 thumbnail.jpeg**（第一頁截圖會留下標籤與 Logo）
- [x] `handler.ts`：**內嵌 Office 檔遞迴處理**（例如 PPT 圖表內嵌的 xlsx）；巨集 / OLE 內嵌物件 / Strict OOXML 警告
- [x] `core/segments.ts` 加入 `tidyRange()`：刪除後整理空白、分隔符號、括號、中文標點（`Restricted | Internal Use Only | Page 1` → `Page 1`）
- [x] 樣本產生器 `scripts/make_fixtures.py`（`npm run fixtures`）+ 測試：穩定 ID、清理後殘留 0、未選取時 bytes 完全相同、例外保留、python-docx/openpyxl/python-pptx 可開啟；另以 LibreOffice 轉 PDF 人工確認可開且標籤消失
- 已知缺口（之後處理）：Excel 工作表層級 customPr（二進位）、Word 欄位代碼 `instrText` 內的字串、註解作者 / people.xml 身分資訊、MIP 內容標記圖形（MSIPCMContentMarking）目前只刪文字不刪圖形、超大 xlsx 的 DOM 記憶體用量

### M3 UI v1（Office + 純文字可用）
- [x] 首頁：拖曳區 + 四步驟說明 + 責任聲明；工作區：左側檔案清單（狀態 / 發現數 / 移除）、右側發現面板
- [x] 發現依位置分組（敏感度標籤 / 浮水印 / 頁首頁尾母片 / 內文 / 其他 / 文件屬性 / 僅提示），群組三態勾選、上下文高亮、位置、信心度與說明標籤
- [x] 一鍵清除並下載 `*_clean.*`；全選 / 全不選 / **保留內文語句**；篩選；例外以刪除線虛框顯示
- [x] 清除後自動重新掃描輸出檔 →「驗證殘留 N」（M8 會再加原始 bytes 層級的驗證）
- [x] 多檔「全部清除並下載 ZIP」
- [x] 關鍵字設定：內建字庫依語言開關、個別停用、自訂字眼（公司名 / 專案代號）、自訂 regex（即時驗證）；存 localStorage（失敗時退回預設）；變更後自動重新掃描
- [x] 純文字 handler（txt / csv / md）：逐行比對、保留換行與 BOM；Big5 / GB18030 / Shift_JIS 解碼（輸出改 UTF-8 BOM 並提示）
- [x] E2E（file://）：舊格式訊息、docx 發現、例外保留、下載內容驗證、殘留 0、自訂字眼、ZIP、手機寬度無水平捲動、零網路、零 console error
- 暫時：PDF 顯示「開發中」（M4/M5 實作）

### M4 PDF 基礎（`src/formats/pdf/`）
- [x] `core/candidates.ts`：TextUnit / Candidate 模型自 OOXML 抽出為通用模組，PDF 共用
- [x] `pdfdoc.ts`：pdf-lib 載入（加密檔給出可行動的錯誤訊息）、字串編解碼、**GC：刪除所有自 trailer 不可達的物件**（增量更新舊版本、孤兒物件、舊 object stream）、旋轉感知的座標正規化
- [x] `metadata.ts`：Info 字典（標題等文字切除、作者 / Company 身分資訊、`MSIP_Label_*` 依 GUID 合併、分級名稱鍵）、XMP（含標籤 / 字眼 / 作者 → 整段移除）、PieceInfo
- [x] `structure.ts`：註解（標準分級圖章 `/Confidential` `/TopSecret`…、內容命中字眼的任何註解連同 Popup；附件註解）、書籤標題、文件附件（name tree）
- [x] `render.ts` + `ui/PdfPreview.tsx`：pdf.js worker 以 blob: 內嵌（file:// + CSP 下可用，E2E 驗證實際有畫出像素）；延遲渲染、高亮框、📍定位閃爍、點高亮框反查清單、原始 / 清除後切換
- [x] `verify/raw.ts`：原始位元組驗證器（PDF 每個串流依 `/Filter` 鏈解碼 Flate / ASCII85 / ASCIIHex；zip 逐 part 含巢狀；XML 實體與 PDF hex / UTF-16 字串展開）——測試證明增量更新殘留的 `CONFIDENTIAL` 在清理後消失
- [x] 樣本 `scripts/make_pdf_fixtures.py`：office.pdf（LibreOffice 匯出 + MSIP / XMP / 圖章 / 書籤 / 附件）、incremental.pdf、reportlab.pdf（標準字型、斜向浮水印、逐字繪製、CJK CID 字型、重複 Logo）
- 暫時：掃描結果附警示「頁面上直接繪製的文字將在下一版支援」（M5 完成後移除 `handler.ts` 的 TODO）
- 已知限制：加密 PDF（含僅有權限密碼者）目前直接拒絕 → M9 評估實作標準安全處理常式解密
