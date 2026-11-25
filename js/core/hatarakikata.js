// 働き方の比較: 同じ稼ぎを会社員・個人事業で受け取ったときの、社会保険料・税・手取り・年金の増え方 — 純関数・UMD
//
// 揃え方: 会社員の「会社が払う総額」＝ 個人事業の「売上から経費を引いた額」（青色申告特別控除を引く前）。
//   会社が払う総額 ＝ 額面年収 ＋ 会社が負担する社会保険料（健康保険・介護保険・子ども・子育て支援金・厚生年金・雇用保険・子ども・子育て拠出金）
//
// 制度値は呼び出し側が data で渡す（本ファイルに数値を埋めない。年も data.config.years から読み、既定値を持たない）:
//   data.config      data/national/hatarakikata-<年>.json
//   data.shaho       { kenpo, kosei, koyo, standard, senpo }（data/shaho/*.json。Shaho.calculateShaho にそのまま渡す）
//   data.shotokuDb   data/national/shotokuzei-<年>.json
//   data.haigu       data/national/jumin-haigusha-kojo.json
//   data.nenkin      data/national/kokumin-nenkin-<年>.json（monthly）
//   data.nenkinKyufu data/national/nenkin-kyufu-<年>.json
//   data.jigyozei    data/national/kojin-jigyozei-<年>.json
//   data.kokuho      自治体の kokuho-<年>.json（個人事業の列に必須）
//   data.jumin       自治体の jumin-<年>.json（無ければ null。住民税エンジンの既定の税率で計算する）
//
// 入力:
//   input.mode       'kaishain'（額面年収から入れる）| 'kojin'（売上と経費から入れる）
//   input.common     { age, prefSlug, kyuchi, spouse: null | { age, salary, ownShaho? }, kids: { u16, preschool, a1618, a1922 } }
//   input.kaishain   { nenshu（mode が kaishain のとき必須）, ideco }
//   input.kojin      { uriage・keihi（mode が kojin のとき必須）, aoiro, gyoshu, ideco, kyosai }
//   知らない入れ物（input.houjin など）は読まない。
//
// 出力: { schemaVersion, mode, total, align: { nenshu, kaishainTotal, gap }, columns: [ 列, … ] }
//   列は opts.columns の順（既定 ['kaishain', 'kojin']）。列ごとに作る関数が分かれていて、ほかの列の結果を読まない。
//   列の形は全列で共通。その働き方に無い項目は null（0 円と区別する）。
//   どの列でも次が成り立つ: totalUsed ＝ takeHome ＋ siEmployer ＋ siEmployee ＋ taxTotal ＋ buckets.savings ＋ buckets.retained（null は 0 として足す）
//
// 簡略: 賞与なし（年収÷12 を毎月の報酬とする）・配偶者自身の税と社会保険料は入れない・労災保険は入れない・
//       国民年金の免除は扱わない・iDeCo と小規模企業共済の掛金は上限を検査しない（呼び出し側が検査する）。
'use strict';

