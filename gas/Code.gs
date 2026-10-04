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
 *   OWNER_USER_ID / OWNER_NAME … マスター（スプレッドシートの持ち主）のIDと表示名。マスターはUsersシートに入れない。
 *   HISTORY_LIMIT       … りれきに表示する件数（それより古いものは表示しない）。設定タブから変更。既定 30
 *   BONUS_SAME_DAY_ENABLED / BONUS_STREAK_ENABLED … 「1日3回目」「3日連続」ボーナスの有効/無効（'false' で無効）
 *   ALLOWANCE_ENABLED / ALLOWANCE_AMOUNT / ALLOWANCE_DAY / ALLOWANCE_START … 定期おこづかい（金額・毎月の支給日・開始年月 yyyy-MM）
 *   INTEREST_YEN_RATE / INTEREST_YEN_START … りそく（月の%。0か空＝なし）と付け始めた月（yyyy-MM）。設定タブから変更
 *   DROP_TEST_BOOST     … ずかんの落下物の確率を何倍にするか（お試し用。ふだんは空＝1倍。新しく引くくじだけに効く）
 *   CONFIRM_USED_<ユーザーID> … v3.5.2 までの「使った月」の印。v3.5.3 からは PICKS_ だけで判定する（読まない）
 *   PICKS_<ユーザーID>        … ゴールデンチケットでえらんだもの [{ym, id, at}]。ずかんに足される（手で触らない）
 *   CONFIRM_ARMED_<ユーザーID> … v3.4 の確定開き（つぎの承認でレアが落ちる）。v3.5.3 で廃止（見つけたら消す）
 *   CONFIRMED_<子供ID>  … v3.3 の確定開きの結果（v3.3 までの記録を読むためだけに使う）
 *   sess_<token>        … ログインセッション。自動で作成・削除される（手で触らない）。
 *
 * ── シート ──
 *   Users          … UserId / Email / Name / Role(parent|child) / Active / Pin(4桁・書式なしテキスト)（マスター以外の親と子供）
 *   ChoreMaster    … ChoreId / Name / BaseAmount / Active / DailyMax（家族で1日○回まで。空＝上限なし）
 *   Ledger         … 全ての記録（お金の出入り・申請・ボーナス・りそく）。残高は Status=approved の Amount 合計。
 *                    Thanks＝親が承認のときに送った「ありがとう」
 *   PinDeviceState … PIN入力の失敗回数・ロック状態（端末＝ブラウザ単位）。TotalFails＝これまでの失敗の合計、Hidden＝親が一覧から隠した
 */

// ===================== 設定値 =====================
const SERVER_VERSION = '3.5.3';

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
  // DailyMax … 家族（兄弟みんな）で1日○回まで（空＝上限なし）
  ChoreMaster: ['ChoreId', 'Name', 'BaseAmount', 'Active', 'DailyMax'],
  // RequestedById … 押した（記録した）人のUserId。「押した本人なら取り消せる」の判定に使う。
  // Thanks … 親が承認のときに送った「ありがとう」スタンプ・ひとこと
  // ApprovedById … 最後に承認・却下した人のUserId（システムは system）。Drops / ParentDrops … ずかんの落下物（ずかんの説明を参照）
  Ledger: ['Id', 'Timestamp', 'ChildId', 'Type', 'ChoreId', 'ChoreName', 'Status', 'Amount', 'Memo',
    'RequestedBy', 'ApprovedBy', 'ApprovedAt', 'Hidden', 'RequestedById', 'Thanks', 'ApprovedById', 'Drops', 'ParentDrops'],
  PinDeviceState: ['DeviceId', 'FailCount', 'LockUntil', 'HardLocked', 'UpdatedAt', 'TotalFails', 'Hidden']
};

// [名前, 金額, 家族で1日○回まで]
const DEFAULT_CHORES = [
  ['ゴミ捨て', 30, 1], ['お風呂掃除', 30, 1], ['料理', 100, 1], ['食器洗い', 30, 2], ['洗濯物たたみ', 30, 1],
  ['掃除機がけ', 30, 1], ['布団干し', 30, 1], ['玄関掃除', 30, 1], ['ペットのお世話', 30, 2], ['草むしり', 30, 1]
];

// 承認のときに親が「ありがとう」をえらばなかったら、この中からランダムで送る（画面のスタンプも同じ）
const THANKS_DEFAULTS = ['ありがとう！', 'たすかったよ！', 'さすが！', 'ピカピカだね✨', 'いつもえらいね', 'またおねがいね'];

// りそく（月末の残高に月○%。親が設定タブで決める）
const INTEREST_MAX_RATE = 20;
const INTEREST_PREFIX = 'interest:'; // りそく行の ChoreId（interest:yen:yyyy-MM）。この行があれば「受取済み」

// ずかん（落下物）。承認されたお手伝い・うけとったボーナス・おこづかい1件につき子供に DROPS_CHILD こ、
// お手伝いを承認した親に DROPS_PARENT こ落ちてくる。1こごとに SR 1/100・レア 1/10（DROP_TEST_BOOST で何倍にもできる。お試し用）。
// レアの中は ★1:★2:★3 ＝ 3:2:1 の出やすさ（RARE_WEIGHT）。くじは承認したときに引いて Ledger に保存する
const DROPS_CHILD = 5;
const DROPS_PARENT = 2;
const DROP_SR_PER_100K = 1000;    // 1/100
const DROP_RARE_PER_100K = 10000; // 1/10
const RARE_WEIGHT = { 1: 3, 2: 2, 3: 1 };
// ずかんの一覧 [ずかんID, ランク(1〜3＝レア★1〜★3, 4＝SR)]。画面側の zukan.js と同じ順番・同じID。
// ID と順番は変えない（v3.3 までの記録はこの順番の番号で読む）。新しく足すときは最後に追加し、zukan.js にも足す
const ZUKAN_POOL = [
  ['star', 1], ['pig', 1], ['cat', 1], ['dog', 1], ['onigiri', 1], ['apple', 1],
  ['banana', 1], ['frog', 1], ['fish', 1], ['sakura', 1], ['strawberry', 1], ['penguin', 1],
  ['elephant', 1], ['giraffe', 1], ['panda', 1], ['koala', 1], ['rabbit', 1], ['turtle', 1],
  ['snail', 1], ['honeybee', 1], ['ladybug', 1], ['butterfly', 1], ['ant', 1], ['donut', 1],
  ['pizza', 1], ['softcream', 1], ['chocolate', 1], ['egg', 1], ['bread', 1], ['watermelon', 1],
  ['corn', 1], ['carrot', 1], ['mushroom', 1], ['sunflower', 1], ['rainbow', 1], ['cloud', 1],
  ['sun', 1], ['moon', 1], ['snowman', 1], ['balloon', 1], ['socks', 1], ['toothbrush', 1],
  ['toiletpaper', 1], ['pencil', 1], ['rice', 1], ['owl', 2], ['octopus', 2], ['squid', 2],
  ['shark', 2], ['dolphin', 2], ['whale', 2], ['flamingo', 2], ['sloth', 2], ['hedgehog', 2],
  ['otter', 2], ['camel', 2], ['kangaroo', 2], ['crocodile', 2], ['parrot', 2], ['rooster', 2],
  ['duck', 2], ['squirrel', 2], ['bat', 2], ['snake', 2], ['crab', 2], ['shrimp', 2],
  ['pufferfish', 2], ['volcano', 2], ['cactus', 2], ['pineapple', 2], ['avocado', 2], ['cheese', 2],
  ['honey', 2], ['tornado', 2], ['snowflake', 2], ['unicorn', 3], ['dragon', 3], ['mermaid', 3],
  ['fairy', 3], ['genie', 3], ['ghost', 3], ['alien', 3], ['trex', 3], ['plesiosaur', 3],
  ['mammoth', 3], ['peacock', 3], ['saturn', 3], ['comet', 3], ['shootingstar', 3], ['wizard', 3],
  ['crown', 4], ['diamond', 4], ['trophy', 4], ['milkyway', 4], ['crystalball', 4], ['key', 4],
  ['gift', 4], ['moneybag', 4], ['miraclestar', 4], ['clover', 4]
];
const ZUKAN_TIER = {};
ZUKAN_POOL.forEach(function (p) { ZUKAN_TIER[p[0]] = p[1]; });

// お手伝いの回数制限（子供が押すとき。親が代わりに押す場合は制限しない）
const DAILY_LIMIT = 3;

