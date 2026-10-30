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

// ─── 非課税限度額 ─────────────────────────────────────────────
// 均等割: 基本額 ×（本人＋同一生計配偶者＋扶養親族）＋ 10万円 ＋ 加算額（扶養等がいる場合）
//   基本額・加算額は生活保護の級地（前年12月31日時点）で決まる。
//     1級地 35万円・21万円 / 2級地 31万5千円・18万9千円 / 3級地 28万円・16万8千円
//   出典: 地方税法施行令 第47条の3 第2号・第3号（35万円・21万円に率を乗じた額を参酌して条例で定める）
//         地方税法施行規則（率: 一級地1.0・二級地0.9・三級地0.8）
//   級地は data/reference/kyuchi.json（生活保護法による保護の基準 別表第9）から生成時に埋め込む。
//   ※条例で国の基準を切り上げている自治体がある（2026-10-09 標本10件中3件。土浦市32万円・泉佐野市32万円/19万円・
//     栃木市 加算17万円）。差は所得で1人あたり最大5,000円程度。限度額を少し上回る帯は kintoBorderline で注記する。
// 所得割: 35万円 ×（同上）＋ 10万円 ＋ 加算32万円（扶養等がいる場合）。級地によらず全国一律（地方税法附則第3条の3）。
// dependents = 同一生計配偶者＋扶養親族の数（本人を除く）。単身は 0。
const KINTO_NON_TAXABLE_BY_KYUCHI = {
  1: { base: 350_000, add: 210_000 },
  2: { base: 315_000, add: 189_000 },
  3: { base: 280_000, add: 168_000 },
};
function _kintoNonTaxableLimit(dependents, kyuchi) {
  const k = KINTO_NON_TAXABLE_BY_KYUCHI[kyuchi] || KINTO_NON_TAXABLE_BY_KYUCHI[1];
  const n = 1 + Math.max(0, dependents | 0);
  return k.base * n + 100_000 + (dependents > 0 ? k.add : 0);
}
// 条例による切り上げを見込んだ「境目付近」の幅（所得）。標本の最大差＝基本額+5,000円/人・加算+2,000円に余裕を持たせた。
function _kintoBorderlineMargin(dependents) {
  const n = 1 + Math.max(0, dependents | 0);
  return 10_000 * n + (dependents > 0 ? 10_000 : 0);
}
function _shotokuNonTaxableLimit(dependents) {
  const n = 1 + Math.max(0, dependents | 0);
  return 350_000 * n + 100_000 + (dependents > 0 ? 320_000 : 0);
}

// ─── 障害者・未成年者・寡婦・ひとり親の非課税 ───────────────────────
// 前年の合計所得金額が135万円以下なら、均等割・所得割とも課さない。扶養人数・級地によらない。
//   出典: 地方税法 第24条の5第1項第2号（道府県民税）・第295条第1項第2号（市町村民税）
//   令和8年度税制改正の法律要綱（https://www.soumu.go.jp/main_content/001060865.pdf）第1の1 に本条の改正は無い
//   [確認済 2026-10-23・要綱の範囲。改正法本文は未照合]。
// 対象は本人の区分のみ（扶養親族が障害者でも本人は対象外）。
const SPECIAL_NON_TAXABLE_INCOME_LIMIT = 1_350_000;

// ─── 本人の区分による所得控除（障害者・寡婦・ひとり親） ─────────────
// 地方税法 第314条の2第1項 第6号（障害者26万円・特別障害者30万円）・第8号（寡婦26万円）・第8号の2（ひとり親30万円）。
// 寡婦・ひとり親は前年の合計所得金額500万円以下が要件（第292条第1項第11号・第12号）。
//   [確認済 2026-10-23 e-Gov 法令API・2026-10-16 施行時点の本文]
//   ※離婚による寡婦の「扶養親族を有すること」の要件は入力が無いため判定しない（呼び出し側の選択を信じる）。
// 戻り値は calculateJumin にそのまま渡せる形（singleParentDeduction・disabilityDeduction・selfDisabled）と、
// 人的控除差（調整控除）の計算に渡す区分 singleParent（所得要件を外れたら 'none'）。
function calcSelfStatusDeductionJumin({ selfIncome = 0, singleParent = 'none', selfDisability = 'none' } = {}) {
  const status = (singleParent === 'mother' || singleParent === 'father' || singleParent === 'widow') && selfIncome <= 5_000_000
    ? singleParent : 'none';
  const singleParentDeduction = status === 'widow' ? 260_000 : (status === 'none' ? 0 : 300_000);
  const disabilityDeduction = selfDisability === 'special' ? 300_000 : (selfDisability === 'general' ? 260_000 : 0);
  return { singleParentDeduction, disabilityDeduction, selfDisabled: disabilityDeduction > 0, singleParent: status };
}

