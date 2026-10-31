// 貸与型奨学金（第一種・第二種・入学時特別増額・返還シミュレーション）コア — Fable5設計版
// 給付コア（shogakukin.js）は無改変。本モジュールは spec.loan のみを参照する自己完結エンジン。
// 一次資料: 2026-07-12 調査（設計 claude/貸与型設計_2026-07-12.md §1）。
//
// 主要な制度事実（[確認済 2026-07-16 再確認]）:
//   L1 貸与額算定基準額 = 課税標準×6% − 市町村民税調整控除額（政令市×3/4）− 多子控除 − ひとり親控除 − 私立自宅外控除。
//      給付式と違い「調整額（税額調整額）」は引かない[§7-1確認済]。100円未満切捨て。所得割非課税者は0円。
//   L2 基準額は「生計維持者」で算出（本人=isStudent は合算しない）[§7-2確認済]。
//   L3 判定閾値: 第一種189,400 / 第二種381,500 / 併用164,600（大学・短大・専修専門課程）。最高月額は併用基準以下で選択可。
//   L4 返還・定額方式: 基礎額表→年数=floor(総額/基礎額)→月額=floor(総額/回数)、端数は最終回。
//   L5 所得連動（第一種のみ）: floor((課税総所得−子1人33万)×9%/12)、下限2,000円、初年度は定額の半分。
//   L6 第二種は元利均等＋据置期間利息/回数の上乗せ（概算）。据置日数は spec.loan.repayment.interest.graceDaysApprox。
//      JASSO公式返還例(大学)全20点で較正: graceDaysApprox=179 で返還月額が全ケース±1円以内[確認済 2026-07-16 kappu/sample/daigaku.html]。
//      最終端数規則は非公開のため _approx を継続。
'use strict';
const _isNodeL = typeof module !== 'undefined' && !!module.exports;
// _adjustmentCreditBase は jumin の実装を共用（core と同じ一本化方針）。browser bundle では前方の定義を使う。
const _adjBaseL = _isNodeL ? require('./jumin.js')._adjustmentCreditBase : _adjustmentCreditBase;