// 月初ボーナス（前月分をまとめて計算し、翌月1日付で1行記録する）
const SAME_DAY_BONUS_FROM = 3;     // 同じ日の3回目以降のお手伝い1回ごとに…
const SAME_DAY_BONUS_AMOUNT = 10;  // …+10円
const STREAK_DAYS_FOR_BONUS = 3;   // 3日以上連続した日のお手伝い1回ごとに…
const STREAK_BONUS_AMOUNT = 10;    // …+10円
const BONUS_CHORE_PREFIX = 'bonus:'; // ボーナス行の ChoreId（bonus:yyyy-MM）。この行があれば「処理済み」
const ALLOWANCE_CHORE_PREFIX = 'allowance:'; // 定期おこづかい行の ChoreId（allowance:yyyy-MM）。この行があれば「支給済み」
const DEFAULT_HISTORY_LIMIT = 30;    // りれきの表示件数（設定タブで変更）
const PARENT_RECENT_LIMIT = 3;       // 親の承認待ちタブの下に出す最新りれきの件数

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
const DEVICE_MAX_ROWS = 30;         // これを超えたら、失敗のない端末→親が隠した端末の古い順に黙って削除

// 却下・取消から何日で履歴から自動的に隠すか（日次トリガー）
const AUTO_HIDE_AFTER_DAYS = 30;

// ===================== 入口 =====================

const API = {
  // ログイン不要
  config: apiConfig_, authNonce: apiAuthNonce_, googleLogin: apiGoogleLogin_, pinLogin: apiPinLogin_,
  resume: apiResume_, logout: apiLogout_,
  // 子供・親
  dashboard: apiDashboard_, dashboardExtras: apiDashboardExtras_, dayEntries: apiDayEntries_, pressChore: apiPressChore_, requestUnlock: apiRequestUnlock_,
  addUsage: apiAddUsage_, cancelEntry: apiCancelEntry_, confirmBonus: apiConfirmBonus_,
  receiveAllowance: apiReceiveAllowance_, changeMyPin: apiChangeMyPin_,
  receiveInterest: apiReceiveInterest_, useConfirm: apiUseConfirm_,
  // 親のみ
  zukan: apiZukan_,
  pending: apiPending_, approve: apiApprove_, reject: apiReject_, editEntry: apiEditEntry_,
  revertEntry: apiRevertEntry_, hideEntry: apiHideEntry_, addAdjustment: apiAddAdjustment_,
  saveChore: apiSaveChore_, deleteChore: apiDeleteChore_,
  users: apiUsers_, upsertUser: apiUpsertUser_, deactivateUser: apiDeactivateUser_,
  settings: apiSettings_, setAppName: apiSetAppName_, saveSettings: apiSaveSettings_,
  unlockDevice: apiUnlockDevice_, hideDevice: apiHideDevice_, repair: apiRepair_
};
// 書き込み系はスクリプトロックで直列化し、requestId による二重送信防止をかける
const WRITE_ACTIONS = {
  googleLogin: 1, pinLogin: 1, pressChore: 1, requestUnlock: 1, addUsage: 1, cancelEntry: 1, confirmBonus: 1,
  approve: 1, reject: 1, editEntry: 1, revertEntry: 1, hideEntry: 1, addAdjustment: 1, saveChore: 1,
  deleteChore: 1, upsertUser: 1, deactivateUser: 1, setAppName: 1, unlockDevice: 1, repair: 1,
  receiveAllowance: 1, changeMyPin: 1, saveSettings: 1, hideDevice: 1, receiveInterest: 1, useConfirm: 1
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

  // マスター（持ち主）はUsersシートに入れない。旧版で登録されていた行があれば、IDと表示名を引き継いで外す
  const owner = ownerEmail_();
  if (owner) {
    const ownerRows = readTable_(SHEET_USERS).rows.filter(function (u) { return normalizeEmail_(u.Email) === owner; });
    ownerRows.sort(function (a, b) { return b._row - a._row; }).forEach(function (u) {
      if (!props_().getProperty('OWNER_USER_ID') && u.UserId) {
        props_().setProperty('OWNER_USER_ID', String(u.UserId));
        props_().setProperty('OWNER_NAME', String(u.Name || ''));
      }
      ss.getSheetByName(SHEET_USERS).deleteRow(u._row);
      report.push('マスター（持ち主）の行をUsersシートから外し、設定に移しました（「' + u.Name + '」）');
    });
    invalidate_(SHEET_USERS);
  }

  // PINの先頭0が消えないよう、Pin列を書式なしテキストにする
  const users = ss.getSheetByName(SHEET_USERS);
  const pinCol = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0].indexOf('Pin') + 1;
  if (pinCol > 0) users.getRange(1, pinCol, users.getMaxRows(), 1).setNumberFormat('@');

  // お手伝いマスタ：空なら初期値、IDが重複していれば後ろの方を振り直す
  const chores = readTable_(SHEET_CHORES);
  if (!chores.rows.length) {
    DEFAULT_CHORES.forEach(function (c, i) {
      appendRow_(SHEET_CHORES, { ChoreId: 'c' + pad2_(i + 1), Name: c[0], BaseAmount: c[1], Active: true, DailyMax: c[2] || '' });
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
  backfillDrops_(report); // v3.3 までの記録のずかんの結果を保存
  if (!report.length) report.push('修正が必要な箇所はありませんでした');
  return report;
}

/**
 * シートが揃っているか・初期設定済みか（config で画面に返す）。
 * 初期設定済み＝マスター（持ち主）が一度ログインしてシートを整えた（OWNER_USER_ID がある）
 */
function setupStatus_() {
  const ss = ss_();
  const sheetsOk = Object.keys(HEADERS).every(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() === 0) return false;
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    return HEADERS[name].every(function (h) { return have.indexOf(h) !== -1; });
  });
  return { sheetsOk: sheetsOk, hasParent: !!props_().getProperty('OWNER_USER_ID') };
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
function invalidate_(name) {
  delete TABLE_CACHE_[name];
  if (name === SHEET_LEDGER) delete TABLE_CACHE_.__collections; // ずかんの集計も読み直す
}

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
  const isOwner = normalizeEmail_(info.email) === ownerEmail_();
  if (!status.sheetsOk || !status.hasParent) {
    // 「初期設定」はマスター（スプレッドシートの持ち主）だけが行える
    if (!isOwner) {
      throw new Error('まだ初期設定がされていません。このスプレッドシートの持ち主のGoogleアカウント（' + maskEmail_(ownerEmail_()) + '）で「初期設定」を押してください。');
    }
    repairSheets_();
    if (!props_().getProperty('OWNER_USER_ID')) {
      props_().setProperty('OWNER_USER_ID', 'owner');
      props_().setProperty('OWNER_NAME', info.name || info.email.split('@')[0]);
    }
  }
  const user = findUserByEmail_(info.email);
  if (!user || !isActive_(user)) {
    // この家族に登録されていない人（未登録の家族 or ほかの家庭の人）。画面で「新しく作る」を選べるようにする
    return { notRegistered: true, email: info.email };
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
  // 1度でも失敗した端末は親の一覧に出す（親が隠していても、また失敗したら出す）
  saveDeviceState_(deviceId, { FailCount: fails, LockUntil: until, HardLocked: hard, TotalFails: Number(state.TotalFails || 0) + 1, Hidden: false });
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

/** マスター＝このスプレッドシートの持ち主。取れない環境では実行ユーザー（デプロイした人）を使う */
let OWNER_EMAIL_CACHE_ = null; // 1回のリクエスト内だけ使う
function ownerEmail_() {
  if (OWNER_EMAIL_CACHE_ !== null) return OWNER_EMAIL_CACHE_;
  let email = '';
  try { const o = ss_().getOwner(); email = o ? o.getEmail() : ''; } catch (e) { /* 共有ドライブなど */ }
  if (!email) { try { email = Session.getEffectiveUser().getEmail(); } catch (e) { /* 取得できない */ } }
  OWNER_EMAIL_CACHE_ = normalizeEmail_(email);
  return OWNER_EMAIL_CACHE_;
}
function ownerId_() { return props_().getProperty('OWNER_USER_ID') || 'owner'; }
/** マスターの利用者情報（Usersシートには無い。アプリからは変更・削除・無効化できない） */
function ownerUser_() {
  const email = ownerEmail_();
  return {
    UserId: ownerId_(), Email: email, Name: props_().getProperty('OWNER_NAME') || (email ? email.split('@')[0] : 'マスター'),
    Role: 'parent', Active: true, Pin: '', isOwner: true
  };
}
/** Usersシートの利用者（マスター以外の親と子供） */
function listUsers_() {
  const owner = ownerEmail_();
  return readTable_(SHEET_USERS).rows.filter(function (u) {
    return u.UserId && !(owner && normalizeEmail_(u.Email) === owner);
  }).map(function (u) {
    u.UserId = String(u.UserId);
    return u;
  });
}
/** マスターを含む全員 */
function allUsers_() { return [ownerUser_()].concat(listUsers_()); }
function findUserById_(id) {
  return allUsers_().filter(function (u) { return u.UserId === String(id); })[0] || null;
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
  return allUsers_().filter(function (u) { return normalizeEmail_(u.Email) === n; })[0] || null;
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
    me: { id: me.UserId, name: me.Name, email: me.Email, isOwner: !!me.isOwner },
    // 親には子供のPINも見せる（子供が自分で変えた番号を親が確認できるように）
    children: users.filter(function (u) { return u.Role === 'child'; }).map(function (u) {
      const pin = u.Pin !== '' && u.Pin != null ? normalizePin_(u.Pin) : '';
      return { id: u.UserId, name: u.Name, email: u.Email || '', hasPin: !!pin, pin: pin, active: isActive_(u), balance: balances[u.UserId] || 0 };
    }),
    // マスターが先頭。マスターは変更・削除・無効化できない（表示名だけ本人が変えられる）
    parents: [ownerUser_()].concat(users.filter(function (u) { return u.Role === 'parent'; })).map(function (u) {
      return { id: u.UserId, name: u.Name, email: u.Email || '', active: isActive_(u), isMe: u.UserId === me.UserId, isOwner: !!u.isOwner };
    })
  };
}

/** 子供本人：自分のPIN（じぶんのばんごう）を変える。画面側で2回入力して一致したときだけ呼ぶ */
function apiChangeMyPin_(ctx) {
  const me = requireUser_(ctx.token, 'child');
  const pin = normalizePin_(ctx.args.pin);
  if (!/^\d{4}$/.test(pin)) throw new Error('4けたの数字にしてね。');
  const taken = listUsers_().some(function (u) {
    return u.UserId !== me.UserId && u.Role === 'child' && u.Pin !== '' && normalizePin_(u.Pin) === pin;
  });
  if (taken) throw new Error('その番号はつかえないよ。べつの番号にしてね。');
  updateRow_(SHEET_USERS, me._row, { Pin: pin });
  return { pin: pin, message: 'あなたが変更した番号は ' + pin + ' です' };
}

function apiUpsertUser_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const a = ctx.args;
  // マスター：変更できるのは本人の表示名だけ
  if (a.userId && String(a.userId) === ownerId_()) {
    if (!me.isOwner) throw new Error('マスター（持ち主）は変更できません。');
    const ownerName = String(a.name || '').trim();
    if (!ownerName) throw new Error('表示名を入力してください。');
    props_().setProperty('OWNER_NAME', ownerName);
    return { message: '表示名を変更しました。' };
  }
  if (a.email && normalizeEmail_(a.email) === ownerEmail_()) {
    throw new Error('そのメールアドレスはマスター（持ち主）です。登録する必要はありません。');
  }
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
  if (target.isOwner) throw new Error('マスター（持ち主）は無効にできません。');
  updateRow_(SHEET_USERS, target._row, { Active: false });
  return { message: '無効にしました。' };
}

