// 勤務変更の［履歴］に出す「カレンダーの予定」（上長が勤怠カレンダーに入れた予定・2026-11-05）
// ・PlanLines … 報告のカードの上に、同じ日の予定を灰色の小さい字で「予定　早退 9:15〜15:00」（予定が2つあれば縦に）
// ・PlanOnlyCard … 予定だけで報告が無い日のカード。状態は lib/shiftReportTodo の classifyEntry 1か所で決める
// 🚨 種類は照合しない（日付だけで報告ありとみなす）。記号（📅 ↳）は付けない＝「予定」「報告」の字で分かる（2体のレビュー）
import React from 'react';
import { ABSENCE_LABEL } from '../lib/attendanceTypes';
import type { CalendarEntry, EntryState } from '../lib/shiftReportTodo';

export interface CalendarEntryRow extends CalendarEntry { id: string }

/** 予定の中身（種類 時刻 校） */
export const planText = (e: CalendarEntry): string => {
  const segs = (Array.isArray(e.work_segments) ? e.work_segments : []).filter(s => s.start && s.end);
  const hm = (t: string) => t.slice(0, 5).replace(/^0/, '');
  const time = segs.length ? `${hm(segs[0].start)}〜${hm(segs[segs.length - 1].end)}` : '';
  const loc = segs.length ? [...new Set(segs.map(s => s.location).filter(Boolean))].join('→') : (e.location ?? '');
  return [ABSENCE_LABEL[e.type] ?? e.type, time, loc].filter(Boolean).join(' ');
};

export const PlanLines: React.FC<{ entries: CalendarEntry[]; isDark: boolean; cancelled?: boolean }> = ({ entries, isDark, cancelled }) => {
  if (entries.length === 0) return null;
  const sub = isDark ? '#adb5bd' : '#888';
  return (
    <div style={{ fontSize: 11, color: sub, marginBottom: 3, lineHeight: 1.6, textAlign: 'left' }}>
      {entries.map((e, i) => <div key={i}>予定　{planText(e)}</div>)}
      {cancelled && <div>報告は取り消し済み（出し直しは管理者へ）</div>}
    </div>
  );
};

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export const PlanOnlyCard: React.FC<{
  date: string;
  dowLabel: string;
  entries: CalendarEntry[];
  state: EntryState;
  isDark: boolean;
  /** 報告のフォームを開く（押しても送らない） */
  onReport?: () => void;
}> = ({ date, dowLabel, entries, state, isDark, onReport }) => {
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#666';
  // 欠勤は前もって報告できる（勤務変更のページの注意書きと同じ決まり）
  const canAdvance = state === 'future' && entries.some(e => e.type === 'absent');
  const chip = (label: string, bg: string, color: string) => (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: bg, color, whiteSpace: 'normal', lineHeight: 1.5 }}>{label}</span>
  );
  const chipEl = state === 'todo' ? chip('まだ報告していません', isDark ? '#5c2b2b' : '#fde2e2', isDark ? '#f5b5b5' : '#a32d2d')
    : state === 'future' ? chip(canAdvance ? 'これからの予定（欠勤は前もって報告できます）' : '報告は当日から', isDark ? '#3d4349' : '#eeeeee', sub)
    : state === 'closed' ? chip('締め切りを過ぎました（担当のリーダー・マネージャーにお知らせください）', isDark ? '#3d4349' : '#eeeeee', sub)
    : null;
  const notes = [...new Set(entries.map(e => (e.notes ?? '').trim()).filter(Boolean))];
  return (
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${isDark ? '#495057' : '#f5f5f5'}`, borderLeft: `4px solid ${isDark ? '#b8860b' : '#f0a020'}`, borderRadius: 0, background: isDark ? '#3d3420' : '#fffaf0', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, textAlign: 'left', boxSizing: 'border-box', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#555', minWidth: 52, flexShrink: 0, marginTop: 2 }}>{md(date)}（{dowLabel}）</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: isDark ? '#f5e3b0' : '#8a5a00' }}>上長が入れたカレンダーの予定</div>
        {entries.map((e, i) => <div key={i} style={{ fontSize: 13.5, fontWeight: 'bold', color: text, marginTop: 2 }}>予定　{planText(e)}</div>)}
        {notes.length > 0 && <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>上長からの連絡：{notes.join('／')}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {chipEl}
          {(state === 'todo' || canAdvance) && onReport && (
            <button type="button" onClick={onReport}
              style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}>
              内容を確認 ›
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
