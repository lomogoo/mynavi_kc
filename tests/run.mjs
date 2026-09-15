/**
 * ブラウザ結合テスト（Playwright）
 *
 *   npm install
 *   npm test
 *
 * tests/mock-supabase.mjs を空きポートで起動し、config.js を
 * そのモックに差し替えた状態で index.html を操作します。
 * 本番の Supabase には接続しません。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startMock() {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(HERE, 'mock-supabase.mjs'), String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('モックサーバーが起動しませんでした')), 8000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('mock on')) { clearTimeout(timer); resolve(); }
    });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

const step = async (name, fn) => {
  try { await fn(); console.log('  \u2713 ' + name); }
  catch (e) { failures += 1; console.log('  \u2717 ' + name + ' -> ' + e.message.split('\n')[0]); }
};

const DOC_URL = 'https://docs.google.com/presentation/d/TEST_DECK/edit';

function stubConfig(page, base, extra = `guidelinesUrl:'${DOC_URL}',`) {
  return page.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.KC_CONFIG={supabaseUrl:'${base}',supabaseKey:'test-key',${extra}};`,
  }));
}

async function runAppTests(base) {
  console.log('\n[1/2] 出店調整ボードの操作');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await stubConfig(p, base);

  await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.card', { timeout: 15000 });

  await step('7日程が表示される', async () => {
    const n = await p.locator('.card').count();
    if (n !== 7) throw new Error(`cards=${n}`);
  });
  await step('10/18・10/24 の目標は 4〜5台', async () => {
    for (const [i, label] of [[3, '10/18'], [4, '10/24']]) {
      const card = p.locator('.card').nth(i);
      if (!(await card.innerText()).includes(label)) throw new Error(`${i}枚目が${label}でない`);
      const t = await card.locator('.count').innerText();
      if (t !== '0 / 4〜5台') throw new Error(`${label}: ${t}`);
      if ((await card.locator('.dots i').count()) !== 5) throw new Error(`${label}: ドット数が5でない`);
    }
  });
  await step('ヘッダーに目標台数の合計が出る', async () => {
    const t = await p.locator('#brand-sub').innerText();
    if (t !== '全7日程 / 目標 計18〜25台') throw new Error(t);
  });
  await step('サマリーの集計', async () => {
    const t = (await p.locator('#summary').innerText()).replace(/\n/g, ' ');
    if (!/出店決定 1台/.test(t) || !/声かけ中 1台/.test(t)) throw new Error(t);
  });
  await step('9/19 のカウンタ表示', async () => {
    const t = await p.locator('.card').first().locator('.count').innerText();
    if (t !== '1 / 2〜3台') throw new Error(t);
  });
  await step('見送りを隠せる', async () => {
    await p.locator('#chk-declined').uncheck();
    if (await p.getByText('別現場と重複').count()) throw new Error('見送りが残っている');
    await p.locator('#chk-declined').check();
    if (!(await p.getByText('別現場と重複').count())) throw new Error('見送りが戻らない');
  });

  // 追加
  await step('キッチンカーを追加できる', async () => {
    const card = p.locator('.card').first();
    await card.locator('[data-act="open-add"]').click();
    const form = card.locator('form[data-fkey^="add:"]');
    await form.locator('[name="vendor_name"]').fill('Novel café');
    await form.locator('[name="genre"]').fill('コーヒー');
    await form.locator('[name="contact"]').fill('佐藤 080-3333-4444');
    await form.locator('label.p-confirmed').click();
    await form.locator('[name="note"]').fill('電源要');
    await form.locator('button[type="submit"]').click();
    await p.waitForTimeout(600);
    if (!(await card.getByText('Novel café').count())) throw new Error('追加されない');
    if ((await card.locator('.count').innerText()) !== '2 / 2〜3台') throw new Error('カウント不整合: ' + await card.locator('.count').innerText());
    if ((await form.locator('[name="vendor_name"]').inputValue()) !== '') throw new Error('フォームが初期化されない');
  });
  await step('目標クリアで枠線色が変わる', async () => {
    const cls = await p.locator('.card').first().getAttribute('class');
    if (!cls.includes('is-filled')) throw new Error(cls);
  });
  await step('ステータスをワンタップ変更できる', async () => {
    const card = p.locator('.card').first();
    const entry = card.locator('.entry', { hasText: 'FoodieGent' });
    await entry.locator('[data-status="confirmed"]').click();
    await p.waitForTimeout(500);
    if ((await card.locator('.count').innerText()) !== '3 / 2〜3台') throw new Error(await card.locator('.count').innerText());
  });
  await step('編集して保存できる', async () => {
    const card = p.locator('.card').first();
    await card.locator('.entry', { hasText: 'FoodieGent' }).locator('[data-act="open-edit"]').click();
    const form = card.locator('form.form-edit');
    await form.locator('[name="note"]').fill('条件OK / 11時搬入');
    await form.locator('button[type="submit"]').click();
    await p.waitForTimeout(500);
    if (!(await card.getByText('条件OK / 11時搬入').count())) throw new Error('メモが反映されない');
  });
  await step('同名から連絡先をオートフィル', async () => {
    const card = p.locator('.card').nth(1);
    await card.locator('[data-act="open-add"]').click();
    const form = card.locator('form[data-fkey^="add:"]');
    await form.locator('[name="vendor_name"]').fill('Novel café');
    await form.locator('[name="vendor_name"]').blur();
    await p.waitForTimeout(300);
    const c = await form.locator('[name="contact"]').inputValue();
    if (!c.includes('佐藤')) throw new Error('contact=' + c);
    await form.locator('button[type="submit"]').click();
    await p.waitForTimeout(500);
    if (!(await card.getByText('Novel café').count())) throw new Error('2枚目に追加できない');
  });
  await step('目標台数を変更できる', async () => {
    const card = p.locator('.card').nth(2);
    await card.locator('[name="target_max"]').fill('4');
    await card.locator('[name="target_max"]').blur();
    await p.waitForTimeout(500);
    if (!(await card.locator('.count').innerText()).includes('〜4台')) throw new Error(await card.locator('.count').innerText());
  });
  await step('日程メモを保存できる', async () => {
    const card = p.locator('.card').nth(2);
    await card.locator('[name="note"]').fill('搬入 9:30 / 電源2口');
    await card.locator('[name="note"]').blur();
    await p.waitForTimeout(500);
    const v = await p.evaluate(async (base) => (await (await fetch(base + '/rest/v1/kc_events?select=*&id=eq.3')).json())[0].note, base);
    if (v !== '搬入 9:30 / 電源2口') throw new Error('DB未保存: ' + v);
  });
  await step('日程を追加できる', async () => {
    await p.locator('#btn-add-date').click();
    await p.locator('#new-date').fill('2026-12-05');
    await p.locator('form[data-fkey="add-date"] button[type="submit"]').click();
    await p.waitForTimeout(600);
    if ((await p.locator('.card').count()) !== 8) throw new Error('cards=' + await p.locator('.card').count());
    if (!(await p.locator('.card').last().innerText()).includes('12/5')) throw new Error('末尾が12/5でない');
  });
  await step('エントリを削除できる', async () => {
    p.once('dialog', d => d.accept());
    const card = p.locator('.card').nth(1);
    await card.locator('.entry', { hasText: 'Novel café' }).locator('[data-act="del-entry"]').click();
    await p.waitForTimeout(600);
    if (await card.getByText('Novel café').count()) throw new Error('削除されない');
  });
  await step('日程を削除できる', async () => {
    p.once('dialog', d => d.accept());
    await p.locator('.card').last().locator('[data-act="del-event"]').click();
    await p.waitForTimeout(600);
    if ((await p.locator('.card').count()) !== 7) throw new Error('cards=' + await p.locator('.card').count());
  });
  await step('担当者名が記録される', async () => {
    p.once('dialog', d => d.accept('吉田'));
    await p.locator('#btn-me').click();
    await p.waitForTimeout(300);
    if (!(await p.locator('#btn-me').innerText()).includes('吉田')) throw new Error(await p.locator('#btn-me').innerText());
    const card = p.locator('.card').first();
    await card.locator('.entry', { hasText: 'つむKITCHEN' }).locator('[data-status="pending"]').click();
    await p.waitForTimeout(500);
    if (!(await card.locator('.entry', { hasText: 'つむKITCHEN' }).innerText()).includes('吉田')) throw new Error('更新者が出ない');
    await card.locator('.entry', { hasText: 'つむKITCHEN' }).locator('[data-status="confirmed"]').click();
    await p.waitForTimeout(400);
  });
  await step('CSVを書き出せる', async () => {
    const dl = p.waitForEvent('download', { timeout: 8000 });
    await p.locator('#btn-csv').click();
    const d = await dl;
    const fsx = await import('node:fs');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), 'kc-export-test.csv');
    await d.saveAs(tmp);
    const csv = fsx.readFileSync(tmp, 'utf8');
    if (!csv.includes('キッチンカー名') || !csv.includes('Novel café')) throw new Error('中身が不正');
    console.log('   csv 1行目:', csv.split('\r\n')[1]);
  });
  await step('Realtime不可でも定期更新に落ちる', async () => {
    await p.waitForTimeout(1500);
    const s = await p.locator('#sync').getAttribute('data-state');
    if (s !== 'polling' && s !== 'live') throw new Error('sync=' + s);
  });

  await step('出店要項ボタンが要項URLへ遷移する', async () => {
    const link = p.locator('#link-guidelines');
    if (!(await link.isVisible())) throw new Error('ボタンが表示されない');
    if ((await link.getAttribute('href')) !== DOC_URL) throw new Error('href=' + await link.getAttribute('href'));
    if ((await link.getAttribute('target')) !== '_blank') throw new Error('新しいタブで開かない');
    if (!(await link.getAttribute('rel')).includes('noopener')) throw new Error('rel が不足');
  });

  await step('JS エラーが出ていない', async () => {
    const real = logs.filter((l) => !/WebSocket|realtime/i.test(l));
    if (real.length) throw new Error(real.join(' | '));
  });

  await b.close();
}

async function runSetupTests(base) {
  console.log('\n[2/2] テーブル未作成時の案内');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 900 } });
  await stubConfig(p, base);
  // 実際の Supabase が返す「テーブルが無い」エラーを再現する
  await p.route('**/rest/v1/kc_**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({
      code: 'PGRST205',
      message: "Could not find the table 'public.kc_events' in the schema cache",
    }),
  }));
  await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#sql-box', { timeout: 15000 });
  await p.waitForTimeout(800);

  await step('セットアップ案内が出る', async () => {
    const t = await p.locator('#notice-host').innerText();
    if (!/テーブルを作成/.test(t)) throw new Error(t.slice(0, 80));
  });
  await step('schema.sql が読み込まれる', async () => {
    const sql = await p.locator('#sql-box').innerText();
    if (!sql.includes('create table if not exists public.kc_entries')) throw new Error('SQL が表示されない');
  });
  await step('ボードとツールバーは隠れる', async () => {
    if (await p.locator('.card').count()) throw new Error('カードが表示されている');
    if (await p.locator('#toolbar').isVisible()) throw new Error('ツールバーが表示されている');
  });
  await step('テーブル未作成でも出店要項は開ける', async () => {
    if (!(await p.locator('#link-guidelines').isVisible())) throw new Error('ボタンが表示されない');
  });

  // guidelinesUrl 未設定ならボタンを出さない
  const p2 = await b.newPage({ viewport: { width: 900, height: 600 } });
  await stubConfig(p2, base, '');
  await p2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.card', { timeout: 15000 });
  await step('要項URL未設定ならボタンを隠す', async () => {
    if (await p2.locator('#link-guidelines').isVisible()) throw new Error('ボタンが残っている');
  });

  await b.close();
}

const { proc, base } = await startMock();
try {
  await runAppTests(base);
  await runSetupTests(base);
} finally {
  proc.kill();
}

console.log(failures ? `\n${failures} 件失敗しました` : '\nすべて成功しました');
process.exit(failures ? 1 : 0);
