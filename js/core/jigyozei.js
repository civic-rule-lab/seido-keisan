// 個人の事業税（1年分・標準税率）— 純関数・UMD
// 制度値は data/national/kojin-jigyozei-<年>.json（jigyonushiKojo.annual / rates[].ratePercent / rounding）。数値を本ファイルに埋めない。
// 根拠（地方税法）:
//   課税標準 ＝ 事業の所得 − 事業主控除（第72条の49の12・第72条の49の14）。千円未満切捨て（第20条の4の2 第1項）
//   税額 ＝ 課税標準 × 税率（第72条の49の17）。百円未満切捨て（第20条の4の2 第3項）
//   事業の所得は、青色申告特別控除を引く前の額で渡す（個人の事業税には青色申告特別控除の適用がない）。
// 扱わないもの: 繰越控除・事業専従者給与（控除）・事業を行った期間が1年に満たない場合の月割り・都道府県ごとの税率の違い。
'use strict';

(function (global) {
  function _posInt(v, name) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`個人事業税の制度値がありません: ${name}`);
    return v;
  }

  // input: { income: 事業の所得（売上 − 経費。青色申告特別控除を引く前）, rateKey: 制度値 rates の key }
  function calc(db, input) {
    const i = input || {};
    if (typeof i.income !== 'number') throw new TypeError(`income は数で渡してください（${String(i.income)}）`);
    if (!Number.isFinite(i.income)) throw new RangeError(`income が範囲外です（${String(i.income)}）`);
    const rates = (db && db.rates) || [];
    const row = rates.find((r) => r.key === i.rateKey);
    if (!row) throw new RangeError(`rateKey が制度値にありません（${String(i.rateKey)}）`);
    const pct = row.ratePercent;
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0) throw new Error(`個人事業税の制度値がありません: rates.${row.key}.ratePercent`);
    const kojo = _posInt(db.jigyonushiKojo && db.jigyonushiKojo.annual, 'jigyonushiKojo.annual');
    const tUnit = _posInt(db.rounding && db.rounding.taxableUnit, 'rounding.taxableUnit');
    const xUnit = _posInt(db.rounding && db.rounding.taxUnit, 'rounding.taxUnit');
    const income = Math.floor(i.income);
    const taxable = Math.max(0, Math.floor((income - kojo) / tUnit) * tUnit);
    // taxable は tUnit の倍数。先に税率（整数の%）を掛けてから 100 で割る＝浮動小数の誤差を作らない
    const tax = Math.floor((taxable * pct) / 100 / xUnit) * xUnit;
    return { income, kojo, taxable, rateKey: row.key, ratePercent: pct, tax };
  }

  const api = { calc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Jigyozei = api;
})(typeof window !== 'undefined' ? window : globalThis);
