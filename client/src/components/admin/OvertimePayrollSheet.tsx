import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import SearchableSelect from '../common/SearchableSelect';
import { backBtn } from '../../lib/buttonStyles';
import { calcPayPeriodStartJst, payPeriodEnd, payMonthLabel, payPeriodLabel, todayJstStr, formatMin, minToTime } from '../../lib/breakCalc';
import type { CalendarKind } from '../../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText, type PatternRow, type NormalShiftSnapshot } from '../../lib/overtimeShift';
import { CALENDAR_CELL_STYLE } from '../../hooks/useCompanyCalendar';
import { computeBalance, duplicateChoseiChecker, type BalanceRow } from '../../lib/overtimeBalance';
import { overtimeApprovedLines } from '../../lib/overtimeApproved';
import { compareEmployeeNo } from '../../lib/employeeNo';
import { onRowPick, pickedRowBg } from '../../lib/rowPick';
import { isOvertimeType, typeLabelFor } from '../../lib/overtimeTypes';

/**
 * 残業の［表で見る］（2026-10-21 ユーザー確定・docs/計画-残業の表で見る.md）。
 * 給与計算で見ていた人ごとのスプレッドシートと同じ形：1人ずつ・給与の期の1日1行・従業員番号の順。
 * ・合計は行の足し算ではなく computeBalance（残業の画面・部門集計と同じ数字）。行の時間数はその内訳
 * ・受理済み（confirmed）は普通に。確認待ち（requested・reported）・実績報告待ち（request_confirmed）は灰色で合計に入れない。
 *   差し戻し・取消は出さない
 * ・休暇から自動で作られた行（leave_auto）も出す（合計に入っているため）。同じ日の手で出した調整休は「休暇の側で計上」
 * ・申請がある日の通常シフトは申請に控えたもの（差分はこれで計算されている）。無い日は残業の画面と同じ決まり（resolveNormalShift）
 * 🚨 読めなかったときに「休み」や 0:00 と出さない（給与に効く表で嘘をつかない）
 */

type Status = BalanceRow['status'];
interface Seg { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }
interface Rep {
  id: string; applicant_id: string; reviewer_id: string | null; work_date: string; entry_type: string; status: Status;
  pay_period_start: string; normal_shift: NormalShiftSnapshot | null; diff_minutes: number | null; reason: string | null;
  application_types: string[] | null; confirmed_by: string | null; confirmed_at: string | null; request_confirmed_at: string | null;
  late_situation: string | null; early_situation: string | null; created_at: string | null;
  segments: Seg[] | null; hist: { change_kind: string | null }[] | null;
}
interface DayCheck { id: string; user_id: string; work_date: string; shift_snapshot: NormalShiftSnapshot | null }
interface Staff { id: string; name: string; employee_no: string | null; is_active: boolean; hire_date: string | null; retire_date: string | null }

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dowOf = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const addDay = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + 1)); return t.toISOString().slice(0, 10); };
/** 元の表と同じ書き方：プラスは符号なし、マイナスは半角の「-」 */
const hm = (min: number) => (min < 0 ? `-${formatMin(min)}` : formatMin(min));

async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await make(off, off + 999);
    if (error) return { rows, error: error.message };
    const list = (data as T[] | null) ?? [];
    rows.push(...list);
    if (list.length < 1000) break;
  }
  return { rows, error: null };
}

interface Loaded {
  staff: Staff[]; reps: Rep[]; checks: DayCheck[]; patterns: PatternRow[];
  calendar: Record<string, CalendarKind>; furikae: Map<string, string>; names: Record<string, string>;
}

