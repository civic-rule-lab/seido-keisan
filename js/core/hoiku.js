// 保育料計算エンジン（0-2歳認可・3号認定）令和8年度(2026)
// 制度計算ファミリー / hoiku-keisan
// 一次ソース: 各市町村の階層表 + 国基準(cfa.go.jp)。指示書 保育料横展開_指示書.md §1・§2 準拠。
// 実行: node js/core/hoiku.js  → 自己テスト結果を表示
//
// 設計方針:
//   ・月額は「公式表の実額」を data(brackets) にそのまま格納。当エンジンは計算せずlookupする。
//   ・指数(=父母の市町村民税所得割額の合算)は「調整控除後・税額控除前」。
//     住民税(jumin)エンジンの中間値API化が別途必要 [未着手]。当ファイルは所得割の直接入力に対応。
//   ・自治体差(無償化・階層・多子・0歳別額・ひとり親軽減)は data 側フラグで吸収。
//
// [確認済] 実装した計算構造は指示書§1に一致。
// [未確認・推測] 各数値(国基準上限104,000/政令市6:8比 等)は指示書記載値。公式資料での最終突合は
//                data 投入時および検証ゲート(test-hoiku-verify.js)で行う前提。

'use strict';

// ブラウザ/Node 両対応。top-level 変数を作らない(kokuho.js/kaigo.js と同方式)。
// jumin.js が top-level `const _isNode` を持つため、同名 const を宣言すると
// 同一ページに両方 <script> 読み込み時に "already declared" で衝突する(2026-07-08 修正)。
// → module 判定は使用箇所でインライン（ブラウザは typeof module が undefined で短絡する）。

// ---- 定数 ---------------------------------------------------------------
const NATIONAL_CAP = 104000; // 国基準3号・標準時間の最上限(月額)。全自治体これ以下のはず[指示書§0]
// 公開UIの入力モード(muni.inputBasis)。engineは不使用・UI/結線が入力フォームを出し分けるためのヒント。
const INPUT_BASES = ['salary', 'shotokuwari-direct'];
const SEIREI_NUM = 6;        // 政令市補正 分子(保育料は旧6%換算)
const SEIREI_DEN = 8;        // 政令市補正 分母(2018税源移譲後8%)
// child2alt.selector に使えない予約入力キー(既存 input フラグと衝突すると誤発火する)
const RESERVED_INPUT_KEYS = ['seikatsuhogo', 'hikazei', 'kintowariOnly', 'isSeireiNotice', 'timeType', 'age', 'childOrder', 'hitorioya', 'facility', 'father', 'mother', 'month'];

// ---- ユーティリティ ------------------------------------------------------

// 時間区分(timeBand)のキー一覧を返す。既定=['standard','short'](2区分)。
// muni.timeBands=[{key,label},...](順序＝長い→短い) を宣言した自治体はN区分。
// 京都市(標準6段+短時間=7区分)等。金額解決(_readAmt)はキー名非依存なので、
// 宣言キーを金額セットに持たせるだけでN対応する。
function timeKeysOf(muni) {
  if (muni && Array.isArray(muni.timeBands) && muni.timeBands.length) {
    return muni.timeBands.map((b) => b && b.key);
  }
  return ['standard', 'short'];
}

// 年度切替: 4-8月分=前年度の所得割 / 9月-3月分=当年度の所得割
// 戻り値: 'prev'(前年度) | 'current'(当年度)。muni.fiscalSwitch は切替月(既定9)。
function pickFiscalYear(month, fiscalSwitch = 9) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`pickFiscalYear: 不正な月 ${month}`);
  }
  return month >= fiscalSwitch ? 'current' : 'prev';
}