function targetChild_(me, childId) {
  const id = String(childId || me.UserId);
  if (me.Role === 'child' && id !== me.UserId) throw new Error('自分以外のきろくは見られません。');
  const child = findUserById_(id);
  if (!child || child.Role !== 'child') throw new Error('子供のユーザーが見つかりません。');
  return child;
}

// ===================== お手伝いマスタ =====================

/** dailyMax … 家族（兄弟みんな）で1日に何回までか（0＝上限なし） */
function listChores_() {
  return readTable_(SHEET_CHORES).rows
    .filter(function (c) { return c.ChoreId && isActive_(c); })
    .map(function (c) {
      return { id: String(c.ChoreId), name: String(c.Name), amount: Number(c.BaseAmount) || 0,
        dailyMax: Math.max(0, Math.round(Number(c.DailyMax) || 0)) };
    });
}

/** 今日、家族みんなでそのお手伝いを何回したか・だれがしたか（申請中も数える） */
function choreTodayByFamily_() {
  const today = todayStr_();
  const names = {};
  allUsers_().forEach(function (u) { names[u.UserId] = u.Name; });
  const out = {};
  ledgerRows_().forEach(function (r) {
    if (!isCountedChore_(r) || dayOf_(r.Timestamp) !== today) return;
    const id = String(r.ChoreId);
    out[id] = out[id] || { count: 0, by: [] };
    out[id].count++;
    const n = names[String(r.ChildId)] || '';
    if (n && out[id].by.indexOf(n) < 0) out[id].by.push(n);
  });
  return out;
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
  const dailyMax = Math.round(Number(ctx.args.dailyMax || 0));
  if (!(dailyMax >= 0 && dailyMax <= 20)) throw new Error('家族で1日の回数は0〜20にしてください（0＝上限なし）。');
  const patch = { Name: name, BaseAmount: amount, Active: true, DailyMax: dailyMax || '' };
  if (ctx.args.choreId) {
    const row = readTable_(SHEET_CHORES).rows.filter(function (c) { return String(c.ChoreId) === String(ctx.args.choreId); })[0];
    if (!row) throw new Error('お手伝いが見つかりません。');
    updateRow_(SHEET_CHORES, row._row, patch);
  } else {
    appendRow_(SHEET_CHORES, Object.assign({ ChoreId: nextChoreId_() }, patch));
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
/** 記録を1行足す。承認済みで作る記録（親が記録・システムの受け取り）は、ここでずかんのくじも引く。足した行を返す */
function addLedger_(o) {
  const row = Object.assign({
    Id: newId_(), Timestamp: new Date(), ChoreId: '', ChoreName: '', Memo: '',
    ApprovedBy: '', ApprovedAt: '', Hidden: '', ApprovedById: ''
  }, o);
  Object.assign(row, rollOnApprove_(row));
  appendRow_(SHEET_LEDGER, row);
  return row;
}
function appendMemo_(memo, add) {
  memo = String(memo || '');
  return memo.endsWith(add) ? memo : memo + add; // 同じ追記が続かないように
}
/**
 * 承認・却下を切り替えたとき、前の「○○が却下」「○○が再承認」などの書き込みを消す。
 * 誰が最後に決めたかは ApprovedBy 列に残り、画面にも表示される（最後の1回分だけ残す）
 */
function stripDecisionMemo_(memo) {
  return String(memo || '').replace(/［[^［］]*?(が却下|が再承認|が承認|が未承認に戻した)］/g, '').replace(/［却下理由: [^［］]*］/g, '');
}
/** 残高に入る記録：承認済み＋子供が申請中の「つかった」（使ったお金はすぐ残高から引く） */
function inBalance_(r) { return r.Status === 'approved' || (r.Status === 'pending' && r.Type === 'usage'); }
/** ボーナスや回数制限の対象になる「お手伝い」（却下・取消は数えない） */
function isCountedChore_(r) { return r.Type === 'chore' && (r.Status === 'approved' || r.Status === 'pending'); }

function labelOf_(r) {
  if (r.ChoreName) return String(r.ChoreName);
  return { usage: 'つかった', adjustment: '残高調整', unlock_request: '上限追加のおねがい', bonus: 'ボーナス', allowance: 'おこづかい',
    interest: 'りそく' }[r.Type] || String(r.Type);
}

/**
 * 「取り消す」は子供だけ（親は却下を使う）。取り消せるのは親が承認する前の、自分で申請したものだけ。
 * 旧データの「つかった」は子供が押すと自動で承認済みになっていたので、承認者が本人のものは取り消せる。
 */
function canCancel_(r, viewer) {
  if (viewer.Role !== 'child' || String(r.ChildId) !== viewer.UserId) return false;
  if (r.Type === 'bonus' || r.Type === 'adjustment' || r.Type === 'allowance' || r.Type === 'interest') return false;
  const selfApprovedUsage = r.Type === 'usage' && r.Status === 'approved' && String(r.ApprovedBy) === String(viewer.Name);
  if (r.Status !== 'pending' && !selfApprovedUsage) return false;
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
  // 非表示にした記録は、承認・却下を切り替えられない（通信の遅れを使って「隠したまま残高に入る」操作を防ぐ）
  const hidden = isTrue_(r.Hidden);
  const o = {
    id: String(r.Id), ts: toIso_(r.Timestamp), day: dayOf_(r.Timestamp), type: r.Type,
    name: labelOf_(r), status: r.Status, amount: Number(r.Amount) || 0, memo: String(r.Memo || ''),
    requestedBy: String(r.RequestedBy || ''), approvedBy: String(r.ApprovedBy || ''),
    thanks: String(r.Thanks || ''),
    // この記録で子供に落ちたレア・SR（ずかんID。はずれはふくめない）と、1こ目が確定開きで出たものか
    drops: childDrops_(r).ids,
    confirmed: childDrops_(r).confirmed,
    canCancel: canCancel_(r, viewer),
    // 親のボタン：申請中＝承認・却下・編集／承認済み＝却下・編集／却下・取消＝承認（取消は除く）・非表示
    // 子供：自分が押した申請中のお手伝いの日付だけ
    editMode: isParent && (r.Status === 'pending' || r.Status === 'approved') ? 'full' : (canChildEditDate_(r, viewer) ? 'date' : ''),
    // 親は「承認済み⇔却下」を何度でも入れ替えられる（間違えて却下した時の再承認）
    canApprove: isParent && !hidden && (r.Status === 'pending' || r.Status === 'rejected'),
    canReject: isParent && !hidden && (r.Status === 'pending' || r.Status === 'approved'),
    canHide: isParent && !hidden && (r.Status === 'rejected' || r.Status === 'cancelled')
  };
  if (childNames) o.childName = childNames[String(r.ChildId)] || String(r.ChildId);
  return o;
}

// ===================== ずかん（落下物・確定開き） =====================
//
// v3.4 から：落ちたものは承認したときにくじを引いて Ledger に保存する（あとで確率や種類を変えても過去は変わらない）
//   Drops       … 子供の分（その記録の ChildId の子供）。ずかんID をカンマでつないだもの
//   ParentDrops … 承認した親の分。「親のUserId|ずかんID,ずかんID」
//   確定開きで出たものは先頭に「!」。くじを引いて何も出なかったら「-」（引きずみの印）
// v3.3 までに承認された記録（Drops が空）は、v3.3 のやり方（記録IDから計算）で読む。修復ボタンで Drops に書きこむ

/** 文字列から 0〜2^32-1 の数を作る（FNV-1a）。v3.3 までの記録を読むのに使う */
function hash32_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** お試し用に確率を何倍にするか（DROP_TEST_BOOST。ふだんは空＝1倍）。新しく引くくじだけに効く */
function dropBoost_() { const b = Number(props_().getProperty('DROP_TEST_BOOST') || 1); return b >= 1 && b <= 9 ? b : 1; }
/** 子供の分の落下物が出る記録：承認されたお手伝い・うけとったボーナス・おこづかい */
function dropsFor_(r) { return r.Status === 'approved' && (r.Type === 'chore' || r.Type === 'bonus' || r.Type === 'allowance'); }

/** "!octopus,pig" → {ids: ['octopus','pig'], confirmed: true} */
function parseDrops_(s) {
  s = String(s || '');
  if (!s || s === '-') return { ids: [], confirmed: false };
  const ids = s.split(',').filter(Boolean);
  const confirmed = ids.length > 0 && ids[0].charAt(0) === '!';
  return { ids: ids.map(function (x) { return x.replace(/^!/, ''); }).filter(function (x) { return ZUKAN_TIER[x]; }), confirmed: confirmed };
}
/** v3.3 までの記録：記録IDから計算（当時の確率 レア1/100・SR1/1000。番号は ZUKAN_POOL の順） */
function legacyDrops_(r) {
  const out = [];
  let confirmed = false;
  const fixed = legacyConfirmed_()[String(r.Id)];
  if (fixed !== undefined) { out.push(ZUKAN_POOL[fixed][0]); confirmed = true; }
  for (let k = fixed !== undefined ? 1 : 0; k < 5; k++) {
    const key = String(r.Id) + ':' + k;
    const roll = hash32_(key) % 100000;
    const pick = hash32_(key + ':item');
    let i = -1;
    if (roll < 100) i = 90 + pick % 10;
    else if (roll < 1100) { const w = pick % 210; i = w < 135 ? Math.floor(w / 3) : w < 195 ? 45 + Math.floor((w - 135) / 2) : 75 + (w - 195); }
    if (i >= 0) out.push(ZUKAN_POOL[i][0]);
  }
  return { ids: out, confirmed: confirmed };
}
/** v3.3 の確定開きの結果（スクリプトプロパティ CONFIRMED_<子供ID> = [{row, item: 番号}]） */
function legacyConfirmed_() {
  if (!TABLE_CACHE_.__legacyConfirmed) {
    const m = {};
    const all = props_().getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('CONFIRMED_') !== 0) return;
      try { JSON.parse(all[k]).forEach(function (e) { if (typeof e.item === 'number') m[e.row] = e.item; }); } catch (e) { /* 壊れていたら無視 */ }
    });
    TABLE_CACHE_.__legacyConfirmed = m;
  }
  return TABLE_CACHE_.__legacyConfirmed;
}
/** その記録で子供に落ちたもの */
function childDrops_(r) {
  if (!dropsFor_(r)) return { ids: [], confirmed: false };
  return r.Drops ? parseDrops_(r.Drops) : legacyDrops_(r);
}
/** その記録で承認した親に落ちたもの {owner, ids, confirmed} */
function parentDrops_(r) {
  const s = String(r.ParentDrops || '');
  const bar = s.indexOf('|');
  if (r.Status !== 'approved' || r.Type !== 'chore' || bar < 0) return { owner: '', ids: [], confirmed: false };
  return Object.assign({ owner: s.substring(0, bar) }, parseDrops_(s.substring(bar + 1)));
}

