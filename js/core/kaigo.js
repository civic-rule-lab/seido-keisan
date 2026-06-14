// 介護保険料（第1号被保険者・65歳以上）計算ロジック（純粋関数）
// 第2号被保険者（40〜64歳）は kokuho.js 内の careTotal で処理済み。
//
// 段階判定は kaigo-{year}.json の brackets[].criteria を順に評価する
// データ駆動方式。自治体ごとの段階数（9〜16段階）に自動対応。
//
// 境界値の格納方法:
//   pensionIncomeMax/Min, totalIncomeMax/Min, sumIncomeMax/Min はすべて
//   「含む（≤）」で格納する。
//   「〜未満」は値を -1 した整数で表す（例: 120万円未満 → totalIncomeMax: 1199999）。
//   「〜以上」は値をそのままで表す（例: 120万円以上 → totalIncomeMin: 1200000）。
//
// criteria 語彙（第4〜14段階の総ざらいで確定。生活保護/老齢福祉年金の
// 第1段階特例フラグは将来の拡張点として未実装＝対象利用者の結果に影響なし）:
//
//   課税状況フラグ（段階の"層"を決める）:
//     householdAllNonTaxable - 世帯全員が住民税非課税か（第1〜3段階の層）
//     selfTaxable            - 本人が住民税課税か（true=第6段階以上の層 /
//                              false かつ householdAllNonTaxable=false=第4〜5段階の層）
//
//   所得しきい値（層の中で段階を分ける。Max/Min は ≤ 含む・未満は -1）:
//     pensionIncome - 課税年金収入額（控除前の収入額）。第1〜3を年金のみで
//                     近似する旧データ向け（年金外所得があると誤判定→sumIncome 推奨）
//     sumIncome     - 段階判定用の合算所得 = 課税年金収入額
//                     ＋（公的年金等に係る所得を除く合計所得金額）。
//                     国の第1〜5段階の標準判定（「課税年金収入額＋合計所得金額が
//                     80万/120万…」）はこの合算しきい値で表す。
//     totalIncome   - 第6段階以上の判定に使う「介護段階判定用の合計所得金額」。
//                     住民税の合計所得金額とは別物で、公的年金等に係る雑所得を
//                     除外し、長期・短期譲渡所得の特別控除を適用した後の額。
//                     導出は呼び出し側（income.js）の責務。境界値・段階数・係数は
//                     自治体ごとにカスタム（13〜19段階等）で、本エンジンは brackets
//                     配列を first-match 評価するだけ（データ駆動）。
//     ※額は bracket.annual（公表値・百円丸め等）があれば優先、なければ
//       baseAmount×rate。係数と公表額が一致しない自治体があるため annual を正とする。

'use strict';

// ─── 段階マッチング ───────────────────────────────────────────

/**
 * memberContext が bracket の criteria を満たすか評価する。
 * criteria フィールドが存在しない bracket は常に true（フォールバック用）。
 *
 * @param {Object} ctx     - { pensionIncome, totalIncome, isSelfTaxable, isHouseholdAllNonTaxable }
 * @param {Object} bracket - { criteria?: { ... } }
 * @returns {boolean}
 */
function matchBracket(ctx, bracket) {
  const c = bracket.criteria;
  if (!c) return true;  // criteria なしはすべてマッチ

  if (c.householdAllNonTaxable !== undefined &&
      c.householdAllNonTaxable !== ctx.isHouseholdAllNonTaxable) return false;

  if (c.selfTaxable !== undefined &&
      c.selfTaxable !== ctx.isSelfTaxable) return false;

  if (c.pensionIncomeMax !== undefined &&
      ctx.pensionIncome > c.pensionIncomeMax) return false;

  if (c.pensionIncomeMin !== undefined &&
      ctx.pensionIncome < c.pensionIncomeMin) return false;

  if (c.totalIncomeMax !== undefined &&
      ctx.totalIncome > c.totalIncomeMax) return false;

  if (c.totalIncomeMin !== undefined &&
      ctx.totalIncome < c.totalIncomeMin) return false;

  if (c.sumIncomeMax !== undefined &&
      ctx.sumIncome > c.sumIncomeMax) return false;

  if (c.sumIncomeMin !== undefined &&
      ctx.sumIncome < c.sumIncomeMin) return false;

  return true;
}

// ─── 計算関数 ─────────────────────────────────────────────────

/**
 * 介護保険第1号被保険者（65歳以上）1人分の年間保険料を計算する。
 *
 * @param {Object} data           - kaigo-{year}.json
 * @param {number} data.baseAmount         - 基準額（円/年）
 * @param {Object[]} data.brackets         - 段階定義（配列順に先頭からマッチング）
 * @param {string} [data.fallbackLevel]    - criteria 不一致時のフォールバック段階
 * @param {Object} memberContext
 * @param {number} memberContext.pensionIncome            - 年金受給額（円・控除前）
 * @param {number} memberContext.totalIncome              - 合計所得金額（円）
 * @param {boolean} memberContext.isSelfTaxable           - 本人が住民税課税か
 * @param {boolean} memberContext.isHouseholdAllNonTaxable - 世帯全員が住民税非課税か
 * @returns {Object|null} null は data が不正な場合
 */
function calculateKaigo(data, memberContext) {
  if (!data || !Array.isArray(data.brackets) || data.brackets.length === 0) return null;

  const ctx = {
    pensionIncome:             memberContext.pensionIncome            ?? 0,
    totalIncome:               memberContext.totalIncome              ?? 0,
    // sumIncome 未指定時は pensionIncome + totalIncome へフォールバックせず、
    // 合算型 criteria を持つ自治体では呼び出し側が必ず sumIncome を渡す前提。
    // （誤フォールバックで二重計上しないよう 0 既定）
    sumIncome:                 memberContext.sumIncome                ?? 0,
    isSelfTaxable:             memberContext.isSelfTaxable            ?? false,
    isHouseholdAllNonTaxable:  memberContext.isHouseholdAllNonTaxable ?? false,
  };

  // 配列を先頭から評価し、最初にマッチした段階を採用
  let matched = data.brackets.find(b => matchBracket(ctx, b));

  // フォールバック（criteria 不一致・データ欠損の防御）
  if (!matched) {
    matched = data.brackets.find(b => String(b.level) === String(data.fallbackLevel))
           || data.brackets[Math.floor(data.brackets.length / 2)];
  }

  // 保険料: annual フィールド優先、なければ baseAmount × rate で算出
  const annual = matched.annual ?? Math.round(data.baseAmount * matched.rate);

  return {
    level:      matched.level,
    label:      matched.label,
    rate:       matched.rate,
    baseAmount: data.baseAmount,
    annual,
    monthly:    Math.round(annual / 12),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateKaigo, matchBracket };
}