// 指数(=父母合算の市町村民税所得割額)を確定する。
//   input.father / input.mother: { shotokuwari } 調整控除後・税額控除前。省略は0(片親等)。
//   政令市: 通知書(8%基準)の額を直接入力した場合のみ 6/8 補正。
//           年収連動(jumin側で6%相当を算出)の場合は input.isSeireiNotice=false のまま補正しない。
function resolveIndex(input, muni) {
  const f = (input.father && Number(input.father.shotokuwari)) || 0;
  const m = (input.mother && Number(input.mother.shotokuwari)) || 0;
  if (f < 0 || m < 0) throw new Error('resolveIndex: 所得割額が負');
  let index = f + m;
  const seireiApplied = !!(muni.seireiConversion && input.isSeireiNotice);
  if (seireiApplied) {
    index = Math.round((index * SEIREI_NUM) / SEIREI_DEN);
  }
  return { index, seireiApplied };
}

// 階層lookup。brackets は level 昇順。criteria(seikatsuhogo/hikazei/kintowari-only)を先に判定し、
// 以降は maxShotokuwari(未指定=Infinity)で最初に index を収める段を返す。
function lookupBracket(index, brackets, flags) {
  const sorted = [...brackets].sort((a, b) => a.level - b.level);
  for (const b of sorted) {
    if (b.criteria === 'seikatsuhogo' && flags.seikatsuhogo) return b;
    if (b.criteria === 'hikazei' && flags.hikazei) return b;
    if (b.criteria === 'kintowari-only' && flags.kintowariOnly) return b;
  }
  // 課税世帯: 所得割の階層
  for (const b of sorted) {
    if (b.criteria) continue; // criteria段はflag非該当なのでスキップ
    const cap = b.maxShotokuwari == null ? Infinity : b.maxShotokuwari;
    if (index <= cap) return b;
  }
  return null;
}

// ---- 本体 ---------------------------------------------------------------

