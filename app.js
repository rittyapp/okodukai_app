/**
 * おこづかい帳 v3 画面（GitHub Pages で配信する静的ファイル）
 *
 * 接続先（家族ごとの Apps Script の /exec URL）は URL の ?api= と localStorage に保存する。
 * 通信はすべて api(action, args) → Apps Script の doPost。
 *
 * localStorage
 *   okd_api       … 接続先の /exec URL
 *   okd_token     … Googleログインのセッション（端末に残る）
 *   okd_device    … PINロック判定用の端末ID
 *   okd_look      … アプリ名・アイコンのキャッシュ（起動直後の表示用）
 *   okd_oauth     … Googleログインの往復中だけ使う state
 * sessionStorage
 *   okd_pin_token … PINログインのセッション（タブを閉じると消える。兄弟で同じ端末を使う想定）
 */
'use strict';

const CFG = window.OKODUKAI_CONFIG;
const BASE_URL = location.origin + location.pathname.replace(/index\.html$/, '');
const COOL_MS = 3000; // ボタンを押した後、受け付けない時間
const DEFAULT_LOOK = { name: 'おこづかい帳', emoji: '🐷', color: '#ffd35c' };

let API_URL = '';
let TOKEN = null;
let ME = null;         // { userId, role, name }
let SERVER = null;     // config の結果
let DEVICE_ID = null;
let pinDigits = [];
let CHILD = null;      // 子供画面の状態
let childSeq = 0;
const coolUntil = {};  // key -> 受付再開の時刻

const $ = (id) => document.getElementById(id);

// ===================== 小物 =====================

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* 同上 */ } }
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function yen(n) { return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString() + '円'; }
function signedYen(n) { return (n > 0 ? '+' : '') + yen(n); }
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '/' : '';
  return y + (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ') ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function isValidApi(url) {
  return /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/.test(url);
}
function shareUrl() { return window.OKD_DEMO ? BASE_URL + '?demo=1' : BASE_URL + '?api=' + encodeURIComponent(API_URL); }

function show(screenId) {
  $('loading').classList.add('hidden');
  ['screenSetup', 'screenLogin', 'screenChild', 'screenPin', 'screenParent'].forEach((id) => $(id).classList.toggle('hidden', id !== screenId));
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, isErr) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast hidden';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 5000 : 2500);
}

/** ボタンを数秒暗くして押せなくする（スプレッドシートの反映待ちでの二重押し対策） */
function cool(key, btn, ms) {
  coolUntil[key] = Date.now() + (ms || COOL_MS);
  if (btn) applyCool(key, btn);
}
function isCooling(key) { return (coolUntil[key] || 0) > Date.now(); }
function applyCool(key, btn) {
  const left = (coolUntil[key] || 0) - Date.now();
  if (left <= 0) return;
  btn.classList.add('cooling');
  btn.disabled = true;
  setTimeout(() => { btn.classList.remove('cooling'); btn.disabled = false; }, left);
}

/** 汎用ダイアログ。OKなら true */
function dialog(title, bodyHtml, okLabel, noCancel) {
  return new Promise((resolve) => {
    const d = $('dlg');
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml || '';
    $('dlgOk').textContent = okLabel || 'OK';
    d.querySelector('button[value="cancel"]').classList.toggle('hidden', !!noCancel);
    // close イベントに頼らず、ボタン（submit）と Esc キー（cancel）で直接結果を返す
    // （close イベントが届かないブラウザがあり、OKを押しても何も起きないことがあったため）
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (d.open) d.close();
      resolve(ok);
    };
    $('dlgForm').onsubmit = (e) => { e.preventDefault(); finish(true); };
    d.querySelector('button[value="cancel"]').onclick = () => finish(false);
    d.oncancel = (e) => { e.preventDefault(); finish(false); };
    d.showModal();
  });
}

// ===================== 通信 =====================

async function api(action, args, requestId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    // text/plain で送ると CORS のプリフライトが発生せず、Apps Script でも受け取れる
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify({ action, args: args || {}, token: TOKEN, requestId }),
      signal: ctrl.signal
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      throw new Error('接続先から正しい応答がありません。URLと、デプロイの「アクセスできるユーザー：全員」を確認してください。');
    }
    if (!j.ok) throw new Error(j.error);
    return j.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('通信がタイムアウトしました。もう一度お試しください。');
    if (e instanceof TypeError) throw new Error('通信できませんでした。インターネット接続か接続先URLを確認してください。');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** エラー表示。ログイン切れならログイン画面へ戻す */
function fail(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/ログインが必要|ログインの有効期限|無効化されています/.test(msg)) {
    clearSession();
    showLogin();
    loginMsg(msg, true);
    return;
  }
  toast(msg, true);
}

// ===================== 見た目（アプリ名・アイコン） =====================

function iconPng(look, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = look.color || DEFAULT_LOOK.color;
  g.fillRect(0, 0, size, size);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = Math.round(size * 0.6) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.fillText(look.emoji || DEFAULT_LOOK.emoji, size / 2, size * 0.55);
  return c.toDataURL('image/png');
}