(function (global) {
  const SCHEMA_VERSION = 1;
  const DEFAULT_COLUMNS = ['kaishain', 'kojin'];
  const _isNode = typeof module !== 'undefined' && !!module.exports;

  // ── ほかのエンジン（Node は require、ブラウザは先に読み込まれたグローバル） ──
  let _deps = null;
  function deps() {
    if (_deps) return _deps;
    if (_isNode) {
      const J = require('./jumin.js'), I = require('./shared/income.js');
      _deps = {
        Shaho: require('./shaho.js'), Shotoku: require('./shotoku.js'),
        calculateJumin: J.calculateJumin, calcSpouseDeductionJumin: J.calcSpouseDeductionJumin,
        calculateKokuho: require('./kokuho.js').calculateKokuho,
        calcSalaryIncome: I.calcSalaryIncome, isKyuyoShotokushaTou: I.isKyuyoShotokushaTou,
        NenkinKyufu: require('./nenkin-kyufu.js'), Jigyozei: require('./jigyozei.js'),
      };
    } else {
      _deps = {
        Shaho: global.Shaho, Shotoku: global.Shotoku,
        calculateJumin: global.calculateJumin, calcSpouseDeductionJumin: global.calcSpouseDeductionJumin,
        calculateKokuho: global.calculateKokuho,
        calcSalaryIncome: global.calcSalaryIncome, isKyuyoShotokushaTou: global.isKyuyoShotokushaTou,
        NenkinKyufu: global.NenkinKyufu, Jigyozei: global.Jigyozei,
      };
    }
    for (const k of Object.keys(_deps)) if (!_deps[k]) { const miss = k; _deps = null; throw new Error(`働き方の比較: 必要なエンジンが読み込まれていません（${miss}）`); }
    return _deps;
  }

  // ── 入力の検査（数でない値・NaN・Infinity・負の数は例外。黙って 0 にしない） ──
  function yen(v, name, dflt) {
    if (v === undefined || v === null) {
      if (dflt === undefined) throw new TypeError(`${name} がありません`);
      return dflt;
    }
    if (typeof v !== 'number') throw new TypeError(`${name} は数で渡してください（${String(v)}）`);
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} が範囲外です（${String(v)}）`);
    return Math.floor(v);
  }
  function count(v, name) {
    if (v === undefined || v === null) return 0;
    if (typeof v !== 'number') throw new TypeError(`${name} は数で渡してください（${String(v)}）`);
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} は 0 以上の整数で渡してください（${String(v)}）`);
    return v;
  }
  function need(obj, name) {
    if (obj === undefined || obj === null) throw new Error(`働き方の比較: 制度値がありません（${name}）`);
    return obj;
  }
  const inRange = (age, r) => age >= r.ageFrom && age < r.ageUnder;
  const sum = (items) => items.reduce((s, x) => s + x.amount, 0);

  // ── 共通の前提（年・家族）を1つにまとめる。列を作る関数はこれと総額だけを読む ──
  function context(input, data) {
    const d = deps();
    const cfg = need(data && data.config, 'config');
    const years = need(cfg.years, 'config.years');
    for (const k of ['shotokuYear', 'juminFiscalYear', 'shahoTargetMonth']) need(years[k], `config.years.${k}`);
    need(data.shaho, 'shaho'); need(data.shotokuDb, 'shotokuDb'); need(data.haigu, 'haigu');
    need(data.nenkin && data.nenkin.monthly, 'nenkin.monthly'); need(data.nenkinKyufu, 'nenkinKyufu');
    const c = need(input && input.common, 'input.common');
    const age = count(c.age, 'common.age');
    if (c.age === undefined || c.age === null) throw new TypeError('common.age がありません');
    const ar = need(cfg.ageRange, 'config.ageRange');
    if (age < ar.min || age >= ar.under) throw new RangeError(`common.age が対象外です（${age}。対象は ${ar.min} 歳以上 ${ar.under} 歳未満）`);
    if (typeof c.prefSlug !== 'string' || !c.prefSlug) throw new TypeError('common.prefSlug がありません');
    if (![1, 2, 3].includes(c.kyuchi)) throw new RangeError(`common.kyuchi は 1・2・3 のいずれかで渡してください（${String(c.kyuchi)}）`);
    const k = c.kids || {};
    const kids = { u16: count(k.u16, 'kids.u16'), preschool: count(k.preschool, 'kids.preschool'), a1618: count(k.a1618, 'kids.a1618'), a1922: count(k.a1922, 'kids.a1922') };
    if (kids.preschool > kids.u16) throw new RangeError(`kids.preschool は kids.u16 以下で渡してください（${kids.preschool} > ${kids.u16}）`);
    kids.total = kids.u16 + kids.a1618 + kids.a1922;
    const engine = d.Shotoku.createEngineFromDB(years.shotokuYear, data.shotokuDb);
    let spouse = null;
    if (c.spouse) {
      const sAge = count(c.spouse.age, 'spouse.age');
      if (c.spouse.age === undefined || c.spouse.age === null) throw new TypeError('spouse.age がありません');
      const salary = yen(c.spouse.salary, 'spouse.salary', 0);
      // 自分の勤め先の社会保険に入っている配偶者（収入が被扶養者の目安以上、または呼び出し側が明示）は、本人の世帯の保険料に入れない
      const ownShaho = !!c.spouse.ownShaho || salary >= need(cfg.spouse && cfg.spouse.hifuyoSalaryLimit, 'config.spouse.hifuyoSalaryLimit');
      spouse = {
        age: sAge, salary, ownShaho, age70plus: sAge >= 70,
        incomeShotoku: engine.kyuyoShotoku(salary),                              // 所得税の配偶者控除の判定に使う合計所得
        incomeJumin: d.calcSalaryIncome(salary, years.juminFiscalYear),          // 住民税・国保で使う給与所得
        nenkinAge: inRange(sAge, need(cfg.nenkin1go, 'config.nenkin1go')),
        kaigoAge: inRange(sAge, need(cfg.kaigoAge, 'config.kaigoAge')),
      };
    }
    return { d, cfg, years, data, engine, age, prefSlug: c.prefSlug, kyuchi: c.kyuchi, kids, spouse,
      selfNenkinAge: inRange(age, cfg.nenkin1go), selfKaigoAge: inRange(age, cfg.kaigoAge) };
  }

  // 住民税（年額）。配偶者控除・扶養控除・人的控除差・非課税判定の人数を、家族の入力から組み立てて住民税エンジンに渡す。
  //   人的控除差: 基礎 5万＋配偶者（エンジンの表）＋一般扶養 5万×人数。19〜22歳の子の 18万と扶養人数はエンジンが specialDependentSalaries から足す
  function juminTax(ctx, base) {
    const { d, years, kids, spouse } = ctx;
    const selfIncome = base.salary > 0 ? d.calcSalaryIncome(base.salary, years.juminFiscalYear) : base.otherIncome;
    const sd = spouse
      ? d.calcSpouseDeductionJumin({ selfIncome, spouseIncome: spouse.incomeJumin, age70plus: spouse.age70plus, fiscalYear: years.juminFiscalYear, data: ctx.data.haigu })
      : { kind: 'none', deduction: 0, humanDiffAmount: 0 };
    const r = d.calculateJumin(ctx.data.jumin || null, {
      salary: base.salary, pension: 0, otherIncome: base.otherIncome, age: ctx.age, socialInsurance: base.socialInsurance,
      spouseDeduction: sd.deduction, dependentDeduction: 330_000 * kids.a1618,
      dependents: (sd.kind === 'haigu' ? 1 : 0) + kids.u16 + kids.a1618,
      humanDeductionDiff: 50_000 + sd.humanDiffAmount + 50_000 * kids.a1618,
      specialDependentSalaries: Array(kids.a1922).fill(0), under23Dependent: kids.total > 0,
      fiscalYear: years.juminFiscalYear, taxCredits: 0, kyuchi: ctx.kyuchi,
    });
    return r.total;
  }
  function shotokuTax(ctx, base) {
    const { kids, spouse } = ctx;
    return ctx.engine.calcShotokuzei({
      salary: base.salary, otherIncome: base.otherIncome, socialInsurance: base.socialInsurance, ideco: base.kakekin,
      spouse: spouse ? { income: spouse.incomeShotoku, age70plus: spouse.age70plus } : null,
      dependents: { general: kids.a1618, specific: kids.a1922 }, under23Dependent: kids.total > 0,
    }).annualTax;
  }

  // ── 会社員: 社会保険料（本人・会社）と、会社が払う総額 ──
  //   opt.koyo: 雇用保険を入れるか（既定 true。役員など雇用保険に入らない働き方を足すときに false を渡す）
  function socialInsurance(ctx, nenshu, opt) {
    const { d, cfg, years } = ctx;
    const withKoyo = !opt || opt.koyo !== false;
    const kc = need(cfg.kaishain, 'config.kaishain');
    const monthly = Math.round(nenshu / 12);
    const s = d.Shaho.calculateShaho({ monthlySalary: monthly, targetMonth: years.shahoTargetMonth, prefSlug: ctx.prefSlug, age: ctx.age, koyoCategory: kc.koyoCategory }, ctx.data.shaho);
    const on = (x) => !!(x && x.applies);
    const fullMonthly = (on(s.health) ? s.health.full : 0) + (on(s.care) ? s.care.full : 0) + (on(s.shienkin) ? s.shienkin.full : 0) + (on(s.koseiNenkin) ? s.koseiNenkin.full : 0);
    const empMonthly = s.employee.socialInsuranceRounded;
    const koseiStd = on(s.koseiNenkin) ? s.koseiNenkin.standardMonthly : null;
    const cat = (ctx.data.shaho.koyo.categories || []).find((x) => x.key === kc.koyoCategory);
    if (withKoyo && !cat) throw new Error(`働き方の比較: 雇用保険の制度値に区分がありません（${kc.koyoCategory}）`);
    const kr = need(kc.kyoshutsukin, 'config.kaishain.kyoshutsukin');
    const employee = [{ key: 'kenpoKosei', amount: empMonthly * 12 }];
    const employer = [{ key: 'kenpoKosei', amount: Math.round((fullMonthly - empMonthly) * 12) }];
    if (withKoyo) {
      employee.push({ key: 'koyo', amount: Math.round(s.employee.koyo * 12) });
      employer.push({ key: 'koyo', amount: Math.round(monthly * cat.employer * 12) });
    }
    employer.push({ key: 'kyoshutsukin', amount: koseiStd === null ? 0 : Math.round((koseiStd * 12 * kr.ratePer10000) / 10000) });
    return { employee, employer, employeeTotal: sum(employee), employerTotal: sum(employer), koseiStd };
  }
  function totalFromNenshu(ctx, nenshu) { return nenshu + socialInsurance(ctx, nenshu).employerTotal; }
  // 総額を超えない最大の額面年収（1,000円刻み）。社会保険料は等級で段になるので、式でなく二分探索で求める
  function nenshuFromTotal(ctx, total) {
    if (totalFromNenshu(ctx, 0) > total) throw new RangeError(`総額が小さすぎて、会社員の額面年収に直せません（${total}）`);
    let lo = 0, hi = Math.ceil(total / 1000);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (totalFromNenshu(ctx, mid * 1000) <= total) lo = mid; else hi = mid - 1;
    }
    return lo * 1000;
  }

  function pensionOf(ctx, koseiStd, spouseGetsKiso) {
    const N = ctx.d.NenkinKyufu, db = ctx.data.nenkinKyufu;
    return {
      kiso: ctx.selfNenkinAge ? N.kisoIncrease(db) : null,                       // 基礎年金に反映されるのは 20歳以上60歳未満の期間
      kosei: koseiStd === null ? null : N.koseiIncrease(db, koseiStd),
      spouseKiso: spouseGetsKiso ? N.kisoIncrease(db) : null,
    };
  }
  function column(key, totalUsed, gross, grossKind, si, taxes, savings, pension, assumptions) {
    const taxTotal = sum(taxes), savingsTotal = sum(savings);
    const emp = si.employee, er = si.employer;
    return {
      key, totalUsed, gross, grossKind,
      siEmployer: er === null ? null : sum(er), siEmployerItems: er === null ? [] : er,
      siEmployee: sum(emp), siEmployeeItems: emp,
      taxes, taxTotal,
      takeHome: totalUsed - (er === null ? 0 : sum(er)) - sum(emp) - taxTotal - savingsTotal,
      buckets: { savings: savingsTotal, savingsItems: savings, retained: null },
      pension, assumptions,
    };
  }

  // ── 列: 会社員 ──
  function buildKaishain(ctx, env) {
    const nenshu = env.nenshu;
    const si = socialInsurance(ctx, nenshu);
    const ideco = yen(env.input.kaishain && env.input.kaishain.ideco, 'kaishain.ideco', 0);
    const base = { salary: nenshu, otherIncome: 0 };
    const taxes = [
      { key: 'shotokuzei', amount: shotokuTax(ctx, { ...base, socialInsurance: si.employeeTotal, kakekin: ideco }) },
      { key: 'juminzei', amount: juminTax(ctx, { ...base, socialInsurance: si.employeeTotal + ideco }) },
    ];
    const savings = ideco > 0 ? [{ key: 'ideco', amount: ideco }] : [];
    const spouseKiso = !!(ctx.spouse && !ctx.spouse.ownShaho && ctx.spouse.nenkinAge);   // 第3号被保険者
    return column('kaishain', nenshu + si.employerTotal, nenshu, 'nenshu', si, taxes, savings, pensionOf(ctx, si.koseiStd, spouseKiso),
      [{ key: 'bonus', value: 'none' }]);
  }

  // ── 列: 個人事業 ──
  function buildKojin(ctx, env) {
    const { d, cfg, kids, spouse } = ctx;
    const kc = need(cfg.kojin, 'config.kojin'), kj = env.input.kojin || {};
    need(ctx.data.kokuho, 'kokuho'); need(ctx.data.jigyozei, 'jigyozei');
    const profit = env.total;
    const aoiroDefaulted = kj.aoiro === undefined || kj.aoiro === null;
    const aoiroIn = aoiroDefaulted ? kc.aoiroDefault : kj.aoiro;
    if (!kc.aoiroOptions.includes(aoiroIn)) throw new RangeError(`kojin.aoiro が選べる額にありません（${String(aoiroIn)}）`);
    const gyoshuDefaulted = kj.gyoshu === undefined || kj.gyoshu === null;
    const gyoshu = gyoshuDefaulted ? kc.gyoshuDefault : kj.gyoshu;
    const ideco = yen(kj.ideco, 'kojin.ideco', 0), kyosai = yen(kj.kyosai, 'kojin.kyosai', 0);
    const aoiro = Math.min(aoiroIn, profit);                        // 青色申告特別控除は事業の所得が限度
    const jigyo = profit - aoiro;

    // 国保: 本人・配偶者（自分の社会保険が無いとき）・子が加入。所得は1人ずつ渡す
    const spouseIn = !!(spouse && !spouse.ownShaho);
    const members = [{ income: jigyo, careTarget: ctx.selfKaigoAge }];
    if (spouseIn) members.push({ income: spouse.incomeJumin, careTarget: spouse.kaigoAge });
    for (let i = 0; i < kids.total; i++) members.push({ income: 0, careTarget: false });
    const kokuho = d.calculateKokuho({
      income: jigyo + (spouseIn ? spouse.incomeJumin : 0), members, family: members.length,
      preschool: kids.preschool, under18: kids.u16 + kids.a1618,
      care: (ctx.selfKaigoAge ? 1 : 0) + (spouseIn && spouse.kaigoAge ? 1 : 0),
      salaryPensionCount: spouseIn && d.isKyuyoShotokushaTou(spouse.salary, 0, spouse.age) ? 1 : 0, fixedAssetTax: 0,
    }, ctx.data.kokuho).total;
    const nm = ctx.data.nenkin.monthly * 12;
    const spousePays = spouseIn && spouse.nenkinAge;
    const employee = [{ key: 'kokuho', amount: kokuho }, { key: 'kokuminNenkin', amount: nm * ((ctx.selfNenkinAge ? 1 : 0) + (spousePays ? 1 : 0)) }];
    const siTotal = sum(employee), kakekin = ideco + kyosai;
    const base = { salary: 0, otherIncome: jigyo };
    const taxes = [
      { key: 'shotokuzei', amount: shotokuTax(ctx, { ...base, socialInsurance: siTotal, kakekin }) },
      { key: 'juminzei', amount: juminTax(ctx, { ...base, socialInsurance: siTotal + kakekin }) },
      { key: 'kojinJigyozei', amount: d.Jigyozei.calc(ctx.data.jigyozei, { income: profit, rateKey: gyoshu }).tax },
    ];
    const savings = [];
    if (ideco > 0) savings.push({ key: 'ideco', amount: ideco });
    if (kyosai > 0) savings.push({ key: 'kyosai', amount: kyosai });
    return column('kojin', profit, jigyo, 'jigyoShotoku', { employee, employer: null }, taxes, savings, pensionOf(ctx, null, spousePays), [
      { key: 'aoiro', value: aoiro, defaulted: aoiroDefaulted },
      { key: 'gyoshu', value: gyoshu, defaulted: gyoshuDefaulted },
    ]);
  }

  const BUILDERS = { kaishain: buildKaishain, kojin: buildKojin };

  function compare(input, data, opts) {
    const ctx = context(input, data);
    const cols = (opts && opts.columns) || DEFAULT_COLUMNS;
    if (!Array.isArray(cols) || cols.length === 0) throw new TypeError('columns は列の名前の配列で渡してください');
    for (const c of cols) if (!BUILDERS[c]) throw new RangeError(`columns に知らない列があります（${String(c)}）`);
    let total, nenshu;
    if (input.mode === 'kaishain') {
      nenshu = yen(input.kaishain && input.kaishain.nenshu, 'kaishain.nenshu');
      total = totalFromNenshu(ctx, nenshu);
    } else if (input.mode === 'kojin') {
      const uriage = yen(input.kojin && input.kojin.uriage, 'kojin.uriage');
      const keihi = yen(input.kojin && input.kojin.keihi, 'kojin.keihi', 0);
      if (keihi > uriage) throw new RangeError(`経費が売上を上回っています（売上 ${uriage}・経費 ${keihi}）。赤字の年は扱いません`);
      total = uriage - keihi;
      nenshu = nenshuFromTotal(ctx, total);
    } else {
      throw new RangeError(`mode は 'kaishain' か 'kojin' で渡してください（${String(input.mode)}）`);
    }
    const kaishainTotal = totalFromNenshu(ctx, nenshu);
    const env = { input, total, nenshu };
    return {
      schemaVersion: SCHEMA_VERSION, mode: input.mode, total,
      align: { nenshu, kaishainTotal, gap: total - kaishainTotal },   // gap: 個人事業から入れたとき、等級の段で揃えきれなかった額（会社員から入れたときは 0）
      columns: cols.map((c) => BUILDERS[c](ctx, env)),
    };
  }

  const api = { compare, SCHEMA_VERSION, DEFAULT_COLUMNS: DEFAULT_COLUMNS.slice() };
  if (_isNode) module.exports = api;
  global.Hatarakikata = api;
})(typeof window !== 'undefined' ? window : globalThis);