// calcHoiku(input, muni) → 結果
//   input: {
//     seikatsuhogo, hikazei, kintowariOnly: bool,
//     father:{shotokuwari}, mother:{shotokuwari},
//     isSeireiNotice: bool,          // 政令市通知書(8%)の額を直接入力したか
//     timeType: 'standard'|'short',  // 保育時間区分(既定standard)
//     age: 'age0'|'age1_2',          // 0歳別額の自治体向け(既定age1_2)
//     childOrder: 1..,               // 多子カウント上の当該児童の順位(既定1)
//     hitorioya: bool,               // ひとり親・障害者等の軽減対象
//     facility: 'ninka'|'kogata'|…,  // 施設タイプ(既定=muni.defaultFacility||'ninka')。bracket.facility 使用時のみ有効。
//     [selector]: bool,              // セレクタギャップ入力(税額で判定不能な世帯要素)。bracket.child2alt.selector が指す
//                                    //   キー(例 olderSiblingNotEnrolled=非在園の年上きょうだい)。第2子時のみ・非ひとり親経路で有効。
//   }
//   muni: data/municipalities/{slug}/hoiku-2026.json 相当のオブジェクト
//     muni.hitorioya = { factor, maxIndex? }  // ひとり親軽減=「実行時率」(大田型)。amount(0歳別額/短時間 適用後)×factor。
//                                             // index<=maxIndex のみ適用(未指定=全階層)。0歳/短時間/多子と合成。
//     muni.multiChild = { second?, third? }   // 多子=係数(大田型)。第2子/第3子に乗じる。明示 child2 が優先。
//     bracket.byAge[age] = 数値 | { standard, short }  // 0歳別額。時間区分別に持てる({standard,short})。
//     bracket.child2 = { standard, short, byAge? }      // 第2子の「明示実額」(横浜型)。あれば multiChild.second より優先。
//     bracket.child2alt = { selector, standard, short, byAge? } // 第2子の「セレクタ別額」(新潟表②型)。input[selector]が真かつ
//                                                        // 非ひとり親経路のとき child2/multiChild より優先。該当ブラケットのみ持たせる(=index条件を内包)。
//     bracket.hitorioya = { standard, short, byAge?, child2? } // ひとり親の実額「代替セット」(横浜E階層型)。該当ブラケットのみ。
//     bracket.reduced.hitorioya = 数値 | {standard,short} // 旧仕様(絶対額の上書き)。上位の hitorioya 指定が無い時のみ(後方互換)。
//     bracket.facility = { ninka:{…}, kogata:{…} }       // 施設タイプ別の金額セット(上記 standard/short/child2/hitorioya/byAge を各施設が持つ)。
//                                                        // 有れば input.facility で選択。level/criteria/maxShotokuwari は bracket 側に残す。
function calcHoiku(input, muni) {
  if (!muni) throw new Error('calcHoiku: muni がありません');
  // 既定の時間区分: input.timeType 明示 > muni.defaultTimeType(京都=std_11h等) > 'standard'。
  const timeType = input.timeType || muni.defaultTimeType || 'standard';
  const age = input.age || 'age1_2';
  const childOrder = input.childOrder || 1;
  const reasons = [];

  // 0) 無償化(東京型: 第1子から無償) — bracketsを見ずに即0
  if (muni.status === 'free' || (muni.freePolicy && muni.freePolicy.firstChild)) {
    return {
      monthly: 0,
      level: null,
      reason: `無償化: ${muni.freePolicy?.since || ''}〜第1子から無償`.trim(),
      free: true,
      breakdown: { index: 0, base: 0 },
    };
  }

  // 1) 生活保護/非課税は0(国基準①②)
  if (input.seikatsuhogo) {
    return { monthly: 0, level: 1, reason: '生活保護世帯', breakdown: { index: 0, base: 0 } };
  }
  if (input.hikazei) {
    return { monthly: 0, level: 2, reason: '住民税非課税世帯', breakdown: { index: 0, base: 0 } };
  }

  // 2) 指数(父母合算 / 政令市6:8補正)
  const { index, seireiApplied } = resolveIndex(input, muni);
  if (seireiApplied) reasons.push(`政令市補正 ×${SEIREI_NUM}/${SEIREI_DEN}`);

  // 3) 階層lookup
  const bracket = lookupBracket(index, muni.brackets || [], {
    seikatsuhogo: input.seikatsuhogo,
    hikazei: input.hikazei,
    kintowariOnly: input.kintowariOnly,
  });
  if (!bracket) {
    throw new Error(`calcHoiku: 指数 ${index} に該当する階層なし(${muni.citySlug || muni.slug || '?'})`);
  }

  // 3b) 施設タイプ選択(横浜型)。bracket.facility={ninka,kogata,...} があれば input.facility(既定=muni.defaultFacility||'ninka')で
  //     金額セットを選ぶ。無ければ bracket 自身が金額セット(大田型・単一施設)。level/criteria/maxShotokuwari は bracket 側。
  const facility = input.facility || muni.defaultFacility || 'ninka';
  let amt = bracket;
  if (bracket.facility) {
    amt = bracket.facility[facility];
    if (!amt) throw new Error(`calcHoiku: 階層${bracket.level} に施設タイプ '${facility}' の金額なし(${muni.citySlug || '?'})`);
    if (facility !== 'ninka') reasons.push(`施設:${facility}`);
  }

  // 4-5) 金額解決(統一)。amount-set = { standard, short, byAge?, child2? } を単位に、
  //   ひとり親(率/E階層代替/旧絶対) → 第1子/第2子/第3子 を解決する。両モデルを1経路で扱う:
  //     ・大田型 = multiChild 係数 ＋ muni.hitorioya={factor,maxIndex}(率)
  //     ・横浜型 = facility別 ＋ amt.child2(第2子の明示実額) ＋ amt.hitorioya(E階層の実額代替セット)
  //   byAge[age]: 数値(両時間区分共通) or {standard,short}。
  //   _readAmt(set, which): which='first'は set 本体、'second'は set.child2(無ければ null=係数フォールバック)。
  //   ・未定義の timeType キーは fail-fast(throw)＝黙って別の時間区分の額を返さない。
  //     ただし which='second' で child2 自体が無い場合のみ null(=係数フォールバック)を返す。
  const _readSrc = (src, ctx) => {
    const av = src.byAge ? src.byAge[age] : undefined;
    let v;
    if (av != null) v = (typeof av === 'object') ? av[timeType] : av;
    else v = src[timeType];
    if (v == null) {
      throw new Error(
        `calcHoiku: level${bracket.level} に時間区分 '${timeType}'(${ctx}/${age}) の額なし(${muni.citySlug || muni.slug || '?'})`
      );
    }
    return v;
  };
  const _readAmt = (set, which) => {
    if (which === 'second' && set.child2 == null) return null; // 明示第2子なし＝係数フォールバック
    return _readSrc(which === 'second' ? set.child2 : set, which);
  };

  // 4a) ひとり親で使う amount-set / factor を決める(施設別 amt を基点)
  let set = amt;
  let hitorioyaFactor = null;
  if (input.hitorioya) {
    const mh = muni.hitorioya;
    if (mh && Number.isFinite(mh.factor) && (mh.maxIndex == null || index <= mh.maxIndex)) {
      hitorioyaFactor = mh.factor;
      reasons.push(`ひとり親等軽減 ×${mh.factor}`);
    } else if (amt.hitorioya) {
      set = amt.hitorioya; // E階層など実額の代替セット(横浜型)
      reasons.push('ひとり親等軽減(代替階層)');
    } else if (amt.reduced && amt.reduced.hitorioya != null) {
      const v = amt.reduced.hitorioya; // 旧・絶対額(数値 or {standard,short})
      set = (typeof v === 'object') ? v : { standard: v, short: v };
      reasons.push('ひとり親等軽減');
    }
  }

  // 4b) 第1子の基本額(0歳別額/時間区分 解決)
  const firstAmt = _readAmt(set, 'first');
  if (firstAmt == null) throw new Error(`calcHoiku: 階層${bracket.level} に ${timeType}(${age}) 額なし`);
  if (age !== 'age1_2' && set.byAge && set.byAge[age] != null) reasons.push('0歳別額');
  const firstFinal = hitorioyaFactor != null ? Math.round(firstAmt * hitorioyaFactor) : firstAmt;

  // 5) 多子(childOrder)。第3子以降は multiChild.third(係数)が無ければ0。
  let amount;
  if (childOrder >= 3) {
    const third = muni.multiChild ? muni.multiChild.third : null;
    amount = (third != null) ? Math.round(firstAmt * third) : 0;
    if (hitorioyaFactor != null) amount = Math.round(amount * hitorioyaFactor);
    reasons.push(third != null ? `多子軽減(第${childOrder}子)×${third}` : `多子軽減(第${childOrder}子)`);
  } else if (childOrder === 2) {
    // 5a) セレクタ別額(新潟表②型): 非ひとり親経路でのみ、input[selector] が真かつ当該階層に
    //     child2alt があれば第2子の別額を最優先(絶対額・係数もひとり親率も掛けない)。
    //     どの階層が child2alt を持つかで index 条件(表②=6%57,700未満 等)を内包する。
    const alt = amt.child2alt;
    if (!input.hitorioya && alt && alt.selector && input[alt.selector]) {
      amount = _readSrc(alt, `child2alt:${alt.selector}`);
      reasons.push(`多子軽減(第2子・${alt.selector})`);
    } else {
      const explicit2 = _readAmt(set, 'second'); // 明示第2子(横浜型)
      if (explicit2 != null) {
        amount = explicit2;
        reasons.push('多子軽減(第2子・実額)');
      } else if (muni.multiChild && muni.multiChild.second != null) {
        amount = Math.round(firstAmt * muni.multiChild.second);
        reasons.push(`多子軽減(第2子)×${muni.multiChild.second}`);
      } else {
        amount = firstAmt;
      }
      if (hitorioyaFactor != null) amount = Math.round(amount * hitorioyaFactor);
    }
  } else {
    amount = firstFinal; // 第1子
  }

  return {
    monthly: amount,
    level: bracket.level,
    reason: reasons.join(' / ') || '通常階層',
    breakdown: {
      index,
      base: firstAmt,       // 第1子の基本額(0歳別額/時間区分 解決後・ひとり親/多子 前)
      firstFinal,           // 第1子確定額(ひとり親 適用後)
      childOrder,
      monthly: amount,
    },
  };
}

