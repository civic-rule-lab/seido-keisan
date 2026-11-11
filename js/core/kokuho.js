// 国民健康保険料 計算ロジック（純粋関数）
// Browser: <script> で読み込むとグローバル関数として使用可能
// Node:    require('./js/core/kokuho') で { calculateKokuho } を取得

// 子ども・子育て支援金分の賦課限度額の国基準（政令）。
// 出典: 国民健康保険法施行令 第29条の7 第5項 第10号（令和8年度新設・30,000円、2026-07-02 確認）
// 注意: 条例で国基準未満を定める自治体が実在する（例: shika 20,000円）ため、
// これは「データ欠落時の最後の手段」であり、正は各自治体 JSON の childcareLevy.cap。
const CHILDCARE_CAP_NATIONAL = 30000;

// 区分（医療・支援・介護・子ども分）ごとの賦課額の端数単位（2026-11-11・TASKS X253＝X148-1・X149-1）。
//   既定は 100 円未満切捨て。保険税は地方税法 第20条の4の2 第3項（地方税の確定金額の百円未満の端数は切捨て。
//   e-Gov 325AC0000000226_20261101 で確認）により区分ごとに切り捨てる（新宮市・久留米市・白山市の公表例で区分ごとを確認）。
//   保険料（料方式）は条例次第なので、既定と違う自治体だけデータ rounding に持つ（持たない自治体と未判明の料方式は既定。X149-1 の ④）。
//     componentUnit  区分ごとの単位。数（全区分共通）か { medical, support, care, childcare }（区分で違う。千葉市は子ども分だけ 1）。
//                    1＝切り捨てない（特別区）。
//     componentDropBelow  区分の額がこの額未満なら全額を切り捨てる（千葉市 条例31条2項「その金額が100円未満であるときは…その全額」）。
//     totalUnit      区分の和（保険料の額）にだけ掛ける単位。既定 1（掛けない）。長野市 10（条例17条2項「保険料の確定金額」）、
//                    夕張市 100（条例15条「保険料の賦課額」＝10条の4区分の合算額）。合計だけ切り捨てる自治体は componentUnit を 1 にする。
//     incomeUnit     区分ごとの所得割の切捨て単位 { medical, support, care, childcare }（書いた区分だけ。京都市 10）。
//   合計だけ切り捨てると区分の額の和と total が合わなくなる（区分は切り捨て前の額のまま）。
const DEFAULT_COMPONENT_UNIT = 100;
const COMPONENT_UNITS = [1, 10, 100];
const COMPONENT_KEYS = ["medical", "support", "care", "childcare"];

