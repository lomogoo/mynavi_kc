/* ============================================================
   キッチンカー出店調整アプリ
   Supabase（kc_events / kc_entries）と同期する 1 ページアプリ
   ============================================================ */
// 出店要項リンク（Supabase の状態に関係なく常に使えるよう先に設定する）
(() => {
  const link = document.getElementById('link-guidelines');
  const url = window.KC_CONFIG?.guidelinesUrl;
  if (!link || !url) return;
  link.href = url;
  link.hidden = false;
})();

// supabase-js は assets/vendor に同梱（CDN 依存なしで動きます）
if (!window.supabase?.createClient) {
  document.getElementById('notice-host').innerHTML =
    '<div class="notice is-error"><h2>読み込みに失敗しました</h2>'
    + '<p>assets/vendor/supabase-js-2.116.0.umd.js を読み込めませんでした。'
    + 'ファイルが揃っているか確認してください。</p></div>';
  throw new Error('supabase-js が読み込まれていません');
}
const { createClient } = window.supabase;

const CFG = window.KC_CONFIG || {};
const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

/* ---------- 定数 ---------- */
const STATUSES = ['confirmed', 'pending', 'declined'];
const STATUS_META = {
  confirmed: { label: '出店決定', short: '決定', group: '出店決定', order: 0 },
  pending:   { label: '声かけ中', short: '打診', group: '声かけ中', order: 1 },
  declined:  { label: '見送り',   short: '見送', group: '見送り・NG', order: 2 },
};
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const POLL_MS = 20000;
const LS_ME = 'kc.me';
const LS_DECLINED = 'kc.showDeclined';

/* ---------- 状態 ---------- */
const state = {
  events: [],
  entries: [],
  loading: true,
  fatal: null,
  missingTables: false,
  showDeclined: localStorage.getItem(LS_DECLINED) !== '0',
  me: localStorage.getItem(LS_ME) || '',
  addDateOpen: false,
};

/** 開いているフォーム: key -> 初期値オブジェクト */
const forms = new Map();
/** 次の描画で DOM 値の復元をスキップするフォーム key */
const resetKeys = new Set();

/* ---------- DOM ---------- */
const el = {
  board: document.getElementById('board'),
  summary: document.getElementById('summary'),
  toolbar: document.getElementById('toolbar'),
  notice: document.getElementById('notice-host'),
  addDate: document.getElementById('add-date-host'),
  sync: document.getElementById('sync'),
  syncLabel: document.getElementById('sync-label'),
  toasts: document.getElementById('toast-host'),
  vendorList: document.getElementById('vendor-suggest'),
  genreList: document.getElementById('genre-suggest'),
  btnMe: document.getElementById('btn-me'),
  btnCsv: document.getElementById('btn-csv'),
  btnReload: document.getElementById('btn-reload'),
  btnAddDate: document.getElementById('btn-add-date'),
  chkDeclined: document.getElementById('chk-declined'),
};

/* ============================================================
   ユーティリティ
   ============================================================ */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const attr = (v) => esc(v);

function parseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d, dow: new Date(y, m - 1, d).getDay() };
}

function fmtDate(iso) {
  const { m, d, dow } = parseDate(iso);
  return { md: `${m}/${d}`, wd: WEEKDAYS[dow], dow };
}

function fmtWhen(ts) {
  if (!ts) return '';
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getMonth() + 1}/${dt.getDate()} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg, isError = false) {
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' err' : '');
  node.textContent = msg;
  el.toasts.appendChild(node);
  setTimeout(() => node.remove(), isError ? 6000 : 2600);
}

let syncTimer = null;
let syncStable = { state: 'init', label: '接続中…' };
function setSync(stateName, label) {
  if (stateName !== 'saving') syncStable = { state: stateName, label };
  el.sync.dataset.state = stateName;
  el.syncLabel.textContent = label;
}
function flashSync(label) {
  setSync('saving', label);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => setSync(syncStable.state, syncStable.label), 900);
}

function isMissingTable(err) {
  if (!err) return false;
  return err.code === 'PGRST205'
    || err.code === '42P01'
    || /Could not find the table/i.test(err.message || '');
}

