/* End-to-end test against the built single-file HTML, opened via file:// exactly like an end user would.
 * Run: npm run build && npm run e2e        (SCREENSHOTS=dir to save screenshots)
 * Requires the `playwright` package (pre-installed in the dev container; CI installs it). */
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const html = path.join(root, 'dist', 'index.html');
const fixtures = path.join(root, 'tests', 'fixtures');
const shots = process.env.SCREENSHOTS;
if (!fs.existsSync(html)) {
  console.error('dist/index.html missing — run `npm run build` first');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')) requests.push(u);
  });

  await page.goto('file://' + html);
  await page.getByTestId('dropzone').waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, '1-landing.png') });

  // ---- folder picker: supported files only; lock / hidden / unsupported files are skipped with a notice ----
  const folder = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ep-folder-'));
  fs.copyFileSync(path.join(fixtures, 'sample.xlsx'), path.join(folder, 'budget.xlsx'));
  fs.writeFileSync(path.join(folder, '~$budget.xlsx'), 'lock');
  fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
  fs.copyFileSync(path.join(fixtures, 'logo.png'), path.join(folder, 'logo.png'));
  await page.getByTestId('folder-input').setInputFiles(folder);
  await page.locator('.filelist li', { hasText: 'budget.xlsx' }).waitFor();
  check('folder: supported file added', (await page.locator('.filelist li').count()) === 1);
  check('folder: skipped files reported', (await page.getByTestId('notice').innerText()).includes('3 個檔案未加入'));
  await page.locator('.filelist li', { hasText: 'budget.xlsx' }).locator('.file-x').click();

  // ---- legacy format gets an actionable message ----
  await page.getByTestId('file-input').setInputFiles([
    { name: 'old.doc', mimeType: 'application/msword', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  ]);
  await page.getByTestId('doc-error').waitFor();
  check('legacy .doc explains how to fix', (await page.getByTestId('doc-error').innerText()).includes('另存新檔'));

  // ---- real Word document: scan → findings ----
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample.docx'));
  await page.locator('.filelist li', { hasText: 'sample.docx' }).locator('.file-btn').click();
  await page.getByTestId('findings-panel').waitFor();
  const panelText = await page.getByTestId('findings-panel').innerText();
  check('lists header label', panelText.includes('頁首 1'));
  check('lists Purview label metadata', panelText.includes('敏感度標籤「Confidential」'));
  check('lists watermark', panelText.includes('浮水印'));
  check('lists header logo with thumbnail', panelText.includes('可能是 Logo') && (await page.locator('[data-group="logo"] img.thumb').count()) > 0);
  check('structured preview shows the header block', (await page.getByTestId('text-preview').innerText()).includes('頁首 1'));
  await page.locator('[data-group="hf"] li', { hasText: '頁尾 1' }).first().locator('button.locate').click();
  await page.waitForTimeout(300);
  check('locate flashes the hit in the text preview', (await page.locator('[data-testid=text-preview] mark.flash').count()) === 1);
  if (shots) await page.screenshot({ path: path.join(shots, '2-findings.png'), fullPage: true });

  // ---- mark one exception (the header label), then clean ----
  const headerRow = page.locator('[data-group="hf"] li', { hasText: '頁首 1' }).first();
  await headerRow.locator('input[type=checkbox]').uncheck();
  await page.getByTestId('clean-one').click();
  await page.getByTestId('confirm-dialog').waitFor();
  check('first clean asks for confirmation', await page.getByTestId('confirm-dialog').isVisible());
  await page.getByTestId('confirm-dialog').locator('input[type=checkbox]').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('confirm-ok').click()]);
  check('download is named *_clean.docx', download.suggestedFilename() === 'sample_clean.docx', download.suggestedFilename());
  const out = fs.readFileSync(await download.path());
  const parts = unzipSync(new Uint8Array(out));
  const all = Object.entries(parts)
    .filter(([k]) => k.endsWith('.xml'))
    .map(([, v]) => strFromU8(v))
    .join('\n');
  check('watermark removed', !all.includes('PowerPlusWaterMarkObject'));
  check('MSIP labels removed', !all.includes('MSIP_Label'));
  check('exception kept (header label)', strFromU8(parts['word/header1.xml']).includes('Confi'));
  check('body label removed', !strFromU8(parts['word/document.xml']).includes('STRICTLY'));
  await page.getByTestId('clean-result').waitFor();
  const resultText = await page.getByTestId('clean-result').innerText();
  check('verification reports 0 residual', /重新掃描殘留\s*0/.test(resultText), resultText);
  check('raw residual shown (exception kept → expected)', /原始位元組殘留\s*\d/.test(resultText), resultText);
  const [reportDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-csv').click()]);
  const csv = fs.readFileSync(await reportDl.path(), 'utf8');
  check('audit report lists removed + kept items without document content', csv.includes('已移除') && csv.includes('保留（例外）') && !csv.includes('information about the plan'), csv.slice(0, 200));
  if (shots) await page.screenshot({ path: path.join(shots, '3-cleaned.png'), fullPage: true });

  // ---- custom keyword + logo sample trigger a re-scan ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('logo-input').setInputFiles(path.join(fixtures, 'photo.png'));
  await page.locator('.logo-chip').first().waitFor();
  await page.getByTestId('custom-words').fill('Apollo');
  await page.getByTestId('settings-save').click();
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample.pptx'));
  await page.locator('.filelist li', { hasText: 'sample.pptx' }).locator('.file-btn').click();
  await page.getByTestId('findings-panel').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid=findings-panel]')?.textContent?.includes('Apollo'));
  check('custom keyword found', (await page.getByTestId('findings-panel').innerText()).includes('Apollo'));
  await page.locator('.filelist li', { hasText: 'sample.docx' }).locator('.file-btn').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=findings-panel]')?.textContent?.includes('Logo（符合樣本）'), null, { timeout: 15000 });
  check('logo sample matches an ordinary picture', true);
  const stillKept = await page.locator('[data-group="hf"] li', { hasText: '頁首 1' }).first().locator('input[type=checkbox]').isChecked();
  check('exception survives the re-scan after a settings change', stillKept === false);
  if (shots) await page.screenshot({ path: path.join(shots, '6-logo.png'), fullPage: false });

  // ---- batch: ZIP of every cleanable file ----
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('clean-all').click()]);
  const zip = unzipSync(new Uint8Array(fs.readFileSync(await zipDl.path())));
  check('ZIP contains both cleaned files', Object.keys(zip).sort().join(',') === 'sample_clean.docx,sample_clean.pptx', Object.keys(zip).join(','));

  // ---- PDF: metadata/annotation findings, rendered preview, locate, clean ----
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'office.pdf'));
  await page.locator('.filelist li', { hasText: 'office.pdf' }).locator('.file-btn').click();
  await page.getByTestId('findings-panel').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid=findings-panel]')?.textContent?.includes('圖章'));
  const canvas = page.locator('[data-testid=pdf-preview] canvas').first();
  await canvas.waitFor({ timeout: 15000 });
  const painted = await canvas.evaluate((c) => {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return dark;
  });
  check('PDF page renders under file:// + CSP', painted > 100, `dark pixels ${painted}`);
  await page.locator('[data-finding-id="p1#annot:0"] button.locate').click();
  await page.waitForTimeout(300);
  check('locate highlights the stamp', await page.locator('.hl.flash').count() > 0);
  if (shots) await page.screenshot({ path: path.join(shots, '5-pdf.png') });
  const [pdfDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('clean-one').click()]);
  const pdfOut = fs.readFileSync(await pdfDl.path()).toString('latin1');
  check('PDF download named *_clean.pdf', pdfDl.suggestedFilename() === 'office_clean.pdf', pdfDl.suggestedFilename());
  check('PDF MSIP / stamp removed', !/MSIP_Label|\/Stamp/.test(pdfOut));
  await page.getByTestId('view-clean').click();
  await page.locator('[data-testid=pdf-preview] canvas').first().waitFor({ timeout: 15000 });
  check('cleaned PDF previews', true);

  // ---- mobile layout has no horizontal scroll ----
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll at phone width', overflow <= 0, `overflow ${overflow}px`);
  if (shots) await page.screenshot({ path: path.join(shots, '4-mobile.png'), fullPage: true });

  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no network requests', requests.length === 0, requests.join(' | '));
  await browser.close();

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ''}`);
    if (!r.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
