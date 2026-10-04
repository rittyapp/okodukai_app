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

/** サーバー（スプレッドシート側の Apps Script）がアプリより古いか。古いと新しい機能（ずかん・りそく等）が動かない */
function serverIsOld() {
  const v = (SERVER && SERVER.version) || '0';
  const a = String(v).split('.').map(Number), b = String(CFG.VERSION).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); }
  return false;
}
function serverOldMsg() {
  return 'スプレッドシート側のプログラムが古いです（サーバー v' + ((SERVER && SERVER.version) || '?') + ' / アプリ v' + CFG.VERSION + '）。' +
    'スプレッドシートの持ち主が「拡張機能 → Apps Script」で Code.gs を最新に置き換え、「デプロイを管理 → 編集 → 新バージョン」でデプロイし直してください。';
}

async function loadConfig() {
  try {
    SERVER = await api('config');
    applyLook({ name: SERVER.appName, emoji: SERVER.appIcon && SERVER.appIcon.emoji, color: SERVER.appIcon && SERVER.appIcon.color });
    $('btnSetup').classList.toggle('hidden', !SERVER.needsSetup);
    $('versionText').textContent = 'v' + CFG.VERSION + ' / サーバー v' + SERVER.version;
    if (SERVER.needsSetup) loginMsg('まだ初期設定がされていないか、スプレッドシートが壊れています。スプレッドシートの持ち主が「初期設定」を押してください。');
    else if (serverIsOld()) loginMsg(serverOldMsg(), true);
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
  $('btnCelebrateOk').onclick = () => $('celebrate').classList.add('hidden');

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
  childTab(lsGet('okd_child_tab') || 'money');
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

/** 子供の画面のタブ：ざんだか／おてつだい／カレンダー／ずかん。最後に開いたタブを端末に覚えておく */
function childTab(tab) {
  if (['money', 'chore', 'cal', 'zukan'].indexOf(tab) < 0) tab = 'money';
  lsSet('okd_child_tab', tab);
  document.querySelectorAll('#screenChild .tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('childPaneMoney').classList.toggle('hidden', tab !== 'money');
  $('childPaneChore').classList.toggle('hidden', tab !== 'chore');
  $('childPaneCal').classList.toggle('hidden', tab !== 'cal');
  $('childPaneZukan').classList.toggle('hidden', tab !== 'zukan');
  if (tab === 'cal' && CHILD && CHILD.data) renderCalendar();
  if (tab === 'zukan') { $('zukanDot').classList.add('hidden'); if (CHILD && CHILD.data) renderRares(); }
}

/** 「おてつだい」タブに出す記録（それ以外は「ざんだか」タブ） */
function isChoreRow(r) { return r.type === 'chore' || r.type === 'unlock_request'; }

function renderChild() {
  const d = CHILD.data;
  // 子供は自分の名前を押すと「じぶんのばんごう」を変えられる
  $('childName').textContent = CHILD.asParent ? d.child.name + ' の画面' : d.child.name + ' ⚙';
  $('childBalance').textContent = yen(d.balance);
  $('childBalance2').textContent = yen(d.balance);

  const t = d.today;
  $('limitBox').classList.toggle('hidden', CHILD.asParent || t.count < t.limit || t.unlocked);
  $('btnRequestUnlock').disabled = t.unlockPending;
  $('btnRequestUnlock').textContent = t.unlockPending ? 'おねがい中…（親の承認をまってね）' : '親に追加をおねがいする';

  renderChores();
  renderHistory();
  renderSim();
  if (CHILD.extras) renderExtras();
  if (!$('childPaneCal').classList.contains('hidden')) renderCalendar();
  if (!$('childPaneZukan').classList.contains('hidden')) renderRares();
  checkCelebrations();
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

  // りそく（親が設定したときだけ）。ちょきん計算きもりそくの%を使うので描き直す
  renderInterest();
  renderSim();
  const intDue = !!(x.interest && x.interest.due.length);

  // 受け取れるおこづかい・ボーナス・りそくがあるときは「ざんだか」タブに●を付ける（おてつだいタブにいても気づけるように）
  $('moneyDot').classList.toggle('hidden', !(al.length || ready.length || intDue));

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
  // 家族で1日○回まで：兄弟がやって上限になったものは、子供は押せない（親は代わりに記録できる）
  const state = (c) => {
    const fam = (d.choreToday || {})[c.id];
    if (c.dailyMax && fam && fam.count >= c.dailyMax) {
      return { full: true, note: 'きょうは ' + fam.by.map((n) => (n === d.child.name ? 'じぶん' : n)).join('・') + ' がやったよ' };
    }
    return { full: false, note: c.dailyMax && fam ? '家族であと' + (c.dailyMax - fam.count) + '回' : '' };
  };
  grid.innerHTML = d.chores.map((c, i) => {
    const s = CHILD.editing ? { full: false, note: '' } : state(c);
    return '<button type="button" class="chore-btn' + (s.full ? ' full' : '') + '" data-i="' + i + '"' + (s.full && !CHILD.asParent ? ' disabled' : '') + '>' +
      esc(c.name) + '<small>' + yen(c.amount) + '</small>' + (s.note ? '<em class="chore-note">' + esc(s.note) + '</em>' : '') +
      (CHILD.editing ? '<span class="chore-tools"><span>✏</span></span>' : '') + '</button>';
  }).join('') + (CHILD.editing ? '<button type="button" class="chore-btn add" data-add="1">＋ 追加</button>' : '');
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
  if (!CHILD.asParent) confetti(24); // 押したらすぐ小さくおいわい（承認されたら落下物）
  try {
    const r = await api('pressChore', { choreId: c.id, childId: CHILD.id }, rid);
    toast(r.message);
    parentCelebrate(r); // 親が代わりに記録したときは、その親のずかんの落下物
  } catch (e) {
    fail(e);
  }
  refreshChild();
}

async function editChore(c) {
  const ok = await dialog(c ? 'お手伝いを編集' : 'お手伝いを追加',
    '<label>名前</label><input id="fChoreName" maxlength="20" value="' + esc(c ? c.name : '') + '">' +
    '<label>金額（円）</label><input id="fChoreAmount" type="number" inputmode="numeric" min="0" value="' + (c ? c.amount : 30) + '">' +
    '<label>家族（兄弟みんな）で1日に何回まで（0＝上限なし）</label>' +
    '<input id="fChoreMax" type="number" inputmode="numeric" min="0" max="20" value="' + (c ? c.dailyMax : 1) + '">' +
    (c ? '<label class="check"><input type="checkbox" id="fChoreDelete"> このお手伝いを削除する</label>' : ''),
    '保存');
  if (!ok) return;
  try {
    if (c && $('fChoreDelete').checked) {
      await api('deleteChore', { choreId: c.id });
      toast('削除しました');
    } else {
      await api('saveChore', { choreId: c ? c.id : '', name: $('fChoreName').value, amount: $('fChoreAmount').value, dailyMax: $('fChoreMax').value });
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
    (r.thanks && r.status === 'approved' ? '<div class="thanks">💌 ' + esc(r.thanks) + (r.approvedBy ? '<small>― ' + esc(r.approvedBy) + '</small>' : '') + '</div>' : '') +
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
  const args = { id: r.id };
  // お手伝いを承認するときは「ありがとう」を一緒に送る（えらばなければサーバーがランダムでえらぶ）
  if (act === 'approve' && r.type === 'chore') {
    const thanks = await askThanks(r);
    if (thanks === null) return;
    args.thanks = thanks;
  }
  cool(key, btn);
  const map = { approve: 'approve', reject: 'reject', cancel: 'cancelEntry', hide: 'hideEntry' };
  try {
    const res = await api(map[act], args, uuid());
    toast(res.message);
    parentCelebrate(res); // 承認した親のずかんの落下物
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

/** りれきを「ざんだか」（お金の出入り）と「おてつだい」に分けて出す。サーバーはそれぞれ最新 historyLimit 件を返す */
function renderHistory() {
  const all = CHILD.data.history;
  renderHistoryList($('childHistory'), all.filter((r) => !isChoreRow(r)), 'お金の出入りのりれきはまだありません。');
  renderHistoryList($('choreHistory'), all.filter(isChoreRow), 'おてつだいのりれきはまだありません。');
}

function renderHistoryList(el, rows, emptyText) {
  el.innerHTML = rows.length ? rows.map((r) => itemHtml(r)).join('') : '<div class="note">' + emptyText + '</div>';
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

  // 全期間の軽い一覧（[日付, 種類, 状態, 金額]）から、日を開かなくてもわかる印を作る
  //   背景色＝お手伝いの回数、赤い枠＝お金をつかった日、＋＝お金がふえた日（おこづかい・ボーナス・残高調整）、・＝申請中あり
  const byDay = {};
  const usedDay = {};
  const inDay = {};
  const waitDay = {};
  d.calendar.forEach(([day, type, status, amount]) => {
    if (status !== 'approved' && status !== 'pending') return;
    if (status === 'pending') waitDay[day] = true;
    if (type === 'chore') byDay[day] = (byDay[day] || 0) + 1;
    else if (type === 'usage' || amount < 0) usedDay[day] = true;
    else if (amount > 0) inDay[day] = true;
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
    const marks = (inDay[key] ? '<b class="mk mk-in">＋</b>' : '') + (waitDay[key] ? '<b class="mk mk-wait">・</b>' : '');
    html += '<button type="button" class="' + cls.join(' ') + '" data-day="' + key + '"' + (key > today ? ' disabled' : '') + '>' +
      (marks ? '<span class="mk-row">' + marks + '</span>' : '') +
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
  // りれき（おてつだい・お金それぞれ最新N件）に入っていない古い日は、その日の分だけサーバーから取る
  const lim = CHILD.data.historyLimit;
  const needFetch = [hist.filter(isChoreRow), hist.filter((r) => !isChoreRow(r))]
    .some((list) => list.length >= lim && sel <= list[list.length - 1].day);
  if (needFetch) {
    el.innerHTML = title + '<div class="note">よみこみ中…</div>';
    try { rows = await api('dayEntries', { childId: CHILD.id, day: sel }); } catch (e) { fail(e); return; }
    if (CHILD.calSel !== sel) return;
  }
  el.innerHTML = title + (rows.length ? rows.map((r) => itemHtml(r)).join('') : '<div class="note">この日のきろくはありません。</div>');
  bindItemActions(el, rows, refreshChild);
}

// ===================== ありがとう・りそく・ちょきん計算き =====================

// 承認のときの「ありがとう」（サーバーの THANKS_DEFAULTS と同じ。えらばなければサーバーがランダムでえらぶ）
const THANKS_STAMPS = ['ありがとう！', 'たすかったよ！', 'さすが！', 'ピカピカだね✨', 'いつもえらいね', 'またおねがいね'];
const CHORE_EMOJI = [[/ゴミ/, '🗑️'], [/風呂/, '🛁'], [/料理/, '🍳'], [/食器|皿/, '🍽️'], [/洗濯/, '👕'], [/掃除機/, '🧹'],
  [/布団/, '🛏️'], [/玄関|靴/, '👟'], [/ペット|犬|猫/, '🐶'], [/草|庭|花/, '🌱'], [/そうじ|掃除/, '🧽']];
function choreEmoji(name) {
  const hit = CHORE_EMOJI.filter((x) => x[0].test(name))[0];
  return hit ? hit[1] : '⭐';
}

/** 親が承認するときの「ありがとう」。null＝やめる、''＝えらばない（サーバーがランダムで送る） */
async function askThanks(r) {
  const p = dialog('承認する',
    '<p><b>' + esc((r.childName ? r.childName + '：' : '') + r.name) + '</b>（' + signedYen(r.amount) + '）</p>' +
    '<div class="note">「ありがとう」をいっしょに送れます（えらばないと、どれかがランダムでとどきます）</div>' +
    '<div class="stamp-grid">' + THANKS_STAMPS.map((s) => '<button type="button" class="stamp" data-s="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>' +
    '<input id="fThanks" maxlength="40" placeholder="ひとこと（じゆうに書けます）">',
    '承認する');
  $('dlgBody').querySelectorAll('.stamp').forEach((b) => {
    b.onclick = () => {
      const on = !b.classList.contains('on');
      $('dlgBody').querySelectorAll('.stamp').forEach((x) => x.classList.remove('on'));
      b.classList.toggle('on', on);
      $('fThanks').value = on ? b.dataset.s : '';
    };
  });
  if (!(await p)) return null;
  return $('fThanks').value.trim();
}

/** りそく：ちょきん計算きの下に1行だけ（率・これまでの合計）。ついた月があれば「うけとる」ボタン */
function renderInterest() {
  const el = $('interestYen');
  const x = CHILD.extras && CHILD.extras.interest;
  if (!x || (!x.on && !x.total)) { el.classList.add('hidden'); return; }
  const dueSum = x.due.reduce((t, m) => t + m.amount, 0);
  el.innerHTML = '<div class="int-line"><span>💹 りそく ' + (x.on ? '毎月 <b>' + x.rate + '%</b>' : 'お休み中') + '</span>' +
    '<span>これまで <b>+' + yen(x.total) + '</b></span></div>' +
    (dueSum ? '<button class="btn btn-main int-recv" data-recv="1">りそく +' + yen(dueSum) + ' をうけとる</button>' : '');
  el.classList.remove('hidden');
  const b = el.querySelector('[data-recv]');
  if (b) { b.onclick = () => receiveInterest(b); applyCool('interest', b); }
}

async function receiveInterest(btn) {
  if (isCooling('interest')) return;
  cool('interest', btn, 5000);
  try {
    toast((await api('receiveInterest', { childId: CHILD.id }, uuid())).message);
    if (!CHILD.asParent) confetti(60);
  } catch (e) { fail(e); }
  refreshChild();
}

/** いちばん多いお手伝いの金額 */
function commonAmount(chores) {
  const cnt = {};
  chores.forEach((c) => { if (c.amount > 0) cnt[c.amount] = (cnt[c.amount] || 0) + 1; });
  const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  return best ? Number(best) : 30;
}

/**
 * ちょきん計算き。1か月ぶんを式で見せ（ボーナスこみ）、いまの残高から毎月ためて使わなかったときの5年分を棒グラフにする。
 * りそくは親の設定の%（月末の残高に付く・ふくり）。設定がなければりそくなし
 */
function renderSim() {
  const d = CHILD.data;
  if (!d) return;
  const r = d.bonusRules || {};
  const amounts = Array.from(new Set(d.chores.map((c) => c.amount).filter((a) => a > 0))).sort((a, b) => a - b);
  if (!CHILD.sim) CHILD.sim = { per: 3, amt: commonAmount(d.chores) };
  const sim = CHILD.sim;
  if (amounts.length && amounts.indexOf(sim.amt) < 0) sim.amt = commonAmount(d.chores);
  const DAYS = 30;
  const base = sim.amt * sim.per * DAYS;
  const sameN = r.sameDay && sim.per >= r.sameDayFrom ? sim.per - r.sameDayFrom + 1 : 0;
  const same = r.sameDayAmount * sameN * DAYS;
  const stDays = r.streak ? Math.max(DAYS - (r.streakDays - 1), 0) : 0;
  const streak = r.streakAmount * sim.per * stDays;
  const month = base + same + streak;
  // 5年：いまの残高から、毎月 month をためて、月末にりそく（サーバーと同じく切り捨て）
  const it = CHILD.extras && CHILD.extras.interest;
  const rate = it && it.on ? it.rate : 0;
  const start = Math.max(d.balance, 0);
  let bal = start;
  let own = start;
  const years = [];
  for (let m = 1; m <= 60; m++) {
    bal += month;
    own += month;
    if (rate) bal += Math.floor(bal * rate / 100);
    if (m % 12 === 0) years.push({ y: m / 12, total: bal, own, int: bal - own });
  }
  const max = years[4].total || 1;
  const seg = (name, opts, cur) => '<div class="seg" data-k="' + name + '">' +
    opts.map((o) => '<button type="button" data-v="' + o[0] + '" class="' + (o[0] === cur ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</div>';
  const man = (n) => (n >= 10000 ? (Math.round(n / 1000) / 10) + '万' : n.toLocaleString()) + '円';
  $('simCard').innerHTML =
    '<div class="sim-q">1回 ' + seg('amt', amounts.map((a) => [a, a + '円']), sim.amt) + '</div>' +
    '<div class="sim-q">1日 ' + seg('per', [[1, '1回'], [2, '2回'], [3, '3回']], sim.per) + '</div>' +
    '<div class="sim-lines">' +
    '<div>' + sim.amt + '円 × ' + sim.per + '回 × ' + DAYS + '日 ＝ <b>' + yen(base) + '</b></div>' +
    (same ? '<div>' + r.sameDayFrom + '回目ボーナス ' + r.sameDayAmount + '円 × ' + sameN + '回 × ' + DAYS + '日 ＝ <b>' + yen(same) + '</b></div>' : '') +
    (streak ? '<div>' + r.streakDays + '日連続ボーナス ' + r.streakAmount + '円 × ' + sim.per + '回 × ' + stDays + '日 ＝ <b>' + yen(streak) + '</b>' +
      '<small>（' + r.streakDays + '日目から）</small></div>' : '') +
    '<div class="sim-total">1か月で <b>' + yen(month) + '</b></div></div>' +
    '<div class="sim-5y-title">いまの残高 ' + yen(start) + ' から、毎月 ' + yen(month) + ' ためて つかわなかったら…</div>' +
    '<div class="sim-chart">' + years.map((y) =>
      '<div class="sim-col"><div class="sim-val">' + man(y.total) + '</div>' +
      '<div class="sim-bar" style="height:' + Math.max(3, Math.round(y.total / max * 90)) + 'px">' +
      '<i class="int" style="height:' + (y.total ? y.int / y.total * 100 : 0) + '%"></i><i class="own" style="flex:1"></i></div>' +
      '<div class="sim-year">' + y.y + '年</div></div>').join('') + '</div>' +
    '<div class="int-legend"><span><i class="own"></i>じぶんでためた</span>' + (rate ? '<span><i class="int"></i>りそく（毎月' + rate + '%）</span>' : '') + '</div>' +
    '<div class="sim-5y">5年後 <b>' + yen(years[4].total) + '</b>' +
    (rate ? '（そのうち りそく <b class="int-c">' + yen(years[4].int) + '</b>）'
      : '<div class="note">りそくは いまはついていないよ（親が設定すると、ためたお金がもっとふえるよ）</div>') + '</div>';
  $('simCard').querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => { sim[b.parentNode.dataset.k] = Number(b.dataset.v); renderSim(); };
  });
}

// ===================== ずかん（落下物・レベル・豆知識・確定開き・家族のシルエット） =====================
//
// データは zukan.js（100種）。サーバーは「だれが・どのずかんIDを・いくつ持っているか」だけを返す。
// レベル：同じものを集めた数で 1→2→3。レベル1＝絵文字、2＝イラスト（Fluent Emoji 3D）、3＝写真（Wikimedia Commons）。
// レベルが上がるごとに、豆知識が「小学生 → 大人 → 専門家」と1つずつ読めるようになる

const ZK = window.OKD_ZUKAN || { levels: {}, items: [] };
const ZK_BY_ID = {};
ZK.items.forEach((it, i) => { ZK_BY_ID[it.id] = Object.assign({ no: i + 1 }, it); });
const TIP_LEVELS = ['小学生レベル', '大人レベル', '専門家レベル'];
const LEVEL_LOOKS = ['', '絵文字', 'イラスト', '写真'];

function zItem(id) { return ZK_BY_ID[id] || { id, tier: 1, emoji: '❔', name: '？', tips: ['', '', ''], no: 0 }; }
function zTierLabel(id) { const t = zItem(id).tier; return t === 4 ? 'SR' : 'レア ' + '★'.repeat(t) + '☆'.repeat(3 - t); }
function zName(id) { return (zItem(id).tier === 4 ? 'SR ' : 'レア ') + zItem(id).name; }
/** 持っている数からレベル（0＝持っていない） */
function zLevel(id, n) {
  if (!n) return 0;
  const th = ZK.levels[zItem(id).tier] || [3, 10];
  return n >= th[1] ? 3 : n >= th[0] ? 2 : 1;
}
/** 次のレベルまであと何こか（レベル3なら null） */
function zToNext(id, n) {
  const th = ZK.levels[zItem(id).tier] || [3, 10];
  const lv = zLevel(id, n);
  return lv >= 3 ? null : { level: lv + 1, left: (lv <= 1 ? th[0] : th[1]) - n };
}
function wikiFile(file, w) { return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=' + w; }
function wikiPage(file) { return 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_')); }
/** レベル2のイラストのURL */
function zIllust(it) {
  if (it.illust && it.illust.wiki) return wikiFile(it.illust.wiki[0], 256);
  const f = String(it.illust || '');
  const path = f.indexOf('/') >= 0 ? f : f + '/3D/' + f.toLowerCase().replace(/ /g, '_') + '_3d.png';
  return ZK.fluentBase + path.split('/').map(encodeURIComponent).join('/');
}
/** レベルに合った見た目（小＝マス用、大＝くわしく見る用） */
function zVisual(id, lv, big) {
  const it = zItem(id);
  if (lv >= 3 && it.photo) return '<img class="zk-photo" loading="lazy" alt="" src="' + esc(wikiFile(it.photo[0], big ? 480 : 120)) + '">';
  if (lv >= 2 && it.illust) return '<img class="zk-illust" loading="lazy" alt="" src="' + esc(zIllust(it)) + '">';
  return '<span class="zk-emoji">' + it.emoji + '</span>';
}

/** いま開いているずかん（子供の画面 or 親のずかんタブ） */
let ZUKAN_VIEW = null;

/**
 * ずかんを描く。ids … {count, confirm, grid, note} の要素ID、z … サーバーの zukan、who … 'child' | 'parent'
 */
function renderZukanBox(ids, z, who) {
  ZUKAN_VIEW = z;
  const col = z.collection || {};
  const fam = z.familyFound || {};
  const got = ZK.items.filter((it) => col[it.id]).length;
  const gotSr = ZK.items.filter((it) => it.tier === 4 && col[it.id]).length;
  const lv3 = ZK.items.filter((it) => zLevel(it.id, col[it.id]) >= 3).length;
  const shadows = ZK.items.filter((it) => !col[it.id] && fam[it.id]).length;
  $(ids.count).textContent = got + ' / ' + ZK.items.length + '（SR ' + gotSr + '・写真 ' + lv3 + '）' + (shadows ? '　家族だけ ' + shadows : '');
  $(ids.grid).innerHTML = ZK.items.map((it) => {
    const n = col[it.id] || 0;
    const lv = zLevel(it.id, n);
    const shadow = !n && fam[it.id];
    return '<button type="button" class="rare-cell t' + it.tier + (n ? ' got lv' + lv : shadow ? ' shadow' : '') + '" data-r="' + it.id + '">' +
      (n ? zVisual(it.id, lv, false) + (n > 1 ? '<small>' + n + '</small>' : '') + (lv > 1 ? '<i class="lv">' + lv + '</i>' : '')
        : shadow ? '<span class="zk-emoji">' + it.emoji + '</span>' : '？') + '</button>';
  }).join('');
  $(ids.grid).querySelectorAll('.rare-cell').forEach((b) => { b.onclick = () => showRare(b.dataset.r); });
  const r = z.rates || { child: 5, parent: 2, sr: 1000, rare: 10000 };
  $(ids.note).textContent = (who === 'parent'
    ? 'お手伝いを承認するたびに、' + r.parent + 'こ落ちてくるよ（子供とはべつのくじ）。'
    : 'お手伝いが承認されたり、ボーナス・おこづかいをうけとったりするたびに、' + r.child + 'こ落ちてくるよ。') +
    'レアは' + Math.round(100000 / r.rare) + 'こに1こ、SRは' + Math.round(100000 / r.sr) + 'こに1こ。同じものを集めるとレベルアップして、絵文字→イラスト→写真に変わり、豆知識がふえるよ。';

  // ゴールデンチケット（月に1まい。好きなレアを1こえらんで、その場でもらえる。SRはえらべない）
  const cf = z.confirm || {};
  const box = $(ids.confirm);
  box.className = 'ticket' + (cf.available ? ' ready' : ' used');
  if (cf.available) {
    box.innerHTML = '<div class="ticket-shine"></div><div class="ticket-row"><span class="ticket-icon">🎫</span>' +
      '<div class="ticket-txt"><b>ゴールデンチケット</b><small>今月の1まい・すきなレアを1こえらんでゲット！</small></div>' +
      '<span class="ticket-go">つかう ▶</span></div>';
    box.onclick = () => useConfirm(who, box);
  } else {
    const p = cf.pickedThisMonth;
    const m = Number(String(cf.nextMonth || '').slice(5, 7)) || '';
    box.innerHTML = '<div class="ticket-row"><span class="ticket-icon">' + (p ? zItem(p).emoji : '🎫') + '</span>' +
      '<div class="ticket-txt"><b>ゴールデンチケット つかったよ</b><small>' +
      (cf.armed ? '前の確定開きが、つぎの承認でとどくよ' : (p ? '今月は ' + esc(zItem(p).name) + ' をえらんだよ。' : '') + (m ? m + '月1日に、つぎのチケットがとどくよ' : '来月またとどくよ')) +
      '</small></div></div>';
    box.onclick = p ? () => showRare(p) : null;
  }
}

/** 子供の画面のずかんタブ */
function renderRares() {
  renderZukanBox({ count: 'rareCount', confirm: 'confirmBox', grid: 'rareGrid', note: 'rareNote' }, CHILD.data.zukan || {}, 'child');
}

/** 親のずかんタブ */
async function refreshParentZukan() {
  try {
    if (serverIsOld()) { toast(serverOldMsg(), true); return; }
    const z = await api('zukan');
    renderZukanBox({ count: 'pRareCount', confirm: 'pConfirmBox', grid: 'pRareGrid', note: 'pRareNote' }, z, 'parent');
  } catch (e) { fail(e); }
}

/**
 * ゴールデンチケット。who＝'child'（子供の画面。親が開いた子の画面ならその子）／'parent'（親が自分の分）
 * えらぶ画面：まだ持っていないレア → もっているレア（レベルアップ用）。えらんだら、その場でめくってゲット
 */
async function useConfirm(who, btn) {
  const key = 'confirm_' + who;
  if (isCooling(key)) return;
  const col = (ZUKAN_VIEW && ZUKAN_VIEW.collection) || {};
  const rares = ZK.items.map((it) => ZK_BY_ID[it.id]).filter((it) => it.tier < 4).sort((a, b) => b.tier - a.tier || a.no - b.no);
  const cell = (it) => {
    const n = col[it.id] || 0;
    const nx = n ? zToNext(it.id, n + 1) : null;
    const lvUp = n && zLevel(it.id, n + 1) > zLevel(it.id, n);
    return '<button type="button" class="pick-cell t' + it.tier + '" data-p="' + it.id + '">' +
      '<span class="pick-emoji">' + it.emoji + '</span><span class="pick-name">' + esc(it.name) + '</span>' +
      '<span class="pick-tier">' + '★'.repeat(it.tier) + '</span>' +
      (!n ? '<span class="pick-tag new">NEW</span>' : lvUp ? '<span class="pick-tag up">Lv' + zLevel(it.id, n + 1) + '!</span>'
        : nx ? '<span class="pick-tag">あと' + nx.left + '</span>' : '') + '</button>';
  };
  const miss = rares.filter((it) => !col[it.id]);
  const have = rares.filter((it) => col[it.id] && zLevel(it.id, col[it.id]) < 3);
  let picked = '';
  const p = dialog('🎫 ゴールデンチケット',
    '<p class="pick-lead">すきなレアを <b>1こ</b> えらんでね！<br><small>えらんだものが、すぐにずかんに入るよ（SRはえらべないよ）</small></p>' +
    (miss.length ? '<div class="pick-sec">まだ持っていない（' + miss.length + '）</div><div class="pick-grid">' + miss.map(cell).join('') + '</div>' : '') +
    (have.length ? '<div class="pick-sec">もういっこ集めてレベルアップ</div><div class="pick-grid">' + have.map(cell).join('') + '</div>' : '') +
    (!miss.length && !have.length ? '<p>レアはぜんぶ さいこうレベル！すごい！</p>' : ''), 'これにする！');
  const okBtn = $('dlgOk');
  okBtn.disabled = true;
  $('dlgBody').querySelectorAll('.pick-cell').forEach((b) => {
    b.onclick = () => {
      $('dlgBody').querySelectorAll('.pick-cell.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      picked = b.dataset.p;
      okBtn.disabled = false;
      okBtn.textContent = zItem(picked).emoji + ' ' + zItem(picked).name + ' にする！';
    };
  });
  const ok = await p;
  okBtn.disabled = false;
  if (!ok || !picked) return;
  cool(key, btn, 5000);
  try {
    const r = await api('useConfirm', who === 'parent' ? { itemId: picked } : { childId: CHILD.id, itemId: picked }, uuid());
    const z = r.zukan || ZUKAN_VIEW;
    await ticketReveal(picked);
    showCelebrate('🎫', 'ゲット！', rareLines([{ id: picked }], (z && z.collection) || {}), z);
    if (!(CHILD && CHILD.asParent) || who === 'parent') confetti(80);
  } catch (e) { fail(e); }
  if (who === 'parent') refreshParentZukan(); else refreshChild();
}

/** チケットがくるっとめくれて、えらんだものが出てくる演出（タップでとばせる） */
function ticketReveal(id) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return Promise.resolve();
  return new Promise((resolve) => {
    const it = zItem(id);
    const box = document.createElement('div');
    box.className = 'ticket-reveal';
    box.innerHTML = '<div class="tr-card"><div class="tr-face tr-front">🎫<small>GOLDEN TICKET</small></div>' +
      '<div class="tr-face tr-back t' + it.tier + '"><span>' + it.emoji + '</span><b>' + esc(it.name) + '</b><small>' + '★'.repeat(it.tier) + '</small></div></div>';
    document.body.appendChild(box);
    let done = false;
    const end = () => { if (done) return; done = true; box.remove(); resolve(); };
    box.onclick = end;
    setTimeout(end, 2300);
  });
}

/** マスをおしたとき。持っている→レベルに合った絵・豆知識／家族だけ→シルエット／だれも→？ */
function showRare(id) {
  const z = ZUKAN_VIEW || {};
  const n = (z.collection || {})[id] || 0;
  const fam = (z.familyFound || {})[id];
  const it = zItem(id);
  if (!n && fam) {
    return dialog('？？？', '<div class="rare-detail t' + it.tier + '"><div class="rare-big rare-shadow">' + it.emoji + '</div>' +
      '<div class="rare-lv">' + zTierLabel(id) + '</div>' +
      '<p class="rare-trivia"><b>' + esc(fam.join('・')) + '</b> が見つけているよ！<br>きみはまだ持っていないよ。見つけると、名前と豆知識が読めるようになるよ。</p></div>',
      'とじる', true);
  }
  if (!n) {
    return dialog('？？？', '<p style="text-align:center;font-size:48px;margin:6px 0">？</p><p style="text-align:center">' + zTierLabel(id) +
      '<br>まだ見つけていないよ。承認されると、たまに落ちてくるよ。</p>', 'とじる', true);
  }
  const lv = zLevel(id, n);
  const next = zToNext(id, n);
  const credit = lv >= 3 && it.photo
    ? '写真：' + esc(it.photo[2]) + '（' + esc(it.photo[1]) + '）<a href="' + esc(wikiPage(it.photo[0])) + '" target="_blank" rel="noopener">Wikimedia Commons</a>'
    : lv >= 2 && it.illust && it.illust.wiki
      ? 'イラスト：' + esc(it.illust.wiki[2]) + '（' + esc(it.illust.wiki[1]) + '）<a href="' + esc(wikiPage(it.illust.wiki[0])) + '" target="_blank" rel="noopener">Wikimedia Commons</a>'
      : lv >= 2 ? 'イラスト：Microsoft Fluent Emoji（MIT License）' : '';
  const tips = it.tips.map((t, i) => i < lv
    ? '<div class="tip"><div class="tip-head">' + TIP_LEVELS[i] + '</div>' + esc(t) + '</div>'
    : '<div class="tip locked"><div class="tip-head">🔒 ' + TIP_LEVELS[i] + '</div>レベル' + (i + 1) + 'になると読めるよ</div>').join('');
  return dialog('No.' + it.no + ' ' + zName(id), '<div class="rare-detail t' + it.tier + ' lv' + lv + '"><div class="rare-big">' + zVisual(id, lv, true) + '</div>' +
    (credit ? '<div class="zk-credit">' + credit + '</div>' : '') +
    '<div class="rare-lv">' + zTierLabel(id) + '　レベル' + lv + '（' + LEVEL_LOOKS[lv] + '）　もっている数 ×' + n + '</div>' +
    (next ? '<div class="zk-next">あと <b>' + next.left + 'こ</b> でレベル' + next.level + '（' + LEVEL_LOOKS[next.level] + '・' + TIP_LEVELS[next.level - 1] + 'の豆知識）</div>'
      : '<div class="zk-next">さいこうレベル！</div>') +
    tips + '</div>', 'とじる', true);
}

/** おいわい画面の上で豆知識を見る（とじたら、おいわいにもどる） */
function showRareOver(id) {
  $('celebrate').classList.add('hidden');
  showRare(id).then(() => $('celebrate').classList.remove('hidden'));
}

/**
 * 落下物。はずれは色つきの四角、レア・SRは絵文字（SRはキラキラ）。
 * レアがあるときは、落ちている途中で全体を一時停止 → 暗転 → レアだけ点滅 → 再開（画面をタップで飛ばせる）。
 * 演出がおわったら resolve する（そのあとでおいわいカードを出す）
 */
function dropRain(normal, rares) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return Promise.resolve();
  const box = document.createElement('div');
  box.className = 'confetti-box';
  const colors = ['#ffd35c', '#6fb98f', '#ff8a8a', '#5b8def', '#ffb43d', '#c38cff'];
  for (let i = 0; i < Math.min(normal, 150); i++) {
    const p = document.createElement('i');
    p.style.left = (4 + Math.random() * 88) + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.6 + 's';
    p.style.animationDuration = 1.6 + Math.random() * 1.2 + 's';
    box.appendChild(p);
  }
  // レアは横にならべて同時に落とす（止まったとき、重ならないように）
  const shown = rares.slice(0, 8);
  shown.forEach((id, k) => {
    const p = document.createElement('b');
    p.className = zItem(id).tier === 4 ? 'drop-sr' : 'drop-rare';
    p.style.left = (shown.length === 1 ? 44 : 8 + (80 / (shown.length - 1)) * k) + '%';
    p.style.animationDuration = '3s';
    p.innerHTML = '<span>' + zItem(id).emoji + '</span>';
    box.appendChild(p);
  });
  document.body.appendChild(box);
  if (!rares.length) {
    setTimeout(() => box.remove(), 3500);
    return Promise.resolve();
  }
  const sr = rares.some((id) => zItem(id).tier === 4);
  return new Promise((resolve) => {
    let ended = false;
    let timer = null;
    const dark = document.createElement('div');
    dark.className = 'rare-dark';
    const banner = document.createElement('div');
    banner.className = 'rare-banner' + (sr ? ' sr' : '');
    banner.innerHTML = (sr ? '🌈 SR が出た！！ 🌈' : '✨ レアが出た！ ✨') +
      (rares.length > 1 ? '<small>レア・SR ×' + rares.length + '</small>' : '');
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      box.classList.remove('paused', 'spot');
      dark.remove();
      banner.remove();
      setTimeout(() => { box.remove(); resolve(); }, 1400);
    };
    // 落ちはじめて約1秒（レアが画面の上のほうに来たころ）で一時停止して暗転・点滅
    timer = setTimeout(() => {
      box.classList.add('paused', 'spot');
      box.appendChild(dark);
      box.appendChild(banner);
      dark.onclick = finish; // タップで飛ばせる
      timer = setTimeout(finish, sr ? 3000 : 2200);
    }, 1000);
  });
}

/** 紙ふぶき（動きをへらす設定の端末では出さない） */
function confetti(n) {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti-box';
  const colors = ['#ffd35c', '#6fb98f', '#ff8a8a', '#5b8def', '#ffb43d', '#c38cff'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.4 + 's';
    p.style.animationDuration = 1.6 + Math.random() * 1.2 + 's';
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3500);
}

/**
 * 出たレア・SRの行（はじめてなら NEW!、確定開きなら 🔓、レベルが上がったら レベルアップ）。
 * items … [{id, conf}]、col … 出たあとのずかん（持っている数）
 */
function rareLines(items, col) {
  const inFresh = {};
  items.forEach(({ id }) => { inFresh[id] = (inFresh[id] || 0) + 1; });
  const done = {};
  return '<div class="cel-rares">' + items.map(({ id, conf }) => {
    const after = col[id] || 0;
    const before = after - inFresh[id];
    const first = !done[id];
    done[id] = true;
    const isNew = first && before === 0;
    const up = first && zLevel(id, after) > Math.max(zLevel(id, before), 1) ? zLevel(id, after) : 0;
    return '<button type="button" class="cel-rare t' + zItem(id).tier + '" data-r="' + id + '">' + zItem(id).emoji +
      ' <b>' + esc(zName(id)) + '</b> が出たよ！' + (isNew ? '<span class="new">NEW!</span>' : '') +
      (conf ? '<span class="conf">🔓確定開き</span>' : '') +
      (up ? '<span class="lvup">レベルアップ！ レベル' + up + '（' + LEVEL_LOOKS[up] + '）</span>' : '') + '</button>';
  }).join('') + '<div class="note">おすと、豆知識が読めるよ</div></div>';
}

/** おいわいカードを出す（rares があれば、その行をおすと豆知識） */
function showCelebrate(icon, title, bodyHtml, z) {
  $('celebrateIcon').textContent = icon;
  $('celebrateTitle').textContent = title;
  $('celebrateBody').innerHTML = bodyHtml;
  ZUKAN_VIEW = z;
  $('celebrateBody').querySelectorAll('.cel-rare').forEach((b) => { b.onclick = () => showRareOver(b.dataset.r); });
  $('celebrate').classList.remove('hidden');
}

/**
 * 子供のおいわい：前に見たときから承認されたお手伝い・うけとったボーナス・おこづかいがあれば、
 * 1件につき5この落下物（レアは演出つき）のあとで、ありがとう・出たレアをカードで見せる。
 * 見た記録は端末に覚えておく。はじめて開いた端末では、今までの分はおいわいしない
 */
function checkCelebrations() {
  if (!CHILD || CHILD.asParent || !CHILD.data) return;
  const d = CHILD.data;
  const key = 'okd_seen_' + CHILD.id;
  const approved = d.history.filter((r) => (r.type === 'chore' || r.type === 'bonus' || r.type === 'allowance') &&
    r.status === 'approved' && !String(r.id).startsWith('tmp_'));
  let seen = null;
  try { seen = JSON.parse(lsGet(key)); } catch (e) { /* 読めなければ初回あつかい */ }
  lsSet(key, JSON.stringify({ ids: approved.map((r) => r.id).concat(seen ? seen.ids : []).slice(0, 300) }));
  if (!seen) return;
  const fresh = approved.filter((r) => seen.ids.indexOf(r.id) < 0);
  if (!fresh.length) return;

  let icon = '🎉';
  let title = 'しょうにんされたよ！';
  if (fresh.every((r) => r.type === 'bonus')) { icon = '🎁'; title = 'ボーナスをうけとったよ！'; }
  if (fresh.every((r) => r.type === 'allowance')) { icon = '💰'; title = 'おこづかいをうけとったよ！'; }
  const parts = ['<div class="cel-list">' + fresh.map((r) => '<div>' +
    (r.type === 'bonus' ? '🎁' : r.type === 'allowance' ? '💰' : choreEmoji(r.name)) + ' ' + esc(r.name) +
    ' <b class="plus">' + signedYen(r.amount) + '</b>' +
    (r.thanks ? '<div class="thanks">💌 ' + esc(r.thanks) + (r.approvedBy ? '<small>― ' + esc(r.approvedBy) + '</small>' : '') + '</div>' : '') +
    '</div>').join('') + '</div>'];

  const z = d.zukan || {};
  const items = [].concat.apply([], fresh.map((r) => (r.drops || []).map((id, k) => ({ id, conf: !!r.confirmed && k === 0 }))));
  const rares = items.map((x) => x.id);
  if (rares.length) {
    parts.unshift(rareLines(items, z.collection || {}));
    const sr = rares.some((id) => zItem(id).tier === 4);
    icon = sr ? '🌟' : '✨';
    title = sr ? 'SRが出た！！' : 'レアが出た！';
    if ($('childPaneZukan').classList.contains('hidden')) $('zukanDot').classList.remove('hidden');
  }
  const total = fresh.length * ((z.rates || {}).child || 5);
  dropRain(total - rares.length, rares).then(() => showCelebrate(icon, title, parts.join(''), z));
}

/** 親のおいわい：承認・代わりに記録したときに、その親に落ちたもの（2こ）。レアが出たときだけカードを出す */
function parentCelebrate(res) {
  const p = res && res.parentDrops;
  if (!p) return;
  const items = p.ids.map((id, k) => ({ id, conf: !!p.confirmed && k === 0 }));
  dropRain(p.count - p.ids.length, p.ids).then(() => {
    if (!p.ids.length) return;
    const sr = p.ids.some((id) => zItem(id).tier === 4);
    showCelebrate(sr ? '🌟' : '✨', sr ? 'SRが出た！！' : 'レアが出た！', rareLines(items, res.myCollection || {}),
      { collection: res.myCollection || {}, familyFound: {} });
    $('pZukanDot').classList.toggle('hidden', !$('parentPaneZukan').classList.contains('hidden'));
  });
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
  $('parentPaneZukan').classList.toggle('hidden', tab !== 'zukan');
  // タブを開くたびに最新を取り直す
  if (tab === 'pending') refreshPending();
  if (tab === 'users') refreshUsers();
  if (tab === 'settings') refreshSettings();
  if (tab === 'zukan') { $('pZukanDot').classList.add('hidden'); refreshParentZukan(); }
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
      // 編集は一番下の「ユーザー変更」で選んで行う
      (u.active ? '<div class="user-acts"><button class="a-approve" data-open="' + esc(u.id) + '">子の画面へ</button></div>' : '') + '</div>'
    ).join('') : '<div class="note">子供がまだ登録されていません。下の「ユーザー変更」から追加してください。</div>';
    // 親は一覧だけ（マスターは変更できない。ほかの親の編集は一番下の「ユーザー変更」で）
    const others = USERS.parents.filter((p) => !p.isMe);
    $('parentsList').innerHTML = others.length ? others.map((u) =>
      '<div class="card"><div class="user-row"><div class="who">' + esc(u.name) + (u.isOwner ? '（マスター）' : '') + (u.active ? '' : '（無効）') +
      '<small>' + esc(u.email) + '</small></div></div></div>'
    ).join('') : '<div class="note">ほかの親はいません。</div>';
    document.querySelectorAll('#parentPaneUsers [data-open]').forEach((b) => { b.onclick = () => openChild(b.dataset.open, true); });
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
    if (!s.allowance) s.allowance = {};
    if (!s.interest) s.interest = { rate: 0 };
    if (serverIsOld()) toast(serverOldMsg(), true);
    $('setAlEnabled').checked = s.allowance.enabled;
    $('setAlAmount').value = s.allowance.amount || '';
    $('setAlDay').value = s.allowance.day || 1;
    $('setAlStart').value = s.allowance.start || new Date().toISOString().slice(0, 7);
    $('setHistoryLimit').value = s.historyLimit;
    $('setIntOn').checked = s.interest.rate > 0;
    $('setIntRate').value = s.interest.rate > 0 ? s.interest.rate : 1;
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
    // 失敗した端末があるときは「心当たりがなければURLを変える」案内を出す
    $('deviceWarn').classList.toggle('hidden', !s.devices.length);
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
      historyLimit: $('setHistoryLimit').value,
      interest: { on: $('setIntOn').checked, rate: $('setIntRate').value }
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
