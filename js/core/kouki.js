// 後期高齢者医療保険料（75歳以上・被保険者1人分）計算ロジック（純粋関数）
//
// 国保(kokuho.js)・住民税(jumin.js)・介護(kaigo.js)＋共通の所得換算(shared/income.js)と
// 同じ「制度ロジックはデータ化」方針に従う。料率・軽減率・しきい値はすべて
// kouki-{year}.json（都道府県均一）に格納し、本エンジンはそれを評価するだけ。
//
// 構造（令和8・9年度 公表ルール）:
//   年間保険料 = 医療分 + 子ども・子育て支援金分（子分）
//   各分 = 均等割額（軽減後） + 所得割額（軽減後）
//   各分ごとに賦課限度額を上限とし、各分100円未満を切り捨てた後に合計する。
//
//   所得割 = (総所得金額等 − 基礎控除43万) × 所得割率
//   均等割軽減(7/5/2割) は世帯の軽減判定所得で決定。
//     ・医療分の7割軽減は国の財政措置で「7.2割軽減」(=0.72)。子ども分は7割(=0.70)。【全国一律・R8】
//   所得割軽減 は広域連合独自（東京のみ: 旧ただし書所得15万以下50%/20万以下25%。
//     独自軽減の無い県は incomeReduction=null）。
//
// 全国一律パラメータ（kouki-{year}.json に各県同値で格納）:
//   reduction.base=430000 / fivePerInsured=310000 / twoPerInsured=570000 / perEarnerAdd=100000
//   caps.medical=850000 / caps.childcare=21000 / basicDeduction=430000
//   ratios.seven={medical:0.72, childcare:0.70} / five=0.50 / two=0.20
//
// データ出典: 厚生労働省「後期高齢者医療制度の令和8・9年度の保険料率について」(令和8年4月10日)
//   全47広域連合の医療分・子ども分の均等割/所得割を一覧化したもの。

'use strict';

/**
 * 後期高齢者医療 被保険者1人分の年間保険料を計算する（純粋関数）。
 *
 * @param {Object} input
 * @param {number} input.totalIncome              - 本人の総所得金額等（基礎控除前）
 * @param {number} [input.reductionJudgmentIncome]- 世帯の均等割軽減判定額
 *                  （65歳以上の年金所得は高齢者特別控除15万を差し引いた後の額の世帯合算）。
 *                   省略時は本人の totalIncome で代用（単身近似）。
 * @param {number} [input.householdInsuredCount]  - 世帯の後期被保険者数（既定1）
 * @param {number} [input.pensionSalaryEarnerCount]- 世帯の公的年金/給与所得者数（2人以上で (−1)×10万 加算）
 * @param {boolean} [input.formerEmployeeInsuranceDependent] - 加入直前に被用者保険（協会けんぽ・
 *                  組合健保・共済等）の被扶養者だった人。true の場合、所得割は賦課されず、
 *                  均等割は5割軽減（低所得軽減に該当する場合は高い方を適用）。加入から2年以内が対象。
 * @param {Object} data                           - kouki-{year}.json
 * @param {number} data.basicDeduction            - 基礎控除（43万）
 * @param {Object} data.perCapita                 - { medical, childcare } 均等割額
 * @param {Object} data.rate                      - { medical, childcare } 所得割率
 * @param {Object} data.caps                      - { medical, childcare } 賦課限度額
 * @param {Object} data.reduction                 - 均等割軽減のしきい値・軽減率
 * @param {Array|null} [data.incomeReduction]     - 所得割の独自軽減（しきい値昇順）。無い県は null
 * @returns {Object|null} null は data が不正な場合
 */
function calculateKouki(input, data) {
  if (!data || !data.perCapita || !data.rate || !data.caps || !data.reduction) return null;

  const {
    totalIncome,
    reductionJudgmentIncome,
    householdInsuredCount,
    pensionSalaryEarnerCount,
  } = input || {};

  const incomeSafe = Math.max(totalIncome || 0, 0);
  const insured    = Math.max(householdInsuredCount || 1, 1);
  const earners    = Math.max(pensionSalaryEarnerCount || 0, 0);
  const judge      = reductionJudgmentIncome ?? incomeSafe;

  // 所得割のもととなる所得金額
  const base = Math.max(incomeSafe - data.basicDeduction, 0);

  // ── 均等割軽減（7/5/2割）判定 ──
  const earnerAdd  = earners >= 2 ? data.reduction.perEarnerAdd * (earners - 1) : 0;
  const sevenLimit = data.reduction.base + earnerAdd;
  const fiveLimit  = data.reduction.base + earnerAdd + data.reduction.fivePerInsured * insured;
  const twoLimit   = data.reduction.base + earnerAdd + data.reduction.twoPerInsured  * insured;

  let rMedical = 0, rChildcare = 0, label = "軽減なし";
  if (judge <= sevenLimit) {
    label = "7割軽減"; rMedical = data.reduction.ratios.seven.medical; rChildcare = data.reduction.ratios.seven.childcare;
  } else if (judge <= fiveLimit) {
    label = "5割軽減"; rMedical = data.reduction.ratios.five.medical;  rChildcare = data.reduction.ratios.five.childcare;
  } else if (judge <= twoLimit) {
    label = "2割軽減"; rMedical = data.reduction.ratios.two.medical;   rChildcare = data.reduction.ratios.two.childcare;
  }

  // ── 被扶養者軽減（旧・被用者保険の被扶養者。加入から2年以内） ──
  //   所得割は賦課されず、均等割は5割軽減。低所得による軽減（医療7.2割等）に該当する場合は高い方を適用。
  const dependent = !!(input && input.formerEmployeeInsuranceDependent);
  if (dependent) {
    rMedical   = Math.max(rMedical,   0.5);
    rChildcare = Math.max(rChildcare, 0.5);
    label = (label === "7割軽減") ? "7割軽減（被扶養者）" : "被扶養者軽減";
  }

  // ── 均等割額（軽減後） ──
  const perCapitaMedical   = Math.round(data.perCapita.medical   * (1 - rMedical));
  const perCapitaChildcare = Math.round(data.perCapita.childcare * (1 - rChildcare));

  // ── 所得割の軽減（広域連合独自・任意。しきい値の小さい順に評価） ──
  let incomeReductionRate = 0;
  if (Array.isArray(data.incomeReduction)) {
    for (const tier of data.incomeReduction) {
      if (base <= tier.threshold) { incomeReductionRate = tier.rate; break; }
    }
  }

  // ── 所得割額（軽減後）。被扶養者軽減の場合は所得割を賦課しない ──
  const incomeMedical   = dependent ? 0 : Math.round(base * data.rate.medical   * (1 - incomeReductionRate));
  const incomeChildcare = dependent ? 0 : Math.round(base * data.rate.childcare * (1 - incomeReductionRate));

  // ── 分ごとに 合計→限度額→100円未満切り捨て ──
  const floor100 = v => Math.floor(v / 100) * 100;
  const medicalTotal   = floor100(Math.min(perCapitaMedical   + incomeMedical,   data.caps.medical));
  const childcareTotal = floor100(Math.min(perCapitaChildcare + incomeChildcare, data.caps.childcare));

  const total = medicalTotal + childcareTotal;
  return {
    medicalTotal,
    childcareTotal,
    total,
    monthly: Math.round(total / 12),
    reductionLabel: label,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateKouki };
}
