/* End-to-end smoke test against the built single-file HTML, opened via file:// exactly like an end user would.
 * Run: npm run build && node e2e/smoke.cjs
 * Requires the `playwright` package (pre-installed in the dev container; CI installs it). */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const html = path.resolve(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(html)) {
  console.error('dist/index.html missing — run `npm run build` first');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
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

  // Simulate the file picker with a tiny text file and an unsupported file.
  await page.getByTestId('file-input').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('This is CONFIDENTIAL') },
    { name: 'old.doc', mimeType: 'application/msword', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  ]);
  await page.getByTestId('file-list').waitFor();
  const text = await page.getByTestId('file-list').innerText();
  const checks = [
    ['lists the text file', text.includes('notes.txt')],
    ['explains legacy .doc', text.includes('另存新檔')],
    ['no console errors', errors.length === 0],
    ['no network requests', requests.length === 0],
  ];
  await browser.close();
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  if (errors.length) console.log('errors:', errors);
  if (requests.length) console.log('requests:', requests);
  process.exit(failed ? 1 : 0);
})();