/* ============================================================
   データ層
   ============================================================ */
async function loadAll() {
  const [ev, en] = await Promise.all([
    sb.from('kc_events').select('*').order('event_date', { ascending: true }),
    sb.from('kc_entries').select('*'),
  ]);
  const err = ev.error || en.error;
  if (err) {
    if (isMissingTable(err)) {
      state.missingTables = true;
      state.fatal = null;
    } else {
      state.fatal = err.message || String(err);
    }
    state.loading = false;
    render();
    return false;
  }
  state.missingTables = false;
  state.fatal = null;
  state.events = ev.data || [];
  state.entries = en.data || [];
  state.loading = false;
  render();
  return true;
}

function nextPosition(eventId) {
  const list = state.entries.filter((e) => e.event_id === eventId);
  return list.reduce((max, e) => Math.max(max, e.position || 0), 0) + 1;
}

async function createEntry(eventId, values) {
  const row = {
    event_id: eventId,
    vendor_name: values.vendor_name,
    genre: values.genre || null,
    contact: values.contact || null,
    status: STATUSES.includes(values.status) ? values.status : 'pending',
    note: values.note || null,
    position: nextPosition(eventId),
    created_by: state.me || null,
    updated_by: state.me || null,
  };
  flashSync('保存中…');
  const { data, error } = await sb.from('kc_entries').insert(row).select().single();
  if (error) return fail(error, '追加できませんでした');
  upsertEntry(data);
  render();
  toast(`${data.vendor_name} を追加しました`);
  return true;
}

async function patchEntry(id, patch) {
  flashSync('保存中…');
  const { data, error } = await sb
    .from('kc_entries')
    .update({ ...patch, updated_by: state.me || null })
    .eq('id', id)
    .select()
    .single();
  if (error) return fail(error, '更新できませんでした');
  upsertEntry(data);
  render();
  return true;
}

async function removeEntry(id) {
  const target = state.entries.find((e) => e.id === id);
  flashSync('削除中…');
  const { error } = await sb.from('kc_entries').delete().eq('id', id);
  if (error) return fail(error, '削除できませんでした');
  state.entries = state.entries.filter((e) => e.id !== id);
  render();
  toast(`${target?.vendor_name ?? 'エントリ'} を削除しました`);
  return true;
}

async function patchEvent(id, patch) {
  flashSync('保存中…');
  const { data, error } = await sb.from('kc_events').update(patch).eq('id', id).select().single();
  if (error) return fail(error, '日程を更新できませんでした');
  state.events = state.events.map((e) => (e.id === data.id ? data : e));
  render();
  return true;
}

async function createEvent(dateIso) {
  if (state.events.some((e) => e.event_date === dateIso)) {
    toast('その日程はすでに登録されています', true);
    return false;
  }
  flashSync('保存中…');
  const { data, error } = await sb
    .from('kc_events')
    .insert({ event_date: dateIso, target_min: 2, target_max: 3 })
    .select()
    .single();
  if (error) return fail(error, '日程を追加できませんでした');
  state.events = [...state.events, data].sort((a, b) => a.event_date.localeCompare(b.event_date));
  state.addDateOpen = false;
  render();
  const f = fmtDate(data.event_date);
  toast(`${f.md}(${f.wd}) を追加しました`);
  return true;
}

async function removeEvent(id) {
  flashSync('削除中…');
  const { error } = await sb.from('kc_events').delete().eq('id', id);
  if (error) return fail(error, '日程を削除できませんでした');
  state.events = state.events.filter((e) => e.id !== id);
  state.entries = state.entries.filter((e) => e.event_id !== id);
  render();
  toast('日程を削除しました');
  return true;
}

function fail(error, msg) {
  console.error(error);
  if (isMissingTable(error)) {
    state.missingTables = true;
    render();
  }
  toast(`${msg}（${error.message || error.code || '不明なエラー'}）`, true);
  return false;
}