// ---- brackets 検証(不変条件) --------------------------------------------
// 検証ゲート validate-hoiku-brackets.js の中核。data投入時に呼ぶ想定。
function validateBrackets(muni) {
  const errs = [];
  // inputBasis: 公開UIの入力モードのヒント(engineは不使用・UI/結線が参照)。
  //   'salary'(既定・省略時) = 年収入力→jumin.hoikuShotokuwari→calcHoiku(京都/横浜/大田 等)
  //   'shotokuwari-direct'  = 所得割課税額を直接入力(名古屋＝税源移譲前基準。jumin経由不可)
  // 値のタイプミスを検出する(将来の入力フォーム出し分けが静かに壊れないように)。
  if (muni.inputBasis != null && !INPUT_BASES.includes(muni.inputBasis)) {
    errs.push(`inputBasis が不正: '${muni.inputBasis}'(許容: ${INPUT_BASES.join('/')})`);
  }
  // timeBands 宣言の構造検証(宣言している自治体のみ・京都等)
  if (muni.timeBands != null) {
    if (!Array.isArray(muni.timeBands) || !muni.timeBands.length) {
      errs.push('timeBands が空/非配列');
    } else {
      const keys = muni.timeBands.map((b) => b && b.key);
      if (keys.some((k) => typeof k !== 'string')) errs.push('timeBands.key が文字列でない要素あり');
      if (new Set(keys).size !== keys.length) errs.push('timeBands.key が重複');
      if (muni.defaultTimeType != null && !keys.includes(muni.defaultTimeType)) {
        errs.push(`defaultTimeType '${muni.defaultTimeType}' が timeBands に無い`);
      }
    }
  }
  if (muni.status === 'free' || (muni.freePolicy && muni.freePolicy.firstChild)) return errs; // free段は表不要
  const brackets = muni.brackets || [];
  if (!brackets.length) errs.push('brackets が空');
  const tkeys = timeKeysOf(muni); // 既定['standard','short']・timeBands宣言時はN区分
  let prevLevel = -Infinity;
  let prevCap = -Infinity;
  for (const b of brackets) {
    // level 昇順
    if (b.level <= prevLevel) errs.push(`level 非昇順: ${b.level}`);
    prevLevel = b.level;
    // 数値段の到達可能性(maxShotokuwari 昇順)
    if (!b.criteria && b.maxShotokuwari != null) {
      if (b.maxShotokuwari <= prevCap) errs.push(`maxShotokuwari 非昇順: level${b.level}`);
      prevCap = b.maxShotokuwari;
    }
    // 国基準上限104,000以下(宣言した全時間区分キー)
    for (const key of tkeys) {
      if (b[key] != null && b[key] > NATIONAL_CAP) {
        errs.push(`${key}が国基準上限超: level${b.level}=${b[key]}`);
      }
    }
    // 単調性: 長い区分 ≥ 短い区分(隣接・保育料固有の不変条件)。既定なら standard≥short。
    for (let i = 0; i < tkeys.length - 1; i++) {
      const lo = b[tkeys[i]];
      const sh = b[tkeys[i + 1]];
      if (lo != null && sh != null && lo < sh) {
        errs.push(`${tkeys[i]}<${tkeys[i + 1]}: level${b.level}`);
      }
    }
    // child2alt(セレクタ別額)の構造検証: selector(文字列)必須・予約入力キーと衝突しない・少なくとも1額を持つ
    if (b.child2alt != null) {
      const a = b.child2alt;
      if (typeof a.selector !== 'string' || !a.selector) errs.push(`child2alt.selector が無い/文字列でない: level${b.level}`);
      else if (RESERVED_INPUT_KEYS.includes(a.selector)) {
        errs.push(`child2alt.selector が予約入力キーと衝突: level${b.level}='${a.selector}'(既存フラグで誤発火する)`);
      }
      const hasAmt = tkeys.some((k) => a[k] != null) || (a.byAge && Object.keys(a.byAge).length);
      if (!hasAmt) errs.push(`child2alt に額(時間区分/byAge)が無い: level${b.level}`);
    }
  }
  return errs;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcHoiku, resolveIndex, lookupBracket, pickFiscalYear, validateBrackets, timeKeysOf, NATIONAL_CAP, INPUT_BASES };
}

// 自己テストは scripts/test-hoiku-selftest.cjs に分離（配信JSに死にコードを載せないため・2026-07-26）
