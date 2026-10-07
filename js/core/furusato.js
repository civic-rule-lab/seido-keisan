// ふるさと納税（都道府県・市区町村への寄附金）の控除上限額と控除の内訳（純粋関数）
//
// 対象: 2026年中の寄附 ＝ 所得税は令和8年分、住民税は令和9年度分（data/national/furusato-2027.json）。
// 制度値（特例控除の割合・2,000円・20% など）はすべてデータから読む。このファイルに数値を埋めない。
//
// 全額控除（自己負担 2,000円）になる寄附額の上限:
//   上限額 ＝ 住民税所得割額 × 20% ÷ 特例控除の割合 ＋ 2,000円
//   ・住民税所得割額 ＝ 税率をかけ、調整控除を引いた後、住宅ローン控除などの税額控除を引く前の額
//     （地方税法 第37条の2第11項「第三十五条及び前条の規定を適用した場合の所得割の額」）。
//     calculateJumin(data, { ..., fiscalYear: 2027, taxCredits: 0 }).incomeLevy がこれに当たる。
//   ・特例控除の割合は「課税総所得金額 − 人的控除差調整額」の区分で決まる（第37条の2第11項第1号・第2号）。
//   ・人的控除差調整額 ＝ 第37条第1号イの金額（calculateJumin の戻り値 humanDeductionDiff。基礎控除の差5万円を含む）
//                       ＋ max(0, 前年分の所得税の基礎控除の額 − 48万円)
//     後半は令和8年法律第2号による改正で、令和8年度分以後に適用（2026年中の寄附にも入る）。
//
// 扱わないもの（呼び出し側で利用者に断る）:
//   ・課税山林所得金額・課税退職所得金額がある人（第37条の2第11項第3号の割合）
//   ・2027年以後の寄附の 193万円上限（令和10年度分から。データの notes 参照）
//
// 金額の端数: 上限額は1円未満切捨て。実際の税額計算は県分・市分ごとに端数処理するため、
// ここでの値は数十円〜数百円ずれうる「目安」である。

// 特例控除の割合を、データの百分率（例 84.895）から 10万分率の整数（84895）にする。
// 浮動小数の割り算を避けるため（0.84895 は2進で正確に表せない）。
function _furusatoRatioUnits(percent) {
  return Math.round(percent * 1000);
}

// 「課税総所得金額 − 人的控除差調整額」から特例控除の割合を引く。
// 戻り値: { percent, units, band } band は 'negative' か、bands の添字（0 始まり）。
function furusatoSpecialRatio(base, data) {
  const sr = data.specialRatio;
  if (base < 0) {
    return { percent: sr.negativePercent, units: _furusatoRatioUnits(sr.negativePercent), band: 'negative' };
  }
  for (let i = 0; i < sr.bands.length; i++) {
    const b = sr.bands[i];
    if (b.upTo == null || base <= b.upTo) {
      return { percent: b.percent, units: _furusatoRatioUnits(b.percent), band: i };
    }
  }
  throw new Error('furusatoSpecialRatio: 区分の表に上限なしの行がありません');
}

// 所得税の限界税率（復興特別所得税を含まない）を、課税所得と税率表から引く。
// taxTable は shotoku.js の loadParams(year, db).taxTable と同じ形 [[上限, 税率, 控除額], ...]（上限 null/Infinity=上限なし）。
function furusatoMarginalShotokuRate(kazeiShotoku, taxTable) {
  if (!(kazeiShotoku > 0)) return 0;
  for (const row of taxTable) {
    const upTo = row[0] == null ? Infinity : row[0];
    if (kazeiShotoku <= upTo) return row[1];
  }
  return taxTable[taxTable.length - 1][1];
}

// 特例控除の割合から、その区分の所得税率（復興特別所得税を含まない）を逆算する。
// 割合は「90% − 所得税率×1.021」で作られている（附則第5条の6 の値はすべてこの形）。
// 区分の基準額（課税総所得 − 人的控除差調整額）は所得税の課税所得に近づけた額なので、
// 所得税の課税所得が分からない簡単計算で、内訳の所得税分の目安に使う。基準額が負（90%）なら 0。
function furusatoImpliedShotokuRate(ratio, data) {
  if (!ratio || ratio.band === 'negative') return 0;
  const neg = _furusatoRatioUnits(data.specialRatio.negativePercent);
  const rateTimesSurtax = (neg - ratio.units) / 100000;           // 例 (90000−84895)/100000 = 0.05105
  return Math.round((rateTimesSurtax / data.shotokuSurtaxMultiplier) * 10000) / 10000; // 0.05
}

