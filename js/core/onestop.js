// ふるさと納税ワンストップ特例の判定（純粋関数）
//
// 対象: 2026年中の寄附（data/national/furusato-onestop-2026.json）。
// 要件・期限・無効になる条件はすべてデータから読む。このファイルに制度値を埋めない。
//
// 根拠（データの meta.source）: 地方税法 附則第7条
//   第2項・第9項  申請できるのは、申請する自治体の数が 5 以下と見込まれる場合
//   第4項・第11項 氏名・住所の変更届は翌年1月10日まで
//   第5項・第12項 自治体は翌年1月31日までに住所地の市区町村へ通知書を送る
//   第6項・第13項 確定申告（還付申告を含む）・住民税申告・5団体超・住所地の相違 → 申請はなかったものとみなす
//
// 入力:
//   shinkoku       'no' | 'yes' | 'unknown'  確定申告をする予定か
//   municipalities 寄附先の自治体数（同じ自治体は 1 と数える）。null なら未入力
//   reasons        shinkoku が 'unknown' のときのチェック { salaryOver20m: bool, ... }（data.needShinkokuReasons の key）
//   donation       寄附額の合計（任意・円）。回収の説明に使うだけで判定には使わない
// 戻り値:
//   { verdict: 'onestop' | 'shinkoku' | 'over5' | 'need-input', reasons: [...], ... }

function judgeOnestop(input, data) {
  const inp = input || {};
  const shinkoku = inp.shinkoku || 'unknown';
  // 寄附先の自治体数は 0 以上の整数（数で渡す）。0 は未入力と同じく「入れてください」に回す。
  //   数でない値（' ' を含む）・NaN・負の数・小数は例外。上限を超える大きさ（Infinity を含む）は5団体超として判定する
  //   （2026-11-03 全方向試算 C149。旧は Number() で ' ' が 0 になり、0・負・NaN でもワンストップ可と返していた）
  const mv = inp.municipalities;
  if (!(mv === null || mv === undefined || mv === '')) {
    if (typeof mv !== 'number') throw new TypeError(`municipalities は数で渡してください（${String(mv)}）`);
    if (Number.isNaN(mv) || mv < 0 || (Number.isFinite(mv) && !Number.isInteger(mv))) {
      throw new RangeError(`municipalities が範囲外です（${String(mv)}）`);
    }
  }
  const n = (mv === null || mv === undefined || mv === '' || mv === 0) ? null : mv;
  const reasons = inp.reasons || {};
  const max = data.maxMunicipalities;

  // 確定申告の有無を決める（「わからない」はチェックから推定）
  let mustFile = null;             // true: 確定申告が必要（または予定）、false: 不要、null: 判定不能
  const why = [];
  if (shinkoku === 'yes') { mustFile = true; why.push('確定申告をする予定'); }
  else if (shinkoku === 'no') { mustFile = false; }
  else {
    const hit = (data.needShinkokuReasons || []).filter(r => reasons[r.key]);
    if (hit.length) { mustFile = true; hit.forEach(r => why.push(r.text)); }
    else { mustFile = false; why.push('確定申告が必要になる項目に当てはまらない'); }
  }

  const base = {
    maxMunicipalities: max,
    municipalities: n,
    mustFile,
    reasons: why,
    deadlines: {
      application: data.applicationDeadlinePractice,
      changeNotice: data.changeNoticeDeadline,
      notice: data.noticeDeadline,
    },
    invalidatedWhen: data.invalidatedWhen,
    recovery: data.recovery,
    donation: Number(inp.donation) > 0 ? Number(inp.donation) : null,
    estimatedFromChecklist: shinkoku === 'unknown',
  };

  if (mustFile) {
    return Object.assign(base, { verdict: 'shinkoku',
      headline: '確定申告で寄附金控除を受けます（ワンストップ特例は使えません）',
      detail: '確定申告をすると、出していたワンストップ特例の申請はすべて無効になります。寄附金受領証明書をもとに、確定申告書の寄附金控除にすべての寄附を記載してください。' });
  }
  if (n === null) {
    return Object.assign(base, { verdict: 'need-input', headline: '寄附先の自治体数を入れてください', detail: '' });
  }
  if (n > max) {
    return Object.assign(base, { verdict: 'over5',
      headline: `寄附先が${max}団体を超えるため、確定申告が必要です`,
      detail: `ワンストップ特例は申請する自治体が${max}団体以内のときだけ使えます。${max}団体を超えると、出していた申請はすべて無効になります。寄附先を${max}団体以内に絞るか、確定申告で寄附金控除を受けてください。` });
  }
  return Object.assign(base, { verdict: 'onestop',
    headline: 'ワンストップ特例が使えます（確定申告は不要）',
    detail: `寄附先が${max}団体以内で、確定申告をしないので、寄附のたびに申請書を出せば、控除の全額が翌年度の住民税から引かれます。` });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { judgeOnestop };
}