// ─── 扶養親族・同一生計配偶者の合計所得金額要件（年度で変わる） ─────────
// 令和8年度まで 58万円以下、令和9年度以後 62万円以下（令和8年度税制改正）。
//   出典: 地方税法等の一部を改正する法律要綱 第1の1(1)
//         https://www.soumu.go.jp/main_content/001060865.pdf
//         改正法 第23条第1項第7号・第9号／第292条第1項第7号・第9号「五十八万円」→「六十二万円」
//         https://www.soumu.go.jp/main_content/001066281.pdf
//   fiscalYear 未指定は令和8年度（2026）扱いで後方互換。
function fuyoIncomeLimitJumin(fiscalYear) {
  return (Number.isFinite(fiscalYear) && fiscalYear >= 2027) ? 620_000 : 580_000;
}

// ─── 配偶者控除・配偶者特別控除（住民税） ─────────────────────────
// 地方税法 第34条第1項第10号・第10号の2（市町村民税は第314条の2第1項第10号・第10号の2）。
//   出典・改正の有無・境目の検証: data/national/jumin-haigusha-kojo.json（meta）。
//   配偶者控除: 配偶者の合計所得が fuyoIncomeLimitJumin 以下。一般 33万／老人控除対象配偶者 38万。
//   配偶者特別控除（本人の合計所得900万円以下）:
//     (1) 配偶者の合計所得 100万円以下 → 33万円
//     (2) 100万円超 130万円以下 → 38万円 −（93万1円を超える部分。「5万円の整数倍 − 3万円」でないときは、それに満たないもののうち最大）
//     (3) 130万円超 133万円以下 → 3万円
//   本人の合計所得 900万円超950万円以下は 2/3、950万円超1,000万円以下は 1/3（1万円未満切上げ）。1,000万円超は 0。
//   令和8年法律第2号は第10号の2 を改めていない（2026-10-12 改正法 PDF で確認）。
const HAIGU_KOJO_JUMIN = { general: [330_000, 220_000, 110_000], elderly: [380_000, 260_000, 130_000] };
const HAIGU_SPECIAL_LIMIT_JUMIN = 1_330_000;
function _haiguSpecialBase(spouseIncome) {
  if (spouseIncome <= 1_000_000) return 330_000;
  if (spouseIncome > 1_300_000) return 30_000;
  const over = spouseIncome - 930_001;                       // 93万1円を超える部分
  let d;
  if ((over + 30_000) % 50_000 === 0) d = over;              // ちょうど「5万円の整数倍 − 3万円」
  else d = Math.floor((over + 30_000) / 50_000) * 50_000 - 30_000; // それに満たないもののうち最大
  return 380_000 - d;
}
/**
 * 住民税の配偶者控除／配偶者特別控除の控除額を返す。
 * @param {object} p
 * @param {number} p.selfIncome    本人の前年の合計所得金額（円）
 * @param {number} p.spouseIncome  配偶者の前年の合計所得金額（円）
 * @param {boolean} [p.age70plus]  配偶者が70歳以上（老人控除対象配偶者）。特別控除には影響しない
 * @param {number} [p.fiscalYear]  住民税の年度。控除対象配偶者の所得要件（58万／62万）に効く。未指定=令和8年度
 * @param {object} [p.data]        data/national/jumin-haigusha-kojo.json。渡せば表引き、無ければ条文の式で計算
 * @returns {{ kind: 'haigu'|'special'|'none', deduction: number, humanDiffSpouse: 'general'|'elderly'|'none' }}
 *   humanDiffSpouse は調整控除の人的控除差（第37条第1号イの表）用。特別控除は表(7)の対象外（配偶者所得55万円未満のみ）なので 'none'。
 */