/** 人ごとのずかん：その人のID → {ずかんID: 数}。子供は Drops、親は ParentDrops */
function collections_() {
  if (!TABLE_CACHE_.__collections) {
    const c = {};
    const add = function (who, ids) { if (!who) return; c[who] = c[who] || {}; ids.forEach(function (id) { c[who][id] = (c[who][id] || 0) + 1; }); };
    ledgerRows_().forEach(function (r) {
      add(String(r.ChildId), childDrops_(r).ids);
      const p = parentDrops_(r);
      add(p.owner, p.ids);
    });
    // ゴールデンチケットでえらんだもの
    const all = props_().getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('PICKS_') !== 0) return;
      add(k.substring(6), picksFrom_(all[k]).map(function (e) { return e.id; }));
    });
    TABLE_CACHE_.__collections = c;
  }
  return TABLE_CACHE_.__collections;
}
function collectionOf_(personId) { return collections_()[String(personId)] || {}; }

/** 家族（有効な子供と親）のほかの人が見つけたもの：ずかんID → 名前の一覧（シルエット表示用） */
function familyFound_(selfId) {
  const all = collections_();
  const out = {};
  allUsers_().filter(isActive_).forEach(function (u) {
    if (u.UserId === selfId) return;
    Object.keys(all[u.UserId] || {}).forEach(function (id) {
      out[id] = out[id] || [];
      if (out[id].indexOf(u.Name) < 0) out[id].push(u.Name);
    });
  });
  return out;
}

/** くじを n 回引く（1回ごとに SR 1/100・レア 1/10。レアの中は ★1:★2:★3 ＝ 3:2:1 の出やすさ） */
function drawItems_(n) {
  const boost = dropBoost_();
  const sr = ZUKAN_POOL.filter(function (p) { return p[1] === 4; });
  const rares = ZUKAN_POOL.filter(function (p) { return p[1] < 4; });
  const total = rares.reduce(function (t, p) { return t + RARE_WEIGHT[p[1]]; }, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    const roll = Math.random() * 100000;
    if (roll < DROP_SR_PER_100K * boost) out.push(sr[Math.floor(Math.random() * sr.length)][0]);
    else if (roll < (DROP_SR_PER_100K + DROP_RARE_PER_100K) * boost) {
      let w = Math.random() * total;
      for (let i = 0; i < rares.length; i++) { w -= RARE_WEIGHT[rares[i][1]]; if (w < 0) { out.push(rares[i][0]); break; } }
    }
  }
  return out;
}

