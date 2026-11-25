// 年金額の目安: 保険料を納めた（厚生年金に入っていた）期間に応じて増える年金の年額 — 純関数・UMD
// 制度値は data/national/nenkin-kyufu-<年>.json（kiso.fullAnnual / kiso.fullMonths / kosei.rateNumerator / kosei.rateDenominator）。数値を本ファイルに埋めない。
// 根拠:
//   老齢基礎年金 ＝ 満額 × 月数 ÷ 480（国民年金法 第27条。免除の期間は条文の割合で月数に換算する＝fraction で受ける）
//   老齢厚生年金（報酬比例部分）＝ 平均標準報酬額 × 5.481/1000 × 被保険者期間の月数（厚生年金保険法 第43条第1項）
// 簡略（目安である理由）:
//   ・報酬比例部分は「標準報酬月額 × 月数 × 乗率」で計算する。再評価率と標準賞与額は扱わない。
//   ・増える額は1円未満を四捨五入する。実際の年金額の端数処理・毎年度の改定・繰上げ繰下げは扱わない。
'use strict';

(function (global) {
  function _num(v, name) {
    if (typeof v !== 'number') throw new TypeError(`${name} は数で渡してください（${String(v)}）`);
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} が範囲外です（${String(v)}）`);
    return v;
  }
  function _months(v) {
    if (v === undefined || v === null) return 12;
    if (typeof v !== 'number') throw new TypeError(`months は数で渡してください（${String(v)}）`);
    if (!Number.isInteger(v) || v < 0 || v > 12) throw new RangeError(`months は 0〜12 の整数で渡してください（${String(v)}）`);
    return v;
  }
  function _db(db, path) {
    const v = path.reduce((o, k) => (o == null ? o : o[k]), db);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`年金額の制度値がありません: ${path.join('.')}`);
    return v;
  }

  // 老齢基礎年金の増える額（年額）。opt.months: 納めた月数（既定 12）。
  //   opt.fraction: 年金額に反映する割合 [分子, 分母]（既定 [1, 1]。全額免除の期間なら [1, 2] など。割合は呼び出し側が制度値から渡す）
  function kisoIncrease(db, opt) {
    const o = opt || {};
    const months = _months(o.months);
    const f = o.fraction === undefined || o.fraction === null ? [1, 1] : o.fraction;
    if (!Array.isArray(f) || f.length !== 2) throw new TypeError('fraction は [分子, 分母] で渡してください');
    const fn = _num(f[0], 'fraction[0]'), fd = _num(f[1], 'fraction[1]');
    if (fd === 0 || fn > fd) throw new RangeError(`fraction が範囲外です（${fn}/${fd}）`);
    const full = _db(db, ['kiso', 'fullAnnual']), fullMonths = _db(db, ['kiso', 'fullMonths']);
    return Math.round((full * months * fn) / (fullMonths * fd));
  }

  // 老齢厚生年金（報酬比例部分）の増える額（年額）。standardMonthly: 厚生年金保険の標準報酬月額。opt.months: 加入した月数（既定 12）
  function koseiIncrease(db, standardMonthly, opt) {
    const std = _num(standardMonthly, 'standardMonthly');
    const months = _months((opt || {}).months);
    const n = _db(db, ['kosei', 'rateNumerator']), d = _db(db, ['kosei', 'rateDenominator']);
    return Math.round((std * months * n) / d);
  }

  const api = { kisoIncrease, koseiIncrease };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NenkinKyufu = api;
})(typeof window !== 'undefined' ? window : globalThis);
