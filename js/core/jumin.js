// 個人住民税 計算ロジック（純粋関数）
// 99%の自治体が同一税率のため、JUMIN_DEFAULTS からマージして使う。
// 差分のある自治体のみ data に値を持つ。
//
// Node: require('./js/core/jumin') で { calculateJumin, JUMIN_DEFAULTS } を取得
// Browser: <script> で読み込むとグローバル関数

'use strict';

const _isNode = typeof module !== 'undefined' && !!module.exports;

const _income = _isNode
  ? require('./shared/income.js')
  : { calcSalaryIncome, calcTaxableIncomeForKokuho, calcTaxableIncomeForJumin };

// ─── 全国標準値（差分管理のベース） ─────────────────────────────

// 令和6年度（2024年）改正:
//   東日本大震災復興特例（均等割 +1,000円）が令和5年度で終了。
//   代わりに国の森林環境税（1,000円）が令和6年度から課税開始。
//   均等割の合計は 5,000円 で変わらないが内訳が変わった。
//     旧: 都道府県 1,500円 + 市区町村 3,500円          = 5,000円
//     新: 都道府県 1,000円 + 市区町村 3,000円 + 国税 1,000円 = 5,000円

const JUMIN_DEFAULTS = {
  prefRate:            0.04,    // 都道府県民税 所得割
  cityRate:            0.06,    // 市区町村民税 所得割
  prefPerCapita:       1_000,   // 都道府県民税 均等割（令和6年度以降）
  cityPerCapita:       3_000,   // 市区町村民税 均等割（令和6年度以降）
  forestTax:           1_000,   // 森林環境税（国税・令和6年度〜、全国一律）
  basicDeductionJumin: 430_000,
};

// ─── 計算関数 ─────────────────────────────────────────────────

// ─── 非課税限度額（標準・生活保護1級地） ───────────────────────────
// 均等割: 35万円 ×（本人＋同一生計配偶者＋扶養親族）＋ 10万円 ＋ 加算21万円（扶養等がいる場合）
// 所得割: 35万円 ×（同上）＋ 10万円 ＋ 加算32万円（扶養等がいる場合）
// dependents = 同一生計配偶者＋扶養親族の数（本人を除く）。単身は 0。
function _kintoNonTaxableLimit(dependents) {
  const n = 1 + Math.max(0, dependents | 0);
  return 350_000 * n + 100_000 + (dependents > 0 ? 210_000 : 0);
}
function _shotokuNonTaxableLimit(dependents) {
  const n = 1 + Math.max(0, dependents | 0);
  return 350_000 * n + 100_000 + (dependents > 0 ? 320_000 : 0);
}

// ─── 特定親族特別控除（令和8年度課税〜・令和7年度税制改正） ─────────
// 19歳以上23歳未満の親族等（配偶者・青色事業専従者等を除く）で、
// 合計所得金額が 58万円超 123万円以下（給与収入のみなら 123万円超 188万円以下）の場合、
// 親族の合計所得金額に応じた7段階の所得控除（住民税は最高45万円）。
//   出典: 総務省説明資料（令7.5.15）・横浜市/大阪市/西宮市 R8税制改正ページ
// 注意:
//   - 対象者は税法上の扶養親族には含まれない（非課税限度額の扶養人数にカウントしない）
//   - 調整控除の人的控除差にも含まれない（境港市・倉敷市のR8調整控除一覧で確認）
const TOKUTEI_SHINZOKU_BRACKETS = [
  //  親族の合計所得金額の上限, 控除額
  [   950_000, 450_000 ], //  58万円超  95万円以下 → 45万円
  [ 1_000_000, 410_000 ], //  95万円超 100万円以下 → 41万円
  [ 1_050_000, 310_000 ], // 100万円超 105万円以下 → 31万円
  [ 1_100_000, 210_000 ], // 105万円超 110万円以下 → 21万円
  [ 1_150_000, 110_000 ], // 110万円超 115万円以下 → 11万円
  [ 1_200_000,  60_000 ], // 115万円超 120万円以下 →  6万円
  [ 1_230_000,  30_000 ], // 120万円超 123万円以下 →  3万円
];

