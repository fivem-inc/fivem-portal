// 「削除の記録」（管理画面 → 受理済みの変更のタブのいちばん下・2026-10-23 ユーザー確定 案A・2026-10-26 修正依頼のタブから移した）。
// 休暇・残業・勤務変更・交通費の申請を［削除］したときに DB のトリガーが残した記録（application_deletion_log）を新しい順に出す。
// 🚨 読めるのは管理者だけ（RLS）。記録はトリガーだけが書き、画面からは書き換えも削除もできない。
//    3年より古い記録は毎月 cron が消す。消す処理は lib/deleteApplication（理由は必須）
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { isOvertimeType, typeLabelFor } from '../../lib/overtimeTypes';
import { SHIFT_TYPE_INFO, type ShiftAppType } from '../../lib/shiftReportTypes';
import { formatLeaveDateSummary } from '../../lib/notifications';
import { TOGGLE_BLUE } from '../../lib/buttonStyles';
import LoadFailedNotice from '../LoadFailedNotice';
import { NOTICE_LOAD_FAILED_TEXT } from '../../lib/netFailure';
import { statusLabel } from '../../lib/applicationStatus';

type Kind = 'leave' | 'overtime' | 'shift' | 'expense';
interface LogRow {
  id: string; kind: Kind; record_id: string; applicant_id: string | null; target_date: string | null; status: string | null;
  deleted_by: string | null; deleted_at: string; reason: string | null;
  snapshot: { record?: Record<string, unknown>; segments?: { phase: string; seg_no: number; start_min: number; end_min: number }[] };
}

const KIND_LABEL: Record<Kind, string> = { leave: '休暇', overtime: '残業', shift: '勤務変更', expense: '交通費' };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const md = (d: string | null | undefined) => {
  if (!d) return '';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return `${m}/${dd}（${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`;
};
const at = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 何の申請か（1行）。消す前の中身から作る */
function titleOf(r: LogRow): string {
  const rec = r.snapshot.record ?? {};
  if (r.kind === 'leave') {
    const t = str(rec.leave_type) === 'その他' ? (str(rec.leave_type_other) || 'その他') : str(rec.leave_type);
    return `${t}　${formatLeaveDateSummary(str(rec.leave_dates) || null, str(rec.start_date) || null, str(rec.end_date) || null, '')}`;
  }
  if (r.kind === 'overtime') {
    const types = (Array.isArray(rec.application_types) ? rec.application_types : []).filter((t): t is string => typeof t === 'string').filter(isOvertimeType);
    return `${types.map(t => typeLabelFor(t, rec as never)).join('・') || '残業'}　${md(r.target_date)}`;
  }
  if (r.kind === 'shift') {
    const ts = (Array.isArray(rec.application_types) && rec.application_types.length ? rec.application_types : [rec.application_type]) as ShiftAppType[];
    return `${ts.map(t => SHIFT_TYPE_INFO[t]?.label ?? String(t)).join('＋')}　${md(r.target_date)}`;
  }
  const items = Array.isArray(rec.expenses_data) ? rec.expenses_data as Record<string, unknown>[] : [];
  const total = items.reduce((a, x) => a + (Number(str(x.amount).replace(/[^\d]/g, '')) || 0), 0);
  return `交通費　${items.length}件・${total.toLocaleString()}円　申請日 ${md(str(rec.created_at))}`;
}

/** 消す前の中身（開いたときに出す）。見出しと値の組 */
function detailOf(r: LogRow): [string, string][] {
  const rec = r.snapshot.record ?? {};
  const rows: [string, string][] = [];
  const add = (k: string, v: unknown) => { const s = str(v).trim(); if (s) rows.push([k, s]); };
  if (r.kind === 'overtime') {
    const segs = (r.snapshot.segments ?? []).filter(s => s.phase !== 'plan');
    if (segs.length) add('時間帯', segs.map(s => `${hm(s.start_min)}〜${hm(s.end_min)}`).join('・'));
    if (typeof rec.diff_minutes === 'number') add('差分', `${rec.diff_minutes < 0 ? '−' : '+'}${hm(Math.abs(rec.diff_minutes))}`);
    add('勤務地', rec.location);
  }
  if (r.kind === 'shift') {
    add('変更前', [str(rec.original_start), str(rec.original_end)].filter(Boolean).join('〜'));
    add('変更後', [str(rec.actual_start), str(rec.actual_end)].filter(Boolean).join('〜'));
  }
  if (r.kind === 'expense') {
    const items = Array.isArray(rec.expenses_data) ? rec.expenses_data as Record<string, unknown>[] : [];
    items.forEach((x, i) => add(`明細${i + 1}`, `${str(x.start_date)} ${str(x.from_station)}→${str(x.to_station)} ${str(x.amount)}円`));
  }
  add('理由（申請）', rec.reason);
  add('出した日', rec.created_at ? at(str(rec.created_at)) : '');
  return rows;
}