// 所得税の基礎控除（前年分）を、合計所得金額と表から引く。
// kisoTable は shotoku.js の loadParams(year, db).kisoKojo と同じ形 [[合計所得の上限, 控除額], ...]。
function furusatoShotokuBasicDeduction(totalIncome, kisoTable) {
  const ti = Math.max(0, Math.floor(totalIncome || 0));
  for (const row of kisoTable) {
    const upTo = row[0] == null ? Infinity : row[0];
    if (ti <= upTo) return row[1];
  }
  return 0;
}

/**
 * 人的控除差（地方税法 第37条第1号イの金額）を家族構成から求める（簡単計算用）。
 * 詳しく計算では calculateJumin の戻り値 humanDeductionDiff を使うこと（そちらは特定扶養の自動判定を含む）。
 * @param {object} f
 * @param {number} f.selfTotalIncome      本人の合計所得金額（配偶者の加算の段階に使う）
 * @param {string} [f.spouse]             'none' | 'general'（控除対象配偶者） | 'elderly'（老人控除対象配偶者）
 * @param {number} [f.dependentGeneral]   一般の控除対象扶養親族（16〜18歳・23〜69歳）の人数
 * @param {number} [f.dependentSpecific]  特定扶養親族（19〜22歳）の人数
 * @param {number} [f.dependentElderly]   老人扶養親族（70歳以上・同居老親を除く）の人数
 * @param {number} [f.dependentCohabitingParent] 同居老親等の人数
 * @param {string} [f.selfDisability]     'none' | 'general' | 'special'
 * @param {string} [f.singleParent]       'none' | 'mother' | 'father' | 'widow'（寡婦）
 * @param {boolean} [f.workingStudent]    勤労学生
 */
function furusatoHumanDeductionDiff(f, data) {
  const t = data.humanDiffTable;
  const n = (v) => Math.max(0, Math.floor(v || 0));
  let diff = t.base;
  if (f.spouse === 'general' || f.spouse === 'elderly') {
    const self = n(f.selfTotalIncome);
    const row = t.spouse.find((r) => r.selfIncomeUpTo == null || self <= r.selfIncomeUpTo);
    diff += f.spouse === 'elderly' ? row.elderly : row.general;
  }
  diff += n(f.dependentGeneral) * t.dependentGeneral;
  diff += n(f.dependentSpecific) * t.dependentSpecific;
  diff += n(f.dependentElderly) * t.dependentElderly;
  diff += n(f.dependentCohabitingParent) * t.dependentCohabitingParent;
  if (f.selfDisability === 'general') diff += t.selfDisabled;
  if (f.selfDisability === 'special') diff += t.selfSpecialDisabled;
  if (f.singleParent === 'mother') diff += t.singleParentMother;
  if (f.singleParent === 'father') diff += t.singleParentFather;
  if (f.singleParent === 'widow') diff += t.widow;
  if (f.workingStudent) diff += t.workingStudent;
  return diff;
}

/**
 * 控除上限額（全額控除になる寄附額の上限）を求める。
 * @param {object} input
 * @param {number} input.incomeLevy            住民税所得割額（県市合計・調整控除後・税額控除前）
 * @param {number} input.taxableIncome         住民税の課税総所得金額
 * @param {number} input.humanDeductionDiff    第37条第1号イの金額（基礎控除の差5万円を含む）
 * @param {number} input.shotokuBasicDeduction 前年分（令和8年分）の所得税の基礎控除の額
 * @param {boolean} [input.hasSanrinOrTaishoku] 課税山林所得金額・課税退職所得金額がある
 * @param {object} data data/national/furusato-2027.json
 * @returns {object} { supported, reason, humanAdjustment, base, ratio, specialCap, limit }
 *   supported=false … 計算の対象外（reason に理由）。limit は null。
 *   limit=0       … 所得割が0円で特例控除が生じない（reason='no_income_levy'）。
 */
