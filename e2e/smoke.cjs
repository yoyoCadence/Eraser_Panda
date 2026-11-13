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
  if (shots) await page.screenshot({ path: path.join(shots, '2-findings.png'), fullPage: true });

  // ---- mark one exception (the header label), then clean ----
  const headerRow = page.locator('[data-group="hf"] li', { hasText: '頁首 1' }).first();
  await headerRow.locator('input[type=checkbox]').uncheck();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('clean-one').click()]);
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
  check('verification reports 0 residual', /驗證殘留\s*0/.test(resultText), resultText);
  if (shots) await page.screenshot({ path: path.join(shots, '3-cleaned.png'), fullPage: true });

  // ---- custom keyword triggers a re-scan ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('custom-words').fill('Apollo');
  await page.getByTestId('settings-save').click();
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample.pptx'));
  await page.locator('.filelist li', { hasText: 'sample.pptx' }).locator('.file-btn').click();
  await page.getByTestId('findings-panel').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid=findings-panel]')?.textContent?.includes('Apollo'));
  check('custom keyword found', (await page.getByTestId('findings-panel').innerText()).includes('Apollo'));

  // ---- batch: ZIP of every cleanable file ----
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('clean-all').click()]);
  const zip = unzipSync(new Uint8Array(fs.readFileSync(await zipDl.path())));
  check('ZIP contains both cleaned files', Object.keys(zip).sort().join(',') === 'sample_clean.docx,sample_clean.pptx', Object.keys(zip).join(','));

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
