/**
 * おこづかい帳 v3 バックエンド（Google Apps Script / スプレッドシートにバインド）
 *
 * 画面は GitHub Pages 側（index.html / app.js）にあり、このスクリプトは JSON API として動く。
 *   画面 → fetch(POST, text/plain) → doPost → API[action] → スプレッドシート
 * doGet は古いURL（…/exec）を開いた人を GitHub Pages の画面へ転送するだけ。
 *
 * ── スクリプトプロパティ（Apps Script「プロジェクトの設定」→「スクリプト プロパティ」）──
 *   OAUTH_CLIENT_ID     … Googleログインに使うOAuthクライアントID。未設定なら DEFAULT_OAUTH_CLIENT_ID。
 *                          画面側もこの値を config API 経由で受け取るので、コードの書き換えは不要。
 *   OAUTH_CLIENT_SECRET … v3のログイン方式（IDトークン方式）では使わない。設定されていても無視される。
 *   FRONTEND_URL        … 画面のURL。未設定なら DEFAULT_FRONTEND_URL（自分でフォークして公開した場合に設定）。
 *   APP_NAME            … アプリ名。親の「設定」タブから変更する（直接編集も可）。
 *   APP_ICON            … アイコン {"emoji":"🐷","color":"#ffd35c"}。親の「設定」タブから変更する。
 *   BONUS_START_MONTH   … 月初ボーナスを計算し始める月（yyyy-MM）。初期設定時に自動で入る。
 *   PIN_GLOBAL_LOCK_UNTIL … 全体PINロックの解除時刻（ミリ秒）。自動で入る。消すと解除（設定タブからも解除可）。
 *   sess_<token>        … ログインセッション。自動で作成・削除される（手で触らない）。
 *
 * ── シート ──
 *   Users          … UserId / Email / Name / Role(parent|child) / Active / Pin(4桁・書式なしテキスト)
 *   ChoreMaster    … ChoreId / Name / BaseAmount / Active
 *   Ledger         … 全ての記録（お金の出入り・申請・ボーナス）。残高は Status=approved の Amount 合計
 *   PinDeviceState … PIN入力の失敗回数・ロック状態（端末＝ブラウザ単位。最大 DEVICE_MAX_ROWS 行）
 */

// ===================== 設定値 =====================
const SERVER_VERSION = '3.0.4';

// 公開してよい情報のみ。クライアントIDはブラウザに渡る前提の値で、秘密ではない。
const DEFAULT_OAUTH_CLIENT_ID = '337708567191-tpqbqqinfgm5bpje56ccdj2gmkphdngi.apps.googleusercontent.com';
const DEFAULT_FRONTEND_URL = 'https://rittyapp.github.io/okodukai_app/';
const DEFAULT_APP_NAME = 'おこづかい帳';

const SHEET_USERS = 'Users';
const SHEET_CHORES = 'ChoreMaster';
const SHEET_LEDGER = 'Ledger';
const SHEET_DEVICES = 'PinDeviceState';

const HEADERS = {
  Users: ['UserId', 'Email', 'Name', 'Role', 'Active', 'Pin'],
  ChoreMaster: ['ChoreId', 'Name', 'BaseAmount', 'Active'],
  // RequestedById … 押した（記録した）人のUserId。「押した本人なら取り消せる」の判定に使う。
  Ledger: ['Id', 'Timestamp', 'ChildId', 'Type', 'ChoreId', 'ChoreName', 'Status', 'Amount', 'Memo',
    'RequestedBy', 'ApprovedBy', 'ApprovedAt', 'Hidden', 'RequestedById'],
  PinDeviceState: ['DeviceId', 'FailCount', 'LockUntil', 'HardLocked', 'UpdatedAt']
};

const DEFAULT_CHORES = [
  ['ゴミ捨て', 30], ['お風呂掃除', 30], ['料理', 100], ['食器洗い', 30], ['洗濯物たたみ', 30],
  ['掃除機がけ', 30], ['布団干し', 30], ['玄関掃除', 30], ['ペットのお世話', 30], ['草むしり', 30]
];

// お手伝いの回数制限（子供が押すとき。親が代わりに押す場合は制限しない）
const DAILY_LIMIT = 3;

// 月初ボーナス（前月分をまとめて計算し、翌月1日付で1行記録する）
const SAME_DAY_BONUS_FROM = 3;     // 同じ日の3回目以降のお手伝い1回ごとに…
const SAME_DAY_BONUS_AMOUNT = 10;  // …+10円
const STREAK_DAYS_FOR_BONUS = 3;   // 3日以上連続した日のお手伝い1回ごとに…
const STREAK_BONUS_AMOUNT = 10;    // …+10円
const BONUS_CHORE_PREFIX = 'bonus:'; // ボーナス行の ChoreId（bonus:yyyy-MM）。この行があれば「処理済み」

// セッション・PINロック
const SESSION_PREFIX = 'sess_';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_STAGE1_COUNT = 3;  const LOCK_STAGE1_MS = 60 * 1000;
const LOCK_STAGE2_COUNT = 6;  const LOCK_STAGE2_MS = 5 * 60 * 1000;
const LOCK_STAGE3_COUNT = 10; // 完全ロック（親のGoogleログイン or 設定タブで解除）
const WRONG_PIN_MESSAGE = 'ちがいます。もういちどためしてね。';
// 端末に関係なく、全体でPINの失敗が続いたら一定時間すべてのPINログインを止める
// （ブラウザの情報を消して端末を変えながら総当たりされるのを防ぐ）
const GLOBAL_FAIL_LIMIT = 20;               // 失敗がこの回数に達したら…
const GLOBAL_FAIL_WINDOW_S = 600;           // （前の失敗から10分以内に続いた失敗を数える）
const GLOBAL_LOCK_MS = 30 * 60 * 1000;      // …30分間、全端末のPINログインを止める（親は設定タブで解除可）
const DEVICE_MAX_ROWS = 30;         // これを超えた古い端末行は黙って削除
const DEVICE_RECENT_DAYS = 30;      // 設定タブに出す期間。0件なら最新3端末を出す

// 却下・取消から何日で履歴から自動的に隠すか（日次トリガー）
const AUTO_HIDE_AFTER_DAYS = 30;

// ===================== 入口 =====================