// ─── 生計維持者1人分の貸与基準額成分（合算前・切捨て前・世帯控除前） ───────
//   課税標準×6% − 調整控除（政令市は実額×3/4、標準は humanDeductionDiff から3%合成）。調整額は引かない[L1]。
// 数の入力を検査する（給付コア shogakukin.js の _num と同じ扱い）。null・undefined は既定値、それ以外で有限の数でなければ例外
function _numL(v, name, dflt) {
  if (v == null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} は有限の数で渡してください（${String(v)}）`);
  return v;
}

function _loanSupporterComponent(s, cfg) {
  if (s.shotokuwariTaxable === false) return 0;                 // 所得割非課税 → 0円
  const taxable = Math.max(0, Math.floor(_numL(s.taxableIncome, 'taxableIncome', 0)));
  if (taxable <= 0) return 0;
  const cityGross = Math.floor(taxable * cfg.rate);             // ×6%
  let cityAdjust;
  if (Number.isFinite(s.cityAdjustActual)) {
    const factor = s.designatedCity ? cfg.designatedCityFactor : 1;
    cityAdjust = Math.floor(Math.max(0, s.cityAdjustActual) * factor);
  } else {
    const adjBase = _adjBaseL(taxable, _numL(s.humanDeductionDiff, 'humanDeductionDiff', 50000), _numL(s.totalIncome, 'totalIncome', taxable));
    cityAdjust = Math.floor(adjBase * cfg.cityAdjustRate);      // 標準3%合成
  }
  return cityGross - cityAdjust;                                // ★調整額は引かない[L1]
}

// ─── 貸与額算定基準額（世帯合算・世帯控除適用・100円未満切捨て） ─────────────
function calcLoanKijungaku(spec, inputs) {
  const L = spec.loan, f = L.kijunFormula;
  const supporters = (Array.isArray(inputs.supporters) ? inputs.supporters : [])
    .filter(s => !s.isStudent);                                 // 本人は合算しない[L2]
  // 1人分は0で止めてから合算する（2026-10-31 全方向試算 C178）。この額は所得割（課税標準×6%−調整控除）にあたり、1人ずつ0を下回らない。
  //   旧実装は1人分の負の額（調整控除の実額を大きく渡したとき等）が他の人の分を相殺していた。
  //   100円未満の切捨ては JASSO の式どおり合算後に1回（1人ずつ切り捨てるかは公表資料に記載なし[未確認]）
  let raw = 0;
  for (const s of supporters) raw += Math.max(0, _loanSupporterComponent(s, f));
  const base100 = Math.floor(Math.max(0, raw) / 100) * 100;

  const student = inputs.student || {};
  const children = Math.max(0, inputs.childrenCount || 0);
  const d = f.deductions;
  let ded = d.tashiPerChild * Math.max(0, children - d.tashiFreeChildren); // 多子控除（2人超分×4万）
  if (inputs.singleParent === 'mother' || inputs.singleParent === 'father') ded += d.singleParent; // ひとり親4万
  const isPrivateAway = (student.schoolType === '私立') && (student.attendance === '自宅外');
  if (isPrivateAway && inputs.applicationType !== 'yoyaku') ded += d.privateAway; // 私立自宅外2.2万（予約時は0）
  // 世帯控除も100の倍数のため切捨て順は無害（設計§2-1）。
  return Math.max(0, base100 - ded);
}

// ─── 第一種の月額表を引く（level→設置者→通学） ───────────────────────────
function _type1Cell(spec, student) {
  const tbl = spec.loan.type1Monthly;
  let level = student.level || '大学';
  if (level === '高等専門学校' && (student.kosenGrade === '1-3' || student.kosenLower === true)) level = '高専1-3年';
  const lv = tbl[level] || tbl['大学'];
  const setti = student.schoolType === '私立' ? '私立' : '国公立';
  const att = student.attendance === '自宅外' ? '自宅外' : '自宅';
  return (lv[setti] && lv[setti][att]) || null;
}

// 第一種の選択可能な月額（自宅外は自宅の選択肢も選べる[確認済]）。最高月額は maxAllowed のときのみ。
function _type1Options(spec, student, maxAllowed) {
  const cell = _type1Cell(spec, student);
  if (!cell) return [];
  const opts = new Set(cell.others || []);
  if (maxAllowed) opts.add(cell.max);
  // 自宅外通学者は自宅側の選択肢も選べる。
  if ((student.attendance === '自宅外')) {
    const home = _type1Cell(spec, Object.assign({}, student, { attendance: '自宅' }));
    if (home) { (home.others || []).forEach(v => opts.add(v)); if (maxAllowed) opts.add(home.max); }
  }
  return Array.from(opts).sort((a, b) => a - b);
}

// 第二種の選択肢（2〜12万・1万刻み）＋増額（医歯薬獣医・私立大学）。
function _type2Options(spec, student) {
  const t = spec.loan.type2Monthly;
  if (student.level === '高等専門学校' && (student.kosenGrade === '1-3' || student.kosenLower === true) && !t.kosen13Eligible) {
    return { monthly: [], zougaku: [] };                       // 高専1-3年は第二種対象外
  }
  const monthly = [];
  for (let v = t.min; v <= t.max; v += t.step) monthly.push(v);
  const zougaku = [];
  if (student.level === '大学' && student.schoolType === '私立') {
    const c = student.course; // '医' '歯' '薬' '獣医' など
    if (c === '医' || c === '歯') zougaku.push({ label: '医・歯学課程', add: t.zougaku['医歯_私立大学'].add, requiresBase: t.zougaku['医歯_私立大学'].requiresBase });
    else if (c === '薬' || c === '獣医') zougaku.push({ label: '薬・獣医学課程', add: t.zougaku['薬獣医_私立大学'].add, requiresBase: t.zougaku['薬獣医_私立大学'].requiresBase });
  }
  return { monthly, zougaku };
}

// ─── 給付併用時の第一種上限（併給調整） ─────────────────────────────────
//   戻り値: null=調整なし（通常選択肢）/ {amounts:[...], special:[...]} / 0のときは amounts:[0]。
function _heikyuCell(spec, student, grantResult) {
  const H = spec.loan.heikyuChosei;
  const level = student.level || '大学';
  // JSONに level キーがあり値が null ＝「表は存在するが未転記」→ 大学表を黙って流用せず未対応と返す（§7-4）。
  const table = (H[level] !== undefined) ? H[level] : H['大学'];
  if (table === null) return { unsupported: true };
  if (!table || !grantResult) return null;
  const setti = student.schoolType === '私立' ? '私立' : '国公立';
  const att = student.attendance === '自宅外' ? '自宅外' : '自宅';
  const key = setti + att;                                      // 例 '私立自宅外'
  const isTashi = !!grantResult.isTashiSetai;
  const kubun = grantResult.kubunCode;                          // '1'..'4' or null
  const isRiko = !!grantResult.isRiko;
  const tashiOver = isTashi && !kubun;                          // 区分外多子

  if (isTashi) {
    const t = table.tashiKakudai;
    if (!t) return null;
    // 区分内多子は区分別セル（大学=全0だが短大/専門/高専は0でないセルがある[確認済 2019ikou 2026-07-17]）
    if (kubun) return _wrapCell(t.kubun && t.kubun[kubun] && t.kubun[kubun][key]);
    if (tashiOver) return _wrapCell(t.over && t.over[key]);     // 区分外多子
    return null;
  }
  const n = table.normal;
  if (!kubun) return null;                                      // 給付なし → 調整対象外
  if (kubun === '4') {
    if (isRiko) return _wrapCell(n['4riko'] && n['4riko'][key]);
    return _wrapCell(n['4tashi'] && n['4tashi'][key]);          // 非多子・非理工農はそもそも区分4対象外だが安全側
  }
  return _wrapCell(n[kubun] && n[kubun][key]);
}
function _wrapCell(cell) {
  if (cell === null || cell === undefined) return null;         // 調整なし
  if (cell === '調整なし') return null;
  if (typeof cell === 'number') return { amounts: [cell], special: null };
  if (Array.isArray(cell)) return { amounts: cell, special: null };
  return { amounts: cell.amounts || [], special: cell.special || null }; // {amounts,special}
}

// ─── 判定メイン ───────────────────────────────────────────────────────
/**
 * @param spec  shogakukin-2026.json
 * @param inputs {
 *   supporters, student:{level,schoolType,attendance,course?,kosenGrade?},
 *   childrenCount, singleParent, applicationType?('zaigaku'|'yoyaku'),
 *   grantResult?  // calcShogakukin の戻り値（併給調整用）。null=給付を受けない
 * }
 */
// 高専本科1〜3年か（給付/第二種/併用/入学時特別増額の対象外・第一種のみ）[確認済 2026-07-20 高専冊子p6/p8目視]
function _isKosen13(student) {
  const s = student || {};
  return s.level === '高専1-3年' || (s.level === '高等専門学校' && (s.kosenGrade === '1-3' || s.kosenLower === true));
}

function calcLoanEligibility(spec, inputs) {
  const L = spec.loan;
  const student = inputs.student || {};
  const key = 'univ_college_senmon'; // 閾値は全学種共通（高専1〜3年含む）[確認済 2026-07-17 高専在学者用案内p.12: 併用164,600/一種189,400/二種381,500・家計基準に学年区分なし]
  const th = L.thresholds[key];
  const kijun = calcLoanKijungaku(spec, inputs);
  const k13 = _isKosen13(student);
  const k13cfg = L.thresholds.kosen13 || {};

  const type2Elig = !k13 && kijun <= th.type2;                  // 第二種は高専4年生から[確認済]
  const type1Elig = kijun <= th.type1;
  const heiyoElig = !k13 && kijun <= th.heiyo;                  // 併用は第二種がない1〜3年では成立しない
  // 最高月額: 通常は併用基準(164,600)以下で可[L3]。高専1〜3年は「月額の種類」区分自体がなく家計制限なし
  // [確認済 2026-07-20 高専冊子p6表(1〜3年生行は斜線)・2018ikou注記「本科4,5年生及び専攻科においては」]
  const maxAllowed = k13 ? (k13cfg.maxMonthlyUnrestricted !== false) : heiyoElig;

  const t2 = _type2Options(spec, student);
  const grantResult = inputs.grantResult || null;
  const heikyu = (grantResult && !k13) ? _heikyuCell(spec, student, grantResult) : null; // 1〜3年は給付自体が対象外＝併給調整なし

  const notes = [];
  if (kijun === 0) notes.push('kijun0_gakuryoku'); // 学力基準の特例対象（基準額0円）
  if (!k13 && grantResult && (grantResult.kubunCode || grantResult.isTashiSetai)) notes.push('grant_heikyu');
  if (k13) notes.push('kosen13'); // 高専1〜3年: 第一種のみ・給付/第二種/併用/入学時特別増額なし

  // 高専1〜3年: 4年進級後（4・5年月額×24か月）の選択肢も返す（申込時に両方選ぶ制度[確認済 p6注]）。
  //   進級後の最高月額(45,000等)は通常ルール＝併用基準以下でのみ可。
  const opts45 = k13
    ? _type1Options(spec, Object.assign({}, student, { level: '高等専門学校', kosenGrade: '4-5', kosenLower: false }), kijun <= th.heiyo)
    : null;

  return {
    loanKijungaku: kijun,
    thresholds: { type1: th.type1, type2: th.type2, heiyo: th.heiyo },
    type1: {
      eligible: type1Elig,
      maxMonthlyAllowed: maxAllowed,
      monthlyOptions: type1Elig ? _type1Options(spec, student, maxAllowed) : [],
      monthlyOptions45: (k13 && type1Elig) ? opts45 : undefined, // 高専1〜3年のみ: 4年進級後の選択肢
      heikyuCap: heikyu,                                        // 給付併用時の上限（null=調整なし）
    },
    type2: {
      eligible: type2Elig,
      unavailable: k13 ? 'kosen13' : undefined,                 // 制度上の対象外（基準額とは無関係）
      monthlyOptions: type2Elig ? t2.monthly : [],
      zougakuOptions: type2Elig ? t2.zougaku : [],
    },
    heiyo: { eligible: heiyoElig, unavailable: k13 ? 'kosen13' : undefined },
    nyugakuZougaku: k13 ? {
      amounts: [], direct: false, needsKoko: false, unavailable: 'kosen13', // 4・5年次編入学時及び専攻科入学時のみ[確認済 p6/p8]
    } : {
      amounts: L.nyugakuZougaku.amounts.slice(),
      direct: kijun <= L.nyugakuZougaku.directKijunLe,          // 基準額75,000以下は公庫手続き不要
      needsKoko: kijun > L.nyugakuZougaku.directKijunLe,
    },
    notes,
  };
}

// ─── 返還: 割賦金の基礎額 ─────────────────────────────────────────────
function _kisogaku(spec, total) {
  const t = Math.max(0, Math.floor(total));
  for (const row of spec.loan.repayment.kisogakuTable) {
    if (row.le != null && t <= row.le) return row.base;
    if (row.over != null && t > row.over) return Math.floor(t / row.divisor);
  }
  return Math.floor(t / 20);
}

// 定額返還方式（第一種・第二種の回数決定にも使用）。月賦。
function simulateTeigaku(spec, total) {
  const t = Math.max(0, Math.floor(total));
  if (t <= 0) return { years: 0, n: 0, monthly: 0, lastMonthly: 0, totalPaid: 0 };
  const base = _kisogaku(spec, t);
  const years = Math.floor(t / base);                          // 小数点以下切捨て
  // 貸与総額が割賦金の基礎額（最小 30,000円）未満だと年数が0になる。算出表に決まりが無いので計算せず印を返す
  //   （2026-10-31 全方向試算 C193。旧は0で割って Infinity／NaN）
  if (years < 1) return { years: 0, n: 0, monthly: 0, lastMonthly: 0, totalPaid: t, belowMinimum: true };
  const n = years * 12;
  const monthly = Math.floor(t / n);                           // 1円未満切捨て
  const lastMonthly = t - monthly * (n - 1);                   // 端数は最終回
  return { years, n, monthly, lastMonthly, totalPaid: t };
}

// 月賦・半年賦併用（総額を半分ずつ）。
function simulateHeiyoHenkan(spec, total) {
  const t = Math.max(0, Math.floor(total));
  if (t <= 0) return { years: 0, monthlyN: 0, halfN: 0, monthly: 0, hanki: 0 };
  const base = _kisogaku(spec, t);
  const years = Math.floor(t / base);
  if (years < 1) return { years: 0, monthlyN: 0, halfN: 0, monthly: 0, hanki: 0, belowMinimum: true };   // C195（simulateTeigaku と同じ）
  const half = Math.floor(t / 2);
  const monthlyN = years * 12, halfN = years * 2;
  const monthly = Math.floor(half / monthlyN);
  const hanki = Math.floor((t - half) / halfN);
  return { years, monthlyN, halfN, monthly, hanki };
}

// 所得連動返還方式（第一種のみ）。課税総所得金額と本人の子ども数から算出。
function simulateShotokuRendo(spec, taxableTotal, childCount, teigakuMonthly) {
  const sr = spec.loan.repayment.shotokuRendo;
  const tt = Math.max(0, Math.floor(taxableTotal || 0));
  const base = Math.max(0, tt - sr.childDeduction * Math.max(0, childCount || 0));
  let monthly = Math.floor(base * sr.rate / 12);
  if (monthly < sr.minMonthly) monthly = sr.minMonthly;
  const firstYearMonthly = sr.firstYearHalfOfTeigaku && teigakuMonthly
    ? Math.floor(teigakuMonthly / 2) : null;
  return { monthly, firstYearMonthly, minApplied: monthly === sr.minMonthly };
}

// 第二種（元利均等＋据置期間利息/回数）。概算（_approx）。annualRate は小数（例 0.02922）。
//   opts.graceDays: 据置日数（既定は貸与終了3月→初回返還10月27日 ≈ 210日相当を呼び出し側指定可）。
function simulateType2(spec, total, annualRate, opts) {
  const o = opts || {};
  const t = Math.max(0, Math.floor(total));
  if (t <= 0) return { monthly: 0, n: 0, years: 0, totalPaid: 0, interest: 0, _approx: true };
  const base = _kisogaku(spec, t);
  const years = Math.floor(t / base);
  if (years < 1) return { monthly: 0, n: 0, years: 0, totalPaid: t, interest: 0, belowMinimum: true, _approx: true };   // C194（simulateTeigaku と同じ）
  const n = years * 12;
  const rate = Math.max(0, Math.min(annualRate || 0, spec.loan.repayment.interest.cap));   // 負の利率は0（C196）
  const r = rate / 12;
  if (r <= 0) {
    // 利率0%は元金均等の定額返還と同じ（端数は最終回）。旧は monthly×n を総額にして元本を下回っていた（C191）
    const monthly0 = Math.floor(t / n);
    return { monthly: monthly0, lastMonthly: t - monthly0 * (n - 1), n, years, rate: 0, totalPaid: t, interest: 0, _approx: true };
  }
  const pmt = t * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  const graceDays = Number.isFinite(o.graceDays) ? o.graceDays
    : (Number.isFinite(spec.loan.repayment.interest.graceDaysApprox) ? spec.loan.repayment.interest.graceDaysApprox : 180); // JASSO公式20点較正=179日[§6-3]
  const graceInterest = Math.round(t * rate * graceDays / 365);
  const monthly = Math.floor(pmt + graceInterest / n);
  // 総返還額は概算表示のため monthly×n を採用（最終回の端数調整は表示上省略）。
  const totalApprox = monthly * n;
  return {
    monthly, n, years, rate,
    totalPaid: totalApprox,
    interest: Math.max(0, totalApprox - t),
    _approx: true,
  };
}


// ─── 機関保証の保証料（目安）──────────────────────────────────────────
//   出典: 2026年度採用者用「保証料月額(目安)」PDF5本[確認済 2026-04-01決定・一次資料/保証料2026/]。
//   表は (貸与月数, 貸与月額)→保証料月額。第二種は貸与利率2.423%(増額分2.623%)前提の目安。
//   高専は1〜3年+4・5年の継続貸与合算総額前提の専用表（g13=36か月分/g45=24か月分・月数固定）。
//   表にない月額（併給調整後の端額など）は最寄り月額の料率から概算し monthlyApprox を立てる。
function _hoshoryoNearestKey(obj, want) {
  let best = null;
  const keys = Object.keys(obj).filter(k => !k.startsWith('_')).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const v of keys) if (best === null || Math.abs(v - want) < Math.abs(best - want)) best = v; // 同距離は小さい側を維持
  return best;
}
/**
 * @param opts { kind:'type1'|'type2', level?, kosenGrade?|kosenLower?, monthly, months? }
 * @returns {fee, monthsUsed, exact, monthlyApprox?, monthsApprox} | null
 */
function lookupHoshoryo(spec, opts) {
  const o = opts || {}, H = spec.loan && spec.loan.hoshoryo;
  if (!H || !H.type1) return null;
  const monthly = Math.floor(o.monthly || 0);
  if (monthly <= 0) return null;
  let map, monthsUsed;
  if (o.kind === 'type2') {
    monthsUsed = _hoshoryoNearestKey(H.type2, o.months || 48);
    map = H.type2[String(monthsUsed)];
  } else if ((o.level || '') === '高等専門学校' || (o.level || '') === '高専1-3年') {
    const K = H.type1['高等専門学校'];
    if (!K) return null;
    const lower = o.level === '高専1-3年' || o.kosenGrade === '1-3' || o.kosenLower === true;
    map = lower ? K.g13 : K.g45;
    monthsUsed = lower ? 36 : 24;                    // 高専表は月数固定（継続貸与合算前提）
  } else {
    const g = H.type1[o.level] || H.type1['大学'];
    monthsUsed = _hoshoryoNearestKey(g, o.months || 48);
    map = g[String(monthsUsed)];
  }
  if (!map || monthsUsed === null) return null;
  const monthsApprox = Number.isFinite(o.months) && o.months !== monthsUsed;
  const hit = map[String(monthly)];
  if (hit !== undefined) return { fee: hit, monthsUsed, exact: !monthsApprox, monthsApprox };
  const m0 = _hoshoryoNearestKey(map, monthly);
  if (m0 === null) return null;
  const fee = Math.round(monthly * map[String(m0)] / m0);
  return { fee, monthsUsed, exact: false, monthlyApprox: true, monthsApprox };
}
// 入学時(留学時)特別増額の保証料（振込時1回払い・単独表）。該当額なしは null。
function hoshoryoNyugakuZougaku(spec, amount) {
  const H = spec.loan && spec.loan.hoshoryo;
  if (!H || !H.nyugakuZougakuFee) return null;
  const f = H.nyugakuZougakuFee[String(Math.floor(amount || 0))];
  return f === undefined ? null : f;
}

if (_isNodeL) module.exports = {
  calcLoanEligibility, calcLoanKijungaku,
  simulateTeigaku, simulateHeiyoHenkan, simulateShotokuRendo, simulateType2,
  lookupHoshoryo, hoshoryoNyugakuZougaku,
  _kisogaku,
};
else if (typeof window !== 'undefined') window.ShogakukinLoan = {
  calcLoanEligibility, calcLoanKijungaku,
  simulateTeigaku, simulateHeiyoHenkan, simulateShotokuRendo, simulateType2,
  lookupHoshoryo, hoshoryoNyugakuZougaku,
};
