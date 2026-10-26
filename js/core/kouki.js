// 後期高齢者医療保険料（75歳以上・被保険者1人分）計算ロジック（純粋関数）
//
// 国保(kokuho.js)・住民税(jumin.js)・介護(kaigo.js)＋共通の所得換算(shared/income.js)と
// 同じ「制度ロジックはデータ化」方針に従う。料率・軽減率・しきい値はすべて
// kouki-{year}.json（都道府県均一）に格納し、本エンジンはそれを評価するだけ。
//
// 構造（令和8・9年度 公表ルール）:
//   年間保険料 = 医療分 + 子ども・子育て支援金分（子分）
//   各分 = 均等割額（軽減後） + 所得割額（軽減後）
//   各分ごとに賦課限度額を上限とし、各分の端数を処理した後に合計する。
//
// 端数処理（広域連合の条例ごとに違う。data.rounding に持つ）:
//   income           所得割額の端数   "floor"（切り捨て）/ "ceil"（切り上げ）/ "round" / "none"（規定なし＝端数を持ったまま合計）
//                    医療分と子ども分で違う県は { medical, childcare } で持つ
//   incomeUnit       所得割額の端数単位（既定 1円。埼玉は10円未満切り捨て）
//   reducedPerCapita 低所得による軽減（7/5/2割）後の均等割額の端数  "floor" / "ceil" / "round" / "none"
//                    条例が「減額する額を切り上げ」と書く県も、軽減後の額では "floor" になる
//   reducedUnit      軽減後の均等割額の端数単位（既定 1円。埼玉は10円）
//   reducedDependent 被扶養者軽減（5割）後の均等割額の端数（既定は reducedPerCapita と同じ。東京は "ceil"）
//   incomeReductionAmount 所得割の独自軽減（東京）の「減額する額」の端数（既定は無し＝率を掛けた後にまとめて処理）
//   levyUnit         賦課額の端数単位 { medical, childcare, total? }  100=100円未満切り捨て / 10 / 1。
//                    total がある県（福島）は医療分＋子ども分の合計に一度だけ掛ける
//   例: 兵庫は賦課額の端数規定なし（levyUnit 1）、愛知は所得割を切り上げ、千葉は子ども分を10円未満切り捨て。
//   data.rounding が無いデータは従来の扱い（1円未満は四捨五入・各分100円未満切り捨て）。
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

// 条例に端数規定が見つかっていないデータの扱い（従来どおり）
const LEGACY_ROUNDING = { income: "round", reducedPerCapita: "round", levyUnit: { medical: 100, childcare: 100 } };

// 金額は 100万分の1円（マイクロ円）の整数で持ち、浮動小数の誤差を出さない。
//   率は小数6桁までを整数に直して掛ける（例 0.1077 → 107700）。
const MICRO = 1000000;
function microMul(amount, rate) { return amount * Math.round(rate * MICRO); }
// unit 円未満の処理（"none" は端数を持ったまま返す）
function roundMicro(m, mode, unit) {
  const u = (unit || 1) * MICRO;
  if (mode === "none")  return m;
  if (mode === "floor") return Math.floor(m / u) * u;
  if (mode === "ceil")  return Math.ceil(m / u) * u;
  return Math.round(m / u) * u;
}

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
 * @param {Object} [data.rounding]                - 条例の端数処理 { income, reducedPerCapita, levyUnit:{medical,childcare} }。
 *                   省略時は従来の扱い（1円未満四捨五入・各分100円未満切り捨て）
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
  // 被扶養者軽減の条は「低所得の7割・5割軽減を受けない人」に掛かる。その人だけ被扶養者軽減の端数規定を使う
  const dependentRule = dependent && rMedical < 0.5;
  if (dependent) {
    rMedical   = Math.max(rMedical,   0.5);
    rChildcare = Math.max(rChildcare, 0.5);
    label = (label === "7割軽減") ? "7割軽減（被扶養者）" : "被扶養者軽減";
  }

  // ── 端数処理の規則（条例ごと）。無ければ従来の扱い ──
  const rd = data.rounding || LEGACY_ROUNDING;
  const levyUnit = rd.levyUnit || LEGACY_ROUNDING.levyUnit;

  // ── 均等割額（軽減後） ──
  const reducedMode = dependentRule ? (rd.reducedDependent || rd.reducedPerCapita) : rd.reducedPerCapita;
  const perCapitaMedical   = roundMicro(microMul(data.perCapita.medical,   1 - rMedical),   reducedMode, rd.reducedUnit);
  const perCapitaChildcare = roundMicro(microMul(data.perCapita.childcare, 1 - rChildcare), reducedMode, rd.reducedUnit);

  // ── 所得割の軽減（広域連合独自・任意。しきい値の小さい順に評価） ──
  let incomeReductionRate = 0;
  if (Array.isArray(data.incomeReduction)) {
    for (const tier of data.incomeReduction) {
      if (base <= tier.threshold) { incomeReductionRate = tier.rate; break; }
    }
  }

  // ── 所得割額（軽減後）。被扶養者軽減の場合は所得割を賦課しない ──
  const incomeMode = typeof rd.income === "object" ? rd.income : { medical: rd.income, childcare: rd.income };
  const incomePart = (rate, mode) => {
    if (dependent) return 0;
    if (rd.incomeReductionAmount && incomeReductionRate > 0) {
      // 所得割額を出してから「減額する額」（所得割額×率）を条例の向きで丸めて引く（東京）
      const full = roundMicro(microMul(base, rate), mode, rd.incomeUnit);
      return full - roundMicro(Math.round(full * incomeReductionRate), rd.incomeReductionAmount);
    }
    return roundMicro(microMul(base, rate * (1 - incomeReductionRate)), mode, rd.incomeUnit);
  };
  const incomeMedical   = incomePart(data.rate.medical,   incomeMode.medical);
  const incomeChildcare = incomePart(data.rate.childcare, incomeMode.childcare);

  // ── 分ごとに 合計→限度額→端数単位（100円・10円・1円）で切り捨て ──
  const capped = (micro, cap) => Math.min(micro, cap * MICRO);
  const toYen  = (micro, unit) => Math.floor(micro / (unit * MICRO)) * unit;
  const medicalMicro   = capped(perCapitaMedical   + incomeMedical,   data.caps.medical);
  const childcareMicro = capped(perCapitaChildcare + incomeChildcare, data.caps.childcare);
  const medicalTotal   = toYen(medicalMicro,   levyUnit.medical);
  const childcareTotal = toYen(childcareMicro, levyUnit.childcare);
  // 合計にだけ端数単位を掛ける県（福島）は、各分の表示額の和と合計が一致しないことがある
  const total = levyUnit.total ? toYen(medicalMicro + childcareMicro, levyUnit.total) : medicalTotal + childcareTotal;
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
