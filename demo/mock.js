/**
 * デモモード（index.html?demo=1）
 * gas/Code.gs をブラウザ内で動かし、スプレッドシートの代わりにメモリ上の表を使う。
 * 実際のデータ・端末の保存内容には一切触れない（localStorage もメモリに差し替える）。
 */
(function () {
  const memory = (m) => ({
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  });
  const local = { okd_api: 'https://script.google.com/macros/s/DEMO/exec' };
  Object.defineProperty(window, 'localStorage', { value: memory(local) });
  Object.defineProperty(window, 'sessionStorage', { value: memory({}) });
  history.replaceState = function () {};

  const pad = (n) => String(n).padStart(2, '0');
  const sheets = {};
  function makeSheet() {
    const data = [];
    const sh = {
      getLastRow: () => data.length,
      getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
      getMaxRows: () => 1000,
      getDataRange: () => sh.getRange(1, 1, Math.max(data.length, 1), Math.max(sh.getLastColumn(), 1)),
      getRange: (r, c, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues: () => {
            if (!data.length && r === 1) return [];
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) { const v = (data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); }
              out.push(row);
            }
            return out;
          },
          setValues: (vals) => vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; }); }),
          setValue: (v) => { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = v; },
          setNumberFormat() {}, clearContent() {}
        };
      },
      appendRow: (row) => data.push(row.slice()),
      deleteRow: (i) => data.splice(i - 1, 1),
      setFrozenRows() {},
      data
    };
    return sh;
  }
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()), getUrl: () => 'https://docs.google.com/spreadsheets/' };
  const props = {};
  const cache = {};
  const jst = (d) => new Date(new Date(d).getTime() + 9 * 3600e3);
  const G = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ alert() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }, getProperties: () => Object.assign({}, props)
    }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => ({ getEmail: () => 'papa@example.com' }) },
    Utilities: {
      getUuid: () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
      formatDate: (d, tz, f) => {
        const t = jst(d);
        return f.replace('yyyy', t.getUTCFullYear()).replace('MM', pad(t.getUTCMonth() + 1)).replace('dd', pad(t.getUTCDate()))
          .replace('HH', pad(t.getUTCHours())).replace('mm', pad(t.getUTCMinutes())).replace('ss', pad(t.getUTCSeconds()));
      },
      parseDate: (s) => {
        const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(s);
        return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], m[4] - 9, +m[5], +m[6]));
      }
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 400, getContentText: () => '{}' }) },
    ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, create() {} }),
      getService: () => ({ getUrl: () => '' })
    },
    HtmlService: {}
  };

  function seed(S) {
    // マスター（持ち主）はUsersシートに入れず、設定に持つ
    props.OWNER_USER_ID = 'uPapa';
    props.OWNER_NAME = 'パパ';
    S.repairSheets_();
    sheets.Users.data.push(['uAiri', '', 'あいり', 'child', true, '1234']);
    sheets.Users.data.push(['uSho', '', 'しょう', 'child', true, '5678']);
    const today = jst(new Date());
    const dayStr = (off) => { const d = new Date(today.getTime() - off * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
    const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const lm = lastMonth.getUTCFullYear() + '-' + pad(lastMonth.getUTCMonth() + 1);
    props.BONUS_START_MONTH = lm;
    // 定期おこづかいのお試し：先月から毎月1日に500円
    props.ALLOWANCE_ENABLED = 'true';
    props.ALLOWANCE_AMOUNT = '500';
    props.ALLOWANCE_DAY = '1';
    props.ALLOWANCE_START = lm;
    const add = (day, hh, type, name, st, amt, by, byId) => sheets.Ledger.data.push([
      G.Utilities.getUuid(), new Date(day + 'T' + hh + ':00+09:00'), 'uAiri', type, 'c01', name, st, amt, '',
      by || 'あいり', st === 'approved' ? 'パパ' : '', '', '', byId || 'uAiri']);
    add(lm + '-03', '17:00', 'chore', 'お風呂掃除', 'approved', 30);
    add(lm + '-04', '17:00', 'chore', 'お風呂掃除', 'approved', 30);
    add(lm + '-05', '17:00', 'chore', '食器洗い', 'approved', 30);
    add(lm + '-05', '18:00', 'chore', 'ゴミ捨て', 'approved', 30);
    add(lm + '-05', '19:00', 'chore', '料理', 'approved', 100);
    add(lm + '-20', '10:00', 'adjustment', 'おこづかい', 'approved', 500, 'パパ', 'uPapa');
    add(dayStr(2), '16:00', 'chore', 'ゴミ捨て', 'approved', 30);
    add(dayStr(1), '16:00', 'chore', '食器洗い', 'approved', 30);
    add(dayStr(1), '16:30', 'usage', 'おかし', 'approved', -120);
    add(dayStr(0), '07:30', 'chore', '布団干し', 'pending', 30);
  }

  window.OKD_BEFORE_BOOT = fetch('gas/Code.gs').then((r) => r.text()).then((code) => {
    const factory = new Function(Object.keys(G).join(','),
      code + '\nreturn { doPost: doPost, repairSheets_: repairSheets_, TABLE_CACHE_: TABLE_CACHE_, createSession_: createSession_ };');
    const S = factory.apply(null, Object.values(G));
    seed(S);
    window.fetch = async (url, init) => {
      await new Promise((r) => setTimeout(r, 350)); // 実物に近い待ち時間
      Object.keys(S.TABLE_CACHE_).forEach((k) => delete S.TABLE_CACHE_[k]);
      const out = S.doPost({ postData: { contents: init.body } });
      return { text: async () => out.s };
    };
    window.OKD_DEMO = {
      loginParent() {
        const token = S.createSession_('uPapa');
        return { token, userId: 'uPapa', role: 'parent', name: 'パパ' };
      }
    };
  });
})();