const API = {
  // ログイン不要
  config: apiConfig_, authNonce: apiAuthNonce_, googleLogin: apiGoogleLogin_, pinLogin: apiPinLogin_,
  resume: apiResume_, logout: apiLogout_,
  // 子供・親
  dashboard: apiDashboard_, pressChore: apiPressChore_, requestUnlock: apiRequestUnlock_,
  addUsage: apiAddUsage_, cancelEntry: apiCancelEntry_, confirmBonus: apiConfirmBonus_,
  // 親のみ
  pending: apiPending_, approve: apiApprove_, reject: apiReject_, editEntry: apiEditEntry_,
  revertEntry: apiRevertEntry_, hideEntry: apiHideEntry_, addAdjustment: apiAddAdjustment_,
  saveChore: apiSaveChore_, deleteChore: apiDeleteChore_,
  users: apiUsers_, upsertUser: apiUpsertUser_, deactivateUser: apiDeactivateUser_,
  settings: apiSettings_, setAppName: apiSetAppName_, unlockDevice: apiUnlockDevice_, repair: apiRepair_
};
// 書き込み系はスクリプトロックで直列化し、requestId による二重送信防止をかける
const WRITE_ACTIONS = {
  googleLogin: 1, pinLogin: 1, pressChore: 1, requestUnlock: 1, addUsage: 1, cancelEntry: 1, confirmBonus: 1,
  approve: 1, reject: 1, editEntry: 1, revertEntry: 1, hideEntry: 1, addAdjustment: 1, saveChore: 1,
  deleteChore: 1, upsertUser: 1, deactivateUser: 1, setAppName: 1, unlockDevice: 1, repair: 1
};

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません。' });
  }
  const fn = API[req.action];
  if (!fn) return json_({ ok: false, error: '不明な操作です: ' + req.action });
  const ctx = { token: req.token || '', args: req.args || {} };
  try {
    const run = function () { return fn(ctx); };
    const data = WRITE_ACTIONS[req.action]
      ? withLock_(function () { return withDedupe_(req.requestId, run); })
      : run();
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** 古いURLやスプレッドシートのメニューから開いた人を、GitHub Pages の画面へ転送する */
function doGet() {
  const url = frontendLink_();
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:40px 16px;">' +
    '<p>新しい画面へ移動します…</p>' +
    '<p><a href="' + url + '" target="_top" style="font-size:18px;">移動しない場合はこちら</a></p>' +
    '<script>try{window.top.location.replace(' + JSON.stringify(url) + ');}catch(e){}</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(appName_())
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('混み合っています。少し待ってからもう一度押してください。');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 同じ requestId の2回目以降は、1回目の結果をそのまま返す（通信の再送・二重押し対策） */
function withDedupe_(requestId, fn) {
  if (!requestId) return fn();
  const cache = CacheService.getScriptCache();
  const key = 'rq_' + requestId;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const result = fn();
  try { cache.put(key, JSON.stringify(result === undefined ? null : result), 21600); } catch (e) { /* 大きすぎる結果はキャッシュしない */ }
  return result;
}

// ===================== スプレッドシートのメニュー =====================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('おこづかい帳')
    .addItem('初期設定・修復（シート作成）', 'menuRepair')
    .addItem('アプリのURLを表示', 'menuShowUrl')
    .addSeparator()
    .addItem('全端末のPINロックを解除', 'resetAllPinLocksForSetup')
    .addToUi();
}

function menuRepair() {
  const report = repairSheets_();
  SpreadsheetApp.getUi().alert('初期設定・修復が完了しました。\n\n' + report.join('\n'));
}

function menuShowUrl() {
  const execUrl = ScriptApp.getService().getUrl();
  if (!execUrl) {
    SpreadsheetApp.getUi().alert('まだウェブアプリとしてデプロイされていません。README の「使い方」にある手順でデプロイしてください。');
    return;
  }
  const link = frontendLink_();
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    '<p>このURLを開き、家族に共有してください（ログイン画面の「共有QRコード」からも共有できます）。</p>' +
    '<p><a href="' + link + '" target="_blank">' + link + '</a></p></div>'
  ).setWidth(460).setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, 'アプリのURL');
}

function resetAllPinLocksForSetup() {
  const sheet = ss_().getSheetByName(SHEET_DEVICES);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
  SpreadsheetApp.getUi().alert('すべてのPINロックを解除しました。');
}

// ===================== 初期設定・修復 =====================

/** 足りないシート・列を作り、壊れやすい箇所（PIN書式・重複ID）を直す。既存データは消さない。 */
function repairSheets_() {
  const ss = ss_();
  const report = [];
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); report.push('シート「' + name + '」を作成'); }
    const want = HEADERS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, want.length).setValues([want]);
      sh.setFrozenRows(1);
    } else {
      const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      want.forEach(function (h) {
        if (have.indexOf(h) === -1) {
          sh.getRange(1, have.length + 1).setValue(h);
          have.push(h);
          report.push('「' + name + '」に列「' + h + '」を追加');
        }
      });
    }
    invalidate_(name);
  });

  // PINの先頭0が消えないよう、Pin列を書式なしテキストにする
  const users = ss.getSheetByName(SHEET_USERS);
  const pinCol = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0].indexOf('Pin') + 1;
  if (pinCol > 0) users.getRange(1, pinCol, users.getMaxRows(), 1).setNumberFormat('@');

  // お手伝いマスタ：空なら初期値、IDが重複していれば後ろの方を振り直す
  const chores = readTable_(SHEET_CHORES);
  if (!chores.rows.length) {
    DEFAULT_CHORES.forEach(function (c, i) {
      appendRow_(SHEET_CHORES, { ChoreId: 'c' + pad2_(i + 1), Name: c[0], BaseAmount: c[1], Active: true });
    });
    report.push('お手伝いの初期データを登録');
  } else {
    const seen = {};
    readTable_(SHEET_CHORES).rows.forEach(function (c) {
      const id = String(c.ChoreId || '');
      if (!id || seen[id]) {
        const newId = nextChoreId_();
        updateRow_(SHEET_CHORES, c._row, { ChoreId: newId });
        report.push('お手伝い「' + c.Name + '」のIDを ' + (id || '(空)') + ' → ' + newId + ' に修正（重複）');
        seen[newId] = true;
      } else {
        seen[id] = true;
      }
    });
  }

  // 月初ボーナスの開始月。旧版は押した時点でボーナスを加算していたため、
  // 既に記録がある場合は二重加算を避けて「来月」から、新規なら「今月」から計算する。
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BONUS_START_MONTH')) {
    const hasChores = readTable_(SHEET_LEDGER).rows.some(function (r) { return r.Type === 'chore'; });
    const start = hasChores ? monthAdd_(thisMonth_(), 1) : thisMonth_();
    props.setProperty('BONUS_START_MONTH', start);
    report.push('ボーナス計算の開始月を ' + start + ' に設定');
  }
  if (!props.getProperty('APP_NAME')) props.setProperty('APP_NAME', DEFAULT_APP_NAME);

  try {
    const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoHideOldEntries'; });
    if (!exists) {
      ScriptApp.newTrigger('autoHideOldEntries').timeBased().everyDays(1).atHour(3).create();
      report.push('自動非表示の毎日トリガーを設定');
    }
  } catch (e) {
    report.push('（トリガーは設定できませんでした: ' + e.message + '）');
  }

  cleanupDevices_();
  if (!report.length) report.push('修正が必要な箇所はありませんでした');
  return report;
}