/** アプリ名・アイコンを画面・タブ名・ホーム画面追加用の情報（manifest）に反映 */
function applyLook(look) {
  look = Object.assign({}, DEFAULT_LOOK, look || {});
  lsSet('okd_look', JSON.stringify(look));
  document.title = look.name;
  $('metaAppleTitle').setAttribute('content', look.name);
  $('loginAppName').textContent = look.name;
  // ホーム画面用のPNGアイコンは、絵文字＋背景色からその場で描く
  let icon192 = BASE_URL + 'icons/icon.svg';
  let icon512 = icon192;
  try {
    icon192 = iconPng(look, 192);
    icon512 = iconPng(look, 512);
    document.querySelector('link[rel="apple-touch-icon"]').href = iconPng(look, 180);
    if (look.emoji !== DEFAULT_LOOK.emoji || look.color !== DEFAULT_LOOK.color) {
      document.querySelector('link[rel="icon"]').href = icon192;
    }
  } catch (e) { /* 描画できない環境では標準のSVGアイコンのまま */ }
  const manifest = {
    name: look.name,
    short_name: look.name.slice(0, 12),
    start_url: API_URL ? shareUrl() : BASE_URL,
    scope: BASE_URL,
    display: 'standalone',
    background_color: '#fdf6ec',
    theme_color: '#ffb43d',
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: BASE_URL + 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  $('linkManifest').href = URL.createObjectURL(blob);
}

function cachedLook() {
  try { return JSON.parse(lsGet('okd_look')) || DEFAULT_LOOK; } catch (e) { return DEFAULT_LOOK; }
}

// ===================== 起動 =====================

document.addEventListener('DOMContentLoaded', () => {
  // デモモード（demo/mock.js）は準備が終わるまで起動を待つ
  Promise.resolve(window.OKD_BEFORE_BOOT).then(boot, (e) => { document.body.textContent = 'デモを読み込めませんでした: ' + e; });
});

async function boot() {
  DEVICE_ID = lsGet('okd_device');
  if (!DEVICE_ID) { DEVICE_ID = uuid(); lsSet('okd_device', DEVICE_ID); }

  const params = new URLSearchParams(location.search);
  const apiParam = params.get('api');
  if (apiParam && isValidApi(apiParam)) lsSet('okd_api', apiParam);
  API_URL = lsGet('okd_api') || '';

  bindStatic();
  $('versionText').textContent = 'v' + CFG.VERSION;

  if (!API_URL) {
    applyLook(DEFAULT_LOOK);
    showSetup();
    return;
  }
  applyLook(cachedLook());

  // Googleログインから戻ってきた（#id_token=…）
  const hash = new URLSearchParams(location.hash.slice(1));
  // アドレスバーには常に ?api= を残す（iPhoneの「ホーム画面に追加」はこのURLを使う）
  history.replaceState(null, '', shareUrl());
  if (hash.get('id_token') || hash.get('error')) {
    showLogin();
    loadConfig();
    await finishGoogleLogin(hash);
    return;
  }

  const saved = lsGet('okd_token') || ssGet('okd_pin_token');
  if (saved) {
    TOKEN = saved;
    try {
      const info = await api('resume');
      enterApp(info);
      loadConfig();
      return;
    } catch (e) {
      clearSession();
    }
  }
  showLogin();
  await loadConfig();
  if (window.OKD_DEMO) loginMsg('【デモ】子供のPINは 1234（あいり）/ 5678（しょう）。「Googleでログイン」で親の画面になります。データは保存されません。');
}

async function loadConfig() {
  try {
    SERVER = await api('config');
    applyLook({ name: SERVER.appName, emoji: SERVER.appIcon && SERVER.appIcon.emoji, color: SERVER.appIcon && SERVER.appIcon.color });
    $('btnSetup').classList.toggle('hidden', !SERVER.needsSetup);
    $('versionText').textContent = 'v' + CFG.VERSION + ' / サーバー v' + SERVER.version;
    if (SERVER.needsSetup) loginMsg('まだ初期設定がされていないか、スプレッドシートが壊れています。スプレッドシートの持ち主が「初期設定」を押してください。');
  } catch (e) {
    loginMsg('接続先に接続できません：' + e.message + '\n（共有QRコード → 接続先を変更する から設定し直せます）', true);
  }
}

function bindStatic() {
  // 初期設定
  $('btnCopyTemplate').onclick = () => {
    if (!CFG.TEMPLATE_SPREADSHEET_ID) {
      $('templateNote').textContent = '原本のIDが未設定です。README の「原本スプレッドシートの作り方」を参照してください。';
      return;
    }
    window.open('https://docs.google.com/spreadsheets/d/' + CFG.TEMPLATE_SPREADSHEET_ID + '/copy', '_blank');
  };
  $('btnConnect').onclick = connectApi;

  // ログイン
  buildKeypad();
  $('btnGoogle').onclick = () => startGoogleLogin('login');
  $('btnSetup').onclick = () => startGoogleLogin('setup');
  $('btnShowQr').onclick = toggleQr;
  $('btnCloseQr').onclick = () => $('qrOverlay').classList.add('hidden');
  $('btnChangeApi').onclick = async () => {
    if (!(await dialog('接続先を変更', '<p>この端末の接続先とログイン情報を消して、初期設定の画面に戻ります。</p>', '変更する'))) return;
    clearSession();
    lsSet('okd_api', null);
    API_URL = '';
    location.replace(BASE_URL);
  };
  // PCのキーボードでもキーパッドを操作できる（ログイン画面・番号変更画面）
  document.addEventListener('keydown', (e) => {
    if ($('dlg').open || !$('qrOverlay').classList.contains('hidden')) return;
    const handler = !$('screenLogin').classList.contains('hidden') ? onKey
      : !$('screenPin').classList.contains('hidden') ? onPinChangeKey : null;
    if (!handler) return;
    if (/^[0-9]$/.test(e.key)) handler(e.key);
    else if (e.key === 'Backspace') handler('del');
    else if (e.key === 'Enter') handler('ok');
  });

  // 子供画面
  document.querySelectorAll('#screenChild .tabbar button').forEach((b) => { b.onclick = () => childTab(b.dataset.tab); });
  $('btnChildLogout').onclick = logout;
  $('btnBackToParent').onclick = () => openParent('users');
  $('btnUsage').onclick = addUsage;
  $('btnAdjust').onclick = addAdjustment;
  $('btnRequestUnlock').onclick = requestUnlock;
  $('btnConfirmBonus').onclick = confirmBonus;
  $('btnChoreEdit').onclick = () => { CHILD.editing = !CHILD.editing; renderChores(); };
  $('btnAllowance').onclick = receiveAllowance;
  $('childName').onclick = () => { if (CHILD && !CHILD.asParent) openPinChange(); };
  $('btnPinBack').onclick = () => openChild(ME.userId, false);
  $('calPrev').onclick = () => { CHILD.calMonth = addMonth(CHILD.calMonth, -1); CHILD.calSel = null; renderCalendar(); };
  $('calNext').onclick = () => { CHILD.calMonth = addMonth(CHILD.calMonth, 1); CHILD.calSel = null; renderCalendar(); };

  // 親画面
  document.querySelectorAll('#screenParent .tabbar button').forEach((b) => { b.onclick = () => parentTab(b.dataset.tab); });
  $('btnParentLogout').onclick = logout;
  $('uSelect').onchange = fillUserForm;
  $('btnSaveUser').onclick = saveUser;
  $('btnOpenSheet').onclick = openSheet;
  $('btnSaveAppName').onclick = saveLook;
  $('btnSaveSettings').onclick = saveSettings;
  $('btnRepair').onclick = repair;
}

// ===================== 初期設定（接続先） =====================

function showSetup() {
  show('screenSetup');
  if (!CFG.TEMPLATE_SPREADSHEET_ID) {
    $('templateNote').textContent = '※ 原本が未公開の場合は、空のスプレッドシートを作り「拡張機能 → Apps Script」に gas/Code.gs と appsscript.json を貼り付けても同じです（README参照）。';
  }
}

async function connectApi() {
  const url = $('inputApiUrl').value.trim();
  const msg = $('setupMsg');
  msg.classList.remove('hidden', 'err');
  if (!isValidApi(url)) {
    msg.classList.add('err');
    msg.textContent = 'URLの形が正しくありません。「https://script.google.com/macros/s/…/exec」の形のURLを貼り付けてください。';
    return;
  }
  msg.textContent = '接続を確認しています…';
  API_URL = url;
  try {
    await api('config');
    lsSet('okd_api', url);
    location.replace(shareUrl());
  } catch (e) {
    API_URL = '';
    msg.classList.add('err');
    msg.textContent = '接続できませんでした：' + e.message;
  }
}

// ===================== ログイン =====================

function showLogin() {
  show('screenLogin');
  pinDigits = [];
  renderPinDots();
  $('pinMsg').textContent = '';
  $('qrOverlay').classList.add('hidden');
}

function loginMsg(text, isErr) {
  const el = $('loginMsg');
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
  el.classList.toggle('hidden', !text);
}

/** 4行×3列のキーパッドを作る（ログイン画面と「じぶんのばんごう」画面で共通） */
function buildPad(containerId, okId, okLabel, handler) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  $(containerId).innerHTML = keys.map((k) => {
    if (k === 'del') return '<button type="button" class="key-del" data-k="del">削除</button>';
    if (k === 'ok') return '<button type="button" class="key-ok" data-k="ok" id="' + okId + '">' + okLabel + '</button>';
    return '<button type="button" data-k="' + k + '">' + k + '</button>';
  }).join('');
  $(containerId).querySelectorAll('button').forEach((b) => { b.onclick = () => handler(b.dataset.k); });
}
function buildKeypad() {
  buildPad('keypad', 'keyOk', 'ログイン', onKey);
  buildPad('pinChangePad', 'pinKeyOk', 'けってい', onPinChangeKey);
}

