// 残業の「表でまとめて入力」（PCだけ・試験中）。計画：docs/計画-残業の表入力.md
//
// 🚨 第3段（2026-09-24）：**見るだけ**。給与期間1か月ぶんを1行1日で並べ、その日に何をする日かを出す。
//    入力・送信は第4段・第5段で足す。
// 🚨 シフト・会社カレンダー・自分の申請は、ここで給与期間の日付範囲を指定して自分で読む
//    （ページの一覧は100件で打ち切っている。シフトの型は読み込みの失敗を見ていない）。
//    どれか1つでも読めなければ、はっきりそう出す（全日が「休み」に見えるような黙った誤りを出さない）。
// 🚨 判定は lib/overtimeGrid・lib/overtimeSubmit にある。ここに条件を書き写さないこと。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  calcPayPeriodStartJst, shiftPayPeriod, payMonthPeriodLabel, todayJstStr, advanceRequestMaxDate,
  formatSignedMin, minToTime,
} from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { resolveNormalShift, normalShiftTimeText, reportGateMin } from '../lib/overtimeShift';
import type { PatternRow, NormalShiftSnapshot } from '../lib/overtimeShift';
import { periodDates, pickDayReport, classifyGridDay, GRID_KIND_TAG } from '../lib/overtimeGrid';
import type { GridReport, GridDayKind } from '../lib/overtimeGrid';
import { STATUS_INFO } from '../lib/overtimeStatus';
import { OT_TYPE_INFO, isOvertimeType } from '../lib/overtimeTypes';
import { CALENDAR_CELL_STYLE } from '../hooks/useCompanyCalendar';

interface Props {
  userId: string;
  isDark: boolean;
  onClose: () => void;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const dowOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); };

/** 種類の札の色。🚨 送る種類（事前・事後・実績・再提出）は青の系統、送らないものは灰。新しい色は足さない */
const TAG_STYLE: Record<GridDayKind, 'send' | 'muted' | 'warn'> = {
  new_post: 'send', new_advance: 'send', new_today: 'send', report: 'send', resubmit: 'warn',
  beyond_max: 'muted', report_wait: 'muted', form_only: 'muted', done: 'muted', leave_auto: 'muted',
};

