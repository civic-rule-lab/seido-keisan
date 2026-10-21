// 国民年金（第1号被保険者）: 保険料・前納・免除/納付猶予/学生納付特例の判定 — 純関数・UMD
// 制度値は data/national/kokumin-nenkin-2026.json（monthly / additionalMonthly / prepay / exemption）。数値を本ファイルに埋めない。
// 一次資料: 日本年金機構「国民年金保険料」「国民年金保険料の前納」「国民年金保険料の免除制度・納付猶予制度」「学生納付特例制度」（JSON の meta に URL と確認日）
// 免除の所得基準（令和8年度分＝2025年中の所得で判定）:
//   全額免除・納付猶予: 前年所得 ≤ (扶養親族等の数+1)×35万円+32万円
//   4分の3免除: ≤ 88万円 + 扶養親族等控除額 + 社会保険料控除額等
//   半額免除:   ≤ 128万円 + 同上
//   4分の1免除: ≤ 168万円 + 同上
//   学生納付特例（本人のみ）: ≤ 128万円 + 扶養親族等の数×38万円 + 社会保険料控除等
//   審査対象: 免除＝本人・配偶者・世帯主の全員 / 納付猶予＝本人・配偶者（50歳未満） / 学生納付特例＝本人
// 「扶養親族等控除額」「社会保険料控除額等」の内訳は JSON の exemption.dependentDeduction / otherDeduction（meta.inferred 参照）。
'use strict';

(function (global) {
  const LEVELS = ['full', 'threeQuarters', 'half', 'quarter'];

  // 人ごとの「扶養親族等の数」（配偶者＋扶養親族。年齢を問わない）
  function dependentCount(d) {
    const x = Object.assign({ spouse: 0, under16: 0, age16to22: 0, general: 0, elderly: 0, elderlyCoRes: 0 }, d || {});
    return (x.spouse ? 1 : 0) + x.under16 + x.age16to22 + x.general + x.elderly + x.elderlyCoRes;
  }

  // 人ごとの「扶養親族等控除額」
  function dependentDeduction(d, E) {
    const x = Object.assign({ spouse: 0, under16: 0, age16to22: 0, general: 0, elderly: 0, elderlyCoRes: 0 }, d || {});
    const t = E.dependentDeduction;
    return (x.spouse ? t.spouse : 0) + x.under16 * t.under16 + x.age16to22 * t.age16to22 +
      x.general * t.general + x.elderly * t.elderly + x.elderlyCoRes * t.elderlyCoRes;
  }

  // 人ごとの「社会保険料控除額等」: 社会保険料控除（実額）＋小規模企業共済等掛金＋医療費等の所得控除＋障害者・寡婦・ひとり親控除
  function otherDeduction(o, E) {
    const x = Object.assign({ socialInsurance: 0, otherKojo: 0, shogai: 0, shogaiSpecial: 0, kafu: false, hitorioya: false }, o || {});
    const t = E.otherDeduction;
    return x.socialInsurance + x.otherKojo + x.shogai * t.shogai + x.shogaiSpecial * t.shogaiSpecial +
      (x.hitorioya ? t.hitorioya : (x.kafu ? t.kafu : 0));
  }

  // 1人分の基準額をすべて返す（画面の「誰のどの基準」表示にも使う）
  function thresholds(person, E) {
    const n = dependentCount(person.dependents);
    const dd = dependentDeduction(person.dependents, E);
    const od = otherDeduction(person.other, E);
    return {
      full: (n + 1) * E.full.perPerson + E.full.base,
      yuyo: (n + 1) * E.yuyo.perPerson + E.yuyo.base,
      threeQuarters: E.partial.threeQuarters + dd + od,
      half: E.partial.half + dd + od,
      quarter: E.partial.quarter + dd + od,
      student: E.student.base + n * E.student.perDependent + od,
      dependentCount: n, dependentDeduction: dd, otherDeduction: od,
    };
  }

  function within(person, key, E) { return (person.income || 0) <= thresholds(person, E)[key]; }

  // 保険料（年額・前納）。tsuka=true で付加保険料（月400円）を月額・年額に足す（前納の表には足さない＝一次資料のとおり付加を含まない）
  function calcPremium(db, opt) {
    const o = opt || {};
    const monthly = db.monthly + (o.tsuka ? db.additionalMonthly : 0);
    return {
      monthly, annual: monthly * 12,
      baseMonthly: db.monthly, tsukaMonthly: o.tsuka ? db.additionalMonthly : 0,
      nextYearMonthly: db.nextYearMonthly,
      prepay: db.prepay,
    };
  }

  // 免除・納付猶予・学生納付特例の判定
  // input: { age, isStudent, self:{income,dependents,other}, spouse:{...}|null, householder:{...}|null }
  //   householder は「本人が世帯主」なら null。配偶者が世帯主なら householder=null・spouse に入れる
  function judgeExemption(db, input) {
    const E = db.exemption;
    const self = input.self || { income: 0 };
    const persons = { self, spouse: input.spouse || null, householder: input.householder || null };
    const detail = {};
    for (const k of Object.keys(persons)) if (persons[k]) detail[k] = thresholds(persons[k], E);
    const age = input.age == null ? 30 : input.age;
    const eligible = age >= 20 && age < 60;
    const out = { eligible, level: 'none', monthlyAfter: db.monthly, detail, payFraction: 1, pensionReflection: null, tsuinoYears: E.tsuinoYears };
    if (!eligible) return out;

    const all = ['self', 'spouse', 'householder'].filter((k) => persons[k]);
    const okFor = (keys, key) => keys.every((k) => within(persons[k], key, E));

    if (input.isStudent) {
      if (within(self, 'student', E)) Object.assign(out, { level: 'student', payFraction: E.payFraction.student });
    } else {
      for (const lv of LEVELS) {
        if (okFor(all, lv)) { Object.assign(out, { level: lv, payFraction: E.payFraction[lv] }); break; }
      }
      if (out.level === 'none' && age < E.yuyo.ageMax && okFor(['self', 'spouse'].filter((k) => persons[k]), 'yuyo')) {
        Object.assign(out, { level: 'yuyo', payFraction: E.payFraction.yuyo });
      }
    }
    out.monthlyAfter = Math.round(db.monthly * out.payFraction);
    out.pensionReflection = out.level === 'none' ? null : E.pensionReflection[out.level];
    // どの人が基準を超えたか（免除の全区分で不成立のとき、画面の説明に使う）
    out.exceeded = all.filter((k) => !within(persons[k], 'quarter', E));
    return out;
  }

  const api = { calcPremium, judgeExemption, thresholds, dependentCount, dependentDeduction, otherDeduction, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Nenkin = api;
})(typeof window !== 'undefined' ? window : globalThis);