const OvertimePayrollSheet: React.FC<{
  isDarkMode: boolean;
  initialPeriod?: string;
  initialPerson?: string;
  onBack: () => void;
}> = ({ isDarkMode, initialPeriod, initialPerson, onBack }) => {
  const isDark = isDarkMode;
  const text = isDark ? '#e9ecef' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const headBg = isDark ? '#343a40' : '#f6f6f6';
  const cardBg = isDark ? '#212529' : '#fff';
  const gray = isDark ? '#8a929a' : '#9aa0a6';

  const currentPeriod = calcPayPeriodStartJst(todayJstStr());
  const periodOptions = useMemo(() => {
    const out: string[] = [];
    let p = calcPayPeriodStartJst(addDay(payPeriodEnd(currentPeriod))); // 次の期も選べる（先の事前申請を見るため）
    for (let i = 0; i < 14; i++) {
      out.push(p);
      const [y, m] = p.split('-').map(Number);
      const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
      p = `${py}-${String(pm).padStart(2, '0')}-16`;
    }
    if (initialPeriod && !out.includes(initialPeriod)) out.push(initialPeriod);
    return out;
  }, [currentPeriod, initialPeriod]);
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [personId, setPersonId] = useState<string | null>(initialPerson ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const [openReason, setOpenReason] = useState<Set<string>>(new Set());

  const end = payPeriodEnd(period);
  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    const [staffRes, repRes, dcRes, patRes, calRes, furRes] = await Promise.all([
      readAll<Staff>((a, b) => supabase.from('profiles').select('id, name, employee_no, is_active, hire_date, retire_date').eq('employment_type', '正社員').order('id').range(a, b)),
      readAll<Rep>((a, b) => supabase.from('overtime_reports')
        .select('id, applicant_id, reviewer_id, work_date, entry_type, status, pay_period_start, normal_shift, diff_minutes, reason, application_types, confirmed_by, confirmed_at, request_confirmed_at, late_situation, early_situation, created_at, segments:overtime_report_segments(phase, seg_no, start_min, end_min), hist:overtime_report_history(change_kind)')
        .eq('pay_period_start', period).order('id').range(a, b)),
      readAll<DayCheck>((a, b) => supabase.from('overtime_day_checks').select('id, user_id, work_date, shift_snapshot').gte('work_date', period).lte('work_date', end).order('id').range(a, b)),
      readAll<PatternRow>((a, b) => supabase.from('weekly_shift_patterns').select('*').order('id').range(a, b)),
      readAll<{ date: string; kind: CalendarKind }>((a, b) => supabase.from('company_calendar').select('date, kind').gte('date', period).lte('date', end).order('date').range(a, b)),
      readAll<{ applicant_id: string; work_date: string; furikae_origin_date: string | null }>((a, b) => supabase.from('overtime_reports')
        .select('applicant_id, work_date, furikae_origin_date').eq('entry_type', 'manual').neq('status', 'cancelled')
        .contains('application_types', ['furikae_off']).gte('furikae_origin_date', period).lte('furikae_origin_date', end).order('id').range(a, b)),
    ]);
    const errs = [
      staffRes.error && 'スタッフ：' + staffRes.error, repRes.error && '申請：' + repRes.error, dcRes.error && '定時の記録：' + dcRes.error,
      patRes.error && '通常シフト：' + patRes.error, calRes.error && '会社カレンダー：' + calRes.error, furRes.error && '振替休日：' + furRes.error,
    ].filter(Boolean);
    if (errs.length) { setLoadErr('読み込めませんでした（' + errs.join('／') + '）。通信環境の良い場所で、もう一度開いてください。'); setData(null); setLoading(false); return; }
    const names: Record<string, string> = Object.fromEntries(staffRes.rows.map(s => [s.id, s.name]));
    const others = [...new Set(repRes.rows.flatMap(r => [r.reviewer_id, r.confirmed_by]).filter((x): x is string => !!x && !names[x]))];
    if (others.length) {
      const { data: p } = await supabase.from('profiles').select('id, name').in('id', others);
      ((p ?? []) as { id: string; name: string }[]).forEach(x => { names[x.id] = x.name; });
    }
    const calendar: Record<string, CalendarKind> = {};
    calRes.rows.forEach(c => { calendar[c.date] = c.kind; });
    const furikae = new Map<string, string>();
    furRes.rows.forEach(f => { if (f.furikae_origin_date) furikae.set(`${f.applicant_id}|${f.furikae_origin_date}`, f.work_date); });
    setData({ staff: staffRes.rows, reps: repRes.rows, checks: dcRes.rows, patterns: patRes.rows, calendar, furikae, names });
    setLoading(false);
  }, [period, end]);
  useEffect(() => { load(); }, [load]);

  // 表に出す人：在籍の正社員（通常シフトがある人）＋この期に申請がある人（途中で退職した人も）。従業員番号の順（番号の無い人は最後）
  const people = useMemo(() => {
    if (!data) return [];
    const withReps = new Set(data.reps.map(r => r.applicant_id));
    // 🚨 通常シフト（曜日パターン）が1つも無い在籍者は出さない（管理者・Q&A 用などの仕事用ではないアカウント）
    const withPattern = new Set(data.patterns.map(p => p.user_id));
    return data.staff
      .filter(s => withReps.has(s.id) || (s.is_active && withPattern.has(s.id) && (!s.hire_date || s.hire_date <= end) && (!s.retire_date || s.retire_date >= period)))
      .sort((a, b) => compareEmployeeNo(a.employee_no, a.name, b.employee_no, b.name));
  }, [data, period, end]);
  const idx = Math.max(0, people.findIndex(p => p.id === personId));
  const person = people[idx] ?? null;
  useEffect(() => { if (people.length && (!personId || !people.some(p => p.id === personId))) setPersonId(people[0].id); }, [people, personId]);
  const go = useCallback((d: number) => {
    const n = people[idx + d];
    if (n) { setPersonId(n.id); setPicked(null); setOpenReason(new Set()); }
  }, [people, idx]);
  // ←／→ で前の人・次の人（探す欄・期の選択に入力しているときは動かさない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const sheet = useMemo(() => {
    if (!data || !person) return null;
    const reps = data.reps.filter(r => r.applicant_id === person.id && r.status !== 'returned' && r.status !== 'cancelled');
    const balance = computeBalance(data.reps.filter(r => r.applicant_id === person.id) as BalanceRow[], period);
    const isDup = duplicateChoseiChecker(reps.filter(r => r.status === 'confirmed'));
    const pats = data.patterns.filter(p => p.user_id === person.id);
    const checks = data.checks.filter(c => c.user_id === person.id);
    const pending = reps.filter(r => r.status !== 'confirmed').length;
    const days: string[] = [];
    for (let d = period; d <= end; d = addDay(d)) days.push(d);
    return { reps, balance, isDup, pats, checks, pending, days };
  }, [data, person, period, end]);

  const nameOf = (id: string) => data?.names[id] || '不明';
  const sel: React.CSSProperties = { padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13 };
  const navBtn = (disabled: boolean): React.CSSProperties => ({ ...backBtn(isDark), padding: '5px 12px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: 1, color: disabled ? gray : undefined });
  const th: React.CSSProperties = { padding: '6px 4px', border: `1px solid ${border}`, background: headBg, color: text, fontWeight: 'normal', fontSize: 12, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 6px', borderTop: `1px solid ${border}`, borderLeft: `1px solid ${border}`, fontSize: 12.5, color: text, verticalAlign: 'top' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" onClick={onBack} style={{ ...backBtn(isDark), padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>← 一覧に戻る</button>
        <select value={period} onChange={e => { setPeriod(e.target.value); setPicked(null); }} style={sel}>
          {periodOptions.map(p => <option key={p} value={p}>{payPeriodEnd(p).slice(0, 4)}年{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
        </select>
      </div>

      {loadErr ? (
        <div style={{ padding: 10, background: isDark ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDark ? '#fca5a5' : '#842029', fontSize: 13 }}>
          {loadErr} <button type="button" onClick={load} style={{ ...backBtn(isDark), padding: '3px 10px', borderRadius: 6, fontSize: 12, marginLeft: 6, cursor: 'pointer' }}>再読み込み</button>
        </div>
      ) : loading || !data ? (
        <p style={{ color: sub, fontSize: 13 }}>読み込み中...</p>
      ) : !person || !sheet ? (
        <p style={{ color: sub, fontSize: 13 }}>この期間に表示できる方がいません</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => go(-1)} disabled={idx === 0} style={navBtn(idx === 0)}>◀ 前の人</button>
            <SearchableSelect value={person.id} isDarkMode={isDark} onChange={v => { if (v !== 'all') { setPersonId(v); setPicked(null); setOpenReason(new Set()); } }}
              options={people.map(p => [p.id, `${p.employee_no ?? '番号なし'} ${p.name}`] as [string, string])} />
            <button type="button" onClick={() => go(1)} disabled={idx >= people.length - 1} style={navBtn(idx >= people.length - 1)}>次の人 ▶</button>
            <span style={{ fontSize: 12, color: sub }}>{idx + 1} / {people.length}人（←→ キーでも移れます）</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 16px', padding: '8px 12px', marginBottom: 8, borderRadius: 8, background: isDark ? '#3a2a33' : '#fde8ee', border: `1px solid ${border}`, color: text }}>
            <span style={{ fontSize: 13, color: sub }}>{person.employee_no ?? '番号なし'}</span>
            <span style={{ fontSize: 16, fontWeight: 'bold' }}>{person.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 14 }}>
              合計時間 → <b style={{ fontSize: 17, color: sheet.balance.total < 0 ? '#c62828' : text }}>{hm(sheet.balance.total)}</b>
            </span>
            <span style={{ width: '100%', fontSize: 11.5, color: sub, textAlign: 'right' }}>確認待ち・実績報告待ちは合計に入っていません{sheet.balance.absenceDays > 0 ? `／欠勤 ${sheet.balance.absenceDays}日` : ''}</span>
          </div>
          {!person.employee_no && (
            <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>従業員番号が登録されていない方です（管理画面の「👤 ユーザー」で登録できます）</div>
          )}
          {sheet.pending > 0 && (
            <div style={{ fontSize: 13, color: '#856404', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '6px 12px', marginBottom: 8 }}>
              確認待ち・実績報告待ちが{sheet.pending}件あります。受理され、実績が確定すると合計に入ります。
            </div>
          )}
          {sheet.reps.length === 0 && sheet.checks.length === 0 && (
            <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>この期間の残業・時間調整の申請はありません</div>
          )}

          <div style={{ overflowX: 'auto', border: `1px solid ${border}`, borderRadius: 8, background: cardBg }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 780, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 52 }} /><col style={{ width: 32 }} /><col style={{ width: 110 }} /><col style={{ width: 92 }} />
                <col /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 72 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...th, position: 'sticky', left: 0, zIndex: 2 }}>日付</th>
                  <th style={{ ...th, position: 'sticky', left: 52, zIndex: 2 }}></th>
                  <th style={th}>通常シフト時間</th><th style={th}>労働時間(休憩)</th><th style={th}>理由</th>
                  <th style={th}>確認サイン</th><th style={th}>変更(実務)シフト時間</th><th style={th}>時間数</th>
                </tr>
              </thead>
              <tbody>
                {sheet.days.map(d => {
                  const dow = dowOf(d);
                  const dayColor = dow === 6 ? (isDark ? '#8fc5f6' : '#1565c0') : dow === 0 ? (isDark ? '#f1aeb5' : '#c62828') : text;
                  const employed = (!person.hire_date || d >= person.hire_date) && (!person.retire_date || d <= person.retire_date);
                  const dayReps = sheet.reps.filter(r => r.work_date === d)
                    .sort((a, b) => (a.entry_type === b.entry_type ? String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) : a.entry_type === 'manual' ? -1 : 1));
                  const dayChecks = sheet.checks.filter(c => c.work_date === d);
                  const snap = dayReps.find(r => r.entry_type === 'manual' && r.normal_shift)?.normal_shift ?? dayChecks[0]?.shift_snapshot ?? null;
                  const cal = data.calendar[d] ?? null;
                  const ns = snap ?? (employed ? resolveNormalShift(sheet.pats, d, cal) : null);
                  const nsText = ns ? normalShiftTimeText(ns) : '';
                  const offLabel = !employed && !snap ? '—' : cal === 'closed_all' ? CALENDAR_CELL_STYLE.closed_all.short : '休み';
                  const furikaeTo = data.furikae.get(`${person.id}|${d}`);
                  type Entry = { key: string; reason: string; sign: string; actual: string; time: string; muted: boolean; strike: boolean; timeColor?: string };
                  const entries: Entry[] = [
                    ...dayReps.map((r): Entry => {
                      const pendingLabel = r.status === 'request_confirmed' ? '（実績報告待ち）' : r.status === 'confirmed' ? '' : '（確認待ち）';
                      const dup = r.status === 'confirmed' && sheet.isDup(r);
                      const segs = (r.segments ?? []);
                      const usePhase = segs.some(s => s.phase === 'actual') ? 'actual' : 'planned';
                      const actual = segs.filter(s => s.phase === usePhase).sort((a, b) => a.seg_no - b.seg_no).map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ');
                      const typeText = (r.application_types ?? []).filter(isOvertimeType).map(t => typeLabelFor(t, r)).join('・');
                      const sign = r.entry_type === 'leave_auto' ? '自動（休暇から）'
                        : pendingLabel || overtimeApprovedLines(r, nameOf).map(l => (l.label === '確定' ? `確定：${l.name}` : l.name)).join('／');
                      const diff = r.diff_minutes ?? 0;
                      return {
                        key: r.id,
                        reason: r.reason?.trim() || typeText || (r.entry_type === 'leave_auto' ? '休暇（自動）' : ''),
                        sign: dup ? '（休暇の側で計上）' : sign,
                        actual,
                        time: r.status === 'confirmed' ? hm(diff) : `（${hm(diff)}）`,
                        muted: r.status !== 'confirmed' || dup,
                        strike: dup,
                        timeColor: r.status === 'confirmed' && !dup && diff < 0 ? '#c62828' : undefined,
                      };
                    }),
                    ...dayChecks.map((c): Entry => ({ key: `dc-${c.id}`, reason: '定時', sign: '定時', actual: '', time: '0:00', muted: false, strike: false })),
                  ];
                  if (furikaeTo) entries.unshift({ key: `fk-${d}`, reason: `振替元（${md(furikaeTo)}の振替休日で計上）`, sign: '', actual: '', time: '', muted: true, strike: false });
                  if (entries.length === 0) entries.push({ key: `none-${d}`, reason: '', sign: '', actual: '', time: '', muted: false, strike: false });
                  return entries.map((en, i) => {
                    const rowKey = `${d}|${en.key}`;
                    const pickedNow = picked === rowKey;
                    const rowBg = pickedNow ? pickedRowBg(isDark) : cardBg;
                    const first = i === 0;
                    const cellTop = first ? `1px solid ${border}` : `1px dotted ${border}`;
                    const c = (extra?: React.CSSProperties): React.CSSProperties => ({ ...td, borderTop: cellTop, background: rowBg, ...extra });
                    const mutedColor = en.muted ? gray : text;
                    const reasonOpen = openReason.has(rowKey);
                    return (
                      <tr key={rowKey} onClick={e => onRowPick(e, rowKey, picked, setPicked)} style={{ cursor: 'pointer' }}>
                        <td style={c({ position: 'sticky', left: 0, zIndex: 1, textAlign: 'center', color: dayColor, borderLeft: 'none' })}>{first ? md(d) : ''}</td>
                        <td style={c({ position: 'sticky', left: 52, zIndex: 1, textAlign: 'center', color: dayColor })}>{first ? DOW[dow] : ''}</td>
                        <td style={c({ textAlign: 'center', color: nsText ? text : gray })}>
                          {first ? (nsText ? nsText.split(' / ').map((t, k) => <div key={k}>{t}</div>) : offLabel) : ''}
                        </td>
                        <td style={c({ textAlign: 'center', color: nsText ? text : gray })}>
                          {first ? (nsText && ns ? `${formatMin(ns.labor_minutes)}(${formatMin(ns.break_minutes)})` : '-') : ''}
                        </td>
                        <td style={c({ color: mutedColor, textDecoration: en.strike ? 'line-through' : undefined })}
                          onClick={() => setOpenReason(prev => { const n = new Set(prev); if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey); return n; })}>
                          <div style={reasonOpen ? { whiteSpace: 'pre-wrap' } : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{en.reason}</div>
                        </td>
                        <td style={c({ color: mutedColor, fontSize: 11.5 })}>{en.sign}</td>
                        <td style={c({ textAlign: 'center', color: mutedColor })}>{en.actual}</td>
                        <td style={c({ textAlign: 'right', color: en.timeColor ?? mutedColor, fontVariantNumeric: 'tabular-nums', textDecoration: en.strike ? 'line-through' : undefined })}>{en.time}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: sub, marginTop: 6 }}>
            行を押すと色が付きます（もう一度押すと消えます）。理由が長いときは、押すと全文が出ます。理由が空の申請は、種別（残業・早出など）を出しています。
          </div>
        </>
      )}
    </div>
  );
};

export default OvertimePayrollSheet;