/** シートが揃っているか・親がいるか（config で画面に返す） */
function setupStatus_() {
  const ss = ss_();
  const sheetsOk = Object.keys(HEADERS).every(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() === 0) return false;
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    return HEADERS[name].every(function (h) { return have.indexOf(h) !== -1; });
  });
  let hasParent = false;
  if (ss.getSheetByName(SHEET_USERS)) {
    hasParent = listUsers_().some(function (u) { return u.Role === 'parent' && isActive_(u) && u.Email; });
  }
  return { sheetsOk: sheetsOk, hasParent: hasParent };
}

// ===================== 共通ユーティリティ =====================

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function tz_() { return Session.getScriptTimeZone(); }
function props_() { return PropertiesService.getScriptProperties(); }
function appName_() { return props_().getProperty('APP_NAME') || DEFAULT_APP_NAME; }
function appIcon_() {
  try { return JSON.parse(props_().getProperty('APP_ICON')) || {}; } catch (e) { return {}; }
}
function clientId_() { return props_().getProperty('OAUTH_CLIENT_ID') || DEFAULT_OAUTH_CLIENT_ID; }
function frontendUrl_() { return props_().getProperty('FRONTEND_URL') || DEFAULT_FRONTEND_URL; }
function frontendLink_() {
  const execUrl = ScriptApp.getService().getUrl() || '';
  return frontendUrl_() + (execUrl ? '?api=' + encodeURIComponent(execUrl) : '');
}

// 1回のリクエスト内だけ有効な読み取りキャッシュ（書き込み時に破棄）
const TABLE_CACHE_ = {};
function readTable_(name) {
  if (TABLE_CACHE_[name]) return TABLE_CACHE_[name];
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。親でログインして「初期設定」を実行してください。');
  const values = sh.getDataRange().getValues();
  const headers = (values.shift() || []).map(String);
  const rows = values.map(function (row, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (h, j) { if (h) o[h] = row[j]; });
    return o;
  });
  TABLE_CACHE_[name] = { headers: headers, rows: rows };
  return TABLE_CACHE_[name];
}
function invalidate_(name) { delete TABLE_CACHE_[name]; }

function appendRow_(name, obj) {
  const t = readTable_(name);
  ss_().getSheetByName(name).appendRow(t.headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
  invalidate_(name);
}
function updateRow_(name, rowIndex, patch) {
  const t = readTable_(name);
  const range = ss_().getSheetByName(name).getRange(rowIndex, 1, 1, t.headers.length);
  const values = range.getValues()[0];
  t.headers.forEach(function (h, i) { if (patch[h] !== undefined) values[i] = patch[h]; });
  range.setValues([values]);
  invalidate_(name);
}

function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function isActive_(u) { return !(u.Active === false || String(u.Active).toUpperCase() === 'FALSE'); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function newId_() { return Utilities.getUuid(); }
function toIso_(v) { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toISOString(); }
function dayOf_(v) { return Utilities.formatDate(new Date(v), tz_(), 'yyyy-MM-dd'); }
function todayStr_() { return dayOf_(new Date()); }
function thisMonth_() { return todayStr_().substring(0, 7); }

/** 'yyyy-MM-dd' に日数を足す（タイムゾーンに依存しない文字列計算） */
function dayAdd_(dayStr, diff) {
  const p = dayStr.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + diff));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}
/** 'yyyy-MM' に月数を足す */
function monthAdd_(ym, diff) {
  const p = ym.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1 + diff, 1));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1);
}
function parseLocal_(str) { return Utilities.parseDate(str, tz_(), 'yyyy-MM-dd HH:mm:ss'); }

// ===================== セッション =====================

function createSession_(userId) {
  const props = props_();
  // 期限切れセッションの掃除（プロパティの容量上限対策）
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    try {
      if (Date.now() - JSON.parse(all[k]).issuedAt > SESSION_MAX_AGE_MS) props.deleteProperty(k);
    } catch (e) { props.deleteProperty(k); }
  });
  const token = Utilities.getUuid() + Utilities.getUuid().substring(0, 8);
  props.setProperty(SESSION_PREFIX + token, JSON.stringify({ userId: userId, issuedAt: Date.now() }));
  return token;
}

function requireUser_(token, role) {
  if (!token) throw new Error('ログインが必要です。');
  const raw = props_().getProperty(SESSION_PREFIX + token);
  if (!raw) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
  const s = JSON.parse(raw);
  if (Date.now() - s.issuedAt > SESSION_MAX_AGE_MS) {
    props_().deleteProperty(SESSION_PREFIX + token);
    throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
  }
  const user = findUserById_(s.userId);
  if (!user || !isActive_(user)) throw new Error('このユーザーは無効化されています。');
  if (role && user.Role !== role) throw new Error('この操作を行う権限がありません。');
  return user;
}

function loginInfo_(user, token) {
  return { token: token, userId: user.UserId, role: user.Role, name: user.Name };
}

// ===================== 公開API（ログイン不要） =====================

function apiConfig_() {
  let status = { sheetsOk: false, hasParent: false };
  try { status = setupStatus_(); } catch (e) { /* シートが壊れていても config は返す */ }
  return {
    version: SERVER_VERSION,
    appName: appName_(),
    appIcon: appIcon_(),
    clientId: clientId_(),
    needsSetup: !status.sheetsOk || !status.hasParent,
    status: status
  };
}

/** Googleログイン前に呼ぶ。IDトークンに埋め込む使い捨ての値（リプレイ防止） */
function apiAuthNonce_() {
  const nonce = Utilities.getUuid();
  CacheService.getScriptCache().put('nonce_' + nonce, '1', 900);
  return { nonce: nonce, clientId: clientId_() };
}

function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('Googleログインの情報がありません。');
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Googleログインの確認に失敗しました。もう一度お試しください。');
  const d = JSON.parse(resp.getContentText());
  if (d.aud !== clientId_()) throw new Error('このアプリ用のログイン情報ではありません（OAuthクライアントIDが一致しません）。');
  if (d.iss !== 'accounts.google.com' && d.iss !== 'https://accounts.google.com') throw new Error('Googleログインの発行元が不正です。');
  if (!(d.email_verified === true || d.email_verified === 'true')) throw new Error('メールアドレスの確認が取れませんでした。');
  const cache = CacheService.getScriptCache();
  if (!d.nonce || !cache.get('nonce_' + d.nonce)) {
    throw new Error('ログインの有効期限が切れました。もう一度「Googleでログイン」を押してください。');
  }
  cache.remove('nonce_' + d.nonce);
  return { email: d.email, name: d.name || '' };
}