// ---------- じぶんのばんごう（子供が自分のPINを変える） ----------

let pinChange = { first: '', digits: [] };

function openPinChange() {
  pinChange = { first: '', digits: [] };
  show('screenPin');
  $('pinStepText').textContent = 'あたらしい番号を入れてね（4けた）';
  $('pinChangeMsg').textContent = '';
  renderPinChangeDots();
}

function renderPinChangeDots() {
  document.querySelectorAll('#pinChangeDots span').forEach((s, i) => s.classList.toggle('filled', i < pinChange.digits.length));
}

function onPinChangeKey(k) {
  if (isCooling('pinchg')) return;
  $('pinChangeMsg').textContent = '';
  if (k === 'del') pinChange.digits.pop();
  else if (k === 'ok') return submitPinChange();
  else if (pinChange.digits.length < 4) pinChange.digits.push(k);
  renderPinChangeDots();
}

/** 1回目と2回目が同じときだけ変更する。変更後は新しい番号を見せてOKで完了 */
async function submitPinChange() {
  const p = pinChange;
  if (p.digits.length !== 4) { $('pinChangeMsg').textContent = '4けたの数字を入れてね'; return; }
  const v = p.digits.join('');
  p.digits = [];
  renderPinChangeDots();
  const restart = (msg) => {
    p.first = '';
    $('pinStepText').textContent = 'あたらしい番号を入れてね（4けた）';
    $('pinChangeMsg').textContent = msg;
  };
  if (!p.first) {
    p.first = v;
    $('pinStepText').textContent = 'たしかめるので、もういちど同じ番号を入れてね';
    return;
  }
  if (p.first !== v) { restart('1回目とちがったよ。はじめからやりなおしてね'); return; }
  cool('pinchg', $('pinKeyOk'), 3000);
  try {
    const r = await api('changeMyPin', { pin: v }, uuid());
    await dialog('番号をかえたよ',
      '<p style="text-align:center;font-size:18px">あなたが変更した番号は<br><b style="font-size:34px;letter-spacing:8px">' + esc(r.pin) + '</b><br>です</p>',
      'OK', true);
    openChild(ME.userId, false);
  } catch (e) {
    restart(e.message);
  }
}

function renderPinDots() {
  document.querySelectorAll('#pinDots span').forEach((s, i) => s.classList.toggle('filled', i < pinDigits.length));
}

function onKey(k) {
  if (isCooling('pin')) return;
  $('pinMsg').textContent = '';
  if (k === 'del') pinDigits.pop();
  else if (k === 'ok') return submitPin();
  else if (pinDigits.length < 4) pinDigits.push(k);
  renderPinDots();
}

async function submitPin() {
  if (pinDigits.length !== 4) { $('pinMsg').textContent = '4けたの数字を入れてね'; return; }
  const pin = pinDigits.join('');
  cool('pin', $('keyOk'), 1500);
  try {
    const res = await api('pinLogin', { deviceId: DEVICE_ID, pin });
    pinDigits = [];
    renderPinDots();
    if (!res.ok) { $('pinMsg').textContent = res.message; return; }
    TOKEN = res.token;
    ssSet('okd_pin_token', res.token);
    enterApp(res);
  } catch (e) {
    pinDigits = [];
    renderPinDots();
    $('pinMsg').textContent = e.message;
  }
}

