import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { loadDraft, DRAFT_KEYS } from '../lib/draftStorage';
import TimeInput from './TimeInput';
import { DateField } from './common/DateField';
import { formatSignedMin, formatMin, payMonthPeriodLabel, payPeriodEnd, calcPayPeriodStartJst } from '../lib/breakCalc';
import { buildTimeAdjustReport, resolveNormalShift, fullDayDiffMin, buildWorkDiff, normalShiftTimeText } from '../lib/overtimeShift';
import { timeToMin, calcTotalBreak } from '../lib/breakCalc';
import type { PatternRow } from '../lib/overtimeShift';
import type { CalendarKind, WorkSegment } from '../lib/breakCalc';

// 「残業の調整案（自分用）」（2026-09-09 ユーザー確定）。
//
// 目的：残業が +10時間あるとき、どこで調整できるかを **申請する前に** 自分で組んで
// 見込みを確かめる。申請してしまうと受理のやり直しが要るため、その手前の置き場を作る。
//
// 🚨 本人だけが見る。上長には見せない（RLS も本人だけ）。
// 🚨 差分の計算は lib/overtimeShift の関数だけを使う。ここに式を書かない
//    （申請フォーム・上長の提案と同じものを使う。3つ目を作ると必ず食い違う）。
// 🚨 合計時間数カードと同じ期を見る。数字の出どころを分けない。

type Kind = 'late_start_adj' | 'early_end_adj' | 'chosei_off' | 'overtime';

const KIND_LABEL: Record<Kind, string> = {
  late_start_adj: '遅出（出勤を遅く）',
  early_end_adj: '早退（退勤を早く）',
  chosei_off: '時間外調整休（1日）',
  overtime: '残業（増やす）',
};

interface PlanRow {
  id: string;
  work_date: string;
  kind: Kind;
  adjust_time: string | null;
  start_time: string | null;
  end_time: string | null;
  diff_minutes: number;
  break_minutes: number | null;
  note: string | null;
}

interface Props {
  userId: string;
  /** 合計時間数カードで選んでいる期。ここと必ず同じものを見る */
  period: string;
  /** その期の確定合計（分） */
  confirmedTotal: number;
  /** その期の見込みの増分（申請中・受理済み・報告済み。分） */
  plannedDelta: number;
  patterns: PatternRow[];
  calendarKinds: Record<string, CalendarKind>;
  isDark: boolean;
  /** 1件を申請フォームへ持っていく。親が下書きに入れてフォームを開く。
   *  🚨 ここで申請そのものはしない。理由・申請先は本人がフォームで入れる（検証を素通りさせない） */
  onApply: (plan: {
    kind: Kind; work_date: string; adjust_time: string | null;
    start_time: string | null; end_time: string | null;
    break_minutes: number | null; note: string | null;
  }) => void;
}