/** 確定開き：待っているか（{armedAt, fromRow}） */
function armedOf_(personId) {
  try { return JSON.parse(props_().getProperty('CONFIRM_ARMED_' + personId) || 'null'); } catch (e) { return null; }
}
/** まだ持っていないレア（SRはのぞく） */
function missingRares_(personId) {
  const col = collectionOf_(personId);
  return ZUKAN_POOL.filter(function (p) { return p[1] < 4 && !col[p[0]]; }).map(function (p) { return p[0]; });
}
/** n 回くじを引く。確定開きを待っていれば1こ目を「まだ持っていないレア」にする。保存する文字列を返す */
function rollFor_(personId, n) {
  // v3.5.3：確定開き（CONFIRM_ARMED_）は廃止。残っていても使わずに消す
  if (armedOf_(personId)) props_().deleteProperty('CONFIRM_ARMED_' + personId);
  return drawItems_(n).join(',') || '-';
}

/**
 * 承認された記録にくじを引く（addLedger_ と承認のときに呼ぶ）。もう引いてある記録は引き直さない。
 * 子供の分は Drops、承認した人が親なら ParentDrops。追加で書く列を返す
 */
function rollOnApprove_(r) {
  const patch = {};
  if (r.Status !== 'approved') return patch;
  // 確定開きで出た記録を却下→再承認したときは、待っていた確定開きをもどす（前の結果がそのまま有効になる）
  [String(r.ChildId), String(r.ApprovedById || '')].forEach(function (who) {
    const a = who && armedOf_(who);
    if (a && a.fromRow === String(r.Id)) props_().deleteProperty('CONFIRM_ARMED_' + who);
  });
  if (dropsFor_(r) && !r.Drops) patch.Drops = rollFor_(String(r.ChildId), DROPS_CHILD);
  const approver = r.ApprovedById ? findUserById_(String(r.ApprovedById)) : null;
  if (r.Type === 'chore' && !r.ParentDrops && approver && approver.Role === 'parent') {
    patch.ParentDrops = approver.UserId + '|' + rollFor_(approver.UserId, DROPS_PARENT);
  }
  if (Object.keys(patch).length) delete TABLE_CACHE_.__collections;
  return patch;
}

/** 却下したとき：その記録で確定開きを使っていたら、もう一度待っている状態にもどす */
function rearmOnReject_(r) {
  return; // v3.5.3：確定開きは廃止したので、却下しても待ち状態にもどさない
  const fix = function (who, confirmed) {
    if (!who || !confirmed || armedOf_(who)) return;
    props_().setProperty('CONFIRM_ARMED_' + who, JSON.stringify({ armedAt: new Date().toISOString(), fromRow: String(r.Id) }));
  };
  if (r.Drops) fix(String(r.ChildId), parseDrops_(r.Drops).confirmed);
  const p = String(r.ParentDrops || '');
  if (p.indexOf('|') > 0) fix(p.substring(0, p.indexOf('|')), parseDrops_(p.substring(p.indexOf('|') + 1)).confirmed);
}

/** ゴールデンチケットでえらんだもの [{ym, id, at}]（こわれていたら空） */
function picksFrom_(json) {
  try { return (JSON.parse(json || '[]') || []).filter(function (e) { return e && ZUKAN_TIER[e.id]; }); } catch (e) { return []; }
}
function picksOf_(personId) { return picksFrom_(props_().getProperty('PICKS_' + personId)); }

/** 画面に出すずかん：自分の持ち物・家族が見つけたもの・ゴールデンチケット・確率 */
function zukanFor_(personId) {
  // v3.5.3：今月使ったかは、ゴールデンチケットでえらんだ記録（PICKS_）だけで決める。前の確定開きは消す
  if (armedOf_(personId)) props_().deleteProperty('CONFIRM_ARMED_' + personId);
  const armed = false;
  const picks = picksOf_(personId);
  const last = picks.length ? picks[picks.length - 1] : null;
  const usedThisMonth = !!(last && last.ym === thisMonth_());
  return {
    collection: collectionOf_(personId),
    familyFound: familyFound_(personId),
    // ticket：今月まだ使えるか・今月えらんだもの・つぎに使える月
    confirm: { armed: armed, usedThisMonth: usedThisMonth, available: !armed && !usedThisMonth,
      pickedThisMonth: last && last.ym === thisMonth_() ? last.id : '', nextMonth: monthAdd_(thisMonth_(), 1),
      picks: picks.length },
    rates: { child: DROPS_CHILD, parent: DROPS_PARENT, sr: DROP_SR_PER_100K * dropBoost_(), rare: DROP_RARE_PER_100K * dropBoost_() }
  };
}

/** 親が自分のずかんを見る */
function apiZukan_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  return zukanFor_(me.UserId);
}

/**
 * ゴールデンチケットを使う（月に1回）。えらんだレア（★1〜★3。SRはえらべない）をその場で1こもらえる。
 * 子供は自分の分、親は childId があればその子の分、なければ自分の分
 */
function apiUseConfirm_(ctx) {
  const me = requireUser_(ctx.token);
  const who = me.Role === 'parent' && !ctx.args.childId ? me.UserId : targetChild_(me, ctx.args.childId).UserId;
  const id = String(ctx.args.itemId || '');
  if (!ZUKAN_TIER[id]) throw new Error('えらんだものが見つからないよ。もう一度えらんでね。');
  if (ZUKAN_TIER[id] >= 4) throw new Error('SRはチケットではえらべないよ。じぶんの運でさがそう！');
  const z = zukanFor_(who);
  if (z.confirm.usedThisMonth) throw new Error('ゴールデンチケットは月に1まいだよ。来月1日にまたもらえるよ。');
  const picks = picksOf_(who);
  picks.push({ ym: thisMonth_(), id: id, at: new Date().toISOString() });
  props_().setProperty('PICKS_' + who, JSON.stringify(picks));
  props_().setProperty('CONFIRM_USED_' + who, thisMonth_());
  delete TABLE_CACHE_.__collections;
  return { message: 'ゲット！', itemId: id, zukan: zukanFor_(who) };
}

/** 修復：v3.3 までの承認済みの記録に、当時の計算結果を Drops として書きこむ（以後は読み直しても変わらない） */
function backfillDrops_(report) {
  const sh = ss_().getSheetByName(SHEET_LEDGER);
  const t = readTable_(SHEET_LEDGER);
  const col = t.headers.indexOf('Drops') + 1;
  if (col < 1 || !t.rows.length) return;
  let n = 0;
  const values = t.rows.map(function (r) {
    if (r.Drops || !dropsFor_(r)) return [r.Drops || ''];
    n++;
    const d = legacyDrops_(r);
    return [d.ids.length ? d.ids.map(function (id, k) { return (k === 0 && d.confirmed ? '!' : '') + id; }).join(',') : '-'];
  });
  if (!n) return;
  sh.getRange(2, col, values.length, 1).setValues(values);
  invalidate_(SHEET_LEDGER);
  report.push('これまでの記録 ' + n + '件のずかんの結果を保存しました');
}

// ===================== りそく（月末の残高に、月○%。親が設定タブで決める） =====================

function interestSettings_() {
  const p = props_();
  return { rate: Number(p.getProperty('INTEREST_YEN_RATE') || 0), start: p.getProperty('INTEREST_YEN_START') || '' };
}
function isInterestRow_(r) { return r.Type === 'interest' && String(r.ChoreId || '').indexOf(INTEREST_PREFIX + 'yen:') === 0; }

/**
 * まだ受け取っていないりそく（古い月から）。月末（翌月1日0時より前）の残高 × 月の% を切り捨て。
 * 受け取っていない前の月のりそくも、その次の月の残高にふくめて計算する（ふくり）
 */
function interestDue_(rows) {
  const s = interestSettings_();
  if (!(s.rate > 0) || !/^\d{4}-\d{2}$/.test(s.start)) return [];
  const mine = rows.filter(inBalance_);
  const done = {};
  rows.forEach(function (r) { if (isInterestRow_(r)) done[String(r.ChoreId).substring((INTEREST_PREFIX + 'yen:').length)] = true; });
  const out = [];
  let virtual = 0; // まだ受け取っていない前の月のりそく
  for (let ym = s.start, i = 0; ym < thisMonth_() && i < 120; ym = monthAdd_(ym, 1), i++) {
    if (done[ym]) continue;
    const end = parseLocal_(monthAdd_(ym, 1) + '-01 00:00:00').getTime();
    const bal = mine.reduce(function (t, r) { return new Date(r.Timestamp).getTime() < end ? t + (Number(r.Amount) || 0) : t; }, 0) + virtual;
    const amount = bal > 0 ? Math.floor(bal * s.rate / 100) : 0;
    if (amount <= 0) continue;
    virtual += amount;
    out.push({ ym: ym, label: Number(ym.substring(5)) + '月のりそく', amount: amount, base: bal, rate: s.rate });
  }
  return out;
}