function calcSpouseDeductionJumin(p) {
  const self = Number(p && p.selfIncome) || 0;
  const sp = Number(p && p.spouseIncome) || 0;
  const data = p && p.data;
  const cols = (data && data.honninIncomeCols) || [9_000_000, 9_500_000, 10_000_000];
  const none = { kind: 'none', deduction: 0, humanDiffSpouse: 'none' };
  if (self > cols[2]) return none;
  const col = self <= cols[0] ? 0 : self <= cols[1] ? 1 : 2;
  const limit = (data && data.fuyoIncomeLimit && data.fuyoIncomeLimit[String(p.fiscalYear || 2026)]) || fuyoIncomeLimitJumin(p.fiscalYear);
  if (sp <= limit) {
    const key = p.age70plus ? 'elderly' : 'general';
    const tbl = (data && data.haiguKojo) || HAIGU_KOJO_JUMIN;
    return { kind: 'haigu', deduction: tbl[key][col], humanDiffSpouse: key };
  }
  if (sp > ((data && data.haiguSpecialLimit) || HAIGU_SPECIAL_LIMIT_JUMIN)) return none;
  let ded;
  if (data && Array.isArray(data.haiguSpecial)) {
    const row = data.haiguSpecial.find((r) => sp <= r[0]);
    ded = row ? row[1][col] : 0;
  } else {
    const base = _haiguSpecialBase(sp);
    ded = col === 0 ? base : Math.ceil((base * (col === 1 ? 2 : 1) / 3) / 10_000) * 10_000;
  }
  return { kind: 'special', deduction: ded, humanDiffSpouse: 'none' };
}

// ─── 特定親族特別控除（令和8年度課税〜・令和7年度税制改正） ─────────
// 19歳以上23歳未満の親族等（配偶者・青色事業専従者等を除く）で、
// 合計所得金額が 扶養の所得要件超 123万円以下（令和8年度は58万円超、令和9年度以後は62万円超）の場合、
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
 * @param {number} [fiscalYear]   - 住民税の年度。未指定=令和8年度。
 * @returns {number} 控除額（円）。扶養の所得要件以下（=扶養控除の領域。令和8年度58万円・令和9年度以後62万円）と123万円超は 0。
 *   令和9年度以後も区分表（95万円以下45万円 …）は改正されていない。62万円超95万円以下が45万円になる。
 */
function calcTokuteiShinzokuDeduction(relativeIncome, fiscalYear) {
  if (!Number.isFinite(relativeIncome)) return 0;
  if (relativeIncome <= fuyoIncomeLimitJumin(fiscalYear) || relativeIncome > 1_230_000) return 0;
  for (const [cap, deduction] of TOKUTEI_SHINZOKU_BRACKETS) {
    if (relativeIncome <= cap) return deduction;
  }
  return 0;
}

