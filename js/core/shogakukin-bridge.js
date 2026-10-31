// 結線ブリッジ: 年収 → 住民税エンジン(jumin) → 奨学金コア(shogakukin) — Fable5再設計版
// 生計維持者(＋本人)の「年収・控除」を jumin.calculateJumin に通し、課税標準額・合計所得・
// 所得割課税フラグ(B2)を得て奨学金の supporter 形へ写す。1計算機＋横断連携型の心臓部。
//
// 是正点:
//   B2 所得割非課税を jumin の totalIncome＋扶養人数から判定し supporter.shotokuwariTaxable に結線。
//   M4 扶養控除・特定扶養(大学生等)を jumin へ結線（dependentDeduction/dependents/specialDependentSalaries）。
//   M3 本人(isStudent)も supporter として合算可。収入内訳・householdSize を保持。
'use strict';
// IIFE 化: ブラウザで jumin.js 等と top-level const（_isNode・_income 等）が字句衝突するため
// 全体を関数スコープに包む（Phase2 の vendored shaho.js と同方式・家計簿結線 2026-07-25）。Node 側は無影響。
(function () {
const _isNode = typeof module !== 'undefined' && !!module.exports;

const _jumin = _isNode ? require('./jumin.js') : {
  calculateJumin: (typeof window !== 'undefined' ? window.calculateJumin : null),
  calcSpouseDeductionJumin: (typeof calcSpouseDeductionJumin !== 'undefined' ? calcSpouseDeductionJumin : null),
  calcSelfStatusDeductionJumin: (typeof calcSelfStatusDeductionJumin !== 'undefined' ? calcSelfStatusDeductionJumin : null),
};
const _shogakukin = _isNode ? require('./shogakukin.js') : (typeof window !== 'undefined' ? window.Shogakukin : null);
const _loan = _isNode ? require('./shogakukin-loan.js') : (typeof window !== 'undefined' ? window.ShogakukinLoan : null);

// ─── 調整控除の人的控除差（地方税法 第37条第1号イの表・第314条の6第1号イ）[確認済 2026-10-30 e-Gov 法令API] ──
//   基礎 5万、控除対象配偶者 5万（老人 10万。本人の合計所得 900万超で 4万／6万、950万超で 2万／3万）、
//   一般扶養 5万・老人扶養 10万・同居老親等 13万、本人の障害者 1万・特別障害者 10万、ひとり親（母）5万・（父）1万・寡婦 1万。
//   特定扶養（19〜22歳）の 18万は specialDependentSalaries から住民税エンジンが足す。配偶者特別控除の配偶者は対象外（表(7)は所得55万円未満のみ）。
//   o.spouseHumanDiff（配偶者分の額）を渡せばそれを使い、無ければ hasSpouseDeduction で 5万（従来の簡易形）。
function estimateHumanDeductionDiff(opts) {
  const o = opts || {};
  const n = (v) => Math.max(0, (v | 0));
  let diff = 50_000; // 基礎控除差
  if (Number.isFinite(o.spouseHumanDiff)) diff += o.spouseHumanDiff;
  else if (o.hasSpouseDeduction) diff += 50_000;
  diff += 50_000 * n(o.generalDependents) + 100_000 * n(o.elderlyDependents) + 130_000 * n(o.elderlyCoResDependents);
  if (o.selfDisability === 'special') diff += 100_000;
  else if (o.selfDisability === 'general') diff += 10_000;
  if (o.singleParent === 'mother') diff += 50_000;
  else if (o.singleParent === 'father' || o.singleParent === 'widow') diff += 10_000;
  return diff;
}

// 生計維持者(＋本人)1人分: 年収系入力 → 奨学金 supporter 形
//   in: { salary, pension, age, otherIncome, socialInsurance, fiscalYear,
//         ── 配偶者 ── spouseIncome（配偶者の合計所得）, spouseAge70plus, hasSpouseDeduction（spouseIncome が無いとき所得0の配偶者とみなす）, spouseDeduction（額を直接）,
//         ── 扶養 ── generalDependents, elderlyDependents, elderlyCoResDependents, youngDependents（16歳未満）, specialDependentSalaries[]（19〜22歳の子の給与）,
//                    dependentDeduction（額を直接）, dependents（非課税判定の人数を直接・19〜22歳の子は含めない＝エンジンが足す）,
//         ── 本人 ── singleParent（'mother'|'father'|'widow'）, selfDisability（'general'|'special'）, minor, under23Dependent（所得金額調整控除 第1項）,
//         humanDeductionDiff（直接）, designatedCity, cityAdjustActual, adjustmentAmount, isStudent, householdSize }
//   控除と所得割の課税判定は住民税エンジン（jumin.js）に任せる（2026-10-30 全方向試算 C067・C072〜C081・C179〜C182）。
//   ・配偶者控除／特別控除は配偶者の所得と本人の合計所得から calcSpouseDeductionJumin で決める（旧: hasSpouseDeduction で 33万か 0）
//   ・ひとり親・寡婦・障害者は calcSelfStatusDeductionJumin（寡婦・ひとり親は合計所得500万円以下）。135万円以下の非課税もエンジンが判定
//   ・所得割の課税はエンジンの shotokuTaxable（19〜22歳の子を含む扶養人数・135万円非課税を反映）。旧はブリッジ自前の判定で食い違っていた
function supporterFromIncome(juminData, in_) {
  const i = in_ || {};
  const n = (v) => Math.max(0, (v | 0));
  const fy = i.fiscalYear;
  const under23Dependent = !!i.under23Dependent;
  // 本人の合計所得（配偶者控除の段階・ひとり親の500万円要件に使う）
  const selfIncome = _jumin.calculateJumin(juminData || null, {
    salary: i.salary || 0, pension: i.pension || 0, age: i.age, otherIncome: i.otherIncome || 0, fiscalYear: fy, under23Dependent,
  }).totalIncome;
  const sp = (i.singleParent === 'mother' || i.singleParent === 'father' || i.singleParent === 'widow') ? i.singleParent : 'none';
  const st = _jumin.calcSelfStatusDeductionJumin
    ? _jumin.calcSelfStatusDeductionJumin({ selfIncome, singleParent: sp, selfDisability: i.selfDisability || 'none' })
    : { singleParentDeduction: sp === 'none' ? 0 : (sp === 'widow' ? 260_000 : 300_000), disabilityDeduction: 0, selfDisabled: false, singleParent: sp };
  // 配偶者
  const hasSpouseInfo = Number.isFinite(i.spouseIncome) || !!i.hasSpouseDeduction;
  const sd = (hasSpouseInfo && _jumin.calcSpouseDeductionJumin)
    ? _jumin.calcSpouseDeductionJumin({ selfIncome, spouseIncome: Number.isFinite(i.spouseIncome) ? i.spouseIncome : 0, age70plus: !!i.spouseAge70plus, fiscalYear: fy })
    : { kind: hasSpouseInfo ? 'haigu' : 'none', deduction: hasSpouseInfo ? 330_000 : 0, humanDiffAmount: hasSpouseInfo ? 50_000 : 0 };
  const spouseDeduction = Number.isFinite(i.spouseDeduction) ? i.spouseDeduction : sd.deduction;
  // 扶養
  const generalDependents = n(i.generalDependents), elderlyDependents = n(i.elderlyDependents), elderlyCoResDependents = n(i.elderlyCoResDependents);
  const dependentDeduction = Number.isFinite(i.dependentDeduction) ? i.dependentDeduction
    : 330_000 * generalDependents + 380_000 * elderlyDependents + 450_000 * elderlyCoResDependents;
  const specialDependentSalaries = Array.isArray(i.specialDependentSalaries) ? i.specialDependentSalaries : [];
  // 非課税判定の人数（同一生計配偶者＋扶養親族。19〜22歳の子はエンジンが specialDependentSalaries から足すので入れない）
  const baseDependents = Number.isFinite(i.dependents) ? i.dependents
    : (sd.kind === 'haigu' ? 1 : 0) + generalDependents + elderlyDependents + elderlyCoResDependents + n(i.youngDependents);
  const hdd = Number.isFinite(i.humanDeductionDiff) ? i.humanDeductionDiff
    : estimateHumanDeductionDiff({ spouseHumanDiff: sd.humanDiffAmount, generalDependents, elderlyDependents, elderlyCoResDependents,
        selfDisability: i.selfDisability, singleParent: st.singleParent });

  const j = _jumin.calculateJumin(juminData || null, {
    salary: i.salary || 0, pension: i.pension || 0, age: i.age,
    otherIncome: i.otherIncome || 0, socialInsurance: i.socialInsurance || 0,
    spouseDeduction, dependentDeduction,
    singleParentDeduction: Number.isFinite(i.singleParentDeduction) ? i.singleParentDeduction : st.singleParentDeduction,
    disabilityDeduction: Number.isFinite(i.disabilityDeduction) ? i.disabilityDeduction : st.disabilityDeduction,
    selfDisabled: st.selfDisabled, widow: st.singleParent === 'widow', minor: !!i.minor,
    dependents: baseDependents,
    specialDependentSalaries,           // 19〜22歳の子等（特定扶養／特定親族特別控除・人的控除差18万・非課税人数をエンジンが足す）
    humanDeductionDiff: hdd, fiscalYear: fy, under23Dependent,
  });

  return {
    taxableIncome: j.taxableIncome,
    totalIncome: j.totalIncome,
    humanDeductionDiff: j.humanDeductionDiff,   // 特定扶養18万を含む（奨学金の調整控除用）
    shotokuwariTaxable: j.shotokuTaxable,       // 所得割の課税（エンジンの判定）
    designatedCity: !!i.designatedCity,
    cityAdjustActual: Number.isFinite(i.cityAdjustActual) ? i.cityAdjustActual : undefined,
    adjustmentAmount: i.adjustmentAmount || 0,
    isStudent: !!i.isStudent,           // [M3] 本人合算フラグ
    income: { salary: i.salary || 0, pension: i.pension || 0, other: i.otherIncome || 0 }, // 将来の貸与型用
    householdSize: Number.isFinite(i.householdSize) ? i.householdSize : undefined,
    _jumin: j,                          // 参考: 住民税額・isTaxable など
  };
}

// 年収ベースの一括判定: supportersIncome[] → 奨学金判定
// 高専本科1〜3年は給付型（修学支援新制度）の対象外[確認済 2026-07-20 本科4年生から・国立高専機構/JASSO FAQ]
function _isKosen13(st) {
  return st.level === '高専1-3年' || (st.level === '高等専門学校' && (st.kosenGrade === '1-3' || st.kosenLower === true));
}

function calcFromIncome(spec, juminData, inputs) {
  const supporters = (inputs.supportersIncome || []).map(s => supporterFromIncome(juminData, s));
  // 高専本科1〜3年は対象外として返す（2026-10-30 全方向試算 C186。旧は大学等として区分・給付を出していた）
  if (_isKosen13(inputs.student || {})) {
    return { kijungaku: null, kubun: '対象外（高専本科1〜3年）', kubunCode: null, ratioLabel: null, isTashiSetai: false, isRiko: false,
             category: 'out', grantMonthly: 0, grantIsAnnual: false, reductionCap: { tuition: 0, admission: 0 }, notEligible: 'kosen13' };
  }
  return _shogakukin.calcShogakukin(spec, {
    supporters,
    student: inputs.student,
    childrenCount: inputs.childrenCount,
    assets: inputs.assets,
    rikoNoPrivate: inputs.rikoNoPrivate,
    householdSize: inputs.householdSize,
  });
}

// 年収ベースの貸与型判定: 給付判定＋貸与判定をまとめて返す。給付コア/貸与コアは無改変。
//   inputs は calcFromIncome と同形＋ { singleParent?, applicationType?, withGrant? }。
//   withGrant=false のとき併給調整をしない（給付を受けない前提）。
function calcLoanFromIncome(spec, juminData, inputs) {
  const supporters = (inputs.supportersIncome || []).map(s => supporterFromIncome(juminData, s));
  // 高専本科1〜3年は給付型（修学支援新制度）の対象外＝給付は計算しない[確認済 2026-07-20 本科4年生から・国立高専機構/JASSO FAQ]
  const st = inputs.student || {};
  const isK13 = _isKosen13(st);
  const grantResult = isK13 ? null : _shogakukin.calcShogakukin(spec, {
    supporters,
    student: inputs.student,
    childrenCount: inputs.childrenCount,
    assets: inputs.assets,
    rikoNoPrivate: inputs.rikoNoPrivate,
    householdSize: inputs.householdSize,
  });
  const useGrant = (inputs.withGrant === false || isK13) ? null : grantResult;
  // singleParent は生計維持者1人目の申告を代表として使う（UIは世帯単位で1回入力）。
  const sp = (inputs.singleParent === 'mother' || inputs.singleParent === 'father')
    ? inputs.singleParent
    : ((inputs.supportersIncome || [])[0] || {}).singleParent || null;
  const loan = _loan.calcLoanEligibility(spec, {
    supporters,
    student: inputs.student,
    childrenCount: inputs.childrenCount,
    singleParent: sp,
    applicationType: inputs.applicationType || 'zaigaku',
    grantResult: useGrant,
  });
  return { grant: grantResult, loan };
}

if (_isNode) module.exports = { supporterFromIncome, calcFromIncome, calcLoanFromIncome, estimateHumanDeductionDiff };
else if (typeof window !== 'undefined') window.ShogakukinBridge = { supporterFromIncome, calcFromIncome, calcLoanFromIncome, estimateHumanDeductionDiff };
})();