/**
 * 特定親族特別控除（住民税）の控除額を返す。
 * @param {number} relativeIncome - 親族の合計所得金額（円）
 * @returns {number} 控除額（円）。所得58万円以下（=扶養控除の領域）と123万円超は 0。
 */
function calcTokuteiShinzokuDeduction(relativeIncome) {
  if (!Number.isFinite(relativeIncome)) return 0;
  if (relativeIncome <= 580_000 || relativeIncome > 1_230_000) return 0;
  for (const [cap, deduction] of TOKUTEI_SHINZOKU_BRACKETS) {
    if (relativeIncome <= cap) return deduction;
  }
  return 0;
}

// ─── 調整控除（所得割の税額控除） ─────────────────────────────────
// 税源移譲に伴う所得税・住民税の人的控除差を調整する。
//   課税総所得金額 ≤ 200万円: min(人的控除差合計, 課税総所得金額) × 5%
//   課税総所得金額 > 200万円: { 人的控除差合計 −（課税総所得金額 − 200万円）} × 5%（最低 2,500円）
//   合計所得金額 2,500万円超: 適用なし
// 内訳は県民税2%＋市民税3%＝5%。差額の標準は基礎控除差 5万円（単身）。
// 調整控除の算定基礎（税率を掛ける前の base）。都道府県分・市区町村分を別々に按分するため切り出し。
function _adjustmentCreditBase(taxableIncome, humanDeductionDiff, totalIncome) {
  if (taxableIncome <= 0) return 0;
  if (totalIncome > 25_000_000) return 0;
  const diff = Math.max(0, humanDeductionDiff);
  if (taxableIncome <= 2_000_000) {
    return Math.min(diff, taxableIncome);
  }
  return Math.max(diff - (taxableIncome - 2_000_000), 50_000);
}
function _adjustmentCredit(taxableIncome, humanDeductionDiff, totalIncome) {
  return Math.floor(_adjustmentCreditBase(taxableIncome, humanDeductionDiff, totalIncome) * 0.05);
}

// ─── 保育料指数（市町村民税所得割・調整控除後・税額控除前・旧6%換算） ─────
// 保育所利用者負担額の階層判定に使う「指数」の1人分。
//   ・市区町村民税所得割のみ（都道府県分は含めない）
//   ・調整控除は適用後／ふるさと納税・住宅ローン控除等の税額控除は適用前（＝下がらない）
//   ・税率は常に標準6%・調整控除の市区町村分3%で固定。政令市(cityRate=8%)でも「旧6%換算」を
//     この計算で直接得るため cfg.cityRate は使わない [指示書§1: 政令市6/8補正]。
//   ・名古屋市等の市民税減税は本標準計算では未反映（自治体別の要確認事項）[未確認・推測]。
// 引数は calculateJumin と同じ課税標準・人的控除差・合計所得。父母合算は呼び出し側で2人分を足す。
function calcHoikuShotokuwari(taxableIncome, humanDeductionDiff, totalIncome, shotokuTaxable) {
  if (!shotokuTaxable) return 0;
  const cityGross = Math.floor(taxableIncome * 0.06);
  const cityAdjust = Math.floor(_adjustmentCreditBase(taxableIncome, humanDeductionDiff, totalIncome) * 0.03);
  const levy = Math.max(0, cityGross - cityAdjust);
  return Math.floor(levy / 100) * 100; // 100円未満切捨て
}