/** 画面用：率・受け取れる分・これまでにりそくでふえた合計・月ごと・今月末このままなら */
function interestInfo_(rows) {
  const s = interestSettings_();
  const got = rows.filter(function (r) { return isInterestRow_(r) && r.Status === 'approved'; }).sort(byNewest_);
  const due = interestDue_(rows);
  const bal = rows.reduce(function (t, r) { return inBalance_(r) ? t + (Number(r.Amount) || 0) : t; }, 0) +
    due.reduce(function (t, d) { return t + d.amount; }, 0);
  return {
    rate: s.rate, on: s.rate > 0, due: due,
    total: got.reduce(function (t, r) { return t + (Number(r.Amount) || 0); }, 0),
    months: got.slice(0, 12).map(function (r) { return { label: String(r.ChoreName), amount: Number(r.Amount) || 0 }; }),
    estimate: s.rate > 0 && bal > 0 ? Math.floor(bal * s.rate / 100) : 0
  };
}

/** りそくを受け取る（たまっている月の分をまとめて。各月の翌月1日付で記録） */
function apiReceiveInterest_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const due = interestDue_(rows);
  if (!due.length) return { message: 'うけとれるりそくはありません。' };
  due.forEach(function (d) {
    addLedger_({
      Timestamp: parseLocal_(monthAdd_(d.ym, 1) + '-01 00:00:00'),
      ChildId: child.UserId, Type: 'interest', ChoreId: INTEREST_PREFIX + 'yen:' + d.ym, ChoreName: d.label,
      Status: 'approved', Amount: d.amount, Memo: d.label + '（' + d.base + '円 × ' + d.rate + '%）',
      RequestedBy: 'システム', RequestedById: 'system', ApprovedBy: 'システム', ApprovedById: 'system', ApprovedAt: new Date()
    });
  });
  const total = due.reduce(function (t, d) { return t + d.amount; }, 0);
  return { message: 'りそく +' + total + '円 をうけとったよ！' };
}

function balancesByChild_() {
  const b = {};
  ledgerRows_().forEach(function (r) {
    if (inBalance_(r)) b[String(r.ChildId)] = (b[String(r.ChildId)] || 0) + (Number(r.Amount) || 0);
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

/** 設定タブの「1日3回目ボーナス」「3日連続ボーナス」の有効/無効（既定は有効） */
function sameDayBonusOn_() { return props_().getProperty('BONUS_SAME_DAY_ENABLED') !== 'false'; }
function streakBonusOn_() { return props_().getProperty('BONUS_STREAK_ENABLED') !== 'false'; }

/** ym(yyyy-MM) のボーナスを計算。連続日数は前月から続いていても数える。無効にしたボーナスは0円 */
function calcMonthBonus_(byDay, ym) {
  let same = 0;
  let streak = 0;
  const sameOn = sameDayBonusOn_();
  const streakOn = streakBonusOn_();
  Object.keys(byDay).forEach(function (d) {
    if (d.substring(0, 7) !== ym) return;
    const n = byDay[d];
    if (sameOn && n >= SAME_DAY_BONUS_FROM) same += (n - SAME_DAY_BONUS_FROM + 1) * SAME_DAY_BONUS_AMOUNT;
    if (!streakOn) return;
    let len = 1;
    let c = dayAdd_(d, -1);
    while (byDay[c]) { len++; c = dayAdd_(c, -1); }
    if (len >= STREAK_DAYS_FOR_BONUS) streak += n * STREAK_BONUS_AMOUNT;
  });
  return { same: same, streak: streak, total: same + streak };
}

// ===================== 定期おこづかい =====================

function allowanceSettings_() {
  const p = props_();
  return {
    enabled: p.getProperty('ALLOWANCE_ENABLED') === 'true',
    amount: Number(p.getProperty('ALLOWANCE_AMOUNT') || 0),
    day: Number(p.getProperty('ALLOWANCE_DAY') || 1),
    start: p.getProperty('ALLOWANCE_START') || ''
  };
}
function daysInMonth_(ym) { const p = ym.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate(); }

/**
 * まだ受け取っていない定期おこづかい（古い月から）。支給日（その月に無い日は月末）を過ぎた月だけ。
 * 1度受け取った月は、あとで支給日を変えても2回目は出ない（allowance:yyyy-MM の行が印）
 */
function allowanceDue_(rows) {
  const s = allowanceSettings_();
  if (!s.enabled || !(s.amount > 0) || !/^\d{4}-\d{2}$/.test(s.start)) return [];
  const done = {};
  rows.forEach(function (r) {
    const id = String(r.ChoreId || '');
    if (r.Type === 'allowance' && id.indexOf(ALLOWANCE_CHORE_PREFIX) === 0) done[id.substring(ALLOWANCE_CHORE_PREFIX.length)] = true;
  });
  const today = todayStr_();
  const out = [];
  for (let ym = s.start, i = 0; ym <= today.substring(0, 7) && i < 60; ym = monthAdd_(ym, 1), i++) {
    if (done[ym]) continue;
    const payDay = ym + '-' + pad2_(Math.min(Math.max(s.day, 1), daysInMonth_(ym)));
    if (payDay > today) continue;
    out.push({ ym: ym, label: Number(ym.substring(5)) + '月のおこづかい', day: payDay, amount: s.amount });
  }
  return out;
}

/** 定期おこづかいを1か月分受け取る（押すたびに古い月から1回分。システムが承認） */
function apiReceiveAllowance_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const due = allowanceDue_(rows);
  if (!due.length) return { message: 'うけとれるおこづかいはありません。', remaining: 0 };
  const a = due[0];
  addLedger_({
    Timestamp: parseLocal_(a.day + ' 00:00:00'), // 登録された支給日で記録
    ChildId: child.UserId, Type: 'allowance', ChoreId: ALLOWANCE_CHORE_PREFIX + a.ym, ChoreName: a.label,
    Status: 'approved', Amount: a.amount, Memo: a.label + ' ' + a.amount + '円',
    RequestedBy: 'システム', RequestedById: 'system', ApprovedBy: 'システム', ApprovedById: 'system', ApprovedAt: new Date()
  });
  return { message: a.label + '（' + a.amount + '円）をうけとったよ！', remaining: due.length - 1 };
}

/** まだボーナス処理（0円も含む）がされていない、お手伝いをした過去の月 */
function unconfirmedBonusMonths_(rows) {
  if (!sameDayBonusOn_() && !streakBonusOn_()) return []; // ボーナスを両方とも無効にしている
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
      RequestedBy: 'システム', RequestedById: 'system', ApprovedBy: 'システム', ApprovedById: 'system', ApprovedAt: new Date()
    });
  });
  const total = months.reduce(function (s, m) { return s + m.amount; }, 0);
  return { message: months.length ? 'ボーナス ' + total + '円 をうけとったよ！' : 'かくにんするボーナスはありません。', count: months.length };
}

// ===================== 子供の画面（子供本人・親の両方から） =====================

function historyLimit_() {
  const n = Number(props_().getProperty('HISTORY_LIMIT') || DEFAULT_HISTORY_LIMIT);
  return n >= 5 && n <= 500 ? n : DEFAULT_HISTORY_LIMIT;
}
const byNewest_ = function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); };
/** 子供の画面の「おてつだい」タブに出す記録（それ以外は「ざんだか」タブ） */
function isChoreTab_(r) { return r.Type === 'chore' || r.Type === 'unlock_request'; }

/**
 * 子供の画面（最初に出す分）：残高・お手伝いボタン・りれき（最新 HISTORY_LIMIT 件）・カレンダー用の軽い一覧。
 * ボーナスやおこづかいの判定は、画面を出したあと dashboardExtras で取りに行く（表示を待たせないため）
 */
