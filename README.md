# Eraser Panda 🐼

**單一 HTML、100% 本機執行** 的文件去識別化小工具：找出並移除 PDF / Word / Excel / PowerPoint 中的
分級標籤字眼（Confidential、Sensitive、Secret、機密…）、公司 Logo、敏感度標籤 metadata（如 `MSIP_Label_*`），
讓「已確認可以外傳」的文件不再觸發 DLP / 上傳閘道誤報。原檔不動，輸出 `原檔名_clean.副檔名`。

> ⚠️ 本工具 **不會** 判斷文件能不能外流 —— 那是使用者的責任。請在取得授權的前提下使用。詳見 [需求與風險](docs/REQUIREMENTS.md#3-風險與盲點請正視)。

## 使用方式
1. 下載 `EraserPanda.html`（或自行 `npm run build` 取得 `dist/index.html`），用 Chrome / Edge 直接開啟（不需安裝、不需網路）。
2. 把文件拖進視窗。
3. 檢視發現清單與預覽位置，取消勾選要保留的例外。
4. 按「一鍵清除」，下載 `*_clean.*`。

## 文件
- [需求規格](docs/REQUIREMENTS.md)
- [實作計畫與進度](docs/PLAN.md)
- [接手指南（agent / 開發者）](AGENTS.md)

## 開發
```bash
npm ci
npm run dev      # 開發
npm run check    # typecheck + 測試 + 打包
```