function apiGoogleLogin_(ctx) {
  const info = verifyIdToken_(ctx.args.idToken);
  const status = setupStatus_();
  if (!status.sheetsOk || !status.hasParent) {
    // 「初期設定」：シートを整え、親がいなければスプレッドシートの持ち主を最初の親にする
    repairSheets_();
    if (!setupStatus_().hasParent) {
      const owner = normalizeEmail_(Session.getEffectiveUser().getEmail());
      if (!owner || owner !== normalizeEmail_(info.email)) {
        throw new Error('最初の親は、このスプレッドシートの持ち主のGoogleアカウント（' + maskEmail_(owner) + '）でログインしてください。');
      }
      appendRow_(SHEET_USERS, {
        UserId: generateUserId_(), Email: info.email, Name: info.name || info.email.split('@')[0],
        Role: 'parent', Active: true, Pin: ''
      });
    }
  }
  const user = findUserByEmail_(info.email);
  if (!user || !isActive_(user)) {
    throw new Error('このGoogleアカウント（' + info.email + '）はまだ登録されていません。親に「ユーザー」タブで登録してもらってください。');
  }
  const token = createSession_(user.UserId);
  if (user.Role === 'parent' && ctx.args.deviceId) {
    saveDeviceState_(ctx.args.deviceId, { FailCount: 0, LockUntil: '', HardLocked: false });
  }
  return loginInfo_(user, token);
}

function apiPinLogin_(ctx) {
  const deviceId = String(ctx.args.deviceId || '');
  if (!deviceId) throw new Error('端末情報が取得できませんでした。ページを再読み込みしてください。');
  const state = getDeviceState_(deviceId);
  const locked = isTrue_(state.HardLocked) || (state.LockUntil && Number(state.LockUntil) > Date.now());
  // ロック中（端末 or 全体）は正解でも同じ文言を返す（ロック中であることを悟らせない）
  if (locked || globalPinLockUntil_()) return { ok: false, message: WRONG_PIN_MESSAGE };

  const user = findUserByPin_(ctx.args.pin);
  if (user) {
    saveDeviceState_(deviceId, { FailCount: 0, LockUntil: '', HardLocked: false });
    return Object.assign({ ok: true }, loginInfo_(user, createSession_(user.UserId)));
  }
  const fails = Number(state.FailCount || 0) + 1;
  let until = '';
  let hard = false;
  if (fails >= LOCK_STAGE3_COUNT) hard = true;
  else if (fails >= LOCK_STAGE2_COUNT) until = Date.now() + LOCK_STAGE2_MS;
  else if (fails >= LOCK_STAGE1_COUNT) until = Date.now() + LOCK_STAGE1_MS;
  saveDeviceState_(deviceId, { FailCount: fails, LockUntil: until, HardLocked: hard });
  countGlobalPinFail_();
  return { ok: false, message: WRONG_PIN_MESSAGE };
}

/** 全体ロックの解除時刻（ロック中でなければ 0） */
function globalPinLockUntil_() {
  const until = Number(props_().getProperty('PIN_GLOBAL_LOCK_UNTIL') || 0);
  return until > Date.now() ? until : 0;
}

function countGlobalPinFail_() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('pin_fail_global') || 0) + 1;
  if (n >= GLOBAL_FAIL_LIMIT) {
    props_().setProperty('PIN_GLOBAL_LOCK_UNTIL', String(Date.now() + GLOBAL_LOCK_MS));
    cache.remove('pin_fail_global');
  } else {
    cache.put('pin_fail_global', String(n), GLOBAL_FAIL_WINDOW_S);
  }
}

function apiResume_(ctx) {
  const user = requireUser_(ctx.token);
  return loginInfo_(user, ctx.token);
}

function apiLogout_(ctx) {
  if (ctx.token) props_().deleteProperty(SESSION_PREFIX + ctx.token);
  return { ok: true };
}

// ===================== ユーザー =====================

function listUsers_() {
  return readTable_(SHEET_USERS).rows.filter(function (u) { return u.UserId; }).map(function (u) {
    u.UserId = String(u.UserId);
    return u;
  });
}
function findUserById_(id) {
  return listUsers_().filter(function (u) { return u.UserId === String(id); })[0] || null;
}
function normalizeEmail_(email) { return email ? String(email).trim().toLowerCase() : ''; }
function maskEmail_(email) {
  if (!email) return '不明';
  const p = email.split('@');
  return p[0].substring(0, 2) + '***@' + (p[1] || '');
}
function findUserByEmail_(email) {
  const n = normalizeEmail_(email);
  if (!n) return null;
  return listUsers_().filter(function (u) { return normalizeEmail_(u.Email) === n; })[0] || null;
}
/** 全角数字→半角。シートが数値書式で先頭0が落ちていても4桁に戻して比較する */
function normalizePin_(v) {
  let s = String(v == null ? '' : v).trim()
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  if (/^\d{1,3}$/.test(s)) s = ('0000' + s).slice(-4);
  return s;
}
function findUserByPin_(pin) {
  const p = normalizePin_(pin);
  if (!/^\d{4}$/.test(p)) return null;
  return listUsers_().filter(function (u) {
    return isActive_(u) && u.Role === 'child' && u.Pin !== '' && normalizePin_(u.Pin) === p;
  })[0] || null;
}
function generateUserId_() { return 'u' + Utilities.getUuid().substring(0, 8); }

function apiUsers_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const balances = balancesByChild_();
  const users = listUsers_();
  return {
    me: { id: me.UserId, name: me.Name, email: me.Email },
    children: users.filter(function (u) { return u.Role === 'child'; }).map(function (u) {
      return { id: u.UserId, name: u.Name, email: u.Email || '', hasPin: !!String(u.Pin || ''), active: isActive_(u), balance: balances[u.UserId] || 0 };
    }),
    parents: users.filter(function (u) { return u.Role === 'parent'; }).map(function (u) {
      return { id: u.UserId, name: u.Name, email: u.Email || '', active: isActive_(u), isMe: u.UserId === me.UserId };
    })
  };
}