function apiDashboard_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const today = todayStr_();
  const todayCount = rows.filter(function (r) { return isCountedChore_(r) && dayOf_(r.Timestamp) === today; }).length;
  const isToday = function (r) { return r.Type === 'unlock_request' && dayOf_(r.Timestamp) === today; };
  const visible = rows.filter(function (r) { return !isTrue_(r.Hidden); }).sort(byNewest_);
  const limit = historyLimit_();
  // 「おてつだい」タブ（お手伝い・上限追加のおねがい）と「ざんだか」タブ（それ以外）で、それぞれ最新N件
  const choreRows = visible.filter(isChoreTab_).slice(0, limit);
  const moneyRows = visible.filter(function (r) { return !isChoreTab_(r); }).slice(0, limit);

  return {
    child: { id: child.UserId, name: child.Name },
    viewerRole: me.Role,
    balance: rows.reduce(function (s, r) { return inBalance_(r) ? s + (Number(r.Amount) || 0) : s; }, 0),
    chores: listChores_(),
    // 家族みんなの今日のお手伝い（兄弟がやって「家族で1日○回まで」に達したものは押せない）
    choreToday: choreTodayByFamily_(),
    // ちょきん計算き用：この家族のボーナスの有効/無効と金額
    bonusRules: {
      sameDay: sameDayBonusOn_(), sameDayFrom: SAME_DAY_BONUS_FROM, sameDayAmount: SAME_DAY_BONUS_AMOUNT,
      streak: streakBonusOn_(), streakDays: STREAK_DAYS_FOR_BONUS, streakAmount: STREAK_BONUS_AMOUNT
    },
    // ずかん（ずかんID → 持っている数）・家族が見つけたもの・確定開き・落ちる数と確率（1こあたり10万分の○）
    zukan: zukanFor_(child.UserId),
    // 表示件数より古いりれきは表示しない（非表示フラグは付けないので、カレンダーの日付からは見られる）
    history: choreRows.concat(moneyRows).sort(byNewest_).map(function (r) { return outRow_(r, me); }),
    historyLimit: limit,
    // カレンダー用（日付・種類・状態・金額だけ）。お手伝い・増えた・つかったの印を日ごとに付ける
    calendar: visible.map(function (r) { return [dayOf_(r.Timestamp), r.Type, r.Status, Number(r.Amount) || 0]; }),
    today: {
      day: today, count: todayCount, limit: DAILY_LIMIT,
      unlocked: rows.some(function (r) { return isToday(r) && r.Status === 'approved'; }),
      unlockPending: rows.some(function (r) { return isToday(r) && r.Status === 'pending'; })
    }
  };
}

/** 子供の画面（あとから出す分）：ボーナス発生中・月初ボーナスの確認・定期おこづかい */
function apiDashboardExtras_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId; });
  const today = todayStr_();
  const byDay = countByDay_(rows);
  let streakBefore = 0;
  for (let c = dayAdd_(today, -1); byDay[c]; c = dayAdd_(c, -1)) streakBefore++;
  const todayCount = byDay[today] || 0;
  return {
    bonus: {
      // 昨日まで2日続いていれば、今日のお手伝いは「3日連続」の対象
      streakActive: streakBonusOn_() && streakBefore >= STREAK_DAYS_FOR_BONUS - 1,
      streakDays: streakBefore + (todayCount ? 1 : 0),
      sameDayActive: sameDayBonusOn_() && todayCount >= SAME_DAY_BONUS_FROM - 1,
      pendingMonths: unconfirmedBonusMonths_(rows)
    },
    allowance: allowanceDue_(rows),
    interest: interestInfo_(rows)
  };
}

/** カレンダーで選んだ日の記録（りれきの表示件数より古い日を開いたとき用） */
function apiDayEntries_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const day = String(ctx.args.day || '');
  return ledgerRows_()
    .filter(function (r) { return String(r.ChildId) === child.UserId && !isTrue_(r.Hidden) && dayOf_(r.Timestamp) === day; })
    .sort(byNewest_)
    .map(function (r) { return outRow_(r, me); });
}

function apiPressChore_(ctx) {
  const me = requireUser_(ctx.token);
  const child = targetChild_(me, ctx.args.childId);
  const chore = listChores_().filter(function (c) { return c.id === String(ctx.args.choreId); })[0];
  if (!chore) throw new Error('お手伝いの種類が見つかりません。');

  const isParent = me.Role === 'parent';
  if (!isParent) {
    // 家族で1日○回まで（親が代わりに記録するときは止めない）
    const fam = choreTodayByFamily_()[chore.id];
    if (chore.dailyMax && fam && fam.count >= chore.dailyMax) {
      throw new Error('「' + chore.name + '」はきょう ' + fam.by.join('・') + ' がやったよ。ほかのお手伝いをえらんでね。');
    }
    const today = todayStr_();
    const rows = ledgerRows_().filter(function (r) { return String(r.ChildId) === child.UserId && dayOf_(r.Timestamp) === today; });
    const count = rows.filter(isCountedChore_).length;
    const unlocked = rows.some(function (r) { return r.Type === 'unlock_request' && r.Status === 'approved'; });
    if (count >= DAILY_LIMIT && !unlocked) {
      throw new Error('今日はもう上限（' + DAILY_LIMIT + '回）だよ。もっとやりたい時は「親に追加をおねがいする」を押してね。');
    }
  }
  // 親が押した場合は、その親が承認したものとして記録する（親のずかんのくじも引く）
  const row = addLedger_({
    ChildId: child.UserId, Type: 'chore', ChoreId: chore.id, ChoreName: chore.name,
    Status: isParent ? 'approved' : 'pending', Amount: chore.amount,
    RequestedBy: me.Name, RequestedById: me.UserId,
    ApprovedBy: isParent ? me.Name : '', ApprovedById: isParent ? me.UserId : '', ApprovedAt: isParent ? new Date() : ''
  });
  if (!isParent) return { message: chore.name + '（' + chore.amount + '円）をおくったよ。親の承認をまってね。' };
  return Object.assign({ message: chore.name + '（' + chore.amount + '円）を記録しました。' }, parentResult_(row, me));
}

/** 親が承認・記録したときに返す：その親に落ちたもの・親のずかん（画面のおいわい用） */
function parentResult_(row, me) {
  const p = parentDrops_(row);
  return { parentDrops: p.owner === me.UserId ? { ids: p.ids, confirmed: p.confirmed, count: DROPS_PARENT } : null, myCollection: collectionOf_(me.UserId) };
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
  // 子供が記録したものは申請中（残高からはすぐ引く）。親が承認すると子供は取り消せなくなる
  const isParent = me.Role === 'parent';
  addLedger_({
    ChildId: child.UserId, Type: 'usage', Status: isParent ? 'approved' : 'pending', Amount: amount,
    ChoreName: String(ctx.args.memo || '').trim(), Memo: '',
    RequestedBy: me.Name, RequestedById: me.UserId, ApprovedBy: isParent ? me.Name : '', ApprovedById: isParent ? me.UserId : '', ApprovedAt: isParent ? new Date() : ''
  });
  return { message: isParent ? 'きろくしました。' : 'きろくしたよ。親が確認するまでは自分で取り消せるよ。' };
}

function apiCancelEntry_(ctx) {
  const me = requireUser_(ctx.token);
  const r = findLedger_(ctx.args.id);
  if (!canCancel_(r, me)) throw new Error('この記録は取り消せません。');
  // 自分で取り消したものは、そのまま非表示にする（スプレッドシートには残る）
  updateRow_(SHEET_LEDGER, r._row, { Status: 'cancelled', Hidden: true, Memo: appendMemo_(r.Memo, '［' + me.Name + 'が取消］') });
  return { message: '取り消しました。' };
}

// ===================== 親の操作 =====================

function apiPending_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const names = {};
  allUsers_().forEach(function (u) { names[u.UserId] = u.Name; });
  const rows = ledgerRows_().filter(function (r) { return !isTrue_(r.Hidden); });
  const byDateDesc = function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); };
  return {
    pending: rows.filter(function (r) { return r.Status === 'pending'; })
      .sort(function (a, b) { return new Date(a.Timestamp) - new Date(b.Timestamp); })
      .map(function (r) { return outRow_(r, me, names); }),
    // 申請中以外の記録を「記録の日付」の新しい順に、最新の数件だけ（それより前は子の画面で見る・直す）
    history: rows.filter(function (r) { return r.Status !== 'pending'; })
      .sort(byDateDesc)
      .slice(0, PARENT_RECENT_LIMIT)
      .map(function (r) { return outRow_(r, me, names); })
  };
}