const OvertimePlanSection: React.FC<Props> = ({
  userId, period, confirmedTotal, plannedDelta, patterns, calendarKinds, isDark, onApply,
}) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  // 追加中の1件（保存を押すまでDBに書かない）
  const [draftKind, setDraftKind] = useState<Kind>('late_start_adj');
  const [draftDate, setDraftDate] = useState('');
  const [draftTime, setDraftTime] = useState('');
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  const [draftNote, setDraftNote] = useState('');
  // 休憩の手修正。空 = 自動計算（申請フォームと同じ考え方）
  const [draftBreak, setDraftBreak] = useState('');
  const [draftBreakManual, setDraftBreakManual] = useState(false);
  const [saving, setSaving] = useState(false);
  // 書きかけの申請があるとき、置き換えてよいか聞く相手の行
  const [askReplaceId, setAskReplaceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('overtime_plan_items')
      .select('id, work_date, kind, adjust_time, start_time, end_time, diff_minutes, break_minutes, note')
      .eq('user_id', userId)
      .eq('pay_period_start', period)
      .order('work_date');
    setLoading(false);
    // 🚨 読めなかったときは空で上書きしない（「案が無い」と嘘をつくため）
    if (error) { setErr('調整案を読み込めませんでした：' + error.message); return; }
    setErr('');
    setRows((data ?? []) as PlanRow[]);
  }, [userId, period]);

  useEffect(() => { if (open) load(); }, [open, load]);

  /**
   * 1件の差分を、いまのシフトで計算し直す。
   * 🚨 保存してある diff_minutes は「組んだ時点の控え」。シフトが変わると実際は変わるので、
   *    表示はいつもこの計算を使う（保存値をそのまま出すと、古い数字を見せることになる）。
   */
  // 🚨 計算できないときは 0 ではなく null を返す。入力の途中（「9:3」など）で 0:00 と出すと、
  //    「計算した結果が0分」と読めてしまう（2026-09-09 実機指摘）。
  const calcDiff = useCallback((r: { kind: Kind; work_date: string; adjust_time: string | null; start_time: string | null; end_time: string | null; break_minutes?: number | null }): number | null => {
    const ck = calendarKinds[r.work_date] ?? null;
    if (r.kind === 'late_start_adj' || r.kind === 'early_end_adj') {
      if (!r.adjust_time || timeToMin(r.adjust_time.slice(0, 5)) == null) return null;
      const built = buildTimeAdjustReport(
        patterns, r.work_date, ck,
        r.kind === 'late_start_adj' ? 'late_start' : 'early_end',
        r.adjust_time.slice(0, 5),
      );
      return built.ok ? built.diff_minutes : null;
    }
    const ns = resolveNormalShift(patterns, r.work_date, ck);
    if (r.kind === 'chosei_off') return fullDayDiffMin('chosei_off', ns);
    // 残業：入れた時間帯から労働を出して、通常シフトとの差を取る
    const st = timeToMin((r.start_time ?? '').slice(0, 5));
    let en = timeToMin((r.end_time ?? '').slice(0, 5));
    if (st == null || en == null) return null;
    if (en <= st) en += 1440;
    const segs: WorkSegment[] = [{ startMin: st, endMin: en }];
    // 🚨 休憩は手修正があればそれを使う（イベントの日は普段と休憩の取り方が違う・2026-09-09 ユーザー指摘）。
    //    申請フォームと同じ扱い（手修正が無ければ自動計算）
    return buildWorkDiff(segs, ns, r.break_minutes ?? null).diff_minutes;
  }, [patterns, calendarKinds]);

  // 選んだ日の通常シフト。🚨 種類にかかわらず必ず出す（2026-09-09 ユーザー指示）。
  //    これが無いと「見込みがなぜその値か」「なぜ計算できないのか」が分からない。
  const draftShift = useMemo(
    () => (draftDate ? resolveNormalShift(patterns, draftDate, calendarKinds[draftDate] ?? null) : null),
    [draftDate, patterns, calendarKinds],
  );
  /** 入力中の残業の、自動計算の休憩（分）。時間帯が入っていないときは null */
  const draftAuto = useMemo(() => {
    if (draftKind !== 'overtime') return null;
    const st = timeToMin(draftStart); let en = timeToMin(draftEnd);
    if (st == null || en == null) return null;
    if (en <= st) en += 1440;
    return calcTotalBreak([{ startMin: st, endMin: en }]);
  }, [draftKind, draftStart, draftEnd]);

  /** その日にシフトがあるか（無い日は遅出・早退・調整休が使えない） */
  const draftHasShift = !!draftShift && draftShift.labor_minutes > 0 && !!draftShift.start_time;

  const planDelta = useMemo(() => rows.reduce((s, r) => s + (calcDiff(r) ?? 0), 0), [rows, calcDiff]);
  const draftDiff = useMemo(() => {
    if (!draftDate) return 0;
    return calcDiff({
      kind: draftKind, work_date: draftDate,
      adjust_time: draftTime || null, start_time: draftStart || null, end_time: draftEnd || null,
      break_minutes: draftBreakManual ? (parseInt(draftBreak, 10) || 0) : null,
    });
  }, [draftKind, draftDate, draftTime, draftStart, draftEnd, draftBreakManual, draftBreak, calcDiff]);

  const add = async () => {
    setErr('');
    if (!draftDate) { setErr('日付を選んでください'); return; }
    if ((draftKind === 'late_start_adj' || draftKind === 'early_end_adj') && !draftTime) {
      setErr('時刻を入れてください'); return;
    }
    if (draftKind === 'overtime' && (!draftStart || !draftEnd)) {
      setErr('勤務の開始と終了を入れてください'); return;
    }
    // 🚨 その日が選んでいる期からはみ出していないか（別の期の案が混ざると合計が合わない）
    if (calcPayPeriodStartJst(draftDate) !== period) {
      setErr('この期間（' + payMonthPeriodLabel(period) + '）の日付を選んでください'); return;
    }
    setSaving(true);
    const { error } = await supabase.from('overtime_plan_items').insert({
      user_id: userId,
      pay_period_start: period,
      work_date: draftDate,
      kind: draftKind,
      adjust_time: (draftKind === 'late_start_adj' || draftKind === 'early_end_adj') ? draftTime : null,
      start_time: draftKind === 'overtime' ? draftStart : null,
      end_time: draftKind === 'overtime' ? draftEnd : null,
      diff_minutes: draftDiff ?? 0,
      break_minutes: draftBreakManual ? (parseInt(draftBreak, 10) || 0) : null,
      note: draftNote.trim() || null,
    });
    setSaving(false);
    if (error) {
      // 🚨 「通信を確認してください」で握りつぶさない。同じ日が2件になる場合は理由を分かる言葉にする
      setErr(error.code === '23505'
        ? 'その日はすでに調整案に入っています（1日に1つまで）'
        : '保存できませんでした：' + error.message);
      return;
    }
    setDraftDate(''); setDraftTime(''); setDraftStart(''); setDraftEnd(''); setDraftNote('');
    setDraftBreak(''); setDraftBreakManual(false);
    load();
  };

  const remove = async (id: string) => {
    setErr('');
    // 🚨 delete は0件でもエラーにならない。件数を見る
    const { data, error } = await supabase.from('overtime_plan_items').delete().eq('id', id).select('id');
    if (error) { setErr('消せませんでした：' + error.message); return; }
    if (!data || data.length === 0) { setErr('消せませんでした（すでに消えている可能性があります）'); load(); return; }
    setRows(prev => prev.filter(r => r.id !== id));
  };

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 14, fontSize: 12, fontWeight: 'bold', cursor: 'pointer',
    border: `1px solid ${on ? '#4a90d9' : border}`,
    background: on ? '#e8f4fd' : 'transparent',
    color: on ? '#1565c0' : subText,
  });

  const expected = confirmedTotal + plannedDelta + planDelta;

  return (
    <div style={{ marginBottom: 8 }}>
      {/* 🚨 ライト・ダーク共通の固定色（配色の決まり 🎨🔒）。isDark で切り替えない。
          ダークで暗くすると文字が沈んで読めなくなるため（2026-09-09 ユーザー指示）。
          緑は管理画面の見出しと同じ #E8F5E9 / #2E7D32 / #1B5E20（新しい色は足していない）。
          🚨 この画面の他の色と意味がぶつからないものを選んだ：
             橙＝やることがある／青＝選択・情報／紫＝勤務地変更／赤＝エラー。緑だけが空いていた。 */}
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '11px 14px', cursor: 'pointer',
          // 🚨 左だけの線なので角丸は付けない（片側だけの枠と角丸は合わない）
          border: 'none', borderLeft: '3px solid #2E7D32', borderRadius: 0,
          background: '#E8F5E9',
          color: '#1B5E20',
          fontSize: 13, fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
        <span>残業の調整案（自分用）・{payMonthPeriodLabel(period)}{rows.length > 0 && ` ${rows.length}件`}</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 10, background: innerBg, border: `1px solid ${border}` }}>
          <p style={{ margin: '0 0 10px', fontSize: 11.5, color: subText, lineHeight: 1.7 }}>
            申請する前に、どこで調整できるかを組んで見込みを確かめられます。<br />
            <b style={{ color: text }}>ここに入れただけでは申請されません</b>。上長にも見えません。<br />
            先の期間の案も作れます（上の <b style={{ color: text }}>‹ ›</b> で期間を切り替えてから足してください）。
          </p>

          {/* 予想合計。数字の出どころは合計時間数カードと同じ */}
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, fontSize: 12, color: subText, marginBottom: 10 }}>
            <span>いまの確定 <b style={{ color: text }}>{formatSignedMin(confirmedTotal)}</b></span>
            <span>申請済みの見込み <b style={{ color: text }}>{formatSignedMin(confirmedTotal + plannedDelta)}</b></span>
            <span>この案を入れると <b style={{ color: expected === 0 ? '#1e8449' : text, fontSize: 14 }}>{formatSignedMin(expected)}</b></span>
          </div>

          {err && (
            <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
              background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
          )}

          {/* いま入っている案 */}
          {loading ? (
            <p style={{ margin: '0 0 10px', fontSize: 12, color: subText }}>読み込んでいます…</p>
          ) : rows.length === 0 ? (
            <p style={{ margin: '0 0 10px', fontSize: 12, color: subText }}>まだ案がありません。下から足せます。</p>
          ) : (
            <div style={{ marginBottom: 10 }}>
              {rows.map(r => {
                const d = calcDiff(r);
                return (
                  <div key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 0', fontSize: 12.5, color: text }}>
                    <span style={{ fontWeight: 'bold' }}>{r.work_date.slice(5).replace('-', '/')}</span>
                    <span>{KIND_LABEL[r.kind]}</span>
                    <span style={{ color: subText }}>
                      {r.adjust_time ? r.adjust_time.slice(0, 5) : ''}
                      {r.start_time && r.end_time ? `${r.start_time.slice(0, 5)}〜${r.end_time.slice(0, 5)}` : ''}
                    </span>
                    <span style={{ marginLeft: 'auto', fontWeight: 'bold' }}>{d == null ? '—' : formatSignedMin(d)}</span>
                    {/* 🚨 チェックで複数まとめてではなく、行ごとに1つずつ申請する。
                        申請フォームは1日ぶんしか受け取れないため（2026-09-09） */}
                    <button onClick={() => {
                      // 🚨 書きかけの申請を黙って消さない（連絡板の「コピーして作成」と同じ流儀）
                      const cur = loadDraft<{ date?: string; reason?: string; segments?: { start: string; end: string }[] }>(DRAFT_KEYS.overtime);
                      const has = !!cur && (!!cur.date || !!cur.reason || (cur.segments ?? []).some(x => x.start || x.end));
                      if (has && askReplaceId !== r.id) { setAskReplaceId(r.id); return; }
                      setAskReplaceId(null);
                      onApply(r);
                    }}
                      style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 'bold', cursor: 'pointer', border: 'none', background: '#0d6efd', color: '#fff' }}>
                      申請する
                    </button>
                    <button onClick={() => remove(r.id)}
                      style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
                      消す
                    </button>
                    </div>
                    {askReplaceId === r.id && (
                      <div style={{ margin: '4px 0 8px', padding: '9px 11px', borderRadius: 8, fontSize: 12, lineHeight: 1.7,
                        background: isDark ? '#4a3a1a' : '#fff8e1', border: '1px solid #f0c36d', color: isDark ? '#ffcf8f' : '#b7770d' }}>
                        <p style={{ margin: '0 0 8px' }}>書きかけの申請があります。この案の内容に置き換えますか？</p>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => { setAskReplaceId(null); onApply(r); }}
                            style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>置き換える</button>
                          <button onClick={() => setAskReplaceId(null)}
                            style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1px solid ${border}`, cursor: 'pointer', fontSize: 12, background: 'transparent', color: subText }}>やめる</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 1件足す */}
          <div style={{ borderTop: `1px solid ${border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>調整の案を足す</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {(Object.keys(KIND_LABEL) as Kind[]).map(k => (
                <button key={k} type="button" onClick={() => setDraftKind(k)} style={chip(draftKind === k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <div style={{ marginBottom: 8 }}>
              <DateField value={draftDate} onChange={setDraftDate} isDark={isDark} placeholder="日付を選ぶ"
                minDate={period} maxDate={payPeriodEnd(period)} />
            </div>

            {/* 🚨 選んだ日の通常シフトを必ず出す（2026-09-09 ユーザー指示）。
                これが無いと「何時から何時の勤務を、どう変えるのか」が分からないまま時刻を入れることになる。
                シフトが無い日は、その旨をはっきり出す（見込みが出ない理由がこれ） */}
            {draftDate && (
              draftHasShift ? (
                <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.8,
                  background: isDark ? '#343a40' : '#fff', border: `1px solid ${border}`, color: text }}>
                  <span style={{ color: subText }}>この日の勤務：</span>
                  {normalShiftTimeText(draftShift)}
                  {draftShift?.location && <span style={{ color: subText }}>　{draftShift.location}</span>}
                  <br />
                  <span style={{ color: subText }}>休憩 {formatMin(draftShift?.break_minutes ?? 0)}・労働 {formatMin(draftShift?.labor_minutes ?? 0)}</span>
                </div>
              ) : (
                <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.7,
                  background: isDark ? '#4a3a1a' : '#fff8e1', border: '1px solid #f0c36d', color: isDark ? '#ffcf8f' : '#b7770d' }}>
                  この日はシフトがありません（お休み・休館日など）。<br />
                  {draftKind === 'overtime'
                    ? 'イベントなどで出るときは、そのまま入れられます（働いた時間がまるごとプラスになります）。'
                    : '遅出・早退・調整休は、もとの勤務が無い日には使えません。'}
                </div>
              )
            )}
            {(draftKind === 'late_start_adj' || draftKind === 'early_end_adj') && (
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subText }}>
                  {draftKind === 'late_start_adj' ? '出勤を' : '退勤を'}
                </span>
                <TimeInput value={draftTime} onChange={setDraftTime} isDark={isDark} />
                <span style={{ fontSize: 12, color: subText }}>に</span>
              </div>
            )}
            {draftKind === 'overtime' && (
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <TimeInput value={draftStart} onChange={setDraftStart} isDark={isDark} />
                <span style={{ fontSize: 12, color: subText }}>〜</span>
                <TimeInput value={draftEnd} onChange={setDraftEnd} isDark={isDark} />
              </div>
            )}
            {/* 🚨 イベントの日は休憩の取り方が普段と違う（2026-09-09 ユーザー指摘）。
                申請フォームと同じく、自動計算と手修正を切り替えられるようにする。 */}
            {draftKind === 'overtime' && draftAuto != null && (
              <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: isDark ? '#343a40' : '#fff', border: `1px solid ${border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: text }}>
                  <span style={{ color: subText }}>休憩</span>
                  {draftBreakManual ? (
                    <>
                      <input type="number" inputMode="numeric" min={0} step={1} value={draftBreak}
                        onChange={e => setDraftBreak(e.target.value)}
                        style={{ width: 70, padding: '5px 8px', borderRadius: 6, fontSize: 13, border: `1px solid ${border}`, background: isDark ? '#2b3035' : '#fff', color: text }} />
                      <span>分</span>
                      <button type="button" onClick={() => { setDraftBreakManual(false); setDraftBreak(''); }}
                        style={{ padding: '4px 10px', borderRadius: 10, fontSize: 11, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
                        自動計算に戻す（{formatMin(draftAuto)}）
                      </button>
                    </>
                  ) : (
                    <>
                      <span>{formatMin(draftAuto)}（自動計算）</span>
                      <button type="button" onClick={() => { setDraftBreakManual(true); setDraftBreak(String(draftAuto)); }}
                        style={{ padding: '4px 10px', borderRadius: 10, fontSize: 11, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
                        修正
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            <input value={draftNote} onChange={e => setDraftNote(e.target.value)} placeholder="メモ（任意）"
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13, marginBottom: 8,
                border: `1px solid ${border}`, background: isDark ? '#343a40' : '#fff', color: text, boxSizing: 'border-box' }} />
            {draftDate && (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: subText }}>
                この案の見込み <b style={{ color: text }}>{draftDiff == null ? '—' : formatSignedMin(draftDiff)}</b>
                {/* 🚨 出せない理由を取り違えない。シフトが無い日と、時刻が途中の場合は別のこと */}
                {draftDiff == null && <span style={{ marginLeft: 6 }}>{draftHasShift ? '（時刻を最後まで入れてください）' : '（この日はシフトがありません）'}</span>}
              </p>
            )}
            <button onClick={add} disabled={saving}
              style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
              {saving ? '保存中…' : '案に追加する'}
            </button>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: subText, lineHeight: 1.6 }}>
              各行の「申請する」を押すと、その内容が入った申請フォームが開きます（理由と申請先はご自身で入れてください）。<br />
              {payMonthPeriodLabel(period)}の案は、<b style={{ color: text }}>この期間の締め（支給月17日）を過ぎたら</b>自動で消えます。<br />
              先の期間の案は、その期間の締めまで残ります。
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default OvertimePlanSection;