function apiUpsertUser_(ctx) {
  requireUser_(ctx.token, 'parent');
  const a = ctx.args;
  const email = String(a.email || '').trim();
  const name = String(a.name || '').trim();
  const role = a.role;
  const pinInput = normalizePin_(a.pin);
  if (!name) throw new Error('表示名を入力してください。');
  if (role !== 'parent' && role !== 'child') throw new Error('役割は「親」か「子供」を選んでください。');
  if (pinInput && !/^\d{4}$/.test(pinInput)) throw new Error('PINは4桁の数字にしてください。');
  if (role === 'parent' && pinInput) throw new Error('親にはPINを設定できません（Googleログインのみです）。');
  if (role === 'parent' && !email) throw new Error('親にはGoogleアカウントのメールアドレスが必要です。');

  const existing = a.userId ? findUserById_(a.userId) : null;
  const pin = role === 'child' ? (pinInput || (existing ? normalizePin_(existing.Pin) : '')) : '';
  if (role === 'child' && !email && !pin) throw new Error('子供にはメールアドレスか4桁PINのどちらかが必要です。');

  const users = listUsers_();
  if (pin && users.some(function (u) { return u.UserId !== (existing && existing.UserId) && normalizePin_(u.Pin) === pin && u.Role === 'child'; })) {
    throw new Error('そのPINは別の人がすでに使っています。別の4桁にしてください。');
  }
  if (email && users.some(function (u) { return u.UserId !== (existing && existing.UserId) && normalizeEmail_(u.Email) === normalizeEmail_(email); })) {
    throw new Error('そのメールアドレスは別のユーザーで登録済みです。');
  }

  const active = a.active === undefined ? true : !!a.active;
  if (existing) {
    if (existing.Role === 'parent' && (role === 'child' || !active)) guardLastParent_(existing.UserId);
    updateRow_(SHEET_USERS, existing._row, { Email: email, Name: name, Role: role, Active: active, Pin: pin });
  } else {
    appendRow_(SHEET_USERS, { UserId: generateUserId_(), Email: email, Name: name, Role: role, Active: true, Pin: pin });
  }
  return { message: '保存しました。' };
}

function apiDeactivateUser_(ctx) {
  requireUser_(ctx.token, 'parent');
  const target = findUserById_(ctx.args.userId);
  if (!target) throw new Error('ユーザーが見つかりません。');
  if (target.Role === 'parent') guardLastParent_(target.UserId);
  updateRow_(SHEET_USERS, target._row, { Active: false });
  return { message: '無効にしました。' };
}

function guardLastParent_(excludeUserId) {
  const remaining = listUsers_().filter(function (u) {
    return u.Role === 'parent' && isActive_(u) && u.UserId !== excludeUserId;
  });
  if (!remaining.length) throw new Error('親が0人になってしまうため、この操作はできません。親は最低1人必要です。');
}

function targetChild_(me, childId) {
  const id = String(childId || me.UserId);
  if (me.Role === 'child' && id !== me.UserId) throw new Error('自分以外のきろくは見られません。');
  const child = findUserById_(id);
  if (!child || child.Role !== 'child') throw new Error('子供のユーザーが見つかりません。');
  return child;
}

// ===================== お手伝いマスタ =====================

