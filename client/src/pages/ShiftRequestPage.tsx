import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { actedAtLabel } from '../lib/actedAt';
import { useDarkMode } from '../hooks/useDarkMode';

// ───────────────────────────────────────────────────────────────
// 出勤のお願い（パート用の返事ページ・/shift-request）
//
// 設計は docs/計画-シフト調整.md の「5. パートへの依頼」。
// 🚨 パートは勤怠カレンダーも調整の場も**開けない**ので、返事は専用のページにする。
// 🚨 中身は `shift_adjust_my_part_requests()`（SECURITY DEFINER）が返す。
//    **誰の代わりかは返ってこない**（休んだ人の名前・休暇の種類は相手に見せない決まり）。
// 🚨 権限で塞がない。自分あてのものしか返らないので、塞ぐ必要がない
//    （塞ぐと、パートの役職に権限を足す話になり、かえって間違えやすい）。
// ───────────────────────────────────────────────────────────────

interface Row {
  id: string;
  target_date: string;
  segments: { start: string; end: string; location?: string }[] | null;
  location: string | null;
  due_at: string | null;
  answer: string | null;
  answered_at: string | null;
  picked: boolean;
  decided: boolean;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dateLabel = (d: string): string => {
  const [y, m, dd] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return `${y}年${m}月${dd}日（${DOW[w]}）`;
};

const ShiftRequestPage: React.FC = () => {
  const isDark = useDarkMode();
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const cardBg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#e0e0e0';

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    // 🚨 error を必ず見る。読めないまま「0件」と出すと、届いているのに気づけない
    const { data, error } = await supabase.rpc('shift_adjust_my_part_requests');
    setLoading(false);
    if (error) { setErr('読み込めませんでした：' + error.message); return; }
    setRows((data as Row[] | null) ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const answer = async (id: string, v: 'yes' | 'no') => {
    setErr(''); setBusyId(id);
    const { data, error } = await supabase.rpc('shift_adjust_answer_part_request',
      { p_request_id: id, p_answer: v });
    setBusyId(null);
    // 🚨 rpc は 4xx でも throw しない。error と ok の両方を見る
    if (error) { setErr('送信できませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '送信できませんでした'); return; }
    void load();
  };

  const btn = (active: boolean): React.CSSProperties => ({
    padding: '12px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 'bold',
    border: `1px solid ${active ? '#1976d2' : border}`,
    background: active ? '#1976d2' : (isDark ? '#495057' : '#f8f9fa'),
    color: active ? '#fff' : text,
  });

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ margin: '28px 0 16px', fontSize: 20, fontWeight: 800, color: text, lineHeight: 1.2 }}>
        📅 出勤のお願い
      </h1>

      <div style={{
        background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8,
        padding: '12px 14px', marginBottom: 16,
      }}>
        <p style={{ margin: 0, fontSize: 13, color: '#664d03', lineHeight: 1.8 }}>
          この日に出勤できるかを教えてください。
          <br />
          「入れます」と答えても、担当が決まるまでは確定ではありません。
        </p>
      </div>

      {err && (
        <p style={{ margin: '0 0 12px', padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: '#f8d7da', color: '#842029' }}>{err}</p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: subText }}>読み込んでいます…</p>
      ) : rows.length === 0 ? (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, padding: 18 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: subText, lineHeight: 1.8 }}>
            いまお願いしている日はありません。
          </p>
        </div>
      ) : rows.map(r => {
        const band = (r.segments ?? []).map(s => `${s.start}〜${s.end}`).join(' ＋ ');
        const overdue = !!r.due_at && new Date(r.due_at).getTime() < Date.now();
        return (
          <div key={r.id} style={{
            background: cardBg, borderRadius: 12, border: `1px solid ${border}`,
            padding: 18, marginBottom: 12,
          }}>
            <div style={{ fontSize: 17, fontWeight: 'bold', color: text }}>{dateLabel(r.target_date)}</div>
            <div style={{ fontSize: 14, color: text, marginTop: 6 }}>
              {band || '時間帯の指定なし'}
              {r.location && <span style={{ marginLeft: 10, color: subText }}>{r.location}</span>}
            </div>
            {r.due_at && (
              <div style={{ fontSize: 12, color: subText, marginTop: 6 }}>
                返事の期限：{actedAtLabel(r.due_at)}
                {overdue && !r.answer && <span style={{ marginLeft: 8 }}>（過ぎています。いまからでも答えられます）</span>}
              </div>
            )}

            {/* 決まったあと・決まる前で言い方を変える（🚨 「埋まりました」は使わない・ユーザー確定） */}
            {r.decided ? (
              <p style={{ margin: '12px 0 0', fontSize: 13.5, color: text, lineHeight: 1.8 }}>
                {r.picked
                  ? 'この日はあなたに出勤していただくことになりました。よろしくお願いします。'
                  : 'この日の担当は決定しました。ご返事ありがとうございました。'}
              </p>
            ) : r.answer ? (
              <>
                <p style={{ margin: '12px 0 0', fontSize: 13.5, color: text }}>
                  ご返事：{r.answer === 'yes' ? '入れます' : '入れません'}
                  {r.answered_at && <span style={{ color: subText, marginLeft: 8, fontSize: 12 }}>{actedAtLabel(r.answered_at)}</span>}
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 12.5, color: subText }}>現在調整中です。</p>
                <button onClick={() => void answer(r.id, r.answer === 'yes' ? 'no' : 'yes')}
                  disabled={busyId === r.id}
                  style={{ marginTop: 10, background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 12.5, color: isDark ? '#64b5f6' : '#0d6efd', textDecoration: 'underline', padding: 0 }}>
                  {r.answer === 'yes' ? '「入れません」に変える' : '「入れます」に変える'}
                </button>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                <button onClick={() => void answer(r.id, 'yes')} disabled={busyId === r.id} style={btn(true)}>
                  入れます
                </button>
                <button onClick={() => void answer(r.id, 'no')} disabled={busyId === r.id} style={btn(false)}>
                  入れません
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ShiftRequestPage;