function upsertEntry(row) {
  const i = state.entries.findIndex((e) => e.id === row.id);
  if (i === -1) state.entries = [...state.entries, row];
  else state.entries = state.entries.map((e) => (e.id === row.id ? row : e));
}

/* ============================================================
   描画
   ============================================================ */
function entriesOf(eventId) {
  return state.entries
    .filter((e) => e.event_id === eventId)
    .sort((a, b) => (STATUS_META[a.status]?.order ?? 9) - (STATUS_META[b.status]?.order ?? 9)
      || (a.position || 0) - (b.position || 0)
      || String(a.created_at).localeCompare(String(b.created_at)));
}

function countOf(eventId, status) {
  return state.entries.filter((e) => e.event_id === eventId && e.status === status).length;
}

function snapshotDom() {
  const active = document.activeElement;
  const snap = { forms: {}, focus: null };
  document.querySelectorAll('[data-fkey]').forEach((node) => {
    const key = node.dataset.fkey;
    const hasFocus = node.contains(active);
    // 入力途中のフォームは値を保持する（日程設定は編集中のみ）
    if (!key.startsWith('event:') || hasFocus) {
      const values = {};
      node.querySelectorAll('[name]').forEach((input) => {
        if (input.type === 'radio') {
          if (input.checked) values[input.name] = input.value;
        } else {
          values[input.name] = input.value;
        }
      });
      snap.forms[key] = values;
    }
    if (hasFocus && active && active.name) {
      snap.focus = {
        key,
        name: active.name,
        start: active.selectionStart ?? null,
        end: active.selectionEnd ?? null,
      };
    }
  });
  return snap;
}

function restoreDom(snap) {
  for (const [key, values] of Object.entries(snap.forms)) {
    const node = document.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
    if (!node) continue;
    node.querySelectorAll('[name]').forEach((input) => {
      if (!(input.name in values)) return;
      if (input.type === 'radio') input.checked = input.value === values[input.name];
      else input.value = values[input.name];
    });
  }
  if (snap.focus) {
    const node = document.querySelector(
      `[data-fkey="${CSS.escape(snap.focus.key)}"] [name="${CSS.escape(snap.focus.name)}"]`,
    );
    if (node) {
      node.focus({ preventScroll: true });
      if (snap.focus.start != null) {
        try { node.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* noop */ }
      }
    }
  }
}

function render() {
  const snap = snapshotDom();
  for (const key of resetKeys) delete snap.forms[key];
  resetKeys.clear();

  renderNotice();
  renderSummary();
  renderToolbar();
  renderAddDate();
  renderBoard();
  renderSuggestions();
  el.btnMe.textContent = state.me ? `担当: ${state.me}` : '担当者';

  restoreDom(snap);
}

function renderNotice() {
  if (state.missingTables) {
    el.notice.innerHTML = `
      <div class="notice">
        <h2>あと1ステップ：Supabase にテーブルを作成してください</h2>
        <p>アプリの保存先テーブル（<code>kc_events</code> / <code>kc_entries</code>）がまだありません。
           下記の SQL を Supabase の SQL Editor で 1 回実行すると使い始められます。</p>
        <ol>
          <li>Supabase ダッシュボード → 左メニューの <strong>SQL Editor</strong> を開く</li>
          <li>「コピー」した SQL を貼り付けて <strong>Run</strong></li>
          <li>このページの「再読込」を押す</li>
        </ol>
        <pre id="sql-box">読み込み中…</pre>
        <button class="btn btn-primary" id="btn-copy-sql">SQL をコピー</button>
        <button class="btn" id="btn-open-sql">SQL Editor を開く</button>
      </div>`;
    loadSchemaSql();
    return;
  }
  if (state.fatal) {
    el.notice.innerHTML = `
      <div class="notice is-error">
        <h2>データを読み込めませんでした</h2>
        <p>${esc(state.fatal)}</p>
        <button class="btn" id="btn-retry">もう一度試す</button>
      </div>`;
    return;
  }
  el.notice.innerHTML = '';
}