function listChores_() {
  return readTable_(SHEET_CHORES).rows
    .filter(function (c) { return c.ChoreId && isActive_(c); })
    .map(function (c) { return { id: String(c.ChoreId), name: String(c.Name), amount: Number(c.BaseAmount) || 0 }; });
}
function nextChoreId_() {
  let max = 0;
  readTable_(SHEET_CHORES).rows.forEach(function (c) {
    const m = /^c(\d+)$/.exec(String(c.ChoreId || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'c' + pad2_(max + 1);
}

function apiSaveChore_(ctx) {
  requireUser_(ctx.token, 'parent');
  const name = String(ctx.args.name || '').trim();
  const amount = Number(ctx.args.amount);
  if (!name) throw new Error('お手伝いの名前を入力してください。');
  if (!isFinite(amount) || amount < 0) throw new Error('金額は0以上の数字にしてください。');
  if (ctx.args.choreId) {
    const row = readTable_(SHEET_CHORES).rows.filter(function (c) { return String(c.ChoreId) === String(ctx.args.choreId); })[0];
    if (!row) throw new Error('お手伝いが見つかりません。');
    updateRow_(SHEET_CHORES, row._row, { Name: name, BaseAmount: amount, Active: true });
  } else {
    appendRow_(SHEET_CHORES, { ChoreId: nextChoreId_(), Name: name, BaseAmount: amount, Active: true });
  }
  return { message: '保存しました。' };
}

function apiDeleteChore_(ctx) {
  requireUser_(ctx.token, 'parent');
  const row = readTable_(SHEET_CHORES).rows.filter(function (c) { return String(c.ChoreId) === String(ctx.args.choreId); })[0];
  if (!row) throw new Error('お手伝いが見つかりません。');
  // 過去の記録はお手伝い名を持っているので、非表示（Active=false）にするだけでよい
  updateRow_(SHEET_CHORES, row._row, { Active: false });
  return { message: '削除しました。' };
}

// ===================== 台帳（Ledger） =====================

function ledgerRows_() { return readTable_(SHEET_LEDGER).rows.filter(function (r) { return r.Id; }); }
function findLedger_(id) {
  const r = ledgerRows_().filter(function (x) { return String(x.Id) === String(id); })[0];
  if (!r) throw new Error('対象の記録が見つかりません。');
  return r;
}
function addLedger_(o) {
  appendRow_(SHEET_LEDGER, Object.assign({
    Id: newId_(), Timestamp: new Date(), ChoreId: '', ChoreName: '', Memo: '',
    ApprovedBy: '', ApprovedAt: '', Hidden: ''
  }, o));
}
function appendMemo_(memo, add) {
  memo = String(memo || '');
  return memo.endsWith(add) ? memo : memo + add; // 同じ追記が続かないように
}
/** ボーナスや回数制限の対象になる「お手伝い」（却下・取消は数えない） */
function isCountedChore_(r) { return r.Type === 'chore' && (r.Status === 'approved' || r.Status === 'pending'); }

function labelOf_(r) {
  if (r.ChoreName) return String(r.ChoreName);
  return { usage: 'つかった', adjustment: '残高調整', unlock_request: '上限追加のおねがい', bonus: 'ボーナス' }[r.Type] || String(r.Type);
}

/** 「取り消す」は子供だけ（親は却下を使う） */
function canCancel_(r, viewer) {
  if (r.Status !== 'pending' && r.Status !== 'approved') return false;
  if (viewer.Role !== 'child' || String(r.ChildId) !== viewer.UserId) return false;
  if (r.Type === 'bonus' || r.Type === 'adjustment') return false;
  // 押した本人だけ取り消せる（旧データは RequestedById が無いので名前で判定）
  return r.RequestedById ? String(r.RequestedById) === viewer.UserId : String(r.RequestedBy) === String(viewer.Name);
}

/** 子供は、自分が押した申請中のお手伝いの「日付だけ」を直せる */
function canChildEditDate_(r, viewer) {
  return viewer.Role === 'child' && r.Type === 'chore' && r.Status === 'pending' &&
    String(r.ChildId) === viewer.UserId && String(r.RequestedById || '') === viewer.UserId;
}

function outRow_(r, viewer, childNames) {
  const isParent = viewer.Role === 'parent';
  const o = {
    id: String(r.Id), ts: toIso_(r.Timestamp), day: dayOf_(r.Timestamp), type: r.Type,
    name: labelOf_(r), status: r.Status, amount: Number(r.Amount) || 0, memo: String(r.Memo || ''),
    requestedBy: String(r.RequestedBy || ''), approvedBy: String(r.ApprovedBy || ''),
    canCancel: canCancel_(r, viewer),
    // 親のボタン：申請中＝承認・却下・編集／承認済み＝却下・編集／却下・取消＝承認（取消は除く）・非表示
    // 子供：自分が押した申請中のお手伝いの日付だけ
    editMode: isParent && (r.Status === 'pending' || r.Status === 'approved') ? 'full' : (canChildEditDate_(r, viewer) ? 'date' : ''),
    // 親は「承認済み⇔却下」を何度でも入れ替えられる（間違えて却下した時の再承認）
    canApprove: isParent && (r.Status === 'pending' || r.Status === 'rejected'),
    canReject: isParent && (r.Status === 'pending' || r.Status === 'approved'),
    canHide: isParent && (r.Status === 'rejected' || r.Status === 'cancelled')
  };
  if (childNames) o.childName = childNames[String(r.ChildId)] || String(r.ChildId);
  return o;
}

function balancesByChild_() {
  const b = {};
  ledgerRows_().forEach(function (r) {
    if (r.Status === 'approved') b[String(r.ChildId)] = (b[String(r.ChildId)] || 0) + (Number(r.Amount) || 0);
  });
  return b;
}

// ===================== ボーナス（月初処理） =====================

/** 日ごとのお手伝い回数。approvedOnly=true はボーナス計算用（承認済みだけ数える） */
function countByDay_(rows, approvedOnly) {
  const m = {};
  rows.forEach(function (r) {
    const ok = approvedOnly ? r.Type === 'chore' && r.Status === 'approved' : isCountedChore_(r);
    if (ok) { const d = dayOf_(r.Timestamp); m[d] = (m[d] || 0) + 1; }
  });
  return m;
}

/** ym(yyyy-MM) のボーナスを計算。連続日数は前月から続いていても数える */
function calcMonthBonus_(byDay, ym) {
  let same = 0;
  let streak = 0;
  Object.keys(byDay).forEach(function (d) {
    if (d.substring(0, 7) !== ym) return;
    const n = byDay[d];
    if (n >= SAME_DAY_BONUS_FROM) same += (n - SAME_DAY_BONUS_FROM + 1) * SAME_DAY_BONUS_AMOUNT;
    let len = 1;
    let c = dayAdd_(d, -1);
    while (byDay[c]) { len++; c = dayAdd_(c, -1); }
    if (len >= STREAK_DAYS_FOR_BONUS) streak += n * STREAK_BONUS_AMOUNT;
  });
  return { same: same, streak: streak, total: same + streak };
}

/** まだボーナス処理（0円も含む）がされていない、お手伝いをした過去の月 */
function unconfirmedBonusMonths_(rows) {
  const start = props_().getProperty('BONUS_START_MONTH') || '0000-00';
  const current = thisMonth_();
  const done = {};
  rows.forEach(function (r) {
    const id = String(r.ChoreId || '');
    if (r.Type === 'bonus' && id.indexOf(BONUS_CHORE_PREFIX) === 0) done[id.substring(BONUS_CHORE_PREFIX.length)] = true;
  });
  const byDay = countByDay_(rows, true); // ボーナスは承認済みのお手伝いだけで計算する
  // その月に承認待ちのお手伝いが残っている間は、その月のボーナスは計算・確認できない
  const pendingByMonth = {};
  rows.forEach(function (r) {
    if (r.Type === 'chore' && r.Status === 'pending') {
      const ym = dayOf_(r.Timestamp).substring(0, 7);
      pendingByMonth[ym] = (pendingByMonth[ym] || 0) + 1;
    }
  });
  const months = {};
  Object.keys(byDay).map(function (d) { return d.substring(0, 7); }).concat(Object.keys(pendingByMonth)).forEach(function (ym) {
    if (ym < current && ym >= start && !done[ym]) months[ym] = true;
  });
  return Object.keys(months).sort().map(function (ym) {
    const label = Number(ym.substring(5)) + '月ボーナス';
    const pending = pendingByMonth[ym] || 0;
    if (pending) return { ym: ym, label: label, blocked: true, pending: pending };
    const b = calcMonthBonus_(byDay, ym);
    return { ym: ym, label: label, blocked: false, pending: 0, same: b.same, streak: b.streak, amount: b.total };
  });
}

function apiConfirmBonus_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const all = unconfirmedBonusMonths_(rows);
  const months = all.filter(function (m) { return !m.blocked; });
  if (!months.length && all.length) {
    return { message: '承認待ちのお手伝いがあるので、まだボーナスは確認できないよ。', count: 0 };
  }
  months.forEach(function (m) {
    const next = monthAdd_(m.ym, 1);
    addLedger_({
      Timestamp: parseLocal_(next + '-01 00:00:00'), // ボーナスは翌月1日付で記録
      ChildId: child.UserId, Type: 'bonus', ChoreId: BONUS_CHORE_PREFIX + m.ym, ChoreName: m.label,
      Status: 'approved', Amount: m.amount,
      Memo: m.label + ' ' + m.amount + '円（同じ日3回目から ' + m.same + '円／3日連続 ' + m.streak + '円）',
      RequestedBy: 'システム', RequestedById: 'system', ApprovedBy: 'システム', ApprovedAt: new Date()
    });
  });
  const total = months.reduce(function (s, m) { return s + m.amount; }, 0);
  return { message: months.length ? 'ボーナス ' + total + '円 をうけとったよ！' : 'かくにんするボーナスはありません。', count: months.length };
}

// ===================== 子供の画面（子供本人・親の両方から） =====================

function apiDashboard_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const today = todayStr_();
  const byDay = countByDay_(rows);
  let streakBefore = 0;
  for (let c = dayAdd_(today, -1); byDay[c]; c = dayAdd_(c, -1)) streakBefore++;
  const todayCount = byDay[today] || 0;
  const isToday = function (r) { return r.Type === 'unlock_request' && dayOf_(r.Timestamp) === today; };

  const history = rows
    .filter(function (r) { return !isTrue_(r.Hidden); })
    .sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); })
    .map(function (r) { return outRow_(r, me); });

  return {
    child: { id: child.UserId, name: child.Name },
    viewerRole: me.Role,
    balance: rows.reduce(function (s, r) { return r.Status === 'approved' ? s + (Number(r.Amount) || 0) : s; }, 0),
    chores: listChores_(),
    history: history,
    today: {
      day: today, count: todayCount, limit: DAILY_LIMIT,
      unlocked: rows.some(function (r) { return isToday(r) && r.Status === 'approved'; }),
      unlockPending: rows.some(function (r) { return isToday(r) && r.Status === 'pending'; })
    },
    bonus: {
      // 昨日まで2日続いていれば、今日のお手伝いは「3日連続」の対象
      streakActive: streakBefore >= STREAK_DAYS_FOR_BONUS - 1,
      streakDays: streakBefore + (todayCount ? 1 : 0),
      sameDayActive: todayCount >= SAME_DAY_BONUS_FROM - 1,
      pendingMonths: unconfirmedBonusMonths_(rows)
    }
  };
}