const DeletionLogSection: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#2b3035' : '#fff';
  const [rows, setRows] = useState<LogRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('application_deletion_log')
      .select('id, kind, record_id, applicant_id, target_date, status, deleted_by, deleted_at, reason, snapshot')
      .order('deleted_at', { ascending: false }).limit(300);
    if (error) { console.error('[削除の記録] 読み込みに失敗:', error.message); setFailed(true); setLoaded(true); return; }
    const list = (data ?? []) as LogRow[];
    const ids = [...new Set(list.flatMap(r => [r.applicant_id, r.deleted_by]).filter((x): x is string => !!x))];
    const map: Record<string, string> = {};
    if (ids.length) {
      const { data: profs, error: pErr } = await supabase.from('profiles').select('id, name').in('id', ids);
      if (pErr) console.error('[削除の記録] 名前を読めませんでした:', pErr.message);
      for (const p of (profs ?? []) as { id: string; name: string | null }[]) map[p.id] = p.name || '不明';
    }
    setRows(list); setNames(map); setFailed(false); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = kind === 'all' ? rows : rows.filter(r => r.kind === kind);
  const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 12, borderRadius: 14, padding: '3px 10px', cursor: 'pointer',
    border: `1px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : sub,
  });

  return (
    <div style={{ marginTop: 28, borderTop: `1px solid ${border}`, paddingTop: 16 }}>
      <h3 style={{ color: text, margin: '0 0 4px' }}>削除の記録</h3>
      <p style={{ fontSize: 12.5, color: sub, margin: '0 0 8px', lineHeight: 1.6 }}>
        休暇・残業・勤務変更・交通費の申請を［削除］したときの記録です。消した人・日時・理由と、消す前の内容が残ります（管理者だけが見られます）。2026年10月23日より前に消したものは記録がありません。
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {(['all', 'leave', 'overtime', 'shift', 'expense'] as const).map(k => (
          <button key={k} type="button" style={chip(kind === k)} onClick={() => setKind(k)}>{k === 'all' ? 'すべて' : KIND_LABEL[k]}</button>
        ))}
      </div>
      {failed && <LoadFailedNotice text={NOTICE_LOAD_FAILED_TEXT.replace('お知らせ', '削除の記録')} onRetry={() => { setFailed(false); void load(); }} />}
      {loaded && !failed && shown.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: sub, fontSize: 13 }}>削除の記録はありません</div>
      )}
      {shown.map(r => {
        const open = openIds.has(r.id);
        const who = r.applicant_id ? (names[r.applicant_id] ?? '不明') : '不明';
        const by = r.deleted_by ? (names[r.deleted_by] ?? '不明') : '（自動）';
        return (
          <div key={r.id} style={{ border: `1px solid ${border}`, borderLeft: '4px solid #6c757d', borderRadius: '0 10px 10px 0', padding: '10px 14px', marginTop: 8, fontSize: 13, lineHeight: 1.8, background: cardBg, color: text }}>
            <span style={{ display: 'inline-block', fontSize: 11, borderRadius: 6, padding: '1px 7px', marginRight: 6, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#f8f9fa' : '#495057', fontWeight: 'bold' }}>{KIND_LABEL[r.kind]}</span>
            <b>{who}さん　{titleOf(r)}</b>{r.status && <span style={{ color: sub }}>（{statusLabel(r.kind, r.status)}）</span>}
            <div>削除：{at(r.deleted_at)}　{by}　／　理由：{r.reason || <span style={{ color: sub }}>（記入なし）</span>}</div>
            <button type="button" onClick={() => setOpenIds(prev => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
              style={{ background: 'none', border: 'none', padding: 0, color: isDark ? '#8ec5f0' : '#1565c0', fontSize: 12, cursor: 'pointer' }}>
              {open ? '閉じる ▲' : '消す前の内容を見る ▼'}
            </button>
            {open && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: text }}>
                {detailOf(r).map(([k, v], i) => (
                  <div key={i} style={{ display: 'flex', gap: 8 }}><span style={{ color: sub, minWidth: 84 }}>{k}</span><span style={{ whiteSpace: 'pre-wrap' }}>{v}</span></div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DeletionLogSection;