const OvertimeGrid: React.FC<Props> = ({ userId, isDark, onClose }) => {
  const today = todayJstStr();
  const [period, setPeriod] = useState(() => calcPayPeriodStartJst(today));
  const dates = useMemo(() => periodDates(period), [period]);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const [patterns, setPatterns] = useState<PatternRow[] | null>(null);
  const [calendar, setCalendar] = useState<Record<string, CalendarKind> | null>(null);
  const [reports, setReports] = useState<GridReport[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const errs: string[] = [];
    const [patRes, calRes, repRes] = await Promise.all([
      supabase.from('weekly_shift_patterns').select('*').eq('user_id', userId),
      supabase.from('company_calendar').select('date, kind').gte('date', from).lte('date', to),
      supabase.from('overtime_reports')
        .select('id, work_date, status, entry_type, is_post_hoc, application_types, location, diff_minutes, reason, return_comment, reviewer_id, normal_shift, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
        .eq('applicant_id', userId).gte('work_date', from).lte('work_date', to),
    ]);
    // 🚨 1つでも読めなければ null のままにして、表の上に理由を出す（空の配列にしない＝全日「休み」に見えるのを防ぐ）
    if (patRes.error) { errs.push('通常シフト：' + patRes.error.message); setPatterns(null); }
    else setPatterns((patRes.data as PatternRow[] | null) ?? []);
    if (calRes.error) { errs.push('会社カレンダー：' + calRes.error.message); setCalendar(null); }
    else {
      const map: Record<string, CalendarKind> = {};
      ((calRes.data ?? []) as { date: string; kind: CalendarKind }[]).forEach(r => { map[r.date] = r.kind; });
      setCalendar(map);
    }
    if (repRes.error) { errs.push('申請：' + repRes.error.message); setReports(null); }
    else setReports((repRes.data as GridReport[] | null) ?? []);
    setErrors(errs);
    setLoading(false);
  }, [userId, from, to]);

  useEffect(() => { void load(); }, [load]);

  // いまの時刻（今日の行の「実績報告はまだ／できる」に使う）。1分ごとに更新
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  useEffect(() => {
    const t = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60_000);
    return () => clearInterval(t);
  }, []);

  const advanceMaxDate = advanceRequestMaxDate(today);
  const ready = patterns !== null && calendar !== null && reports !== null;

  const rows = useMemo(() => {
    if (!ready) return [];
    return dates.map(date => {
      const ck = calendar![date] ?? null;
      const ns: NormalShiftSnapshot = resolveNormalShift(patterns!, date, ck);
      const { main, leaveAuto } = pickDayReport(reports!.filter(r => r.work_date === date));
      const planned = (main?.segments ?? []).filter(s => s.phase === 'planned');
      const kind = classifyGridDay({
        date, today, nowMin, advanceMaxDate, main, leaveAuto,
        gateMin: main ? reportGateMin(main.normal_shift as NormalShiftSnapshot | null, planned) : null,
      });
      return { date, ck, ns, main, leaveAuto, kind };
    });
  }, [ready, dates, calendar, patterns, reports, today, nowMin, advanceMaxDate]);

  const counts = useMemo(() => {
    const c: Partial<Record<GridDayKind, number>> = {};
    rows.forEach(r => { c[r.kind] = (c[r.kind] ?? 0) + 1; });
    return c;
  }, [rows]);

  // ---- styles（残業ページと同じ配色） ----
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const toggleBlue = '#1976d2';
  const toggleBg = isDark ? '#1e3a5f' : '#e3f2fd';
  const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, color: text, fontSize: 13, cursor: 'pointer' };
  const th: React.CSSProperties = { position: 'sticky', top: 0, background: innerBg, color: subText, fontSize: 12, fontWeight: 'bold', textAlign: 'left', padding: '7px 8px', borderBottom: `2px solid ${borderColor}`, whiteSpace: 'nowrap', zIndex: 1 };
  const td: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${borderColor}`, verticalAlign: 'top', fontSize: 13, color: text };

  const segText = (segs: { start_min: number; end_min: number }[]) =>
    [...segs].sort((a, b) => a.start_min - b.start_min).map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ');
  const typesText = (types: string[] | null) =>
    (types ?? []).filter(isOvertimeType).map(t => OT_TYPE_INFO[t].label).join('・');

  const tag = (k: GridDayKind) => {
    const st = TAG_STYLE[k];
    const style: React.CSSProperties = st === 'send'
      ? { background: toggleBg, color: toggleBlue, border: `1px solid ${toggleBlue}` }
      : st === 'warn'
        ? { background: isDark ? '#4a1515' : '#fdecea', color: isDark ? '#f5b8bb' : '#c62828', border: '1px solid #c62828' }
        : { background: innerBg, color: subText, border: `1px solid ${borderColor}` };
    return <span style={{ ...style, display: 'inline-block', fontSize: 11.5, fontWeight: 'bold', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' }}>{GRID_KIND_TAG[k]}</span>;
  };

  return (
    <div style={{ background: cardBg, border: `1px solid ${borderColor}`, borderRadius: 12, padding: '16px 18px', color: text }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 'bold' }}>📋 表でまとめて入力（試験中）</span>
        <button type="button" style={btn} onClick={() => setPeriod(p => shiftPayPeriod(p, -1))} aria-label="前の給与期間">◀</button>
        <b>{payMonthPeriodLabel(period)}</b>
        <button type="button" style={btn} onClick={() => setPeriod(p => shiftPayPeriod(p, 1))} aria-label="次の給与期間">▶</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>1件ずつのフォームに戻る</button>
      </div>

      <div style={{ background: innerBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: subText, marginBottom: 10, lineHeight: 1.7 }}>
        <b style={{ color: text }}>いまは見るだけです。</b>入力と送信は次の版から使えます。<br />
        ・日付のすぐ右の札が、その日に送れるもの（<b>事後報告</b>＝過ぎた日／<b>事前申請</b>＝先の日／<b>実績報告</b>＝事前申請が済んだ日／<b>再提出</b>＝差し戻された日）です<br />
        ・申請・報告は、これまでどおり1件ずつのフォームからも出せます
      </div>

      {errors.length > 0 && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, color: '#842029' }}>
            <b>読み込めなかったものがあります。この表は正しく表示できません。</b>
            {errors.map(e => <div key={e}>{e}</div>)}
          </div>
          <button type="button" onClick={() => { void load(); }}
            style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
        </div>
      )}

      {loading ? (
        <p style={{ margin: 0, fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
      ) : ready && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            送れる日：事後報告 {counts.new_post ?? 0}・事前申請 {counts.new_advance ?? 0}・今日 {counts.new_today ?? 0}・
            実績報告 {counts.report ?? 0}・再提出 {counts.resubmit ?? 0} ／
            <span style={{ color: subText }}>済み {counts.done ?? 0}・実績報告はまだ {counts.report_wait ?? 0}・フォームで {counts.form_only ?? 0}・休暇から自動 {counts.leave_auto ?? 0}</span>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...th, left: 0, zIndex: 2 }}>日付</th>
                  <th style={th}>種類</th>
                  <th style={th}>通常シフト</th>
                  <th style={th}>この日の状態</th>
                  <th style={th}>時間（予定／実績）</th>
                  <th style={th}>差分・種別</th>
                  <th style={th}>理由・メモ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const dow = dowOf(r.date);
                  const off = r.ns.day_kind === 'holiday' || dow === 0 || dow === 6;
                  const isToday = r.date === today;
                  const rep = r.main ?? r.leaveAuto;
                  const planned = (rep?.segments ?? []).filter(s => s.phase === 'planned');
                  const actual = (rep?.segments ?? []).filter(s => s.phase === 'actual');
                  const st = rep ? STATUS_INFO[rep.status] : null;
                  const muted = TAG_STYLE[r.kind] === 'muted';
                  const rowBg = isToday ? (isDark ? '#1e3a5f33' : '#e3f2fd66') : (muted ? innerBg : undefined);
                  return (
                    <tr key={r.date} style={{ background: rowBg }}>
                      <td style={{ ...td, position: 'sticky', left: 0, background: rowBg ?? cardBg, whiteSpace: 'nowrap', fontWeight: 'bold', color: off ? '#d9534f' : text }}>
                        {md(r.date)}（{DOW[dow]}）
                        {isToday && <div style={{ fontSize: 11, color: toggleBlue }}>今日</div>}
                        {r.ck && <div style={{ fontSize: 11, fontWeight: 'normal', background: CALENDAR_CELL_STYLE[r.ck].bg, color: CALENDAR_CELL_STYLE[r.ck].text, borderRadius: 4, padding: '0 4px', display: 'inline-block' }}>{CALENDAR_CELL_STYLE[r.ck].short}</div>}
                      </td>
                      <td style={td}>{tag(r.kind)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{normalShiftTimeText(r.ns) || <span style={{ color: subText }}>休み</span>}</td>
                      <td style={td}>
                        {st ? (
                          <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 'bold', color: '#fff', background: st.color, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>{st.label}</span>
                        ) : <span style={{ color: subText }}>―</span>}
                        {r.kind === 'report_wait' && isToday && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>勤務が終わるころに報告できます</div>}
                        {r.kind === 'beyond_max' && <div style={{ fontSize: 11.5, color: subText, marginTop: 2 }}>事前申請はまだ出せません</div>}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {planned.length > 0 && <div><span style={{ color: subText, fontSize: 11.5 }}>予定 </span>{segText(planned)}</div>}
                        {actual.length > 0 && <div><span style={{ color: subText, fontSize: 11.5 }}>実績 </span>{segText(actual)}</div>}
                        {!rep && <span style={{ color: subText }}>―</span>}
                      </td>
                      <td style={td}>
                        {rep && rep.diff_minutes != null && (
                          <b style={{ color: rep.diff_minutes > 0 ? '#2e7d32' : rep.diff_minutes < 0 ? '#c62828' : subText }}>{formatSignedMin(rep.diff_minutes)}</b>
                        )}
                        {rep && <div style={{ fontSize: 11.5, color: subText }}>{typesText(rep.application_types)}</div>}
                      </td>
                      <td style={{ ...td, minWidth: 180 }}>
                        {rep?.reason && <div>{rep.reason}</div>}
                        {rep?.status === 'returned' && rep.return_comment && (
                          <div style={{ color: '#c62828', fontWeight: 'bold', fontSize: 12.5, marginTop: 2 }}>差し戻し理由：{rep.return_comment}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default OvertimeGrid;