function apiPressChore_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const chore = listChores_().filter(function (c) { return c.id === String(ctx.args.choreId); })[0];
  if (!chore) throw new Error('お手伝いの種類が見つかりません。');

  const isParent = me.Role === 'parent';
  if (!isParent) {
    const today = todayStr_();
    const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId && dayOf_(r.Timestamp) === today; });
    const count = rows.filter(isCountedChore_).length;
    const unlocked = rows.some(function (r) { return r.Type === 'unlock_request' && r.Status === 'approved'; });
    if (count >= DAILY_LIMIT && !unlocked) {
      throw new Error('今日はもう上限（' + DAILY_LIMIT + '回）だよ。もっとやりたい時は「親に追加をおねがいする」を押してね。');
    }
  }
  // 親が押した場合は、その親が承認したものとして記録する
  addLedger_({
    ChildId: child.UserId, Type: 'chore', ChoreId: chore.id, ChoreName: chore.name,
    Status: isParent ? 'approved' : 'pending', Amount: chore.amount,
    RequestedBy: me.Name, RequestedById: me.UserId,
    ApprovedBy: isParent ? me.Name : '', ApprovedAt: isParent ? new Date() : ''
  });
  return { message: isParent ? chore.name + '（' + chore.amount + '円）を記録しました。' : chore.name + '（' + chore.amount + '円）をおくったよ。親の承認をまってね。' };
}

function apiRequestUnlock_(ctx) {
  const me = requireUser_(ctx.token, 'child');
  const today = todayStr_();
  const mine = ledgerRows_().filter(function (r) {
    return String(r.ChildId) === me.UserId && r.Type === 'unlock_request' && dayOf_(r.Timestamp) === today;
  });
  if (mine.some(function (r) { return r.Status === 'approved'; })) return { message: '今日はもう追加の許可が出ているよ。' };
  if (mine.some(function (r) { return r.Status === 'pending'; })) return { message: 'もう親におねがいしているよ。承認をまってね。' };
  addLedger_({
    ChildId: me.UserId, Type: 'unlock_request', Status: 'pending', Amount: 0,
    Memo: '上限をこえてお手伝いしたい', RequestedBy: me.Name, RequestedById: me.UserId
  });
  return { message: '親に追加のおねがいをおくったよ。' };
}

function apiAddUsage_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const amount = -Math.abs(Math.round(Number(ctx.args.amount)));
  if (!amount) throw new Error('つかった金額を入力してね。');
  addLedger_({
    ChildId: child.UserId, Type: 'usage', Status: 'approved', Amount: amount,
    ChoreName: String(ctx.args.memo || '').trim(), Memo: '',
    RequestedBy: me.Name, RequestedById: me.UserId, ApprovedBy: me.Name, ApprovedAt: new Date()
  });
  return { message: 'きろくしたよ。' };
}

function apiCancelEntry_(ctx) {
  const me = requireUser_(ctx.token);
  const r = findLedger_(ctx.args.id);
  if (!canCancel_(r, me)) throw new Error('この記録は取り消せません。');
  updateRow_(SHEET_LEDGER, r._row, { Status: 'cancelled', Memo: appendMemo_(r.Memo, '［' + me.Name + 'が取消］') });
  return { message: '取り消しました。' };
}

// ===================== 親の操作 =====================

function apiPending_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const names = {};
  listUsers_().forEach(function (u) { names[u.UserId] = u.Name; });
  const rows = ledgerRows_().filter(function (r) { return !isTrue_(r.Hidden); });
  const byDateDesc = function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); };
  return {
    pending: rows.filter(function (r) { return r.Status === 'pending'; })
      .sort(function (a, b) { return new Date(a.Timestamp) - new Date(b.Timestamp); })
      .map(function (r) { return outRow_(r, me, names); }),
    // 申請中以外のすべての記録を「記録の日付」の新しい順に（ボーナスは翌月1日の位置に並ぶ）
    history: rows.filter(function (r) { return r.Status !== 'pending'; })
      .sort(byDateDesc)
      .slice(0, 200)
      .map(function (r) { return outRow_(r, me, names); })
  };
}

/** 申請中・却下済みを承認にする（間違えて却下したものの再承認も可） */
function apiApprove_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  if (r.Status !== 'pending' && r.Status !== 'rejected') throw new Error('この記録は承認できません。');
  const patch = { Status: 'approved', ApprovedBy: me.Name, ApprovedAt: new Date() };
  if (r.Status === 'rejected') patch.Memo = appendMemo_(r.Memo, '［' + me.Name + 'が再承認］');
  updateRow_(SHEET_LEDGER, r._row, patch);
  return { message: r.Status === 'rejected' ? '再承認しました。' : '承認しました。' };
}

/** 申請中・承認済みを却下にする（承認済み⇔却下は何度でも入れ替えられる） */
function apiReject_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  if (r.Status !== 'pending' && r.Status !== 'approved') throw new Error('この記録は却下できません。');
  updateRow_(SHEET_LEDGER, r._row, {
    Status: 'rejected', ApprovedBy: me.Name, ApprovedAt: new Date(),
    Memo: appendMemo_(r.Memo, ctx.args.reason ? '［却下理由: ' + ctx.args.reason + '］' : '［' + me.Name + 'が却下］')
  });
  return { message: '却下しました。' };
}

/**
 * 項目名・金額・日付（月日のみ。年と時刻は元のまま）を書き換える。
 * 親：取消以外のすべての記録。子供：自分が押した申請中のお手伝いの日付だけ。
 */
function apiEditEntry_(ctx) {
  const me = requireUser_(ctx.token);
  const r = findLedger_(ctx.args.id);
  const isParent = me.Role === 'parent';
  if (isParent && r.Status !== 'pending' && r.Status !== 'approved') throw new Error('却下・取消の記録は編集できません（先に承認してください）。');
  if (!isParent && !canChildEditDate_(r, me)) throw new Error('この記録は編集できません。');
  const a = ctx.args;
  const patch = {};
  if (isParent && a.name !== undefined && String(a.name).trim() && String(a.name).trim() !== labelOf_(r)) {
    patch.ChoreName = String(a.name).trim();
  }
  if (isParent && a.amount !== undefined && a.amount !== '') {
    let n = Math.round(Number(a.amount));
    if (!isFinite(n)) throw new Error('金額は数字で入力してください。');
    if (r.Type === 'usage') n = -Math.abs(n);
    if (n !== Number(r.Amount)) patch.Amount = n;
  }
  if (a.month && a.day) {
    const old = new Date(r.Timestamp);
    const year = Utilities.formatDate(old, tz_(), 'yyyy');
    const time = Utilities.formatDate(old, tz_(), 'HH:mm:ss');
    const m = Number(a.month);
    const d = Number(a.day);
    const probe = new Date(Date.UTC(Number(year), m - 1, d));
    if (probe.getUTCMonth() !== m - 1) throw new Error('その日付はありません。');
    const ts = parseLocal_(year + '-' + pad2_(m) + '-' + pad2_(d) + ' ' + time);
    if (ts.getTime() > Date.now()) throw new Error('未来の日付にはできません。');
    if (dayOf_(ts) !== dayOf_(old)) patch.Timestamp = ts;
  }
  if (!Object.keys(patch).length) return { message: '変更はありませんでした。' };
  patch.Memo = appendMemo_(r.Memo, '［' + me.Name + '編集済み］');
  updateRow_(SHEET_LEDGER, r._row, patch);
  return { message: '編集しました。' };
}