let schemaSqlCache = null;
async function loadSchemaSql() {
  const box = document.getElementById('sql-box');
  if (!box) return;
  if (schemaSqlCache) { box.textContent = schemaSqlCache; return; }
  try {
    const res = await fetch('supabase/schema.sql');
    if (!res.ok) throw new Error(String(res.status));
    schemaSqlCache = await res.text();
    box.textContent = schemaSqlCache;
  } catch {
    box.textContent = 'リポジトリの supabase/schema.sql をコピーして SQL Editor で実行してください。';
  }
}

function renderSummary() {
  if (state.loading || state.missingTables || state.fatal || !state.events.length) {
    el.summary.hidden = true;
    return;
  }
  const confirmed = state.entries.filter((e) => e.status === 'confirmed').length;
  const pending = state.entries.filter((e) => e.status === 'pending').length;
  const filled = state.events.filter((ev) => countOf(ev.id, 'confirmed') >= (ev.target_min ?? 2)).length;
  const shortDays = state.events.length - filled;
  const need = state.events.reduce(
    (sum, ev) => sum + Math.max(0, (ev.target_min ?? 2) - countOf(ev.id, 'confirmed')),
    0,
  );

  el.summary.hidden = false;
  el.summary.innerHTML = `
    ${stat('日程', `${state.events.length}<small>日</small>`, '')}
    ${stat('出店決定', `${confirmed}<small>台</small>`, 'is-ok')}
    ${stat('声かけ中', `${pending}<small>台</small>`, 'is-warn')}
    ${stat('目標クリア', `${filled}<small>/${state.events.length}日</small>`, shortDays ? 'is-warn' : 'is-ok')}
    ${stat('不足台数', `${need}<small>台</small>`, need ? 'is-ng' : 'is-ok')}
  `;
}

