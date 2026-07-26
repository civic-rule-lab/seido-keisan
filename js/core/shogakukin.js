// 奨学金（高等教育の修学支援新制度：給付型＋授業料等減免）計算コア — 純粋関数・Fable5再設計版
// 依存: 生計維持者(＋本人)ごとの課税標準額・人的控除差・合計所得・所得割課税フラグを
//       住民税エンジン jumin.calculateJumin 出力から供給する（1計算機＋横断連携型）。
//
// 主要是正（検証レポート対応）:
//   B1 私立理工農系の第Ⅳ区分: 給付0円・減免は理工農の別建て(rikoReduction)。
//   B2 市区町村民税所得割が非課税の生計維持者は基準額0円（supporter.shotokuwariTaxable===false）。
//   B3 多子×資産5,000万〜3億円: 減免のみ・給付0（assetOk={grant,reduction}の2値）。
//   B4 高専の自宅特例額(第2〜4区分)を実額でJSONに収録済み。
//   B5 通信課程の減免上限(私立のみ)をJSONに収録済み。
//   M1 減免＝満額×分数(num/den)を100円単位に切上げ（事務処理要領第6版）。
//   M2 政令市×3/4は課税証明書の実額入力(cityAdjustActual/adjustmentAmount)経路のみ。
//      humanDeductionDiff から標準3%の調整控除を自前合成する経路では掛けない。
//   M3 supporter に本人(isStudent)を含めて合算可・収入内訳/householdSizeを正式フィールド化。
'use strict';
// IIFE 化: ブラウザで他エンジン（jumin.js 等）と top-level const（_isNode 等）が字句衝突するため
// 全体を関数スコープに包む（Phase2 の vendored shaho.js と同方式・家計簿結線 2026-07-25）。Node 側は無影響。
(function () {
const _isNode = typeof module !== 'undefined' && !!module.exports;
const _adjBase = _isNode ? require('./jumin.js')._adjustmentCreditBase : _adjustmentCreditBase; // 一本化: jumin の実装を使用


// ─── 生計維持者(＋本人)1人分の基準額構成要素（合算前・100円未満切捨て前） ─
//   課税標準×6% −（市町村民税調整控除 ＋ 調整額）
//   ・所得割非課税(shotokuwariTaxable===false)なら 0（JASSO ※3）[B2]
//   ・調整控除は既定で humanDeductionDiff から標準3%を自前合成（政令市補正なし）[M2]
//   ・課税証明書の市民税調整控除実額(cityAdjustActual)を渡した場合のみ政令市×3/4
function _supporterKijungakuComponent(s, cfg) {
  if (s.shotokuwariTaxable === false) return 0; // 所得割非課税 → 基準額0 [B2]
  const taxable = Math.max(0, Math.floor(s.taxableIncome || 0));
  if (taxable <= 0) return 0;
  const cityGross = Math.floor(taxable * cfg.rate);

  let cityAdjust;
  if (Number.isFinite(s.cityAdjustActual)) {
    // 課税証明書の市民税調整控除の実額。政令市はここで×3/4して標準3%相当へ正規化。
    const factor = s.designatedCity ? cfg.designatedCityFactor : 1;
    cityAdjust = Math.floor(Math.max(0, s.cityAdjustActual) * factor);
  } else {
    // 標準3%を humanDeductionDiff から自前合成（政令市補正なし）[M2]。
    const adjBase = _adjBase(taxable, s.humanDeductionDiff ?? 50_000, s.totalIncome ?? taxable);
    cityAdjust = Math.floor(adjBase * cfg.cityAdjustRate);
  }
  // 調整額（税額調整額）は課税証明書の実額。政令市は×3/4。
  const choseiFactor = s.designatedCity ? cfg.designatedCityFactor : 1;
  const chosei = Math.max(0, Math.floor((s.adjustmentAmount || 0) * choseiFactor));

  return cityGross - cityAdjust - chosei;
}

// ─── 給付月額（区分別の実額表を直接引く）。通信は年額。 ─────────────────
function _grantMonthly(g, student, kubunCode) {
  if (!kubunCode) return 0;
  const setti = student.schoolType === '私立' ? '私立' : '国公立';
  if (student.level === '通信') return g.grantMonthly.tsushin['年額'][kubunCode] || 0;
  const cat = student.level === '高等専門学校' ? 'kosen' : 'univ_college_senmon';
  const row = g.grantMonthly[cat][setti][kubunCode];
  if (!row) return 0;
  if (student.attendance === '自宅外') return row['自宅外'] || 0;
  if (student.specialCare && row['自宅特例'] != null) return row['自宅特例'];
  return row['自宅'] || 0;
}

function _reductionTable(g, student) {
  const level = student.level || '大学';
  const setti = student.schoolType === '私立' ? '私立' : '国公立';
  if (level === '通信') {
    const t = g.reductionCapFull['通信'];
    return (t && t[setti]) || null; // 国公立通信は無し
  }
  const lv = g.reductionCapFull[level] || g.reductionCapFull['大学'];
  return lv[setti] || null;
}

// 満額×分数(num/den)を100円単位に切上げ（事務処理要領第6版）[M1]。満額=num/den=1/1。
function _reductionByFraction(tbl, num, den) {
  if (!tbl) return { tuition: 0, admission: 0 };
  const f = (v) => (num === den) ? v : Math.ceil((v * num / den) / 100) * 100;
  return { tuition: f(tbl.tuition), admission: f(tbl.admission) };
}

// 私立理工農系(第Ⅳ)の減免（文系差額に着目した別建て）[B1]。
//   授業料＝私立上限×割合で[確認済-式]。入学金の理工農別扱いは公式明文なく[未確認]=null。
function _rikoReduction(g, student) {
  const level = student.level || '大学';
  const table = g.rikoReduction;
  const tuitionVerified = (table._verified === true || table._verified === 'tuition');
  const cell = table[level] && table[level]['私立'];
  if (!cell) return { tuition: 0, admission: null, tuitionEstimated: !tuitionVerified, admissionUnverified: true };
  return {
    tuition: cell.tuition,
    admission: cell.admission,                 // null = 入学金の扱い未確認
    tuitionEstimated: !tuitionVerified,
    admissionUnverified: cell.admission == null,
  };
}

// 資産判定。返り値 {grant, reduction} または null(未申告)。[B3]
function _assetOk(g, isTashi, assets) {
  if (assets == null) return null;
  const a = Math.max(0, assets);
  if (!isTashi) {
    const ok = a < g.assetCriteria.general;
    return { grant: ok, reduction: ok };
  }
  return {
    grant: a < g.assetCriteria.tashiGrant,          // 5,000万未満で給付可
    reduction: a < g.assetCriteria.tashiReduction,  // 3億未満で減免可
  };
}

/**
 * 奨学金（給付＋減免）判定。
 * @param {Object} spec  - shogakukin-{year}.json
 * @param {Object} inputs
 *   supporters: [{ taxableIncome, totalIncome?, humanDeductionDiff?, shotokuwariTaxable?,
 *                  designatedCity?, cityAdjustActual?, adjustmentAmount?, isStudent?,
 *                  income?: {salary,pension,other} }]  // income内訳は将来の貸与型用に保持[M3]
 *   student: { schoolType, attendance, level, specialCare?, rikoNoPrivate? }
 *   childrenCount: 扶養する子の数（多子=3人以上）
 *   assets: 資産額（自己申告・任意）
 *   rikoNoPrivate: 私立理工農系か（第Ⅳ区分の要件・給付0/減免別建て）
 *   householdSize?: 世帯人数（将来の貸与型家計基準用に保持）
 */
function calcShogakukin(spec, inputs) {
  const g = spec.grant, cfg = g.kijungakuFormula;
  const supporters = Array.isArray(inputs.supporters) ? inputs.supporters : [];

  // 支給額算定基準額 = 全生計維持者(＋本人)を合算 → 100円未満切捨て
  let raw = 0;
  for (const s of supporters) raw += _supporterKijungakuComponent(s, cfg);
  const kijungaku = Math.floor(Math.max(0, raw) / cfg.roundDownUnit) * cfg.roundDownUnit;

  const isTashi = (inputs.childrenCount || 0) >= g.tashiSetai.minChildren;
  const student = inputs.student || {};
  const isRiko = !!(inputs.rikoNoPrivate) &&
                 (student.schoolType === '私立') &&
                 ['大学', '短期大学', '専門学校'].includes(student.level);

  // 区分判定
  let kubun = null;
  for (const k of g.shienKubun) { if (kijungaku < k.kijungakuLt) { kubun = k; break; } }
  const inFourthRange = !!kubun && kubun.kubun === '4';
  // 第Ⅳ区分は多子世帯 or 私立理工農系のみ対象
  if (inFourthRange && !isTashi && !isRiko) kubun = null;

  const kubunCode = kubun ? kubun.kubun : null;
  // 第Ⅳ区分超過×多子＝独立の「多子世帯」区分（減免満額・給付0）[確認済 JASSO r7tashikakudai/在学採用家計基準の収入基準表]
  //   「収入が第4区分を超える方…についても、多子世帯に属している場合は『多子世帯』の支援区分となり、
  //    授業料等減免の対象となりますが、給付奨学金は支給されません。」
  const tashiOver = isTashi && !kubun;
  const assetOk = _assetOk(g, isTashi, inputs.assets);

  // ── 給付月額 ──
  let grantMonthly = _grantMonthly(g, student, kubunCode); // tashiOver は kubunCode=null → 0円
  const grantIsAnnual = student.level === '通信';
  let category = 'normal';
  // 第Ⅳ×理工農(非多子): 給付0円 [B1]
  if (inFourthRange && isRiko && !isTashi) { grantMonthly = 0; category = 'riko'; }
  else if (isTashi && (kubunCode || tashiOver)) category = 'tashi';
  else if (!kubunCode) category = 'out';
  // 資産で給付ゲート（多子×5,000万〜3億は給付0）[B3]
  if (assetOk && assetOk.grant === false) grantMonthly = 0;

  // ── 授業料等減免 ──
  let reductionCap = { tuition: 0, admission: 0 };
  let reductionEstimated = false;
  let reductionAdmissionUnverified = false; // 理工農の入学金扱いが未確認のとき true
  if (kubunCode || tashiOver) {
    if (isTashi) {
      // 多子世帯: 所得制限なしで満額（第Ⅳ含む）
      reductionCap = _reductionByFraction(_reductionTable(g, student), 1, 1);
    } else if (inFourthRange && isRiko) {
      // 私立理工農系: 授業料＝私立上限×割合[確認済-式]・入学金は[未確認]=null [B1]
      const r = _rikoReduction(g, student);
      reductionCap = { tuition: r.tuition, admission: r.admission };
      reductionEstimated = !!r.tuitionEstimated;
      reductionAdmissionUnverified = !!r.admissionUnverified;
    } else {
      // 通常: 満額×区分分数（100円切上げ）[M1]
      reductionCap = _reductionByFraction(_reductionTable(g, student), kubun.num, kubun.den);
    }
  }
  // 資産で減免ゲート（3億以上は減免も対象外）[B3]
  if (assetOk && assetOk.reduction === false) reductionCap = { tuition: 0, admission: 0 };

  return {
    kijungaku,
    kubun: kubun ? kubun.label : (tashiOver ? (g.tashiSetai.overLabel || '多子世帯') : g.outOfRangeLabel),
    kubunCode,
    ratioLabel: kubun ? kubun.ratioLabel : null,
    isTashiSetai: isTashi,
    isRiko,
    category,           // 'normal'|'riko'|'tashi'|'out'
    grantMonthly,       // 資産ゲート反映済み。通信は年額。
    grantIsAnnual,
    reductionCap,       // 資産ゲート・分数切上げ反映済み。理工農の入学金は null(未確認)
    reductionEstimated, // 理工農授業料など実額未確定のとき true（現状 授業料は確定=false）
    reductionAdmissionUnverified, // 理工農の入学金の扱いが公式未確定のとき true
    assetOk,            // {grant, reduction} または null(未申告)
    loan: null,         // 将来の貸与型（第一種/第二種）枠を予約
  };
}

if (_isNode) module.exports = { calcShogakukin };
else if (typeof window !== 'undefined') window.Shogakukin = { calcShogakukin };
})();