/**
 * 個人住民税を計算する。
 *
 * @param {Object|null} data    - jumin-{year}.json（差分のみ）。null なら標準値のみ使用。
 * @param {Object} inputs
 * @param {number} [inputs.salary=0]
 * @param {number} [inputs.pension=0]
 * @param {number} [inputs.age]
 * @param {number} [inputs.otherIncome=0]     - 事業・不動産所得等（所得換算済み）
 * @param {number} [inputs.socialInsurance=0] - 社会保険料控除（国保+介護等の実支払額）
 * @param {number} [inputs.spouseDeduction=0]
 * @param {number} [inputs.dependentDeduction=0]
 * @param {number} [inputs.disabilityDeduction=0]
 * @param {number} [inputs.singleParentDeduction=0]
 * @param {number} [inputs.lifeInsuranceDeduction=0] - 生命保険料控除
 * @param {number} [inputs.earthquakeInsuranceDeduction=0] - 地震保険料控除
 * @param {number} [inputs.medicalDeduction=0]   - 医療費控除
 * @param {number} [inputs.dependents=0]          - 同一生計配偶者＋扶養親族の数（非課税判定用）
 * @param {number} [inputs.humanDeductionDiff=50000] - 人的控除差の合計（調整控除用。標準=基礎控除差5万）
 * @param {number} [inputs.taxCredits=0]          - ふるさと納税・住宅ローン等の税額控除合計（所得割から控除）
 * @param {number} [inputs.fiscalYear=2026]       - 住民税の年度。未指定=令和8年度で後方互換。
 *   令和9年度(2027)以降は給与所得控除の最低保障が74万（令和8年度税制改正）。保育料の令和9年度指数を出す際に指定する。
 * @param {number[]} [inputs.specialDependentSalaries=[]] - 19〜22歳の子等の給与収入（年収）。
 *   給与所得換算した合計所得から自動判定する:
 *     所得58万円以下（給与123万円以下）   → 特定扶養控除45万円＋人的控除差18万円＋扶養人数に加算
 *     所得58万円超123万円以下（給与188万円以下） → 特定親族特別控除（7段階・調整控除と扶養人数の対象外）
 *     所得123万円超                       → 控除なし
 *   ※特定扶養として dependentDeduction / dependents に既に計上済みの子は入れないこと（二重計上防止）
 * @returns {Object}
 *   taxableIncome    - 課税総所得金額（所得割の算定基礎）
 *   totalIncome      - 合計所得金額（介護保険段階判定に使用）
 *   incomeLevy       - 所得割（調整控除・税額控除適用後）
 *   adjustmentCredit - 適用した調整控除額
 *   perCapita        - 均等割（森林環境税を含む）
 *   total            - 年間住民税
 *   monthly          - 月額目安
 *   isTaxable        - 均等割課税者か（介護保険段階判定に使用）
 *   hoikuShotokuwari - 保育料の指数(1人分)。市町村民税所得割・調整控除後・税額控除前・旧6%換算。
 *                      父母合算は呼び出し側で2回呼んで加算する。非課税は0。
 */
