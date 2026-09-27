/**
 * 画面側の設定（公開してよい値だけを書く。秘密情報は絶対に書かない）
 *
 * VERSION                … ログイン画面に出すバージョン。リリースごとに上げる（README「更新とロールバック」参照）
 * DEFAULT_OAUTH_CLIENT_ID… 接続先のApps Scriptから clientId が取れなかった時の予備。通常は接続先の値を使う
 * TEMPLATE_SPREADSHEET_ID… 「原本スプレッドシート」のID（誰でも閲覧可で共有したもの）。
 *                          初期設定画面の「原本をコピー」ボタンが /copy リンクを開く。空なら手順だけ表示
 */
window.OKODUKAI_CONFIG = {
  VERSION: '3.0.6',
  DEFAULT_OAUTH_CLIENT_ID: '337708567191-tpqbqqinfgm5bpje56ccdj2gmkphdngi.apps.googleusercontent.com',
  TEMPLATE_SPREADSHEET_ID: ''
};