function calcFurusatoLimit(input, data) {
  const incomeLevy = Math.max(0, Math.floor(input.incomeLevy || 0));
  const taxableIncome = Math.max(0, Math.floor(input.taxableIncome || 0));
  const humanDeductionDiff = Math.max(0, Math.floor(input.humanDeductionDiff || 0));
  const shotokuBasic = Math.max(0, Math.floor(input.shotokuBasicDeduction || 0));

  const humanAdjustment =
    humanDeductionDiff + Math.max(0, shotokuBasic - data.humanAdjustment.shotokuBasicDeductionOffset);
  const base = taxableIncome - humanAdjustment;

  if (input.hasSanrinOrTaishoku) {
    return { supported: false, reason: 'sanrin_or_taishoku', humanAdjustment, base, ratio: null, specialCap: null, limit: null };
  }
  if (incomeLevy <= 0 || taxableIncome <= 0) {
    return { supported: true, reason: 'no_income_levy', humanAdjustment, base, ratio: null, specialCap: 0, limit: 0 };
  }

  const ratio = furusatoSpecialRatio(base, data);
  // 特例分の上限 ＝ 所得割額 × 20%
  const specialCap = Math.floor(incomeLevy * data.specialCapRateOfIncomeLevy);
  // 上限額 ＝ 特例分の上限 ÷ 割合 ＋ 2,000円（割合は10万分率の整数で割る）
  const limit = Math.floor((specialCap * 100000) / ratio.units) + data.selfBurden;
  return { supported: true, reason: null, humanAdjustment, base, ratio, specialCap, limit };
}

/**
 * 寄附額ごとの控除の内訳（所得税・住民税基本分・住民税特例分）と自己負担額。
 * 確定申告をした場合の内訳（ワンストップ特例では所得税分も住民税から引かれるが、合計は同じ）。
 * @param {number} donation 寄附額（2026年中のふるさと納税の合計）
 * @param {object} ctx
 * @param {number} ctx.incomeLevy   住民税所得割額（calcFurusatoLimit と同じ値）
 * @param {object} ctx.ratio        calcFurusatoLimit(...).ratio
 * @param {number} ctx.shotokuMarginalRate 所得税の限界税率（furusatoMarginalShotokuRate）
 * @param {number} ctx.totalIncome  総所得金額等（控除対象額の 40%・30% の上限に使う）
 * @param {object} data data/national/furusato-2027.json
 */
function calcFurusatoBreakdown(donation, ctx, data) {
  const d = Math.max(0, Math.floor(donation || 0));
  const sb = data.selfBurden;
  const totalIncome = Math.max(0, Math.floor(ctx.totalIncome || 0));
  if (d <= sb || !ctx.ratio) {
    return { donation: d, shotoku: 0, juminBasic: 0, juminSpecial: 0, totalDeduction: 0, selfBurden: d };
  }
  // 所得税: (min(寄附額, 総所得金額等×40%) − 2,000) × 限界税率 × 1.021
  const shotokuBase = Math.max(0, Math.min(d, Math.floor(totalIncome * data.shotokuCapRateOfTotalIncome)) - sb);
  const shotoku = Math.floor(shotokuBase * (ctx.shotokuMarginalRate || 0) * data.shotokuSurtaxMultiplier);
  // 住民税 基本分: (min(寄附額, 総所得金額等×30%) − 2,000) × 10%
  const basicBase = Math.max(0, Math.min(d, Math.floor(totalIncome * data.juminBasicCapRateOfTotalIncome)) - sb);
  const juminBasic = Math.floor(basicBase * data.juminBasicRate);
  // 住民税 特例分: (寄附額 − 2,000) × 特例控除の割合。ただし所得割額の 20% まで
  const specialRaw = Math.floor(((d - sb) * ctx.ratio.units) / 100000);
  const specialCap = Math.floor(Math.max(0, ctx.incomeLevy || 0) * data.specialCapRateOfIncomeLevy);
  const juminSpecial = Math.min(specialRaw, specialCap);
  const totalDeduction = shotoku + juminBasic + juminSpecial;
  return { donation: d, shotoku, juminBasic, juminSpecial, totalDeduction, selfBurden: d - totalDeduction };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcFurusatoLimit, calcFurusatoBreakdown, furusatoSpecialRatio, furusatoMarginalShotokuRate,
    furusatoImpliedShotokuRate, furusatoShotokuBasicDeduction, furusatoHumanDeductionDiff,
  };
}
