/**
 * haito.js — 上場株式の配当「申告不要／申告分離／総合課税」の損得判定（純関数）
 *
 * 制度値はすべて data/national/haito-2026.json から読む（このファイルに税率を埋めない）。
 * 所得税の累進税率表は shotoku.js の loadParams(年分, shotokuzei-YYYY.json) の params（taxTable・surtaxRate・kazeiRoundDown・taxRoundDown）を渡す。
 *
 * 根拠（data の meta.source に条文）: 租特法 8条の4・8条の5、所得税法 92条、復興財確法 13条、
 * 地方税法 71条の28・37条の4・314条の9・附則 5条・附則 33条の2・附則 35条の6（国保税）、国保法施行令 29条の7（国保料）、
 * 対象外の線引きは 所得税法 92条かっこ書・95条、租特法 9条（meta.source.taishogai）。
 *
 * 入力:
 *   dividend        上場株式の配当の年額（税引前・円）
 *   shotokuTaxable  配当を含めない所得税の課税総所得金額（円）
 *   juminTaxable    配当を含めない住民税の課税総所得金額（円）
 * 戻り値: { none, separate, sogo } それぞれ
 *   shotokuTax  配当に係る所得税（復興特別所得税込み。総合は「配当を足したときの年税額 − 足さないときの年税額」で、配当控除が他の所得の税を減らす分は負になる）
 *   juminTax    配当に係る住民税（総合は 10% − 配当控除、分離・申告不要は 5%）
 *   haitoKojoShotoku / haitoKojoJumin  配当控除（総合のみ）
 *   incomeAdd   国保の所得（総所得金額等）に加わる額（申告不要 0・申告は配当の額）
 *   levyAdd     ふるさと納税の特例控除の 2 割上限の基礎（調整控除後の所得割）に加わる額（分離 5%・総合 10%）
 *   taxableAdd  住民税の課税総所得に加わる額（総合のみ。特例控除の割合の判定に使う）
 *   total       所得税＋住民税（税だけ。国保は呼び出し側が自治体データで足す）
 */
(function (root) {
  'use strict';

  function floorTo(v, unit) { return Math.floor(v / unit) * unit; }

  // 率の掛け算を整数で行い、切り捨てる（v は 0 以上の整数・率は小数 5 桁まで）。
  // 浮動小数点のまま掛けると 100000×1.021 = 102099.99… や 配当×0.15315 が真値より小さくなり、
  // 切捨てで 1 円・100 円少なく出る（2026-10-24 全方向試算 HAITO-1・HAITO-2）。shotoku.js の mulRateFloor と同じ
  const RATE_SCALE = 100000;
  function scaled(rate) { return Math.round(rate * RATE_SCALE); }
  function floorScaled(n) { return (n - n % RATE_SCALE) / RATE_SCALE; }
  function mulRateFloor(v, rate) { return floorScaled(v * scaled(rate)); }

  // 所得税の年税額（復興特別所得税込み・100円未満切捨て）。shotoku.js calcShotokuzei と同じ丸め
  function shotokuAnnualTax(taxable, P) {
    const kazei = floorTo(Math.max(0, taxable), P.kazeiRoundDown);
    let rate = 0, sub = 0;
    for (const row of P.taxTable) { if (row[0] == null || kazei <= row[0]) { rate = row[1]; sub = row[2]; break; } }
    const tax = Math.max(0, mulRateFloor(kazei, rate) - sub);   // kazei は 1,000 の倍数なので真値は整数
    return { kazei, tax, annual: floorTo(mulRateFloor(tax, P.surtaxRate), P.taxRoundDown) };
  }

  // 配当控除: 課税総所得（配当込み）が閾値以下の部分は rate、超える部分に対応する配当は rateOver（所得税法 92条・地方税法 附則 5条）
  function haitoKojo(dividend, taxableWithDividend, k) {
    const over = Math.max(0, taxableWithDividend - k.threshold);
    const partOver = Math.min(dividend, over);
    return floorScaled((dividend - partOver) * scaled(k.rate) + partOver * scaled(k.rateOver));
  }

  function judgeHaito(input, data, P) {
    const dividend = Math.max(0, Math.floor(input.dividend || 0));
    const shotokuTaxable = Math.max(0, Math.floor(input.shotokuTaxable || 0));
    const juminTaxable = Math.max(0, Math.floor(input.juminTaxable || 0));
    const S = data.shotoku, J = data.jumin;

    // 申告不要（源泉徴収のまま）: 所得税 15% × 1.021、住民税（配当割）5%
    // 15%×1.021＝15.315%。率どうしを先に掛けて整数にする（配当に先に掛けると桁があふれる）
    const srcRate = scaled(S.separateRate) * scaled(1 + S.fukkoRate) / RATE_SCALE;
    const srcShotoku = floorScaled(dividend * srcRate);
    const srcJumin = mulRateFloor(dividend, J.separateRate);
    const none = { shotokuTax: srcShotoku, juminTax: srcJumin, haitoKojoShotoku: 0, haitoKojoJumin: 0, incomeAdd: 0, levyAdd: 0, taxableAdd: 0 };
    // 申告分離: 税額は同じ（源泉分が控除される）。所得と所得割に入る
    const separate = { shotokuTax: srcShotoku, juminTax: srcJumin, haitoKojoShotoku: 0, haitoKojoJumin: 0, incomeAdd: dividend, levyAdd: mulRateFloor(dividend, J.separateRate), taxableAdd: 0 };
    // 総合課税: 累進税率を当て直して配当控除を引く
    const t0 = shotokuAnnualTax(shotokuTaxable, P);
    const kojoS = dividend > 0 ? haitoKojo(dividend, floorTo(shotokuTaxable + dividend, P.kazeiRoundDown), S.haitoKojo) : 0;
    const t1 = shotokuAnnualTax(shotokuTaxable + dividend, P);
    const annual1 = floorTo(mulRateFloor(Math.max(0, t1.tax - kojoS), P.surtaxRate), P.taxRoundDown);
    const kojoJ = dividend > 0 ? haitoKojo(dividend, juminTaxable + dividend, J.haitoKojo) : 0;
    const sogo = {
      shotokuTax: annual1 - t0.annual,
      juminTax: mulRateFloor(dividend, J.sogoRate) - kojoJ,
      haitoKojoShotoku: kojoS, haitoKojoJumin: kojoJ,
      incomeAdd: dividend, levyAdd: mulRateFloor(dividend, J.sogoRate), taxableAdd: dividend,
    };
    for (const m of [none, separate, sogo]) m.total = m.shotokuTax + m.juminTax;
    return { dividend, none, separate, sogo };
  }

  const api = { judgeHaito, shotokuAnnualTax, haitoKojo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.judgeHaito = judgeHaito;
})(typeof window !== 'undefined' ? window : globalThis);