function stat(k, v, cls) {
  return `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

function renderToolbar() {
  const show = !state.loading && !state.missingTables && !state.fatal;
  el.toolbar.hidden = !show;
  el.chkDeclined.checked = state.showDeclined;
}

function renderAddDate() {
  if (!state.addDateOpen) { el.addDate.innerHTML = ''; return; }
  el.addDate.innerHTML = `
    <form class="form" data-fkey="add-date">
      <div class="field">
        <label for="new-date">追加する出店日</label>
        <input type="date" id="new-date" name="event_date" value="${attr(todayIso())}" required>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" type="submit">追加</button>
        <button class="btn btn-sm" type="button" data-act="cancel-date">キャンセル</button>
      </div>
    </form>`;
}

function renderBoard() {
  if (state.loading) {
    el.board.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
    return;
  }
  if (state.missingTables || state.fatal) { el.board.innerHTML = ''; return; }
  if (!state.events.length) {
    el.board.innerHTML = `<div class="notice"><h2>日程がありません</h2>
      <p>「＋ 日程を追加」から出店日を登録してください。</p></div>`;
    return;
  }
  el.board.innerHTML = state.events.map(renderCard).join('');
}

function renderCard(ev) {
  const f = fmtDate(ev.event_date);
  const min = ev.target_min ?? 2;
  const max = ev.target_max ?? 3;
  const nConf = countOf(ev.id, 'confirmed');
  const nPend = countOf(ev.id, 'pending');

  let countCls = 'ng';
  let countText = `${nConf} / ${min}〜${max}台`;
  if (nConf >= min && nConf <= max) countCls = 'ok';
  else if (nConf > max) { countCls = 'over'; countText = `${nConf}台（超過）`; }
  else if (nConf > 0) countCls = 'warn';

  const dots = Array.from({ length: Math.max(max, nConf) }, (_, i) => {
    const cls = [i < nConf ? 'fill' : '', i >= min ? 'opt' : ''].filter(Boolean).join(' ');
    return `<i class="${cls}"></i>`;
  }).join('');

  const cardCls = nConf >= min ? 'is-filled' : 'is-short';
  const groups = STATUSES
    .filter((s) => s !== 'declined' || state.showDeclined)
    .map((s) => renderGroup(ev, s))
    .join('');

  const addKey = `add:${ev.id}`;
  const addBlock = forms.has(addKey)
    ? renderEntryForm(addKey, forms.get(addKey), 'add')
    : `<button class="btn btn-dashed btn-block" data-act="open-add" data-event="${attr(ev.id)}">
         ＋ キッチンカーを追加
       </button>`;

  return `
    <section class="card ${cardCls}">
      <div class="card-head">
        <div>
          <div class="date">
            <span class="md">${esc(f.md)}</span>
            <span class="wd ${f.dow === 0 ? 'sun' : f.dow === 6 ? 'sat' : ''}">(${esc(f.wd)})</span>
          </div>
          <div class="date-meta">${esc(ev.title || ev.venue || `目標 ${min}〜${max}台`)}${
            nPend ? ` ・ 打診中 ${nPend}件` : ''
          }</div>
        </div>
        <div class="head-right">
          <span class="count ${countCls}">${esc(countText)}</span>
          <span class="dots" aria-hidden="true">${dots}</span>
        </div>
      </div>

      <div class="card-body">
        ${groups}
        ${addBlock}
      </div>

      <div class="card-foot" data-fkey="event:${attr(ev.id)}">
        <div class="foot-row">
          <span>目標</span>
          <input class="num" type="number" min="0" max="20" name="target_min"
                 value="${attr(min)}" data-act="target" data-event="${attr(ev.id)}" aria-label="最低台数">
          <span>〜</span>
          <input class="num" type="number" min="0" max="20" name="target_max"
                 value="${attr(max)}" data-act="target" data-event="${attr(ev.id)}" aria-label="最大台数">
          <span>台</span>
          <span class="spacer"></span>
          <button class="icon-btn danger" data-act="del-event" data-event="${attr(ev.id)}"
                  title="この日程を削除">日程を削除</button>
        </div>
        <textarea class="memo" name="note" rows="1" placeholder="この日のメモ（会場・搬入時間・電源など）"
                  data-act="event-note" data-event="${attr(ev.id)}">${esc(ev.note || '')}</textarea>
      </div>
    </section>`;
}

function renderGroup(ev, status) {
  const meta = STATUS_META[status];
  const list = entriesOf(ev.id).filter((e) => e.status === status);
  if (!list.length && status !== 'confirmed') return '';
  const rows = list.length
    ? list.map(renderEntry).join('')
    : `<div class="empty">${status === 'confirmed' ? 'まだ決定していません' : 'なし'}</div>`;
  return `
    <div class="group">
      <div class="group-title">
        <span>${esc(meta.group)}</span>
        <span class="n">${list.length}</span>
        <span class="bar"></span>
      </div>
      ${rows}
    </div>`;
}

function renderEntry(entry) {
  const key = `edit:${entry.id}`;
  if (forms.has(key)) return renderEntryForm(key, forms.get(key), 'edit');

  const sub = [
    entry.genre ? `<span class="chip">${esc(entry.genre)}</span>` : '',
    entry.contact ? `<span>${esc(entry.contact)}</span>` : '',
  ].filter(Boolean).join('');

  const seg = STATUSES.map((s) => `
    <button class="s-${s}" data-act="status" data-entry="${attr(entry.id)}" data-status="${s}"
            aria-pressed="${entry.status === s}" title="${attr(STATUS_META[s].label)}に変更">
      ${esc(STATUS_META[s].short)}
    </button>`).join('');

  const who = entry.updated_by || entry.created_by;
  const when = fmtWhen(entry.updated_at || entry.created_at);

  return `
    <div class="entry st-${entry.status}">
      <div class="entry-main">
        <div class="entry-name">${esc(entry.vendor_name)}</div>
        ${sub ? `<div class="entry-sub">${sub}</div>` : ''}
        ${entry.note ? `<div class="entry-note">${esc(entry.note)}</div>` : ''}
        ${when ? `<div class="entry-foot">${esc(when)} 更新${who ? ` / ${esc(who)}` : ''}</div>` : ''}
      </div>
      <div class="entry-side">
        <span class="seg">${seg}</span>
        <span class="row-tools">
          <button class="icon-btn" data-act="open-edit" data-entry="${attr(entry.id)}" title="編集">編集</button>
          <button class="icon-btn danger" data-act="del-entry" data-entry="${attr(entry.id)}" title="削除">削除</button>
        </span>
      </div>
    </div>`;
}

function renderEntryForm(key, values, mode) {
  const v = values || {};
  const picker = STATUSES.map((s) => `
    <label class="p-${s}">
      <input type="radio" name="status" value="${s}" ${(v.status || 'pending') === s ? 'checked' : ''}>
      ${esc(STATUS_META[s].short)}
    </label>`).join('');

  return `
    <form class="form ${mode === 'edit' ? 'form-edit' : ''}" data-fkey="${attr(key)}">
      <div class="field">
        <label>キッチンカー名 <span aria-hidden="true">*</span></label>
        <input type="text" name="vendor_name" list="vendor-suggest" required autocomplete="off"
               placeholder="例：つむKITCHEN" value="${attr(v.vendor_name || '')}">
      </div>
      <div class="field field-row">
        <div>
          <label>ジャンル</label>
          <input type="text" name="genre" list="genre-suggest" autocomplete="off"
                 placeholder="例：クレープ" value="${attr(v.genre || '')}">
        </div>
        <div>
          <label>連絡先・担当</label>
          <input type="text" name="contact" autocomplete="off"
                 placeholder="例：山田 090-…" value="${attr(v.contact || '')}">
        </div>
      </div>
      <div class="field">
        <label>ステータス</label>
        <div class="status-picker">${picker}</div>
      </div>
      <div class="field">
        <label>メモ</label>
        <textarea name="note" rows="2" placeholder="打診の経緯・返答期限・条件など">${esc(v.note || '')}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" type="submit">${mode === 'edit' ? '保存' : '追加'}</button>
        <button class="btn btn-sm" type="button" data-act="close-form" data-key="${attr(key)}">キャンセル</button>
      </div>
    </form>`;
}

function renderSuggestions() {
  const vendors = [...new Set(state.entries.map((e) => e.vendor_name).filter(Boolean))].sort();
  const genres = [...new Set(state.entries.map((e) => e.genre).filter(Boolean))].sort();
  el.vendorList.innerHTML = vendors.map((v) => `<option value="${attr(v)}"></option>`).join('');
  el.genreList.innerHTML = genres.map((v) => `<option value="${attr(v)}"></option>`).join('');
}

/* ============================================================
   操作
   ============================================================ */
function readForm(node) {
  const values = {};
  node.querySelectorAll('[name]').forEach((input) => {
    if (input.type === 'radio') {
      if (input.checked) values[input.name] = input.value;
    } else {
      values[input.name] = input.value.trim();
    }
  });
  return values;
}

/** 同名のキッチンカーが既にあれば、ジャンル・連絡先を補完する */
function autofill(formNode) {
  const nameInput = formNode.querySelector('[name="vendor_name"]');
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) return;
  const past = state.entries
    .filter((e) => e.vendor_name === name)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))[0];
  if (!past) return;
  for (const field of ['genre', 'contact']) {
    const input = formNode.querySelector(`[name="${field}"]`);
    if (input && !input.value.trim() && past[field]) input.value = past[field];
  }
}

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'open-add') {
    forms.set(`add:${btn.dataset.event}`, { status: 'pending' });
    render();
    document.querySelector(`[data-fkey="${CSS.escape(`add:${btn.dataset.event}`)}"] [name="vendor_name"]`)?.focus();
    return;
  }

  if (act === 'open-edit') {
    const entry = state.entries.find((e) => e.id === btn.dataset.entry);
    if (!entry) return;
    forms.set(`edit:${entry.id}`, {
      vendor_name: entry.vendor_name,
      genre: entry.genre || '',
      contact: entry.contact || '',
      status: entry.status,
      note: entry.note || '',
    });
    render();
    return;
  }

  if (act === 'close-form') {
    forms.delete(btn.dataset.key);
    render();
    return;
  }

  if (act === 'status') {
    const entry = state.entries.find((e) => e.id === btn.dataset.entry);
    if (!entry || entry.status === btn.dataset.status) return;
    await patchEntry(entry.id, { status: btn.dataset.status });
    return;
  }

  if (act === 'del-entry') {
    const entry = state.entries.find((e) => e.id === btn.dataset.entry);
    if (!entry) return;
    if (!confirm(`「${entry.vendor_name}」を削除しますか？`)) return;
    await removeEntry(entry.id);
    return;
  }

  if (act === 'del-event') {
    const id = Number(btn.dataset.event);
    const target = state.events.find((e) => String(e.id) === String(btn.dataset.event));
    if (!target) return;
    const n = state.entries.filter((e) => String(e.event_id) === String(target.id)).length;
    const f = fmtDate(target.event_date);
    const msg = n
      ? `${f.md}(${f.wd}) を削除します。登録済みの ${n} 件も一緒に削除されます。よろしいですか？`
      : `${f.md}(${f.wd}) を削除しますか？`;
    if (!confirm(msg)) return;
    await removeEvent(Number.isNaN(id) ? target.id : id);
    return;
  }

  if (act === 'cancel-date') {
    state.addDateOpen = false;
    render();
    return;
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-fkey]');
  if (!form) return;
  event.preventDefault();
  const key = form.dataset.fkey;
  const values = readForm(form);

  if (key === 'add-date') {
    if (!values.event_date) { toast('日付を入力してください', true); return; }
    await createEvent(values.event_date);
    return;
  }

  if (!values.vendor_name) {
    toast('キッチンカー名を入力してください', true);
    form.querySelector('[name="vendor_name"]')?.focus();
    return;
  }

  if (key.startsWith('add:')) {
    const eventId = key.slice(4);
    const numeric = Number(eventId);
    const ok = await createEntry(Number.isNaN(numeric) ? eventId : numeric, values);
    if (ok) {
      forms.set(key, { status: values.status || 'pending' });
      resetKeys.add(key);
      render();
      document.querySelector(`[data-fkey="${CSS.escape(key)}"] [name="vendor_name"]`)?.focus();
    }
    return;
  }

  if (key.startsWith('edit:')) {
    const id = key.slice(5);
    const ok = await patchEntry(id, {
      vendor_name: values.vendor_name,
      genre: values.genre || null,
      contact: values.contact || null,
      status: values.status || 'pending',
      note: values.note || null,
    });
    if (ok) { forms.delete(key); render(); toast('保存しました'); }
  }
});

// 名前欄からのオートフィル
document.addEventListener('change', async (event) => {
  const node = event.target;

  if (node.name === 'vendor_name') {
    const form = node.closest('form[data-fkey]');
    if (form) autofill(form);
    return;
  }

  if (node.dataset?.act === 'target') {
    const ev = state.events.find((e) => String(e.id) === String(node.dataset.event));
    if (!ev) return;
    const min = Number(node.closest('[data-fkey]').querySelector('[name="target_min"]').value);
    const max = Number(node.closest('[data-fkey]').querySelector('[name="target_max"]').value);
    if (Number.isNaN(min) || Number.isNaN(max) || min < 0 || max < min) {
      toast('目標台数の指定が正しくありません', true);
      resetKeys.add(`event:${ev.id}`);
      render();
      return;
    }
    if (min === (ev.target_min ?? 2) && max === (ev.target_max ?? 3)) return;
    await patchEvent(ev.id, { target_min: min, target_max: max });
    return;
  }

  if (node.dataset?.act === 'event-note') {
    const ev = state.events.find((e) => String(e.id) === String(node.dataset.event));
    if (!ev) return;
    const next = node.value.trim() || null;
    if ((ev.note || null) === next) return;
    await patchEvent(ev.id, { note: next });
  }
});

el.chkDeclined.addEventListener('change', () => {
  state.showDeclined = el.chkDeclined.checked;
  localStorage.setItem(LS_DECLINED, state.showDeclined ? '1' : '0');
  render();
});

el.btnAddDate.addEventListener('click', () => {
  state.addDateOpen = !state.addDateOpen;
  render();
  if (state.addDateOpen) document.getElementById('new-date')?.focus();
});

el.btnMe.addEventListener('click', () => {
  const name = prompt('更新履歴に残すお名前を入力してください', state.me || '');
  if (name === null) return;
  state.me = name.trim();
  localStorage.setItem(LS_ME, state.me);
  render();
  toast(state.me ? `担当者を「${state.me}」にしました` : '担当者名をクリアしました');
});

el.btnReload.addEventListener('click', async () => {
  flashSync('読込中…');
  await loadAll();
  toast('最新の状態を読み込みました');
});

el.btnCsv.addEventListener('click', exportCsv);

el.notice.addEventListener('click', async (event) => {
  const id = event.target.id;
  if (id === 'btn-copy-sql') {
    const sql = schemaSqlCache || document.getElementById('sql-box')?.textContent || '';
    try {
      await navigator.clipboard.writeText(sql);
      toast('SQL をコピーしました');
    } catch {
      toast('コピーできませんでした。SQL を選択してコピーしてください', true);
    }
  }
  if (id === 'btn-open-sql') {
    const ref = (CFG.supabaseUrl || '').replace(/^https:\/\//, '').split('.')[0];
    window.open(`https://supabase.com/dashboard/project/${ref}/sql/new`, '_blank', 'noopener');
  }
  if (id === 'btn-retry') {
    state.loading = true;
    render();
    await loadAll();
  }
});

