# AGENTS.md — 接手指南（給任何 agent / 開發者）

## 先讀
1. `docs/REQUIREMENTS.md` — 需求（U = 使用者明說，I = 為達目的補上的）
2. `docs/PLAN.md` — 架構、里程碑、**進度日誌**（從第一個未勾選的項目繼續）

## 工作流程（使用者要求）
- 每完成一個段落（通常 = 一個里程碑或其子項）→ 開 PR → 確認 CI/本機檢查通過 → **merge 進 `main`** → 繼續下一段。
- 不需要每步問使用者；只有真正需要使用者決定的事才問。
- 每個 PR 都要更新 `docs/PLAN.md` 的進度日誌，讓下一個接手者知道停在哪。

## 指令
```bash
npm ci                 # 安裝
npm run dev            # 開發伺服器
npm run check          # typecheck + 單元測試 + 打包（PR 前必跑）
npm run build          # 產出 dist/index.html（單一 HTML，可直接用 file:// 開）
npm run e2e            # 對 dist/index.html 跑 Playwright 冒煙測試（需先 build）
npm run fixtures       # 重新產生 tests/fixtures/ 下的樣本文件（需 python3 + LibreOffice + PIL）
npm run release        # 產出 release/EraserPanda.html（使用者下載的檔案；發版時一併提交）
```

## 不可違反的原則
1. **文件絕不離開使用者電腦**：不得加入任何網路請求、CDN、遙測。`index.html` 的 CSP 有 `connect-src 'none'`，E2E 會檢查零網路請求。
2. **原檔唯讀**，輸出永遠是新的 bytes。
3. **真刪除**：PDF 不能用框蓋住了事；Office 不能留下孤兒 part / media。
4. **未修改的部分保留原始 bytes**（OOXML 只重寫有變動的 part）。
5. 只用寬鬆授權（MIT / Apache-2.0 / BSD）套件。不要引入 MuPDF（AGPL）。
6. Finding id 必須穩定（同輸入 + 同規則 → 同 id），因為 `apply()` 依 id 重新掃描後刪除。
7. **Excel 工作表不可整份 `pkg.xml()`**（可能數百萬儲存格）—— 一律用 `pkg.fragment()` / `pkg.removeText()`。
8. 報告（audit report）不得包含文件的上下文內容，只能有標籤字眼與位置。

## 程式碼地圖
```
src/core/        與格式無關：型別、檔案類型偵測、規則、正規化、比對、跨片段映射、候選刪除模型、預覽、影像雜湊、報告
src/formats/     各格式 handler（實作 FormatHandler：scan / apply）—— ooxml/、pdf/（content/ 為內容串流引擎）、text/
src/verify/      原始位元組驗證器
src/ui/          Preact 介面
tests/           Vitest 單元測試（happy-dom 環境）；tests/fixtures 樣本文件
e2e/             Playwright 腳本（對 build 後的單檔 HTML）
scripts/         樣本產生器等工具腳本
```

## 慣例
- 使用者介面文字：繁體中文。程式碼與註解：英文。
- Commit / PR 描述：說明「為什麼」，並附上驗證方式。