// ─── 基礎控除（合計所得金額で逓減） ─────────────────────────────────
// 合計所得 2,400万円以下 43万円 / 2,450万円以下 29万円 / 2,500万円以下 15万円 / 2,500万円超 0円
//   根拠: 地方税法 第314条の2 第2項（市町村民税）・第34条第2項（道府県民税）[確認済 2026-10-25 e-Gov 法令API・2026-10-16 施行時点]
//   base は 2,400万円以下の額（JUMIN_DEFAULTS.basicDeductionJumin）。
function calcBasicDeductionJumin(totalIncome, base = JUMIN_DEFAULTS.basicDeductionJumin) {
  if (!(totalIncome > 24_000_000)) return base;
  if (totalIncome <= 24_500_000) return 290_000;
  if (totalIncome <= 25_000_000) return 150_000;
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
 * @param {number} [inputs.singleParentDeduction=0] - ひとり親控除・寡婦控除。0より大きければ本人がひとり親・寡婦とみなし、
 *   合計所得135万円以下の非課税を判定する（inputs.singleParent / widow を省略してよい）
 * @param {boolean} [inputs.selfDisabled=false] - 本人が障害者（合計所得135万円以下で非課税）。
 *   disabilityDeduction は扶養親族の分も含みうるため、本人かどうかはこのフラグで渡す
 * @param {boolean} [inputs.minor=false]        - 本人が未成年者（同上）
 * @param {boolean} [inputs.widow=false]        - 本人が寡婦（同上）
 * @param {boolean} [inputs.singleParent=false] - 本人がひとり親（同上）
 * @param {number} [inputs.lifeInsuranceDeduction=0] - 生命保険料控除
 * @param {number} [inputs.earthquakeInsuranceDeduction=0] - 地震保険料控除
 * @param {number} [inputs.medicalDeduction=0]   - 医療費控除
 * @param {number} [inputs.dependents=0]          - 同一生計配偶者＋扶養親族の数（非課税判定用）
 * @param {number} [inputs.humanDeductionDiff=50000] - 人的控除差の合計（調整控除用。標準=基礎控除差5万）
 * @param {number} [inputs.taxCredits=0]          - ふるさと納税・住宅ローン等の税額控除合計（所得割から控除）
 * @param {number} [inputs.fiscalYear=2026]       - 住民税の年度。未指定=令和8年度で後方互換。
 *   令和9年度(2027)以降は給与所得控除の最低保障が74万（令和8年度税制改正）。保育料の令和9年度指数を出す際に指定する。
 * @param {number} [inputs.kyuchi]               - 生活保護の級地（1/2/3）。均等割の非課税限度額に使う。
 *   未指定なら data.kyuchi、それも無ければ 1級地（後方互換）。ページは生成時に data/reference/kyuchi.json から埋め込む。
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
 *   kyuchi           - 非課税判定に使った級地（1/2/3）
 *   kintoNonTaxableLimit - 均等割の非課税限度額（合計所得）
 *   kintoBorderline  - 国の基準では課税だが、限度額を少し上回るだけ（余裕幅以内）。条例で切り上げている自治体では非課税になりうる。注記に使う
 *   specialNonTaxable - 障害者・未成年者・寡婦・ひとり親の135万円以下の非課税に当たったか（当たれば均等割・所得割とも0）
 *   humanDeductionDiff - 調整控除に使った人的控除差の合計（入力値＋特定扶養分18万円/人）
 *   dependentsCount  - 非課税判定に使った扶養等の人数（入力値＋特定扶養の子）
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
    selfDisabled = false,
    minor = false,
    widow = false,
    singleParent = false,
    lifeInsuranceDeduction = 0,
    earthquakeInsuranceDeduction = 0,
    medicalDeduction = 0,
    dependents = 0,
    humanDeductionDiff = 50_000,
    taxCredits = 0,
    specialDependentSalaries = [],
    fiscalYear, // 住民税の年度。未指定=令和8年度(2026)で後方互換（給与所得控除の最低保障65万）。
                // 2027以降で給与所得控除の最低保障74万を適用（令和8年度税制改正）。
    kyuchi: kyuchiInput, // 生活保護の級地（1/2/3）。未指定は data.kyuchi → 1級地。
  } = inputs || {};
  const kyuchi = [1, 2, 3].includes(kyuchiInput) ? kyuchiInput
               : [1, 2, 3].includes(cfg.kyuchi) ? cfg.kyuchi : 1;

  // ── 19〜22歳の子等（B案: 給与収入から特定扶養／特定親族特別控除を自動判定） ──
  let specialDependentDeduction = 0; // 適用された控除額の合計（特定扶養45万を含む）
  let _sdHumanDiff = 0;              // 特定扶養該当分の人的控除差（特別控除分は対象外）
  let _sdDependents = 0;             // 特定扶養該当分の扶養人数（特別控除対象者は含めない）
  for (const s of (Array.isArray(specialDependentSalaries) ? specialDependentSalaries : [])) {
    if (!Number.isFinite(s) || s < 0) continue; // 給与 0円の子も所得 0 で特定扶養に当たる（2026-10-29 C128。旧: s <= 0 で読み飛ばしていた）
    // 給与→所得の閾値も年度で動く（65万前提「給与123万⇔所得58万」→74万年度は「給与132万⇔所得58万」）。
    const relIncome = _income.calcSalaryIncome(s, fiscalYear);
    if (relIncome <= fuyoIncomeLimitJumin(fiscalYear)) {
      // 所得が扶養の要件以下（令和8年度58万円・令和9年度以後62万円）→ 特定扶養控除（45万円・控除差18万円・扶養人数+1）
      specialDependentDeduction += 450_000;
      _sdHumanDiff += 180_000;
      _sdDependents += 1;
    } else {
      specialDependentDeduction += calcTokuteiShinzokuDeduction(relIncome, fiscalYear);
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
      calcBasicDeductionJumin(totalIncome, cfg.basicDeductionJumin) + lifeInsuranceDeduction + earthquakeInsuranceDeduction + medicalDeduction,
  });
  const taxableIncome = Math.floor(taxableRaw / 1000) * 1000;

  // ── 非課税判定（均等割は級地別・所得割は全国一律） ──
  // 障害者・未成年者・寡婦・ひとり親で合計所得135万円以下なら、両方とも非課税（地方税法 第24条の5・第295条）。
  const specialStatus = !!(selfDisabled || minor || widow || singleParent || singleParentDeduction > 0);
  const specialNonTaxable = specialStatus && totalIncome <= SPECIAL_NON_TAXABLE_INCOME_LIMIT;
  const kintoNonTaxableLimit = _kintoNonTaxableLimit(effDependents, kyuchi);
  const kintoTaxable   = !specialNonTaxable && totalIncome > kintoNonTaxableLimit;
  // 境目付近: 国の基準では課税だが、条例で基準額を切り上げている自治体なら非課税になりうる帯。
  //   条例の差は確認できた範囲ではすべて切り上げ（非課税が広がる向き）なので、課税側だけを見る。
  const kintoBorderline = kintoTaxable && totalIncome <= kintoNonTaxableLimit + _kintoBorderlineMargin(effDependents);
  const shotokuTaxable = !specialNonTaxable && taxableIncome > 0 && totalIncome > _shotokuNonTaxableLimit(effDependents);

  // ── 所得割（調整控除・税額控除適用後） ──
  let incomeLevy = 0;
  let adjustmentCredit = 0;
  if (shotokuTaxable) {
    // 道府県民税と市町村民税は別の税なので、所得割はそれぞれで算出し、それぞれ 100円未満を切り捨てる
    //（地方税法 第20条の4の2第3項。自治体の計算例も別々に切り捨てる＝調布市「個人住民税が算出されるまでの計算例」
    //  https://www.city.chofu.lg.jp/030010/p014019.html ・2026-10-29 確認。2026-10-29 全方向試算 C042）。
    // 調整控除の率は 道府県2%・市町村3%（政令市は 1%・4%）。税額控除（寄附金等）も同じ割合で分ける（概算）。
    // 政令市は市の税率が 7%以上（標準 8%・名古屋 7.7%）で見分ける。県の税率には超過課税（例 4.025%）が乗るので比では分けない。
    const seirei   = cfg.cityRate >= 0.07;
    const prefShare = seirei ? 1 : 2;  // 調整控除 5% のうち道府県分（%）
    const adjBase  = _adjustmentCreditBase(taxableIncome, effHumanDiff, totalIncome);
    const prefAdj  = Math.floor(adjBase * prefShare / 100);
    const cityAdj  = Math.floor(adjBase * (5 - prefShare) / 100);
    adjustmentCredit = prefAdj + cityAdj;
    const credits  = Math.max(0, taxCredits);
    const prefCred = Math.floor(credits * prefShare / 5);
    const cityCred = credits - prefCred;
    const prefLevy = Math.max(0, Math.floor(taxableIncome * cfg.prefRate) - prefAdj - prefCred);
    const cityLevy = Math.max(0, Math.floor(taxableIncome * cfg.cityRate) - cityAdj - cityCred);
    incomeLevy = Math.floor(prefLevy / 100) * 100 + Math.floor(cityLevy / 100) * 100; // それぞれ 100円未満切捨て
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
    kyuchi, kintoNonTaxableLimit, kintoBorderline,
    specialNonTaxable,         // 障害者・未成年者・寡婦・ひとり親の135万円以下の非課税に当たったか
    specialDependentDeduction, // 19〜22歳の子等に適用された控除額（特定扶養45万/特定親族特別控除3万〜45万）
    humanDeductionDiff: effHumanDiff, // 調整控除に使った人的控除差の合計（特定扶養分を含む）
    dependentsCount: effDependents,   // 非課税判定に使った扶養等の人数（特定扶養の子を含む）
    hoikuShotokuwari,          // 保育料の指数(1人分・市民税所得割/調整控除後/税額控除前/旧6%換算)。父母合算は呼び出し側で。
  };
}

if (_isNode) module.exports = { calculateJumin, JUMIN_DEFAULTS, calcTokuteiShinzokuDeduction, calcHoikuShotokuwari, _adjustmentCreditBase, fuyoIncomeLimitJumin, calcSpouseDeductionJumin, calcSelfStatusDeductionJumin, calcBasicDeductionJumin };