function calculateKokuho(input, data) {
  const { income, family: familyIn, preschool, under18, care, salaryPensionCount, fixedAssetTax,
          reductionJudgmentIncome, members, tokuteiDouitsuCount, giseiSetainushi, tokuteiSetaiKubun } = input;

  // 加入者ごとの所得（任意・2026-10-04 追加・TASKS X170-12）。
  //   members: [{ income: 前年の総所得金額等（基礎控除前）, careTarget: 40〜64歳なら true }, ...]
  // 所得割の基礎額は「加入者ごとに 所得 − 基礎控除（下限0）」の合計で、介護分の所得割は
  // careTarget の人の基礎額だけに掛ける（市原市の公式計算例で確認）。
  // members が無いときは従来どおり income 1本から基礎控除を1回だけ引く（既存ページ・API・テストの結果は不変）。
  // 均等割・平等割の人数（family / care / under18 / preschool）は members ではなく従来の入力を使う。
  const memberList = Array.isArray(members) && members.length > 0 ? members : null;

  // 加入者（被保険者）が 0 人の世帯には国保料を課さない（2026-10-24）。
  //   保険料は「被保険者の属する世帯の世帯主」から徴収する（国民健康保険法 第76条第1項。e-Gov 2026-10-01 施行時点で確認）。
  //   被保険者がいなければ課す相手がない。
  //   世帯全員が後期高齢者医療・社保に入っている場合などに呼び出し側が family: 0 を渡す。旧実装は平等割と
  //   子ども・子育て支援金の世帯割（と資産割）を課していた。family を省略したときは 0 ではなく、下のとおり 1 人（または members の人数）とみなす。
  // 世帯人数（加入者数）を省略した・数でないときは、members があればその人数、無ければ 1 人とみなす。
  //   旧実装は省略すると均等割が 0 人分・軽減の基準額が NaN になり、黙って「軽減なし」で計算していた（2026-10-25・全方向試算 B-8）。
  // 人数は 0 以上の整数に正規化する（小数は切り捨て・負値は 0 人）。旧実装は 1.5 人で 0.5 円単位の額、-1 人で均等割だけ 0 の額を返していた（2026-11-09・S1-2 F2）。
  const family = (familyIn === undefined || familyIn === null || !Number.isFinite(Number(familyIn)))
    ? (Array.isArray(members) && members.length > 0 ? members.length : 1)
    : Math.max(0, Math.floor(Number(familyIn)));
  if (family === 0) {
    return {
      medicalTotal: 0, supportTotal: 0, careTotal: 0, childcareTotal: 0,
      total: 0, monthly: 0,
      preschoolReduction: 0, schoolReduction: 0, totalReduction: 0,
      reductionLabel: '軽減なし', assetLevyTotal: 0,
    };
  }

  // ① income=undefined 対策：未指定時は 0 として扱う
  // members があるときは各人の所得の合計（軽減判定の既定値にも使う）。
  const incomeSafe      = memberList
    ? memberList.reduce((s, m) => s + Math.max(m?.income || 0, 0), 0)
    : (income || 0);
  const familySafe      = Math.max(family || 0, 0);
  // ③ preschool / care が family を超えた場合は family に clamp
  const preschoolSafe   = Math.min(Math.max(preschool || 0, 0), familySafe);
  const careSafe        = Math.min(Math.max(care      || 0, 0), familySafe);

  // 軽減判定に使う所得。擬制世帯主がいる場合は呼び出し側が
  // (加入者所得 + 世帯主所得) を計算してここに渡す。未指定時は income にフォールバック。
  const reductionBase = reductionJudgmentIncome ?? incomeSafe;

  // 資産割
  // 固定資産税額を省略した・数でない・負の値のときは 0 として扱う。旧実装は省略すると資産割のある自治体（R8 で 113 件）で
  // 合計が NaN になっていた（公開ページは 0 を渡すので表示には出ない。API・テストの呼び出しで起きる。2026-10-25・全方向試算 B-7）。
  const fixedAssetTaxSafe = Number.isFinite(Number(fixedAssetTax)) ? Math.max(Number(fixedAssetTax), 0) : 0;
  const assetLevyMedical = data.assetLevy ? Math.round(fixedAssetTaxSafe * (data.assetLevy.medical || 0)) : 0;
  const assetLevySupport = data.assetLevy ? Math.round(fixedAssetTaxSafe * (data.assetLevy.support || 0)) : 0;
  // 介護分は介護納付金課税被保険者（40〜64歳）がいる世帯だけに課す（所得割・均等割・平等割と同じ条件）。
  // 旧実装は care=0 の世帯にも介護分資産割を課していた（2026-10-01 修正）。
  const assetLevyCare    = data.assetLevy && careSafe > 0 ? Math.round(fixedAssetTaxSafe * (data.assetLevy.care    || 0)) : 0;
  const assetLevyChildcare = data.assetLevy ? Math.round(fixedAssetTaxSafe * (data.assetLevy.childcare || 0)) : 0;

  const memberBase = (m) => Math.max(Math.max(m?.income || 0, 0) - data.basicDeduction, 0);
  const baseIncome = memberList
    ? memberList.reduce((s, m) => s + memberBase(m), 0)
    : Math.max(incomeSafe - data.basicDeduction, 0);
  // 介護分の所得割の基礎額。members が無いときは従来どおり世帯の基礎額全部（簡易計算）。
  const careBaseIncome = memberList
    ? memberList.reduce((s, m) => s + (m?.careTarget ? memberBase(m) : 0), 0)
    : baseIncome;

  // 所得割。既定は 1 円未満四捨五入。rounding.incomeUnit（{ 区分: 10 }）を持つ自治体は、その区分の所得割を
  //   単位未満切捨て（京都市 条例12条2項・14条の4第2項・15条の4第2項＝医療・支援・子ども分は 10 円未満切捨て。介護分は規定なし）。
  const incomeUnitOf = (k) => {
    const u = data.rounding?.incomeUnit?.[k];
    if (u == null) return null;
    if (!COMPONENT_UNITS.includes(u)) throw new RangeError(`[kokuho] ${data.citySlug || "(citySlug不明)"}: rounding.incomeUnit.${k} は ${COMPONENT_UNITS.join("/")} のいずれか（${String(u)}）`);
    return u;
  };
  const incomeLevy = (base, rate, k) => {
    const u = incomeUnitOf(k);
    return u == null ? Math.round(base * rate) : Math.floor(base * rate / u) * u;
  };
  const medicalIncome = incomeLevy(baseIncome, data.rate.medical, "medical");
  const supportIncome = incomeLevy(baseIncome, data.rate.support, "support");
  const careIncome    = careSafe > 0 ? incomeLevy(careBaseIncome, data.rate.care, "care") : 0;

  // 均等割
  const medicalPerCapita = familySafe * data.perCapita.medical;
  const supportPerCapita = familySafe * data.perCapita.support;
  const carePerCapita    = careSafe   * data.perCapita.care;

  // 平等割
  // 特定世帯（後期へ移った特定同一世帯所属者と同じ世帯で、国保の加入者が1人だけ・移ってから5年以内）は 1/2、
  // 特定継続世帯（その後3年間）は 3/4（国民健康保険法施行令 第29条の7 第2項第8号ロ・ハ、第3項第7号、第5項第9号）
  //   [確認済 2026-10-25 e-Gov 法令API・2026-08-01 施行時点]。医療分・後期支援金分・子ども子育て支援金分が対象で、介護分には無い。
  //   1円未満は切り捨てる（10円未満を切り捨てる条例もあり、数円ずれることがある）。
  const tokuteiRatio = familySafe === 1
    ? (tokuteiSetaiKubun === 'tokutei' ? [1, 2] : tokuteiSetaiKubun === 'keizoku' ? [3, 4] : null)
    : null;
  const tokuteiAdj = (v) => tokuteiRatio ? Math.floor(v * tokuteiRatio[0] / tokuteiRatio[1]) : v;
  const medicalHousehold = tokuteiAdj(data.household?.medical || 0);
  const supportHousehold = tokuteiAdj(data.household?.support || 0);
  const careHousehold    = careSafe > 0 ? (data.household?.care || 0) : 0;

  // 未就学児軽減の計算は「軽減判定」で reductionRate が確定した後に行う。
  // 制度上、法定軽減（7/5/2割）が適用される世帯では「軽減後の」均等割額の5割を
  // 軽減するため、reductionRate に依存する。定義は下方（reductionRate 決定後）へ移動。

  // 学齢児軽減（未就学児を除く 18 歳未満の医療分・支援分均等割を減額）
  // 例: 昭島市の独自減免「未就学児を除く 18 歳未満の医療分・支援分均等割を 5割減額」
  // 対象人数 = under18 - 未就学児（負値防止のため max(0, ...)）。介護分には適用しない。
  // schoolReduction.enabled が true でない自治体は schoolReductionMedical/Support = 0 → 既存挙動完全維持。
  // 未就学児は必ず 18 歳未満なので、under18 は preschool を下限にする。
  //   旧実装は under18 を省略すると未就学児にも子ども・子育て支援金分の均等割が課されていた（2026-11-09・S1-2 F1）。
  const u18Safe = Math.min(Math.max(under18 || 0, preschoolSafe), familySafe);
  const schoolSafe = Math.max(u18Safe - preschoolSafe, 0);
  // 実際の減額計算は「軽減判定」で reductionRate が確定した後に行う（未就学児軽減と同じ）。

  // 軽減判定
  // 特定同一世帯所属者（後期高齢者医療へ移って国保の資格を失い、そのまま同じ世帯にいる人）の数。
  //   5割・2割の基準額は「被保険者の数と特定同一世帯所属者の数の合計数」に掛ける。所得は呼び出し側が
  //   reductionJudgmentIncome に入れる（国民健康保険法施行令 第29条の7 第6項第1号・第3号）
  //   [確認済 2026-10-25 e-Gov 法令API・2026-08-01 施行時点]。均等割・平等割の人数には入れない。
  const tokuteiSafe = Math.max(Math.floor(Number(tokuteiDouitsuCount) || 0), 0);
  const judgedPersons = family + tokuteiSafe;
  // ② salaryPensionCount > family 対策：世帯主等の人数を上限として clamp。
  //   給与所得者等の数は「世帯主並びに…被保険者及び特定同一世帯所属者」（世帯主等）のうちで数える
  //   （国民健康保険法施行令 第29条の7 第6項第1号）。国保に入っていない世帯主（擬制世帯主）も入るので、
  //   giseiSetainushi: true のときは上限に 1 を足す（2026-10-25・全方向試算 B-3）。
  const earnerCap = familySafe + tokuteiSafe + (giseiSetainushi ? 1 : 0);
  const B = Math.max(Math.min(salaryPensionCount || 0, earnerCap || 1), 1);
  const salaryPensionAdd = data.reduction?.salaryPensionAdd || 0;
  const extraForIncomeEarners = salaryPensionAdd * Math.max(0, B - 1);

  const sevenTenthsLimit =
    (data.reduction?.standards?.sevenTenths?.base || 0) +
    ((data.reduction?.standards?.sevenTenths?.perPersonAdd || 0) * judgedPersons) +
    extraForIncomeEarners;

  const fiveTenthsLimit =
    (data.reduction?.standards?.fiveTenths?.base || 0) +
    ((data.reduction?.standards?.fiveTenths?.perPersonAdd || 0) * judgedPersons) +
    extraForIncomeEarners;

  const twoTenthsLimit =
    (data.reduction?.standards?.twoTenths?.base || 0) +
    ((data.reduction?.standards?.twoTenths?.perPersonAdd || 0) * judgedPersons) +
    extraForIncomeEarners;

  let reductionLabel = "軽減なし";
  let reductionRate  = 0;

  if (reductionBase <= sevenTenthsLimit) {
    reductionLabel = "7割軽減";
    reductionRate  = data.reduction?.ratios?.sevenTenths || 0;
  } else if (reductionBase <= fiveTenthsLimit) {
    reductionLabel = "5割軽減";
    reductionRate  = data.reduction?.ratios?.fiveTenths || 0;
  } else if (reductionBase <= twoTenthsLimit) {
    reductionLabel = "2割軽減";
    reductionRate  = data.reduction?.ratios?.twoTenths || 0;
  }

  // 未就学児軽減（均等割の医療分・支援分）
  // 制度: 法定軽減（7/5/2割）が適用される世帯では「軽減後の均等割額」の5割を軽減する。
  //   例) 7割軽減世帯 → 残り3割の5割(=1.5割)を軽減 → 合計8.5割軽減。
  // よって未就学児分の per-capita に (1 - reductionRate) を乗じた残額へ軽減率を適用する。
  // reductionRate=0（軽減なし）のときは (1-0)=1 で従来式と一致（後方互換）。
  const preschoolReductionMedical = Math.round(
    preschoolSafe * data.perCapita.medical * (1 - reductionRate) * (data.preschoolReduction?.medicalPerCapitaRate || 0)
  );
  const preschoolReductionSupport = Math.round(
    preschoolSafe * data.perCapita.support * (1 - reductionRate) * (data.preschoolReduction?.supportPerCapitaRate || 0)
  );
  const preschoolReduction = preschoolReductionMedical + preschoolReductionSupport;

  // 学齢児軽減（自治体独自）
  // 法定軽減（7/5/2割）が適用される世帯では「軽減後の均等割額」に対して独自減額率を掛ける。
  //   例) 7割軽減世帯 × 独自5割 → 残り3割の5割(=1.5割)を軽減 → 合計8.5割軽減。
  //   例) 7割軽減世帯 × 独自10割 → 残り3割を全部軽減 → 当該児の均等割は0円。
  // 乗算なので「法定が先か独自が先か」で結果は変わらない。
  // (1 - reductionRate) を掛けないと軽減率+独自率が100%を超え、他の被保険者分まで
  //   食いつぶして区分合計が0円に張り付く（旧実装の不具合）。
  const schoolReductionMedical = data.schoolReduction?.enabled ? Math.round(
    schoolSafe * data.perCapita.medical * (1 - reductionRate) * (data.schoolReduction?.medicalPerCapitaRate || 0)
  ) : 0;
  const schoolReductionSupport = data.schoolReduction?.enabled ? Math.round(
    schoolSafe * data.perCapita.support * (1 - reductionRate) * (data.schoolReduction?.supportPerCapitaRate || 0)
  ) : 0;
  const schoolReduction = schoolReductionMedical + schoolReductionSupport;

  // 子ども・子育て支援金分（R8新設・0なら無効）
  // childcareLevy（旧方式・under18Reduction/perCapitaAdult 対応）を優先、
  // なければ migration 後の data.childcare（フラット: rate/perCapita/household）を使う。
  const childcareCfg        = data.childcareLevy || data.childcare;
  const childcareRate       = childcareCfg?.rate      || 0;
  const childcarePerCapita  = childcareCfg?.perCapita || 0;
  const childcareHousehold  = tokuteiAdj(childcareCfg?.household || 0);
  const childcareIncome     = childcareRate > 0 ? incomeLevy(baseIncome, childcareRate, "childcare") : 0;

  // 均等割の計算
  // 新方式(perCapitaAdult あり):
  //   18歳以上 → perCapita + perCapitaAdult（例: 京都市 1,110 + 60 = 1,170円）
  //   18歳未満 → 0（under18Reductionで全額減額）
  // 旧方式(perCapitaAdult なし、under18Reduction: true):
  //   18歳以上 → perCapita のみ（例: 練馬区 1,873円）
  //   18歳未満 → 0
  const u18    = u18Safe;   // preschool を下限にした 18 歳未満の人数（上で正規化済み）
  const adults = familySafe - u18;
  let childcarePerCapitaTotal;
  if (childcareCfg?.perCapitaAdult !== undefined) {
    // perCapitaAdultScope で均等割の計算方式を切り替える（電話確認後にフラグを確定）
    //   "all_ages"    : 大人 = perCapita + perCapitaAdult、18歳未満 = 0
    //                     （「全員に perCapita 適用」ではない。18歳未満は下の adults 計算から除外される。
    //                       2026-08-30: この記述が実装と食い違っており、条例照合で誤読の原因になった）
    //   "adults_only" : 大人のみ perCapitaAdult、perCapita は 18歳未満向け名目額（全額減額で実質0）
    const scope = childcareCfg.perCapitaAdultScope;
    if (scope === undefined) {
      throw new Error(`[kokuho] ${data.citySlug}: perCapitaAdult が定義されていますが perCapitaAdultScope がありません。"all_ages" または "adults_only" を設定してください。`);
    }
    if (scope === 'adults_only') {
      childcarePerCapitaTotal = adults * (childcareCfg.perCapitaAdult || 0);
    } else {
      childcarePerCapitaTotal = adults * (childcarePerCapita + (childcareCfg.perCapitaAdult || 0));
    }
  } else {
    // 旧形式（perCapitaAdult 未定義）: 国制度上、子ども・子育て支援金分の均等割は
    // 18歳未満が全額軽減（10割減免）のため、デフォルトで 18歳未満を除外する。
    // （旧実装は under18Reduction: true 明示時のみ除外しており、フラグなしの
    //   旧形式 childcareLevy 1,449自治体で18歳未満からも徴収する計算誤りがあった）
    const under18Excluded = childcarePerCapita > 0 ? u18 : 0;
    childcarePerCapitaTotal = (family - under18Excluded) * childcarePerCapita;
  }
  const childcareHouseholdTotal = childcareRate > 0 ? childcareHousehold : 0;

  // 軽減額（均等割＋平等割に適用）
  const medicalReduction   = Math.round((medicalPerCapita  + medicalHousehold)             * reductionRate);
  const supportReduction   = Math.round((supportPerCapita  + supportHousehold)             * reductionRate);
  const careReduction      = Math.round((carePerCapita     + careHousehold)                * reductionRate);
  const childcareReduction = Math.round((childcarePerCapitaTotal + childcareHouseholdTotal) * reductionRate);

  // 区分別合計
  let medicalTotal   = medicalIncome  + medicalPerCapita        + medicalHousehold         + assetLevyMedical - preschoolReductionMedical - schoolReductionMedical - medicalReduction;
  let supportTotal   = supportIncome  + supportPerCapita        + supportHousehold         + assetLevySupport - preschoolReductionSupport - schoolReductionSupport - supportReduction;
  let careTotal      = careIncome     + carePerCapita           + careHousehold            + assetLevyCare    - careReduction;
  let childcareTotal = childcareIncome + childcarePerCapitaTotal + childcareHouseholdTotal + assetLevyChildcare - childcareReduction;

  medicalTotal   = Math.min(Math.max(medicalTotal,   0), data.caps.medical);
  supportTotal   = Math.min(Math.max(supportTotal,   0), data.caps.support);
  careTotal      = Math.min(Math.max(careTotal,      0), data.caps.care);
  // 支援金分の cap は自治体データが正。未定義なら国基準で代用するが、
  // 静かに落とさず警告する（cap 未定義は 2026-07-02 時点で 114 自治体）。
  let childcareCap = childcareCfg?.cap;
  if (childcareCap === undefined) {
    childcareCap = CHILDCARE_CAP_NATIONAL;
    if (childcareTotal > 0 && typeof console !== "undefined") {
      console.warn(`[kokuho] ${data.citySlug || "(citySlug不明)"}: childcareLevy.cap がデータ未定義のため国基準 ${CHILDCARE_CAP_NATIONAL} 円で代用（条例値の確認・データ整備が必要）`);
    }
  }
  childcareTotal = Math.min(Math.max(childcareTotal, 0), childcareCap);

  // 区分ごとの端数（限度額で頭打ちにした後に切り捨てる。限度額は単位の倍数なので順序で結果は変わらない）。
  const rd = data.rounding || {};
  const where = data.citySlug || "(citySlug不明)";
  const checkUnit = (u, name) => {
    if (!COMPONENT_UNITS.includes(u)) throw new RangeError(`[kokuho] ${where}: rounding.${name} は ${COMPONENT_UNITS.join("/")} のいずれか（${String(u)}）`);
    return u;
  };
  const cu = rd.componentUnit ?? DEFAULT_COMPONENT_UNIT;
  const unitOf = {};
  for (const k of COMPONENT_KEYS) {
    unitOf[k] = checkUnit(typeof cu === "object" && cu !== null ? (cu[k] ?? DEFAULT_COMPONENT_UNIT) : cu, `componentUnit${typeof cu === "object" ? "." + k : ""}`);
  }
  const dropBelow = rd.componentDropBelow ?? 0;
  if (!Number.isFinite(dropBelow) || dropBelow < 0) throw new RangeError(`[kokuho] ${where}: rounding.componentDropBelow は 0 以上の数（${String(dropBelow)}）`);
  const totalUnit = checkUnit(rd.totalUnit ?? 1, "totalUnit");
  const floorTo = (v, u) => Math.floor(v / u) * u;
  const roundComponent = (v, k) => {
    const f = floorTo(v, unitOf[k]);
    return unitOf[k] > 1 && f < dropBelow ? 0 : f;   // 全額切捨ては単位で切り捨てる区分だけ（千葉市の子ども分は対象外）
  };
  medicalTotal   = roundComponent(medicalTotal, "medical");
  supportTotal   = roundComponent(supportTotal, "support");
  careTotal      = roundComponent(careTotal, "care");
  childcareTotal = roundComponent(childcareTotal, "childcare");

  const total          = floorTo(medicalTotal + supportTotal + careTotal + childcareTotal, totalUnit);
  const monthly        = Math.round(total / 12);
  const totalReduction = medicalReduction + supportReduction + careReduction + childcareReduction;
  const assetLevyTotal = assetLevyMedical + assetLevySupport + assetLevyCare + assetLevyChildcare;

  return {
    medicalTotal, supportTotal, careTotal, childcareTotal,
    total, monthly,
    preschoolReduction, schoolReduction, totalReduction,
    reductionLabel, assetLevyTotal,
  };
}

// 特定世帯の区分を年齢から推定する（75歳で国保から後期へ移ったとみなす）。
//   75〜79歳＝移ってから5年以内（特定世帯）、80〜82歳＝その後3年間（特定継続世帯）、それ以外は null。
//   誕生月によっては境目の年に1年ずれることがある。
function tokuteiSetaiKubunFromAge(age) {
  if (!Number.isFinite(age) || age < 75) return null;
  if (age <= 79) return 'tokutei';
  if (age <= 82) return 'keizoku';
  return null;
}

if (typeof module !== 'undefined') module.exports = { calculateKokuho, tokuteiSetaiKubunFromAge };