function apiRevertEntry_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  if (r.Status !== 'approved') throw new Error('承認済みの記録のみ、未承認に戻せます。');
  updateRow_(SHEET_LEDGER, r._row, {
    Status: 'pending', ApprovedBy: '', ApprovedAt: '', Memo: appendMemo_(r.Memo, '［' + me.Name + 'が未承認に戻した］')
  });
  return { message: '未承認に戻しました。' };
}

function apiHideEntry_(ctx) {
  requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  updateRow_(SHEET_LEDGER, r._row, { Hidden: true });
  return { message: '非表示にしました。' };
}

function apiAddAdjustment_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const child = targetChild_(me, ctx.args.childId);
  const amount = Math.round(Number(ctx.args.amount));
  if (!amount) throw new Error('金額を入力してください（マイナスも可）。');
  addLedger_({
    ChildId: child.UserId, Type: 'adjustment', Status: 'approved', Amount: amount,
    ChoreName: String(ctx.args.memo || '').trim() || '残高調整',
    RequestedBy: me.Name, RequestedById: me.UserId, ApprovedBy: me.Name, ApprovedAt: new Date()
  });
  return { message: '残高を調整しました。' };
}

// ===================== 設定 =====================

function apiSettings_(ctx) {
  requireUser_(ctx.token, 'parent');
  const g = globalPinLockUntil_();
  return {
    appName: appName_(), appIcon: appIcon_(), spreadsheetUrl: ss_().getUrl(), devices: listDevices_(),
    globalLockUntil: g ? new Date(g).toISOString() : '', version: SERVER_VERSION
  };
}

/** アプリ名とアイコン（絵文字＋背景色）を保存。画面側がショートカット用の情報に反映する */
function apiSetAppName_(ctx) {
  requireUser_(ctx.token, 'parent');
  const name = String(ctx.args.name || '').trim();
  if (!name || name.length > 30) throw new Error('アプリ名は1〜30文字で入力してください。');
  props_().setProperty('APP_NAME', name);
  if (ctx.args.emoji !== undefined || ctx.args.color !== undefined) {
    const emoji = String(ctx.args.emoji || '').trim().substring(0, 8);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(ctx.args.color)) ? String(ctx.args.color) : '';
    props_().setProperty('APP_ICON', JSON.stringify({ emoji: emoji, color: color }));
  }
  return { appName: name, appIcon: appIcon_() };
}

/** 端末ロックの解除。deviceId が '*' のときは全体ロックを解除する */
function apiUnlockDevice_(ctx) {
  requireUser_(ctx.token, 'parent');
  if (ctx.args.deviceId === '*') {
    props_().deleteProperty('PIN_GLOBAL_LOCK_UNTIL');
    CacheService.getScriptCache().remove('pin_fail_global');
    return { message: '全体のPINロックを解除しました。' };
  }
  saveDeviceState_(ctx.args.deviceId, { FailCount: 0, LockUntil: '', HardLocked: false });
  return { message: 'ロックを解除しました。' };
}

function apiRepair_(ctx) {
  requireUser_(ctx.token, 'parent');
  return { report: repairSheets_() };
}

// ===================== PIN端末の状態 =====================

function getDeviceState_(deviceId) {
  return readTable_(SHEET_DEVICES).rows.filter(function (r) { return String(r.DeviceId) === deviceId; })[0] ||
    { DeviceId: deviceId, FailCount: 0, LockUntil: '', HardLocked: false, _row: null };
}

function saveDeviceState_(deviceId, patch) {
  const state = getDeviceState_(deviceId);
  const row = Object.assign({ DeviceId: deviceId }, patch, { UpdatedAt: new Date() });
  if (state._row) updateRow_(SHEET_DEVICES, state._row, row);
  else appendRow_(SHEET_DEVICES, row);
  cleanupDevices_();
}

/** 端末行が DEVICE_MAX_ROWS を超えたら古い順に黙って削除 */
function cleanupDevices_() {
  const sh = ss_().getSheetByName(SHEET_DEVICES);
  if (!sh) return;
  const rows = readTable_(SHEET_DEVICES).rows.filter(function (r) { return r.DeviceId; });
  if (rows.length <= DEVICE_MAX_ROWS) return;
  rows.sort(function (a, b) { return new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0); })
    .slice(DEVICE_MAX_ROWS)
    .map(function (r) { return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (rowIndex) { sh.deleteRow(rowIndex); });
  invalidate_(SHEET_DEVICES);
}

function listDevices_() {
  const now = Date.now();
  const all = readTable_(SHEET_DEVICES).rows.filter(function (r) { return r.DeviceId; })
    .sort(function (a, b) { return new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0); });
  const cutoff = now - DEVICE_RECENT_DAYS * 24 * 60 * 60 * 1000;
  let list = all.filter(function (r) { return new Date(r.UpdatedAt || 0).getTime() >= cutoff; });
  if (!list.length) list = all.slice(0, 3);
  return list.map(function (d) {
    const hard = isTrue_(d.HardLocked);
    const until = Number(d.LockUntil) || 0;
    return {
      deviceId: String(d.DeviceId), shortId: String(d.DeviceId).substring(0, 8),
      failCount: Number(d.FailCount) || 0, hardLocked: hard,
      lockedUntil: until > now ? new Date(until).toISOString() : '',
      locked: hard || until > now, updatedAt: toIso_(d.UpdatedAt)
    };
  });
}

// ===================== 自動非表示（日次トリガー） =====================

/** 却下・取消から AUTO_HIDE_AFTER_DAYS 日経った記録を Hidden にする（残高には影響しない） */
function autoHideOldEntries() {
  const cutoff = dayAdd_(todayStr_(), -AUTO_HIDE_AFTER_DAYS);
  ledgerRows_().forEach(function (r) {
    if ((r.Status === 'rejected' || r.Status === 'cancelled') && !isTrue_(r.Hidden) && dayOf_(r.ApprovedAt || r.Timestamp) <= cutoff) {
      updateRow_(SHEET_LEDGER, r._row, { Hidden: true });
    }
  });
}
