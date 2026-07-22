/* VENDORED from shotoku-keisan/shotoku-engine.js — 正本を編集すること。このコピーは scripts/vendor-shaho.mjs が生成（手編集禁止）。
   IIFE 内包＝classic <script> 同時読込時の top-level const 字句衝突回避。window.Shaho / window.Shotoku は IIFE 内で代入。 */
(function(){
// 所得税計算エンジン 本実装 — 令和8年(2026)/令和9年(2027)分・給与所得者
// 制度計算ファミリー / shotoku-keisan
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
        return a < t.highThreshold
          ? Math.floor(a * t.lowRate - t.lowSub)
          : Math.floor(a * t.highRate - t.highSub);
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

// ---- 本体 -------------------------------------------------------------------
// input（草案と同一契約）:
//   salary, socialInsurance, ideco, otherDeductions,
//   spouse:{income,age70plus}|null, dependents:{general,specific,elderly,elderlyCoRes},
//   tokuteiShinzoku:[所得,...], under23Dependent, singleParent, widow, workingStudent, mortgageDeduction
function calcShotokuzei(input, P) {
  const salary = input.salary || 0;

  // 1) 給与所得・所得金額調整控除
  const kyuyo = kyuyoShotoku(salary, P.kyuyoShotoku);
  let chosei = 0;
  const C = P.choseiKojo;
  if (salary > C.salaryThreshold && input.under23Dependent) {
    chosei = Math.floor((Math.min(salary, C.cap) - C.salaryThreshold) * C.rate);
  }
  const gokeiShotoku = kyuyo - chosei;

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

  const kojo = detail.kiso + detail.shaho + detail.ideco + detail.other +
    detail.haigu + detail.fuyo + detail.tokutei + detail.jinteki;

  // 3) 課税所得(1,000円未満切捨) → 速算表 → 住宅ローン控除 → ×102.1% → 100円未満切捨
  const kazei = Math.floor(Math.max(0, gokeiShotoku - kojo) / P.kazeiRoundDown) * P.kazeiRoundDown;
  const [rate, sub] = lookup(P.taxTable, kazei);
  let tax = Math.max(0, kazei * rate - sub);
  tax = Math.max(0, tax - (input.mortgageDeduction || 0));
  const annualTax = Math.floor((tax * P.surtaxRate) / P.taxRoundDown) * P.taxRoundDown;

  return {
    year: P.year, salary, kyuyoShotoku: kyuyo, choseiKojo: chosei, gokeiShotoku,
    deductions: detail, totalDeductions: kojo, kazeiShotoku: kazei, annualTax,
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

if (_isNode && require.main === module) {
  const year = Number(process.argv[2]) || 2026;
  const eng = createEngine(year);
  console.log(`== shotoku-engine ${year}年分 アンカー ==`);
  for (const c of [
    { salary: 1780000 },
    { salary: 1790000 },
    { salary: 5000000, socialInsurance: 750000 },
  ]) console.log(JSON.stringify(c), '→', eng.calcShotokuzei(c).annualTax, '円');
}

const _api = {
  createEngine, createEngineFromDB, calcShotokuzei, calcTedori, kyuyoShotoku, loadParams, loadDB, normalizeTable, DB_PATH,
};
if (_isNode) module.exports = _api;                      // Node: require で使う
if (typeof window !== 'undefined') window.Shotoku = _api; // ブラウザ: window.Shotoku で使う

})();