/* ---------- CSV ---------- */
function exportCsv() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['日付', '曜日', 'ステータス', 'キッチンカー名', 'ジャンル', '連絡先・担当', 'メモ', '更新者', '更新日時'];
  const lines = [head.map(cell).join(',')];
  for (const ev of state.events) {
    const f = fmtDate(ev.event_date);
    const list = entriesOf(ev.id);
    if (!list.length) {
      lines.push([ev.event_date, f.wd, '未登録', '', '', '', ev.note || '', '', ''].map(cell).join(','));
      continue;
    }
    for (const e of list) {
      lines.push([
        ev.event_date, f.wd, STATUS_META[e.status]?.label || e.status,
        e.vendor_name, e.genre || '', e.contact || '', e.note || '',
        e.updated_by || e.created_by || '', e.updated_at || '',
      ].map(cell).join(','));
    }
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `キッチンカー出店調整_${todayIso()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('CSV を書き出しました');
}

/* ============================================================
   同期（Realtime + ポーリング）
   ============================================================ */
function applyRealtime(payload) {
  const { table, eventType, new: row, old } = payload;
  if (table === 'kc_entries') {
    if (eventType === 'DELETE') {
      state.entries = state.entries.filter((e) => e.id !== old?.id);
    } else if (row) {
      upsertEntry(row);
    }
  } else if (table === 'kc_events') {
    if (eventType === 'DELETE') {
      state.events = state.events.filter((e) => String(e.id) !== String(old?.id));
    } else if (row) {
      const i = state.events.findIndex((e) => String(e.id) === String(row.id));
      if (i === -1) state.events = [...state.events, row];
      else state.events = state.events.map((e) => (String(e.id) === String(row.id) ? row : e));
      state.events.sort((a, b) => a.event_date.localeCompare(b.event_date));
    }
  }
  render();
}

function subscribeRealtime() {
  sb.channel('kc-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kc_entries' }, applyRealtime)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kc_events' }, applyRealtime)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setSync('live', '同期中');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('polling', '定期更新');
      else if (status === 'CLOSED') setSync('polling', '定期更新');
    });
}

function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    if (state.missingTables) return;
    if (forms.size) return; // 入力中は更新しない
    loadAll();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.missingTables && !forms.size) loadAll();
  });
}

/* ============================================================
   起動
   ============================================================ */
async function init() {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) {
    state.loading = false;
    state.fatal = 'assets/config.js に Supabase の URL と key を設定してください。';
    render();
    return;
  }
  render();
  setSync('init', '接続中…');
  const ok = await loadAll();
  if (ok) {
    setSync('polling', '定期更新');
    subscribeRealtime();
  } else {
    setSync('error', '未接続');
  }
  startPolling();
}

init();