function calculateJumin(data, inputs) {
  const cfg = { ...JUMIN_DEFAULTS, ...(data || {}) };
  const {
    salary = 0, pension = 0, age,
    otherIncome = 0,
    socialInsurance = 0,
    spouseDeduction = 0,
    dependentDeduction = 0,
    disabilityDeduction = 0,
    singleParentDeduction = 0,
    lifeInsuranceDeduction = 0,
    earthquakeInsuranceDeduction = 0,
    medicalDeduction = 0,
    dependents = 0,
    humanDeductionDiff = 50_000,
    taxCredits = 0,
    specialDependentSalaries = [],
    fiscalYear, // 住民税の年度。未指定=令和8年度(2026)で後方互換（給与所得控除の最低保障65万）。
                // 2027以降で給与所得控除の最低保障74万を適用（令和8年度税制改正）。
  } = inputs || {};

  // ── 19〜22歳の子等（B案: 給与収入から特定扶養／特定親族特別控除を自動判定） ──
  let specialDependentDeduction = 0; // 適用された控除額の合計（特定扶養45万を含む）
  let _sdHumanDiff = 0;              // 特定扶養該当分の人的控除差（特別控除分は対象外）
  let _sdDependents = 0;             // 特定扶養該当分の扶養人数（特別控除対象者は含めない）
  for (const s of (Array.isArray(specialDependentSalaries) ? specialDependentSalaries : [])) {
    if (!Number.isFinite(s) || s <= 0) continue;
    // 給与→所得の閾値も年度で動く（65万前提「給与123万⇔所得58万」→74万年度は「給与132万⇔所得58万」）。
    const relIncome = _income.calcSalaryIncome(s, fiscalYear);
    if (relIncome <= 580_000) {
      // 給与123万円以下 → 従来どおり特定扶養控除（45万円・控除差18万円・扶養人数+1）
      specialDependentDeduction += 450_000;
      _sdHumanDiff += 180_000;
      _sdDependents += 1;
    } else {
      specialDependentDeduction += calcTokuteiShinzokuDeduction(relIncome);
    }
  }
  const effDependentDeduction = dependentDeduction + specialDependentDeduction;
  const effHumanDiff          = humanDeductionDiff + _sdHumanDiff;
  const effDependents         = dependents + _sdDependents;

  // 合計所得金額（介護保険段階判定・基礎控除前）
  const totalIncome = _income.calcTaxableIncomeForKokuho({ salary, pension, age, otherIncome, fiscalYear });

  // 住民税課税所得（所得控除後）。1,000円未満切捨て（課税標準）。
  const taxableRaw = _income.calcTaxableIncomeForJumin({
    salary, pension, age, otherIncome, fiscalYear,
    socialInsurance,
    spouseDeduction, dependentDeduction: effDependentDeduction,
    disabilityDeduction, singleParentDeduction,
    // 保険料・医療費控除も所得控除として差し引く
    basicDeductionJumin:
      cfg.basicDeductionJumin + lifeInsuranceDeduction + earthquakeInsuranceDeduction + medicalDeduction,
  });
  const taxableIncome = Math.floor(taxableRaw / 1000) * 1000;

  // ── 非課税判定（標準・1級地） ──
  const kintoTaxable   = totalIncome > _kintoNonTaxableLimit(effDependents);
  const shotokuTaxable = taxableIncome > 0 && totalIncome > _shotokuNonTaxableLimit(effDependents);

  // ── 所得割（調整控除・税額控除適用後） ──
  let incomeLevy = 0;
  let adjustmentCredit = 0;
  if (shotokuTaxable) {
    const gross = Math.floor(taxableIncome * (cfg.prefRate + cfg.cityRate));
    adjustmentCredit = _adjustmentCredit(taxableIncome, effHumanDiff, totalIncome);
    incomeLevy = Math.max(0, gross - adjustmentCredit - Math.max(0, taxCredits));
    incomeLevy = Math.floor(incomeLevy / 100) * 100; // 100円未満切捨て
  }

  // ── 均等割 ＋ 森林環境税（均等割課税者のみ） ──
  const perCapita = kintoTaxable
    ? cfg.prefPerCapita + cfg.cityPerCapita + cfg.forestTax
    : 0;

  const total   = incomeLevy + perCapita;
  const monthly = Math.round(total / 12);

  // 保育料指数（市町村民税所得割・調整控除後・税額控除前・旧6%換算）。1人分。
  const hoikuShotokuwari = calcHoikuShotokuwari(taxableIncome, effHumanDiff, totalIncome, shotokuTaxable);

  return {
    taxableIncome, totalIncome, incomeLevy, adjustmentCredit, perCapita, total, monthly,
    isTaxable: kintoTaxable,
    specialDependentDeduction, // 19〜22歳の子等に適用された控除額（特定扶養45万/特定親族特別控除3万〜45万）
    hoikuShotokuwari,          // 保育料の指数(1人分・市民税所得割/調整控除後/税額控除前/旧6%換算)。父母合算は呼び出し側で。
  };
}

if (_isNode) module.exports = { calculateJumin, JUMIN_DEFAULTS, calcTokuteiShinzokuDeduction, calcHoikuShotokuwari, _adjustmentCreditBase };
