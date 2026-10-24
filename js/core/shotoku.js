/* VENDORED from 所得税エンジンの正本（非公開リポ）shotoku-engine.js — 正本を編集すること。このコピーは scripts/vendor-shaho.mjs が生成（手編集禁止）。
   IIFE 内包＝classic <script> 同時読込時の top-level const 字句衝突回避。window.Shaho / window.Shotoku は IIFE 内で代入。 */
(function(){
// 所得税計算エンジン 本実装 — 令和8年(2026)/令和9年(2027)分・給与所得者
// 制度計算ファミリー / 所得税
// パラメータは data/national/shotokuzei-2026.json（年分キー・source/confidence付き）から読込。
// ロジックとパラメータを分離。草案 shotoku_engine_2026.js と計算結果は一致する（test-shotoku-verify.js のクロスチェックで担保）。
// 一次ソース: 国税庁「源泉所得税の改正のあらまし(令和8年4月)」
//   https://www.nta.go.jp/publication/pamph/gensen/2026kaisei.pdf
// 実行: node shotoku-engine.js [year]  → 指定年分でアンカーを表示（既定2026）

'use strict';

// Node/ブラウザ両対応（UMD）。fs/path は Node の loadDB 専用＝ブラウザでは null
// （ブラウザは fetch した JSON を createEngineFromDB(year, db) に直接渡す。shaho.js と同型）。
const _isNode = (typeof module !== 'undefined' && !!module.exports);
const fs = _isNode ? require('fs') : null;
const path = _isNode ? require('path') : null;

const DB_PATH = _isNode ? path.join(__dirname, 'data', 'national', 'shotokuzei-2026.json') : null;

// null(上限なし) → Infinity へ正規化。lookup が key<=row[0] で使うため。
function normalizeTable(table) {
  return table.map((row) => [row[0] == null ? Infinity : row[0], ...row.slice(1)]);
}

// 年分パラメータをロード（inheritsFrom を解決してマージ）。
function loadParams(year, db) {
  const raw = db.years[String(year)];
  if (!raw) throw new Error(`shotoku-engine: params未定義 year=${year}`);
  let base = {};
  if (raw.inheritsFrom) base = JSON.parse(JSON.stringify(db.years[String(raw.inheritsFrom)]));
  const SKIP = new Set(['inheritsFrom', 'diff']);
  const merged = { ...base };
  for (const [k, v] of Object.entries(raw)) if (!SKIP.has(k)) merged[k] = v;

  // テーブルの null 上限 → Infinity
  merged.kisoKojo = normalizeTable(merged.kisoKojo);
  merged.taxTable = normalizeTable(merged.taxTable);
  merged.haiguSpecial = normalizeTable(merged.haiguSpecial);
  merged.tokuteiShinzoku = normalizeTable(merged.tokuteiShinzoku);
  return merged;
}

function loadDB(dbPath = DB_PATH) {
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

// ---- 給与収入 → 給与所得（データ駆動） -------------------------------------
function kyuyoShotoku(rev, K) {
  for (const [limit, h] of K.steps) {
    const lim = limit == null ? Infinity : limit;
    if (rev < lim) {
      if (h === 'zero') return 0;
      if (h === 'minus740k') return rev - K.floorGuarantee;
      if (typeof h === 'number') return h;
      if (h === 'table5') {
        const t = K.table5band;
        const a = Math.floor(rev / t.roundUnit) * t.roundUnit;
        // a は roundUnit(4,000) の倍数なので a×rate は数学的に整数。浮動小数点誤差（例 2,624,000×0.7 = 1836799.999…）で
        // 1 円低く出ないよう、積を整数に丸めてから控除する（2026-10-21 国税庁「令和8年分 年末調整のしかた」47〜54 頁の表と
        // 全 1,103 区間を突合して発見。修正前は 93 区間で 1 円低かった）。
        return a < t.highThreshold
          ? Math.round(a * t.lowRate) - t.lowSub
          : Math.round(a * t.highRate) - t.highSub;
      }
      if (h === 'rate90') return Math.floor(rev * K.rate90.rate) - K.rate90.sub;
      if (h === 'cap195') return rev - K.cap195.sub;
    }
  }
  return 0;
}

function lookup(table, key) {
  for (const row of table) if (key <= row[0]) return row.slice(1);
  return null;
}

// 率の掛け算を整数で行い、切り捨てる（v は 0 以上の整数・率は小数 5 桁まで）。
// 浮動小数点のまま掛けると 100000×1.021 = 102099.99999999999 のように真値より小さくなり、
// 100円未満切捨てで年税額が 100 円少なく出る（2026-10-24 全方向試算 shotoku F1）。
const RATE_SCALE = 100_000;
function mulRateFloor(v, rate) {
  const n = v * Math.round(rate * RATE_SCALE);
  return (n - n % RATE_SCALE) / RATE_SCALE;
}

// ---- 本体 -------------------------------------------------------------------
// input（草案と同一契約）:
//   salary, otherIncome（事業・雑所得等の所得金額。給与所得に加算・2026-10-15 追加・既定 0）, socialInsurance, ideco, otherDeductions,
//   spouse:{income,age70plus}|null, dependents:{general,specific,elderly,elderlyCoRes},
//   tokuteiShinzoku:[所得,...], under23Dependent, singleParent, widow, workingStudent, mortgageDeduction,
//   disability:{general,special,specialCoRes}（障害者控除の人数・2026-10-21 追加・既定 0）,
//   medicalPaid, medicalReimbursed（医療費控除: 支払額と保険金等の補填額。控除額はエンジンが計算・既定 0）,
//   lifeInsurance, earthquakeInsurance（生命保険料控除・地震保険料控除の「控除額」を入れる。上限で頭打ち・既定 0）
// 出力に marginalRate（課税所得が属する税率区分・復興特別所得税を含まない）を含む。
function calcShotokuzei(input, P) {
  const salary = input.salary || 0;

  // 1) 給与所得・所得金額調整控除
  const kyuyo = kyuyoShotoku(salary, P.kyuyoShotoku);
  let chosei = 0;
  const C = P.choseiKojo;
  if (salary > C.salaryThreshold && input.under23Dependent) {
    chosei = Math.floor((Math.min(salary, C.cap) - C.salaryThreshold) * C.rate);
  }
  const gokeiShotoku = kyuyo - chosei + (input.otherIncome || 0);   // 合計所得金額（給与所得＋事業・雑所得等）

  // 2) 所得控除
  const detail = {};
  detail.kiso = lookup(P.kisoKojo, gokeiShotoku)[0];
  detail.shaho = input.socialInsurance || 0;
  detail.ideco = input.ideco || 0;
  detail.other = input.otherDeductions || 0;

  detail.haigu = 0;
  if (input.spouse && gokeiShotoku <= P.honninIncomeCols[2]) {
    const col = gokeiShotoku <= P.honninIncomeCols[0] ? 0 : gokeiShotoku <= P.honninIncomeCols[1] ? 1 : 2;
    const si = input.spouse.income || 0;
    if (si <= P.fuyoIncomeLimit) {
      detail.haigu = P.haiguKojo[input.spouse.age70plus ? 'elderly' : 'general'][col];
    } else if (si <= P.haiguSpecialLimit) {
      detail.haigu = lookup(P.haiguSpecial, si)[0][col];
    }
  }

  const d = Object.assign({ general: 0, specific: 0, elderly: 0, elderlyCoRes: 0 }, input.dependents);
  detail.fuyo = d.general * P.fuyoKojo.general + d.specific * P.fuyoKojo.specific +
    d.elderly * P.fuyoKojo.elderly + d.elderlyCoRes * P.fuyoKojo.elderlyCoRes;
  detail.tokutei = (input.tokuteiShinzoku || [])
    .filter((i) => i > P.fuyoIncomeLimit && i <= P.tokuteiShinzokuLimit)
    .reduce((s, i) => s + lookup(P.tokuteiShinzoku, i)[0], 0);

  detail.jinteki = (input.singleParent ? P.hitorioya : input.widow ? P.kafu : 0) +
    (input.workingStudent ? P.kinroGakusei : 0);

  // 障害者控除（所得税法 79 条）: 人数 × 27 / 40 / 75 万
  const dis = Object.assign({ general: 0, special: 0, specialCoRes: 0 }, input.disability);
  detail.shogai = dis.general * P.shogai.general + dis.special * P.shogai.special + dis.specialCoRes * P.shogai.specialCoRes;

  // 医療費控除（所得税法 73 条）: 支払額 − 補填 − min(総所得金額等×5%, 10 万)、上限 200 万。総所得金額等は合計所得金額で代用（給与＋その他の所得）
  const iry = P.iryohiKojo;
  const iryFloor = Math.min(Math.floor(gokeiShotoku * iry.floorRate), iry.floorMax);
  detail.iryohi = Math.min(iry.max, Math.max(0, (input.medicalPaid || 0) - (input.medicalReimbursed || 0) - iryFloor));

  // 生命保険料控除（76 条・合計 12 万）・地震保険料控除（77 条・5 万）: 控除額を受け取り上限で頭打ち
  detail.seiho = Math.min(input.lifeInsurance || 0, P.seihoKojoMax);
  detail.jishin = Math.min(input.earthquakeInsurance || 0, P.jishinKojoMax);

  const kojo = detail.kiso + detail.shaho + detail.ideco + detail.other +
    detail.haigu + detail.fuyo + detail.tokutei + detail.jinteki +
    detail.shogai + detail.iryohi + detail.seiho + detail.jishin;

  // 3) 課税所得(1,000円未満切捨) → 速算表 → 住宅ローン控除 → ×102.1% → 100円未満切捨
  const kazei = Math.floor(Math.max(0, gokeiShotoku - kojo) / P.kazeiRoundDown) * P.kazeiRoundDown;
  const [rate, sub] = lookup(P.taxTable, kazei);
  let tax = Math.max(0, mulRateFloor(kazei, rate) - sub);   // kazei は 1,000 の倍数なので真値は整数
  tax = Math.max(0, tax - Math.floor(input.mortgageDeduction || 0));
  const annualTax = Math.floor(mulRateFloor(tax, P.surtaxRate) / P.taxRoundDown) * P.taxRoundDown;

  return {
    year: P.year, salary, kyuyoShotoku: kyuyo, choseiKojo: chosei, gokeiShotoku,
    deductions: detail, totalDeductions: kojo, kazeiShotoku: kazei, annualTax,
    marginalRate: rate,
  };
}

// 家計簿統合フック: 手取り = 給与 − 社保 − 所得税 − 住民税(既存エンジン)
function calcTedori(input, residentTax, P) {
  const r = calcShotokuzei(input, P);
  return {
    ...r, residentTax,
    tedori: (input.salary || 0) - (input.socialInsurance || 0) - r.annualTax - (residentTax || 0),
  };
}

// パース済みDB（fetch結果 or require結果）からエンジンを作る。Node/ブラウザ共通・fs不要。
function createEngineFromDB(year = 2026, db) {
  if (!db) throw new Error('createEngineFromDB: db（パース済みJSON）が必要');
  const P = loadParams(year, db);
  return {
    params: P,
    meta: db.meta,
    calcShotokuzei: (input) => calcShotokuzei(input, P),
    calcTedori: (input, residentTax) => calcTedori(input, residentTax, P),
    kyuyoShotoku: (rev) => kyuyoShotoku(rev, P.kyuyoShotoku),
  };
}

// year を渡すだけで使えるファクトリ（Node専用＝ディスクからJSONを読む）
function createEngine(year = 2026, dbPath = DB_PATH) {
  return createEngineFromDB(year, loadDB(dbPath));
}

// ---- 自己テストは vendor 時に除去（scripts/vendor-shaho.mjs）。実行は正本側で: node js/core/shaho.js ----

const _api = {
  createEngine, createEngineFromDB, calcShotokuzei, calcTedori, kyuyoShotoku, loadParams, loadDB, normalizeTable, DB_PATH,
};
if (_isNode) module.exports = _api;                      // Node: require で使う
if (typeof window !== 'undefined') window.Shotoku = _api; // ブラウザ: window.Shotoku で使う

})();
