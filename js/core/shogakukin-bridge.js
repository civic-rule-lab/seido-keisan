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

const _jumin = _isNode ? require('./jumin.js') : { calculateJumin: (typeof window !== 'undefined' ? window.calculateJumin : null) };
const _shogakukin = _isNode ? require('./shogakukin.js') : (typeof window !== 'undefined' ? window.Shogakukin : null);
const _loan = _isNode ? require('./shogakukin-loan.js') : (typeof window !== 'undefined' ? window.ShogakukinLoan : null);
const _income = _isNode ? require('./shared/income.js') : { calcSalaryIncome: (typeof calcSalaryIncome !== 'undefined' ? calcSalaryIncome : (s => 0)) };

// ─── 所得割の非課税限度額（標準・1級地）。jumin._shotokuNonTaxableLimit と同一の公開ルール ──
//   35万×(1+扶養等の人数)＋10万＋(扶養等がいれば32万)。
function _shotokuNonTaxableLimit(dependents) {
  const n = 1 + Math.max(0, dependents | 0);
  return 350_000 * n + 100_000 + (dependents > 0 ? 320_000 : 0);
}

// ─── 人的控除差の簡易合成 ───────────────────────────────────────────
//   基礎5万＋配偶者控除5万＋一般扶養5万/人。特定扶養(大学生等)分は jumin 側で自動加算されるので入れない。
//   ひとり親控除の差額は 母5万/父1万[確認済 姫路市・諏訪市 人的控除差早見表 2026-07-12]。
function estimateHumanDeductionDiff(opts) {
  const o = opts || {};
  let diff = 50_000; // 基礎控除差
  if (o.hasSpouseDeduction) diff += 50_000;
  diff += 50_000 * Math.max(0, (o.generalDependents | 0));
  if (o.singleParent === 'mother') diff += 50_000;
  else if (o.singleParent === 'father') diff += 10_000;
  return diff;
}

// 生計維持者(＋本人)1人分: 年収系入力 → 奨学金 supporter 形
//   in: { salary, pension, age, otherIncome, socialInsurance,
//         hasSpouseDeduction, generalDependents, specialDependentSalaries[],
//         dependentDeduction, spouseDeduction, dependents,
//         designatedCity, cityAdjustActual, adjustmentAmount, humanDeductionDiff,
//         isStudent, householdSize, fiscalYear }
function supporterFromIncome(juminData, in_) {
  const i = in_ || {};
  const generalDependents = Math.max(0, (i.generalDependents | 0));
  // ひとり親控除（令和3年度〜）: 住民税30万円[確認済 姫路市]。'mother'|'father' で人的控除差も分岐（5万/1万）。
  const singleParent = (i.singleParent === 'mother' || i.singleParent === 'father') ? i.singleParent : null;
  const singleParentDeduction = singleParent ? 300_000 : 0;
  const hdd = Number.isFinite(i.humanDeductionDiff) ? i.humanDeductionDiff : estimateHumanDeductionDiff(i);
  const spouseDeduction = Number.isFinite(i.spouseDeduction) ? i.spouseDeduction : (i.hasSpouseDeduction ? 330_000 : 0);
  const dependentDeduction = Number.isFinite(i.dependentDeduction) ? i.dependentDeduction : (330_000 * generalDependents);
  const specialDependentSalaries = Array.isArray(i.specialDependentSalaries) ? i.specialDependentSalaries : [];
  // 特定扶養に該当する子（所得58万円以下=給与123万円以下）は税法上の扶養親族＝非課税判定の人数に算入する。
  //   [80052df相当] dependents未指定のAPI直叩き経路で算入漏れ→第Ⅰ→第Ⅱ誤判定になり得たのを是正（UI経路は dependents 明示渡しで不変）。
  let _sdDepCount = 0;
  for (const s of specialDependentSalaries) {
    if (Number.isFinite(s) && s > 0 && _income.calcSalaryIncome(s, i.fiscalYear) <= 580_000) _sdDepCount++;
  }
  // 非課税判定に使う扶養等の人数（同一生計配偶者＋一般扶養＋特定扶養の子）。
  const baseDependents = Number.isFinite(i.dependents)
    ? i.dependents
    : (i.hasSpouseDeduction ? 1 : 0) + generalDependents + _sdDepCount;

  const j = _jumin.calculateJumin(juminData || null, {
    salary: i.salary || 0, pension: i.pension || 0, age: i.age,
    otherIncome: i.otherIncome || 0, socialInsurance: i.socialInsurance || 0,
    spouseDeduction, dependentDeduction, singleParentDeduction,
    dependents: baseDependents,
    specialDependentSalaries,           // 19〜22歳の子等（特定扶養/特定親族特別控除・非課税人数へ自動加算）[M4]
    humanDeductionDiff: hdd, fiscalYear: i.fiscalYear,
  });

  // 所得割の非課税判定[B2]: 課税標準>0 かつ 合計所得>非課税限度 でのみ所得割課税。
  //   非課税限度の扶養人数は baseDependents（同一生計配偶者＋一般扶養＋特定扶養の子）で近似。
  //   ※特定親族特別控除の対象者(給与188万以下・所得58万超)は税法上の扶養に含まれず限度に非加算だが、
  //     その帯は課税されることがほとんどで判定への影響は小さい[未確認・近似]。
  //   ひとり親・寡婦等は前年合計所得135万円以下で均等割・所得割とも非課税[確認済 大阪市 地方税法295条相当 2026-07-12]。
  const singleParentNonTax = !!singleParent && j.totalIncome <= 1_350_000;
  const shotokuwariTaxable = !singleParentNonTax &&
    (j.taxableIncome > 0 && j.totalIncome > _shotokuNonTaxableLimit(baseDependents));

  // 特定扶養(19〜22歳・所得58万以下)の人的控除差18万を、奨学金の調整控除にも反映する。
  //   （jumin 内部の effHumanDiff と同一ロジック。ここで合成しないと調整控除が過小→基準額が高め→区分が厳しめに振れる。）
  //   特定親族特別控除の帯(所得58万超)は人的控除差の対象外＝加算しない。
  let sdHumanDiff = 0;
  for (const s of specialDependentSalaries) {
    if (!Number.isFinite(s) || s <= 0) continue;
    if (_income.calcSalaryIncome(s, i.fiscalYear) <= 580_000) sdHumanDiff += 180_000;
  }
  const humanDeductionDiffOut = hdd + sdHumanDiff;

  return {
    taxableIncome: j.taxableIncome,
    totalIncome: j.totalIncome,
    humanDeductionDiff: humanDeductionDiffOut,   // 特定扶養18万を含む（奨学金の調整控除用）
    shotokuwariTaxable,                 // [B2]
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
function calcFromIncome(spec, juminData, inputs) {
  const supporters = (inputs.supportersIncome || []).map(s => supporterFromIncome(juminData, s));
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
  const isK13 = st.level === '高専1-3年' || (st.level === '高等専門学校' && (st.kosenGrade === '1-3' || st.kosenLower === true));
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