/** 申請中・却下済みを承認にする（間違えて却下したものの再承認も可） */
function apiApprove_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  if (isTrue_(r.Hidden)) throw new Error('非表示にした記録は、承認・却下を変更できません。');
  if (r.Status !== 'pending' && r.Status !== 'rejected') throw new Error('この記録は承認できません。');
  // 最後に決めた人だけを残す（ApprovedBy）。前の却下・再承認の書き込みは消す
  const patch = { Status: 'approved', ApprovedBy: me.Name, ApprovedById: me.UserId, ApprovedAt: new Date(), Memo: stripDecisionMemo_(r.Memo) };
  // 「ありがとう」。お手伝いで親がえらばなかったら、ランダムでどれかを送る（再承認で空なら前のまま）
  let thanks = String(ctx.args.thanks || '').trim().substring(0, 40);
  if (!thanks && !r.Thanks && r.Type === 'chore') thanks = THANKS_DEFAULTS[Math.floor(Math.random() * THANKS_DEFAULTS.length)];
  if (thanks) patch.Thanks = thanks;
  // ずかんのくじ（子供の分と、承認した親の分）。一度引いた記録は引き直さない
  Object.assign(patch, rollOnApprove_(Object.assign({}, r, patch)));
  updateRow_(SHEET_LEDGER, r._row, patch);
  return Object.assign({ message: r.Status === 'rejected' ? '再承認しました。' : '承認しました。' }, parentResult_(Object.assign({}, r, patch), me));
}

/** 申請中・承認済みを却下にする（承認済み⇔却下は何度でも入れ替えられる） */
function apiReject_(ctx) {
  const me = requireUser_(ctx.token, 'parent');
  const r = findLedger_(ctx.args.id);
  if (isTrue_(r.Hidden)) throw new Error('非表示にした記録は、承認・却下を変更できません。');
  if (r.Status !== 'pending' && r.Status !== 'approved') throw new Error('この記録は却下できません。');
  const base = stripDecisionMemo_(r.Memo);
  updateRow_(SHEET_LEDGER, r._row, {
    Status: 'rejected', ApprovedBy: me.Name, ApprovedById: me.UserId, ApprovedAt: new Date(),
    Memo: ctx.args.reason ? base + '［却下理由: ' + ctx.args.reason + '］' : base
  });
  // ずかんの落下物はその記録に残る（却下中は数えない）。確定開きで出ていたら、確定開きを待っている状態にもどす
  rearmOnReject_(r);
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
    Status: 'pending', ApprovedBy: '', ApprovedById: '', ApprovedAt: '', Memo: appendMemo_(r.Memo, '［' + me.Name + 'が未承認に戻した］')
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
    RequestedBy: me.Name, RequestedById: me.UserId, ApprovedBy: me.Name, ApprovedById: me.UserId, ApprovedAt: new Date()
  });
  return { message: '残高を調整しました。' };
}

// ===================== 設定 =====================

function apiSettings_(ctx) {
  requireUser_(ctx.token, 'parent');
  const g = globalPinLockUntil_();
  return {
    appName: appName_(), appIcon: appIcon_(), spreadsheetUrl: ss_().getUrl(), devices: listDevices_(),
    globalLockUntil: g ? new Date(g).toISOString() : '', version: SERVER_VERSION,
    bonusSameDay: sameDayBonusOn_(), bonusStreak: streakBonusOn_(),
    allowance: allowanceSettings_(), historyLimit: historyLimit_(), interest: interestSettings_()
  };
}

/** 設定タブ：ボーナスの有効/無効・定期おこづかい・りれきの表示件数 */
function apiSaveSettings_(ctx) {
  requireUser_(ctx.token, 'parent');
  const a = ctx.args;
  const p = props_();
  if (a.bonusSameDay !== undefined || a.bonusStreak !== undefined) {
    const wasOff = !sameDayBonusOn_() && !streakBonusOn_();
    p.setProperty('BONUS_SAME_DAY_ENABLED', a.bonusSameDay ? 'true' : 'false');
    p.setProperty('BONUS_STREAK_ENABLED', a.bonusStreak ? 'true' : 'false');
    // 両方無効 → 有効に戻したときは、止めていた間の月をさかのぼって出さない（今月から計算）
    if (wasOff && (a.bonusSameDay || a.bonusStreak)) p.setProperty('BONUS_START_MONTH', thisMonth_());
  }
  if (a.allowance) {
    const al = a.allowance;
    const amount = Math.round(Number(al.amount));
    const day = Math.round(Number(al.day));
    if (al.enabled) {
      if (!(amount > 0)) throw new Error('おこづかいの金額を入力してください。');
      if (!(day >= 1 && day <= 31)) throw new Error('支給日は1〜31日で入力してください。');
      if (!/^\d{4}-\d{2}$/.test(String(al.start || ''))) throw new Error('開始年月を選んでください。');
    }
    p.setProperty('ALLOWANCE_ENABLED', al.enabled ? 'true' : 'false');
    if (amount > 0) p.setProperty('ALLOWANCE_AMOUNT', String(amount));
    if (day >= 1 && day <= 31) p.setProperty('ALLOWANCE_DAY', String(day));
    if (/^\d{4}-\d{2}$/.test(String(al.start || ''))) p.setProperty('ALLOWANCE_START', String(al.start));
  }
  if (a.historyLimit !== undefined) {
    const n = Math.round(Number(a.historyLimit));
    if (!(n >= 5 && n <= 500)) throw new Error('りれきの表示件数は5〜500件で入力してください。');
    p.setProperty('HISTORY_LIMIT', String(n));
  }
  // りそく（月○%。0＝なし）。なし → ありにしたときは、その月から付け始める（さかのぼらない）
  if (a.interest) {
    const rate = a.interest.on ? Math.round(Number(a.interest.rate) * 10) / 10 : 0;
    if (a.interest.on && !(rate > 0 && rate <= INTEREST_MAX_RATE)) throw new Error('りそくは 0.1〜' + INTEREST_MAX_RATE + '% で入力してください。');
    if (rate > 0 && !(interestSettings_().rate > 0)) p.setProperty('INTEREST_YEN_START', thisMonth_());
    p.setProperty('INTEREST_YEN_RATE', String(rate));
  }
  return { message: '設定を保存しました。' };
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

/** 親の一覧に出す端末：1度でも失敗したことがあり、親が隠していない端末 */
function isListedDevice_(d) { return Number(d.TotalFails || 0) > 0 && !isTrue_(d.Hidden); }

/**
 * 端末行が DEVICE_MAX_ROWS を超えたら黙って削除する。
 * 消す順番：失敗したことのない端末 → 親が隠した端末（それぞれ古い順）。一覧に出ている端末は消さない
 */
function cleanupDevices_() {
  const sh = ss_().getSheetByName(SHEET_DEVICES);
  if (!sh) return;
  const rows = readTable_(SHEET_DEVICES).rows.filter(function (r) { return r.DeviceId; });
  if (rows.length <= DEVICE_MAX_ROWS) return;
  const oldestFirst = function (a, b) { return new Date(a.UpdatedAt || 0) - new Date(b.UpdatedAt || 0); };
  const candidates = rows.filter(function (r) { return !Number(r.TotalFails || 0); }).sort(oldestFirst)
    .concat(rows.filter(function (r) { return Number(r.TotalFails || 0) && isTrue_(r.Hidden); }).sort(oldestFirst));
  candidates.slice(0, rows.length - DEVICE_MAX_ROWS)
    .map(function (r) { return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (rowIndex) { sh.deleteRow(rowIndex); });
  invalidate_(SHEET_DEVICES);
}

function listDevices_() {
  const now = Date.now();
  return readTable_(SHEET_DEVICES).rows.filter(function (r) { return r.DeviceId && isListedDevice_(r); })
    .sort(function (a, b) { return new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0); })
    .map(function (d) {
      const hard = isTrue_(d.HardLocked);
      const until = Number(d.LockUntil) || 0;
      return {
        deviceId: String(d.DeviceId), shortId: String(d.DeviceId).substring(0, 8),
        failCount: Number(d.FailCount) || 0, totalFails: Number(d.TotalFails) || 0, hardLocked: hard,
        lockedUntil: until > now ? new Date(until).toISOString() : '',
        locked: hard || until > now, updatedAt: toIso_(d.UpdatedAt)
      };
    });
}

/** 親：端末を一覧から隠す（その後また失敗したら自動で一覧に戻る） */
function apiHideDevice_(ctx) {
  requireUser_(ctx.token, 'parent');
  const d = getDeviceState_(String(ctx.args.deviceId || ''));
  if (!d._row) throw new Error('端末が見つかりません。');
  updateRow_(SHEET_DEVICES, d._row, { Hidden: true });
  return { message: '一覧から非表示にしました。' };
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