async function startGoogleLogin(purpose) {
  const btn = purpose === 'setup' ? $('btnSetup') : $('btnGoogle');
  cool('google', btn, 5000);
  if (window.OKD_DEMO) {
    const info = window.OKD_DEMO.loginParent();
    TOKEN = info.token;
    enterApp(info);
    return;
  }
  try {
    const n = await api('authNonce');
    const state = uuid();
    lsSet('okd_oauth', JSON.stringify({ state, purpose }));
    const q = new URLSearchParams({
      client_id: n.clientId || CFG.DEFAULT_OAUTH_CLIENT_ID,
      redirect_uri: BASE_URL,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce: n.nonce,
      state,
      prompt: 'select_account'
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  } catch (e) {
    loginMsg(e.message, true);
  }
}

async function finishGoogleLogin(hash) {
  let saved = {};
  try { saved = JSON.parse(lsGet('okd_oauth')) || {}; } catch (e) { /* 無視 */ }
  lsSet('okd_oauth', null);
  if (hash.get('error')) {
    loginMsg(hash.get('error') === 'access_denied'
      ? 'Googleログインがキャンセルされたか、このアカウントは許可されていません。'
      : 'Googleログインが中断されました（' + hash.get('error') + '）。', true);
    return;
  }
  if (!saved.state || saved.state !== hash.get('state')) {
    loginMsg('ログインをやり直してください（確認情報が一致しません）。', true);
    return;
  }
  loginMsg('ログインしています…');
  try {
    const info = await api('googleLogin', { idToken: hash.get('id_token'), deviceId: DEVICE_ID });
    if (info.notRegistered) { loginMsg(''); offerNewFamily(info.email); return; }
    TOKEN = info.token;
    lsSet('okd_token', info.token);
    loginMsg('');
    enterApp(info);
    if (saved.purpose === 'setup' || (SERVER && SERVER.needsSetup)) welcomeAfterSetup();
  } catch (e) {
    loginMsg(e.message, true);
  }
}

/**
 * 共有QRで開いた人が、その家族に登録されていないGoogleアカウントでログインしたとき。
 * 「この家族の人（まだ未登録）」か「ほかの家庭の人」かを選んでもらう。
 */
async function offerNewFamily(email) {
  const go = await dialog('この家族には登録されていないアカウントです',
    '<p><b>' + esc(email) + '</b> は、この「' + esc(cachedLook().name) + '」には登録されていません。</p>' +
    '<ul><li><b>この家族の方</b>：親に「ユーザー」タブで登録してもらってから、もう一度ログインしてください。</li>' +
    '<li><b>ほかのご家庭の方</b>：自分の家族用のおこづかい帳を新しく作れます（この端末の接続先が切り替わります）。</li></ul>',
    '自分の家族用を新しく作る');
  if (!go) { loginMsg('この家族の方は、親に登録してもらってからログインしてください。'); return; }
  clearSession();
  lsSet('okd_api', null);
  lsSet('okd_look', null);
  location.replace(BASE_URL);
}

async function welcomeAfterSetup() {
  const go = await dialog('初期設定が完了しました 🎉',
    '<p>つぎに次の3つをしましょう。</p><ol><li><b>設定</b>タブで、アプリ名と<b>アイコン</b>をデザインする</li>' +
    '<li><b>ユーザー</b>タブで、子供（4桁PIN）やほかの親を登録する</li>' +
    '<li>ログイン画面の<b>共有QRコード</b>を家族の端末で読み取り、ホーム画面に追加する</li></ol>',
    'アイコンをデザインする');
  if (go) parentTab('settings');
  if (SERVER) SERVER.needsSetup = false;
}

/** 共有QRを画面いっぱいのカードで表示（アプリ名・アイコン付き。スクショして貼り出せる） */
function toggleQr() {
  const look = cachedLook();
  $('qrAppName').textContent = look.name;
  try { $('qrIcon').src = iconPng(look, 128); } catch (e) { $('qrIcon').src = BASE_URL + 'icons/icon.svg'; }
  const el = $('qrCanvas');
  el.innerHTML = '';
  if (window.QRCode) new QRCode(el, { text: shareUrl(), width: 240, height: 240, colorDark: '#000000', colorLight: '#ffffff' });
  else el.textContent = shareUrl();
  $('qrOverlay').classList.remove('hidden');
}

function clearSession() {
  TOKEN = null;
  ME = null;
  lsSet('okd_token', null);
  ssSet('okd_pin_token', null);
}

function logout() {
  const t = TOKEN;
  clearSession();
  if (t) { TOKEN = t; api('logout').catch(() => {}); TOKEN = null; }
  showLogin();
  loginMsg('');
}

function enterApp(info) {
  ME = { userId: info.userId, role: info.role, name: info.name };
  if (ME.role === 'parent') openParent('pending');
  else openChild(ME.userId, false);
}

// ===================== 子供画面 =====================

function openChild(childId, asParent) {
  CHILD = { id: childId, asParent, data: null, extras: null, editing: false, calMonth: null, calSel: null };
  show('screenChild');
  document.querySelectorAll('#screenChild .parent-only').forEach((el) => el.classList.toggle('hidden', !asParent));
  $('btnBackToParent').classList.toggle('hidden', !asParent);
  $('btnChildLogout').classList.toggle('hidden', !!asParent);
  $('childName').textContent = asParent ? '' : ME.name;
  $('childBalance').textContent = '-';
  $('choreGrid').innerHTML = '';
  $('childHistory').innerHTML = '<div class="note">よみこみ中…</div>';
  $('bonusConfirmBox').classList.add('hidden');
  $('allowanceBox').classList.add('hidden');
  $('bonusBanner').classList.add('hidden');
  $('limitBox').classList.add('hidden');
  $('childName').classList.toggle('clickable', !asParent);
  childTab('log');
  refreshChild();
}

/**
 * 子供の画面を取り直す。先に残高・ボタン・りれきを出し、
 * ボーナスやおこづかいの判定（重め）はそのあとで取りに行って足す（データが増えても待たせないため）
 */
async function refreshChild() {
  const seq = ++childSeq;
  try {
    const d = await api('dashboard', { childId: CHILD.id });
    if (seq !== childSeq || !CHILD) return; // 後から出した取得の結果を優先
    CHILD.data = d;
    if (!CHILD.calMonth) CHILD.calMonth = d.today.day.slice(0, 7);
    renderChild();
    const x = await api('dashboardExtras', { childId: CHILD.id });
    if (seq !== childSeq || !CHILD) return;
    CHILD.extras = x;
    renderExtras();
  } catch (e) {
    fail(e);
  }
}

function childTab(tab) {
  document.querySelectorAll('#screenChild .tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('childPaneLog').classList.toggle('hidden', tab !== 'log');
  $('childPaneCal').classList.toggle('hidden', tab !== 'cal');
  if (tab === 'cal' && CHILD && CHILD.data) renderCalendar();
}

function renderChild() {
  const d = CHILD.data;
  // 子供は自分の名前を押すと「じぶんのばんごう」を変えられる
  $('childName').textContent = CHILD.asParent ? d.child.name + ' の画面' : d.child.name + ' ⚙';
  $('childBalance').textContent = yen(d.balance);

  const t = d.today;
  $('limitBox').classList.toggle('hidden', CHILD.asParent || t.count < t.limit || t.unlocked);
  $('btnRequestUnlock').disabled = t.unlockPending;
  $('btnRequestUnlock').textContent = t.unlockPending ? 'おねがい中…（親の承認をまってね）' : '親に追加をおねがいする';

  renderChores();
  renderHistory();
  if (CHILD.extras) renderExtras();
  if (!$('childPaneCal').classList.contains('hidden')) renderCalendar();
}

/** ボーナス発生中・月初ボーナスの確認・おこづかい発生中（あとから届く分） */
function renderExtras() {
  const x = CHILD.extras;
  // 承認待ちが残っている月（blocked）はまだ確認できない
  const months = x.bonus.pendingMonths;
  const ready = months.filter((m) => !m.blocked);
  $('bonusConfirmBox').classList.toggle('hidden', !months.length);
  $('btnConfirmBonus').classList.toggle('hidden', !ready.length);
  if (months.length) {
    $('bonusConfirmText').innerHTML = '<b>' + (ready.length ? 'ボーナスがとどいているよ！' : 'ボーナスはまだ確認できないよ') + '</b><br>' +
      months.map((m) => esc(m.label) + '：' + (m.blocked
        ? '承認待ちが' + m.pending + '件あるので、親の承認のあとで確認できるよ'
        : yen(m.amount))).join('<br>');
  }

  // 定期おこづかい：押すたびに古い月から1か月分うけとる
  const al = x.allowance || [];
  $('allowanceBox').classList.toggle('hidden', !al.length);
  if (al.length) {
    $('allowanceText').innerHTML = '<b>💰 おこづかい発生中！</b><br>' +
      al.map((a) => esc(a.label) + '：' + yen(a.amount)).join('<br>');
    $('btnAllowance').textContent = al.length > 1 ? 'おこづかいをうけとる（あと' + al.length + '回）' : 'おこづかいをうけとる';
  }

  const banners = [];
  if (x.bonus.streakActive) banners.push('🔥 ボーナス発生中！ ' + Math.max(x.bonus.streakDays, 3) + '日連続（今日のお手伝いは1回につき+10円、来月1日にまとめてもらえるよ）');
  if (x.bonus.sameDayActive) banners.push('⭐ 今日のつぎのお手伝いから「3回目ボーナス」+10円');
  $('bonusBanner').classList.toggle('hidden', !banners.length);
  $('bonusBanner').innerHTML = banners.map(esc).join('<br>');
}

async function receiveAllowance() {
  if (isCooling('allowance')) return;
  cool('allowance', $('btnAllowance'));
  try {
    const r = await api('receiveAllowance', { childId: CHILD.id }, uuid());
    toast(r.message);
  } catch (e) { fail(e); }
  refreshChild();
}

function renderChores() {
  const d = CHILD.data;
  const grid = $('choreGrid');
  grid.classList.toggle('editing', !!CHILD.editing);
  $('btnChoreEdit').textContent = CHILD.editing ? '✔ 編集をおわる' : '✏ お手伝い編集';
  grid.innerHTML = d.chores.map((c, i) =>
    '<button type="button" class="chore-btn" data-i="' + i + '">' + esc(c.name) + '<small>' + yen(c.amount) + '</small>' +
    (CHILD.editing ? '<span class="chore-tools"><span>✏</span></span>' : '') + '</button>'
  ).join('') + (CHILD.editing ? '<button type="button" class="chore-btn add" data-add="1">＋ 追加</button>' : '');
  grid.querySelectorAll('.chore-btn').forEach((b) => {
    if (b.dataset.add) { b.onclick = () => editChore(null); return; }
    const c = d.chores[Number(b.dataset.i)];
    b.onclick = () => (CHILD.editing ? editChore(c) : pressChore(c, b));
    applyCool('chore_' + c.id, b);
  });
}

async function pressChore(c, btn) {
  const key = 'chore_' + c.id;
  if (isCooling(key)) return;
  const d = CHILD.data;
  const t = d.today;
  if (!CHILD.asParent && t.count >= t.limit && !t.unlocked) {
    toast('今日はもう上限だよ。', true);
    return;
  }
  // スクロール中に指が当たっただけの誤操作を防ぐため、確認でOKを押したときだけ送る
  const ok = await dialog(CHILD.asParent ? '記録しますか？' : 'おくる？',
    '<p style="font-size:18px;text-align:center"><b>' + esc(c.name) + '</b>（' + yen(c.amount) + '）</p>',
    CHILD.asParent ? '記録する' : 'おくる');
  if (!ok) return;
  cool(key, btn);
  const rid = uuid();
  // 先に画面へ反映しておき、あとでサーバーの内容で置き換える（反映待ちで固まって見えないように）
  d.history.unshift({
    id: 'tmp_' + rid, ts: new Date().toISOString(), day: t.day, type: 'chore', name: c.name,
    status: CHILD.asParent ? 'approved' : 'pending', amount: c.amount, memo: '', requestedBy: ME.name
  });
  if (CHILD.asParent) d.balance += c.amount;
  t.count++;
  renderChild();
  try {
    const r = await api('pressChore', { choreId: c.id, childId: CHILD.id }, rid);
    toast(r.message);
  } catch (e) {
    fail(e);
  }
  refreshChild();
}

async function editChore(c) {
  const ok = await dialog(c ? 'お手伝いを編集' : 'お手伝いを追加',
    '<label>名前</label><input id="fChoreName" maxlength="20" value="' + esc(c ? c.name : '') + '">' +
    '<label>金額（円）</label><input id="fChoreAmount" type="number" inputmode="numeric" min="0" value="' + (c ? c.amount : 30) + '">' +
    (c ? '<label class="check"><input type="checkbox" id="fChoreDelete"> このお手伝いを削除する</label>' : ''),
    '保存');
  if (!ok) return;
  try {
    if (c && $('fChoreDelete').checked) {
      await api('deleteChore', { choreId: c.id });
      toast('削除しました');
    } else {
      await api('saveChore', { choreId: c ? c.id : '', name: $('fChoreName').value, amount: $('fChoreAmount').value });
      toast('保存しました');
    }
    refreshChild();
  } catch (e) { fail(e); }
}

async function addUsage() {
  if (isCooling('usage')) return;
  const amount = $('usageAmount').value;
  const memo = $('usageMemo').value;
  if (!(Number(amount) > 0)) { toast('つかった金額を入れてね', true); return; }
  cool('usage', $('btnUsage'));
  // 押した瞬間に入力欄を空にして、同じ内容をもう一度送れないようにする
  $('usageAmount').value = '';
  $('usageMemo').value = '';
  const rid = uuid();
  const d = CHILD.data;
  d.history.unshift({ id: 'tmp_' + rid, ts: new Date().toISOString(), day: d.today.day, type: 'usage', name: memo || 'つかった', status: CHILD.asParent ? 'approved' : 'pending', amount: -Math.abs(amount), memo: '', requestedBy: ME.name });
  d.balance -= Math.abs(amount);
  renderChild();
  try {
    const r = await api('addUsage', { childId: CHILD.id, amount, memo }, rid);
    toast(r.message);
  } catch (e) { fail(e); }
  refreshChild();
}

async function addAdjustment() {
  if (isCooling('adjust')) return;
  const amount = $('adjAmount').value;
  const memo = $('adjMemo').value;
  if (!Number(amount)) { toast('金額を入れてください', true); return; }
  cool('adjust', $('btnAdjust'));
  $('adjAmount').value = '';
  $('adjMemo').value = '';
  try {
    const r = await api('addAdjustment', { childId: CHILD.id, amount, memo }, uuid());
    toast(r.message);
  } catch (e) { fail(e); }
  refreshChild();
}

async function requestUnlock() {
  if (isCooling('unlock')) return;
  cool('unlock', $('btnRequestUnlock'));
  try {
    const r = await api('requestUnlock', {}, uuid());
    toast(r.message);
  } catch (e) { fail(e); }
  refreshChild();
}

async function confirmBonus() {
  if (isCooling('bonus')) return;
  cool('bonus', $('btnConfirmBonus'), 5000);
  try {
    const r = await api('confirmBonus', { childId: CHILD.id }, uuid());
    toast(r.message);
  } catch (e) { fail(e); }
  refreshChild();
}

// ---------- 履歴（子供画面・親画面で共通） ----------

function statusTag(st) {
  const m = { pending: ['申請中', 'tag-pending'], approved: ['承認済み', 'tag-approved'], rejected: ['却下', 'tag-rejected'], cancelled: ['取消', 'tag-cancelled'] }[st] || [st, ''];
  return '<span class="tag ' + m[1] + '">' + m[0] + '</span>';
}

function itemHtml(r) {
  const acts = [];
  if (!String(r.id).startsWith('tmp_')) {
    // 親は「承認済み⇔却下」を入れ替えられる。却下済みには「再承認」
    if (r.canApprove) acts.push('<button class="a-approve" data-act="approve">' + (r.status === 'rejected' ? '再承認' : '承認') + '</button>');
    if (r.canReject) acts.push('<button class="a-reject" data-act="reject">却下</button>');
    if (r.editMode) acts.push('<button class="a-edit" data-act="edit">' + (r.editMode === 'date' ? '日付を直す' : '編集') + '</button>');
    if (r.canCancel) acts.push('<button class="a-gray" data-act="cancel">取り消す</button>');
    if (r.canHide) acts.push('<button class="a-gray" data-act="hide">非表示</button>');
  }
  const who = (r.requestedBy && (!ME || r.requestedBy !== ME.name) ? ' ・ ' + esc(r.requestedBy) : '') +
    // 最後に承認・却下した人だけを出す（何度切り替えても最後の1回）
    ((r.status === 'approved' || r.status === 'rejected') && r.approvedBy && r.approvedBy !== r.requestedBy
      ? ' ・ ' + (r.status === 'approved' ? '承認' : '却下') + '：' + esc(r.approvedBy) : '');
  return '<div class="item st-' + esc(r.status) + '" data-id="' + esc(r.id) + '">' +
    '<div class="r1"><span>' + (r.childName ? esc(r.childName) + '：' : '') + esc(r.name) + '</span>' +
    '<span class="' + (r.amount < 0 ? 'minus' : 'plus') + '">' + signedYen(r.amount) + '</span></div>' +
    '<div class="r2">' + fmtDateTime(r.ts) + ' ' + statusTag(r.status) + who + (r.memo ? ' ・ ' + esc(r.memo) : '') + '</div>' +
    (acts.length ? '<div class="acts">' + acts.join('') + '</div>' : '') + '</div>';
}

/** 履歴の各ボタン。after は処理後に呼ぶ再読み込み */
function bindItemActions(container, rows, after) {
  container.querySelectorAll('.item').forEach((el) => {
    const r = rows.filter((x) => x.id === el.dataset.id)[0];
    if (!r) return;
    el.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => itemAction(b.dataset.act, r, b, after);
    });
  });
}

async function itemAction(act, r, btn, after) {
  const key = 'item_' + r.id + '_' + act; // 同じボタンの二重押しだけ防ぐ（却下→再承認はすぐできる）
  if (isCooling(key)) return;
  if (act === 'edit') return editEntry(r, after);
  if (act === 'cancel' && !(await dialog('取り消しますか？', '<p>' + esc(r.name) + '（' + signedYen(r.amount) + '）を取り消します。</p>', '取り消す'))) return;
  cool(key, btn);
  const map = { approve: 'approve', reject: 'reject', cancel: 'cancelEntry', hide: 'hideEntry' };
  try {
    const res = await api(map[act], { id: r.id }, uuid());
    toast(res.message);
  } catch (e) { fail(e); }
  after();
}

async function editEntry(r, after) {
  const d = new Date(r.ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const opt = (n, sel) => '<option value="' + n + '"' + (n === sel ? ' selected' : '') + '>' + n + '</option>';
  let mOpts = '';
  let dOpts = '';
  for (let i = 1; i <= 12; i++) mOpts += opt(i, month);
  for (let i = 1; i <= 31; i++) dOpts += opt(i, day);
  const full = r.editMode === 'full'; // 子供は日付だけ直せる
  const ok = await dialog(full ? '記録を編集' : 'やった日を直す',
    (full
      ? '<label>項目</label><input id="fName" maxlength="30" value="' + esc(r.name) + '">' +
        '<label>金額（円）' + (r.type === 'usage' ? '　※つかった金額' : '') + '</label>' +
        '<input id="fAmount" type="number" inputmode="numeric" value="' + (r.type === 'usage' ? Math.abs(r.amount) : r.amount) + '">'
      : '<p>' + esc(r.name) + '（' + signedYen(r.amount) + '）</p>') +
    '<label>日付（' + d.getFullYear() + '年・時刻はそのまま）</label>' +
    '<div class="date-row"><select id="fMonth">' + mOpts + '</select><span>月</span><select id="fDay">' + dOpts + '</select><span>日</span></div>' +
    '<div class="note">メモに「' + esc(ME.name) + '編集済み」と記録されます。</div>',
    '保存');
  if (!ok) return;
  try {
    const args = { id: r.id, month: $('fMonth').value, day: $('fDay').value };
    if (full) { args.name = $('fName').value; args.amount = $('fAmount').value; }
    const res = await api('editEntry', args, uuid());
    toast(res.message);
  } catch (e) { fail(e); }
  after();
}

function renderHistory() {
  const rows = CHILD.data.history; // サーバーが最新 historyLimit 件だけ返す
  const el = $('childHistory');
  el.innerHTML = rows.length ? rows.map((r) => itemHtml(r)).join('') : '<div class="note">まだりれきはありません。</div>';
  if (rows.length >= CHILD.data.historyLimit) {
    el.innerHTML += '<div class="note">最新' + CHILD.data.historyLimit + '件を表示しています。それより前は「カレンダー」で日付をタップすると見られます。</div>';
  }
  bindItemActions(el, rows, refreshChild);
}

// ---------- カレンダー（月曜始まり・未来の月へは進めない） ----------

function addMonth(ym, diff) {
  const p = ym.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1 + diff, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function renderCalendar() {
  const d = CHILD.data;
  const today = d.today.day;
  const thisMonth = today.slice(0, 7);
  if (CHILD.calMonth > thisMonth) CHILD.calMonth = thisMonth;
  const ym = CHILD.calMonth;
  const [y, m] = ym.split('-').map(Number);
  $('calTitle').textContent = y + '年' + m + '月';
  $('calNext').disabled = ym >= thisMonth;

  // 色付けは全期間の軽い一覧（[日付, 種類, 状態]）を使う（りれきの表示件数とは関係なく出る）
  const byDay = {};
  const usedDay = {}; // お金をつかった日（枠でかこむ）
  d.calendar.forEach(([day, type, status]) => {
    if (status !== 'approved' && status !== 'pending') return;
    if (type === 'chore') byDay[day] = (byDay[day] || 0) + 1;
    if (type === 'usage') usedDay[day] = true;
  });
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // 月曜=0
  const days = new Date(y, m, 0).getDate();
  let html = ['月', '火', '水', '木', '金', '土', '日'].map((w, i) =>
    '<div class="dow' + (i === 5 ? ' sat' : i === 6 ? ' sun' : '') + '">' + w + '</div>').join('');
  for (let i = 0; i < lead; i++) html += '<div class="cal-day blank"></div>';
  for (let day = 1; day <= days; day++) {
    const key = ym + '-' + String(day).padStart(2, '0');
    const n = byDay[key] || 0;
    const cls = ['cal-day'];
    if (key > today) cls.push('future');
    else if (n >= 3) cls.push('d3');
    else if (n >= 1) cls.push('d1');
    if (usedDay[key]) cls.push('used');
    if (key === today) cls.push('today');
    if (key === CHILD.calSel) cls.push('sel');
    html += '<button type="button" class="' + cls.join(' ') + '" data-day="' + key + '"' + (key > today ? ' disabled' : '') + '>' +
      day + (n ? '<small>' + n + '回</small>' : '') + '</button>';
  }
  $('calGrid').innerHTML = html;
  $('calGrid').querySelectorAll('.cal-day[data-day]').forEach((b) => {
    b.onclick = () => { CHILD.calSel = b.dataset.day; renderCalendar(); };
  });
  renderCalDetail();
}

async function renderCalDetail() {
  const el = $('calDetail');
  const sel = CHILD.calSel;
  if (!sel) { el.innerHTML = '<div class="note">日付をタップすると、その日の内容が見られるよ。</div>'; return; }
  const [, m, d] = sel.split('-').map(Number);
  const title = '<div class="section-title">' + m + '月' + d + '日</div>';
  const hist = CHILD.data.history;
  let rows = hist.filter((r) => r.day === sel);
  // りれきに入っていない古い日は、その日の分だけサーバーから取る
  const oldest = hist.length ? hist[hist.length - 1].day : '';
  if (hist.length >= CHILD.data.historyLimit && sel <= oldest) {
    el.innerHTML = title + '<div class="note">よみこみ中…</div>';
    try { rows = await api('dayEntries', { childId: CHILD.id, day: sel }); } catch (e) { fail(e); return; }
    if (CHILD.calSel !== sel) return;
  }
  el.innerHTML = title + (rows.length ? rows.map((r) => itemHtml(r)).join('') : '<div class="note">この日のきろくはありません。</div>');
  bindItemActions(el, rows, refreshChild);
}

// ===================== 親画面 =====================

let USERS = null;

function openParent(tab) {
  CHILD = null;
  show('screenParent');
  $('parentName').textContent = ME.name;
  parentTab(tab || 'pending');
}

function parentTab(tab) {
  document.querySelectorAll('#screenParent .tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('parentPanePending').classList.toggle('hidden', tab !== 'pending');
  $('parentPaneUsers').classList.toggle('hidden', tab !== 'users');
  $('parentPaneSettings').classList.toggle('hidden', tab !== 'settings');
  // タブを開くたびに最新を取り直す
  if (tab === 'pending') refreshPending();
  if (tab === 'users') refreshUsers();
  if (tab === 'settings') refreshSettings();
}

async function refreshPending() {
  try {
    const d = await api('pending');
    const pl = $('pendingList');
    pl.innerHTML = d.pending.length ? d.pending.map((r) => itemHtml(r)).join('') : '<div class="note">今のところ承認待ちはありません。</div>';
    bindItemActions(pl, d.pending, refreshPending);
    const rl = $('recentList');
    rl.innerHTML = d.history.length ? d.history.map((r) => itemHtml(r)).join('') : '<div class="note">まだありません。</div>';
    bindItemActions(rl, d.history, refreshPending);
  } catch (e) { fail(e); }
}

async function refreshUsers() {
  try {
    USERS = await api('users');
    $('usersMe').textContent = USERS.me.name + (USERS.me.isOwner ? '（マスター）' : '');
    $('childrenList').innerHTML = USERS.children.length ? USERS.children.map((u) =>
      '<div class="card"><div class="user-row"><div class="who">' + esc(u.name) + (u.active ? '' : '（無効）') +
      '<small>' + (u.hasPin ? 'PIN登録済み' : 'PINなし') + (u.email ? ' ・ ' + esc(u.email) : '') + '</small></div>' +
      '<div class="bal">' + yen(u.balance) + '</div></div>' +
      '<div class="user-acts">' +
      (u.active ? '<button class="a-approve" data-open="' + esc(u.id) + '">子の画面へ</button>' : '') +
      '<button class="a-edit" data-edit="' + esc(u.id) + '">編集</button></div></div>'
    ).join('') : '<div class="note">子供がまだ登録されていません。下の「ユーザー変更」から追加してください。</div>';
    // マスター（持ち主）は変更できないので、編集ボタンを出さない
    const others = USERS.parents.filter((p) => !p.isMe);
    $('parentsList').innerHTML = others.length ? others.map((u) =>
      '<div class="card"><div class="user-row"><div class="who">' + esc(u.name) + (u.isOwner ? '（マスター）' : '') + (u.active ? '' : '（無効）') +
      '<small>' + esc(u.email) + '</small></div>' +
      (u.isOwner ? '' : '<button class="a-edit btn-small" data-edit="' + esc(u.id) + '">編集</button>') + '</div></div>'
    ).join('') : '<div class="note">ほかの親はいません。</div>';
    document.querySelectorAll('#parentPaneUsers [data-open]').forEach((b) => { b.onclick = () => openChild(b.dataset.open, true); });
    document.querySelectorAll('#parentPaneUsers [data-edit]').forEach((b) => {
      b.onclick = () => { $('uSelect').value = b.dataset.edit; fillUserForm(); $('uSelect').scrollIntoView({ behavior: 'smooth' }); };
    });
    const all = USERS.children.concat(USERS.parents);
    const cur = $('uSelect').value;
    $('uSelect').innerHTML = '<option value="">＋ 新しく追加する</option>' +
      '<option value="' + esc(USERS.me.id) + '">' + esc(USERS.me.name) + '（あなた）</option>' +
      all.filter((u) => u.id !== USERS.me.id && !u.isOwner).map((u) => '<option value="' + esc(u.id) + '">' + esc(u.name) + '（' + (USERS.children.indexOf(u) >= 0 ? '子供' : '親') + '）</option>').join('');
    $('uSelect').value = all.some((u) => u.id === cur) ? cur : '';
    fillUserForm();
  } catch (e) { fail(e); }
}

function fillUserForm() {
  const id = $('uSelect').value;
  const all = USERS ? USERS.children.map((u) => Object.assign({ role: 'child' }, u)).concat(USERS.parents.map((u) => Object.assign({ role: 'parent' }, u))) : [];
  const u = all.filter((x) => x.id === id)[0];
  $('uName').value = u ? u.name : '';
  $('uRole').value = u ? u.role : 'child';
  $('uEmail').value = u ? u.email : '';
  // 親には子供の今の番号（子供が自分で変えた番号も）を見せる
  $('uPin').value = u && u.pin ? u.pin : '';
  $('uPin').placeholder = '4桁PIN（子供のみ）';
  $('uActive').checked = u ? u.active : true;
  // マスターは表示名だけ変えられる
  const ownerLock = !!(u && u.isOwner);
  ['uRole', 'uEmail', 'uPin', 'uActive'].forEach((id) => { $(id).disabled = ownerLock; });
  $('btnSaveUser').textContent = u ? (ownerLock ? '表示名を保存する' : '変更を保存する') : '追加する';
}

async function saveUser() {
  if (isCooling('saveUser')) return;
  cool('saveUser', $('btnSaveUser'));
  try {
    const r = await api('upsertUser', {
      userId: $('uSelect').value, name: $('uName').value, role: $('uRole').value,
      email: $('uEmail').value, pin: $('uPin').value, active: $('uActive').checked
    }, uuid());
    toast(r.message);
    if (!$('uSelect').value) $('uSelect').value = '';
    refreshUsers();
  } catch (e) { fail(e); }
}

async function refreshSettings() {
  try {
    const s = await api('settings');
    $('appNameInput').value = s.appName;
    ensureIconFields(s.appIcon || {});
    $('settingsVersion').textContent = 'アプリ v' + CFG.VERSION + ' / サーバー v' + s.version;
    // ボーナス・定期おこづかい・りれきの表示件数
    $('setBonusSame').checked = s.bonusSameDay;
    $('setBonusStreak').checked = s.bonusStreak;
    $('setAlEnabled').checked = s.allowance.enabled;
    $('setAlAmount').value = s.allowance.amount || '';
    $('setAlDay').value = s.allowance.day || 1;
    $('setAlStart').value = s.allowance.start || new Date().toISOString().slice(0, 7);
    $('setHistoryLimit').value = s.historyLimit;
    const el = $('deviceList');
    // 全体ロック（端末を変えながらの総当たり対策）が働いているとき
    const globalHtml = s.globalLockUntil
      ? '<div class="item st-rejected" style="opacity:1"><div class="r1"><span>⚠ 全体のPINロック中</span></div>' +
        '<div class="r2">PINの失敗が続いたため、' + fmtDateTime(s.globalLockUntil) + 'まで全員のPINログインを止めています。</div>' +
        '<div class="acts"><button class="a-approve" data-dev="*">全体ロックを解除する</button></div></div>'
      : '';
    // 1度でもPINを間違えた端末だけを出す（親が「非表示」にするまで残る。また間違えたら再び出る）
    el.innerHTML = globalHtml + (s.devices.length ? s.devices.map((d) => {
      const state = d.hardLocked ? '完全ロック' : d.locked ? '一時ロック（' + fmtDateTime(d.lockedUntil) + 'まで）' : 'ロックなし';
      return '<div class="item"><div class="r1"><span>端末 ' + esc(d.shortId) + '…</span><span>' + state + '</span></div>' +
        '<div class="r2">これまでの失敗 ' + d.totalFails + '回（連続 ' + d.failCount + '回）・ 最終 ' + fmtDateTime(d.updatedAt) + '</div>' +
        '<div class="acts">' + (d.locked ? '<button class="a-approve" data-dev="' + esc(d.deviceId) + '">解除する</button>' : '') +
        '<button class="a-gray" data-hide-dev="' + esc(d.deviceId) + '">非表示</button></div></div>';
    }).join('') : '<div class="note">PINを間違えた端末はありません。</div>');
    el.querySelectorAll('[data-dev]').forEach((b) => {
      b.onclick = async () => {
        cool('dev', b);
        try { toast((await api('unlockDevice', { deviceId: b.dataset.dev }, uuid())).message); } catch (e) { fail(e); }
        refreshSettings();
      };
    });
    el.querySelectorAll('[data-hide-dev]').forEach((b) => {
      b.onclick = async () => {
        cool('hidedev', b);
        try { toast((await api('hideDevice', { deviceId: b.dataset.hideDev }, uuid())).message); } catch (e) { fail(e); }
        refreshSettings();
      };
    });
  } catch (e) { fail(e); }
}

/** アプリ名の下にアイコン（絵文字＋背景色）の入力欄を用意する */
function ensureIconFields(icon) {
  if (!$('iconEmoji')) {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="section-title">アイコン</div>' +
      '<div style="display:flex;gap:10px;align-items:center">' +
      '<img id="iconPreview" width="64" height="64" style="border-radius:14px" alt="">' +
      '<input id="iconEmoji" maxlength="4" placeholder="絵文字" style="width:80px;font-size:26px;text-align:center;padding:6px;border-radius:10px;border:1px solid #ccc">' +
      '<input id="iconColor" type="color" style="width:56px;height:44px;border:none;background:none">' +
      '</div><div class="note">絵文字1つと背景色でアイコンを作ります。保存後に作ったショートカットに反映されます。</div>';
    $('appNameInput').parentNode.insertBefore(wrap, $('btnSaveAppName'));
    const upd = () => { $('iconPreview').src = iconPng({ emoji: $('iconEmoji').value || DEFAULT_LOOK.emoji, color: $('iconColor').value }, 128); };
    $('iconEmoji').oninput = upd;
    $('iconColor').oninput = upd;
  }
  $('iconEmoji').value = icon.emoji || DEFAULT_LOOK.emoji;
  $('iconColor').value = icon.color || DEFAULT_LOOK.color;
  $('iconEmoji').oninput();
}

async function saveLook() {
  if (isCooling('look')) return;
  cool('look', $('btnSaveAppName'));
  try {
    const r = await api('setAppName', { name: $('appNameInput').value, emoji: $('iconEmoji').value, color: $('iconColor').value }, uuid());
    applyLook({ name: r.appName, emoji: r.appIcon.emoji, color: r.appIcon.color });
    toast('保存しました。ホーム画面のショートカットは作り直すと新しい名前・アイコンになります。');
  } catch (e) { fail(e); }
}

/** 設定タブ：ボーナスの有効/無効・定期おこづかい・りれきの表示件数を保存 */
async function saveSettings() {
  if (isCooling('settings')) return;
  cool('settings', $('btnSaveSettings'));
  try {
    const r = await api('saveSettings', {
      bonusSameDay: $('setBonusSame').checked,
      bonusStreak: $('setBonusStreak').checked,
      allowance: { enabled: $('setAlEnabled').checked, amount: $('setAlAmount').value, day: $('setAlDay').value, start: $('setAlStart').value },
      historyLimit: $('setHistoryLimit').value
    }, uuid());
    toast(r.message);
    refreshSettings();
  } catch (e) { fail(e); }
}

async function openSheet() {
  // ポップアップブロック対策：先に空のタブを開いてからURLを入れる
  const w = window.open('', '_blank');
  try {
    const s = await api('settings');
    if (w) w.location = s.spreadsheetUrl; else location.href = s.spreadsheetUrl;
  } catch (e) {
    if (w) w.close();
    fail(e);
  }
}

async function repair() {
  if (!(await dialog('初期設定（修復）', '<p>足りないシートや列を作り直し、壊れやすい箇所を修正します。今あるデータは消えません。</p>', '実行する'))) return;
  cool('repair', $('btnRepair'), 5000);
  try {
    const r = await api('repair', {}, uuid());
    await dialog('修復の結果', '<ul>' + r.report.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>', 'OK', true);
  } catch (e) { fail(e); }
}
