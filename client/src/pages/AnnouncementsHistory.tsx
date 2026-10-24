// 過去のお知らせ（/announcements・2026-10-18 ユーザー確定 A・計画 docs/計画-ホームの新着.md）
// ・管理者からのお知らせ（announcements）を、届いた日・確認した日・掲載期限つきで並べる。押すと本文が開く
// ・並び：いちばん上に「掲載期限が切れたのに、まだ確認していないもの」（ホームから消えて、ここでしか読めない）、その下は新しい順。
//   掲載中でまだ確認していないものには「ホームに出ています」
// ・確認した日は home_acks（ann:◯◯:n／:r のうち早いほう・自分の行だけ読める）。前に端末で ✕ していたものは「確認した日」が無い（記録が無いため）
// 🚨 管理者が取り下げたもの（active=false）は出さない。［確認した］が始まる前（ACK_SINCE より前）に届いたものは「まだ確認していません」を付けない（記録が無いため）
// 🚨 読むのは2本だけ（お知らせ 最新200件・自分の確認の記録）。開いたときに1回

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { backBtn } from '../lib/buttonStyles';
import LoadFailedNotice from '../components/LoadFailedNotice';
import { isNetworkFailure, NOTICE_LOAD_FAILED_TEXT } from '../lib/netFailure';

interface Row { id: string; title: string; body: string; created_at: string; starts_at: string | null; ends_at: string | null; active: boolean }

/** ［確認した］の記録が始まった日（2026-10-19）。これより前に届いたお知らせは、確認したかどうかが分からない */
const ACK_SINCE = new Date('2026-10-19T00:00:00+09:00').getTime();
const md = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const AnnouncementsHistory: React.FC = () => {
  const navigate = useNavigate();
  const isDark = useDarkMode();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [acks, setAcks] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  // 通信のせいで読めなかったとき（2026-10-24・圏外で英語の文が出ていた）。前の一覧は残す・［再読み込み］
  const [netFailed, setNetFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void (async () => {
      const [a, h] = await Promise.all([
        supabase.from('announcements').select('id, title, body, created_at, starts_at, ends_at, active').eq('active', true).order('created_at', { ascending: false }).limit(200),
        supabase.from('home_acks').select('item_key, acked_at').like('item_key', 'ann:%'),
      ]);
      if (a.error) {
        if (isNetworkFailure(a.error)) { setNetFailed(true); setErr(''); return; }
        setNetFailed(false); setErr('読み込めませんでした：' + a.error.message); setRows([]); return;
      }
      setNetFailed(false); setErr('');
      const m = new Map<string, string>();
      for (const r of (h.data ?? []) as { item_key: string; acked_at: string }[]) {
        const id = r.item_key.split(':')[1];
        const prev = m.get(id);
        if (!prev || r.acked_at < prev) m.set(id, r.acked_at);
      }
      setAcks(m);
      // 🚨 まだ始まっていない予約のお知らせは出さない
      const now = Date.now();
      setRows(((a.data ?? []) as Row[]).filter(r => !r.starts_at || new Date(r.starts_at).getTime() <= now));
    })();
  }, [reloadKey]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const now = Date.now();
    const ended = (r: Row) => !!r.ends_at && new Date(r.ends_at).getTime() < now;
    const tracked = (r: Row) => new Date(r.starts_at ?? r.created_at).getTime() >= ACK_SINCE;
    const missed = (r: Row) => ended(r) && tracked(r) && !acks.has(r.id);
    return [...rows].sort((x, y) => (Number(missed(y)) - Number(missed(x))) || (new Date(y.starts_at ?? y.created_at).getTime() - new Date(x.starts_at ?? x.created_at).getTime()));
  }, [rows, acks]);

  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const card = isDark ? '#2b3035' : '#fff';
  const tag = (label: string, bg: string, fg: string) => (
    <span style={{ display: 'inline-block', fontSize: 11, padding: '1px 8px', borderRadius: 10, background: bg, color: fg, marginLeft: 6, verticalAlign: 'middle' }}>{label}</span>
  );

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '12px 16px 40px', color: text }}>
      <button type="button" onClick={() => navigate(-1)} style={{ ...backBtn(isDark), padding: '6px 14px', fontSize: 13, marginBottom: 12 }}>← 戻る</button>
      <h2 style={{ fontSize: 18, margin: '0 0 6px' }}>📢 過去のお知らせ</h2>
      <p style={{ fontSize: 12.5, color: sub, margin: '0 0 12px', lineHeight: 1.7 }}>
        管理者からのお知らせの一覧です。押すと本文が開きます。掲載期限が切れたのにまだ確認していないものを、いちばん上に出しています。
      </p>
      {netFailed && <LoadFailedNotice text={NOTICE_LOAD_FAILED_TEXT} onRetry={() => setReloadKey(k => k + 1)} />}
      {err && <p style={{ color: '#842029', background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>{err}</p>}
      {rows === null && !netFailed && <p style={{ color: sub, fontSize: 13 }}>読み込み中…</p>}
      {rows !== null && sorted.length === 0 && !err && !netFailed && <p style={{ color: sub, fontSize: 13 }}>お知らせはありません。</p>}
      <div style={{ background: card, border: `1px solid ${border}`, borderRadius: 12, overflow: 'hidden' }}>
        {sorted.map((r, i) => {
          const now = Date.now();
          const ended = !!r.ends_at && new Date(r.ends_at).getTime() < now;
          const tracked = new Date(r.starts_at ?? r.created_at).getTime() >= ACK_SINCE;
          const ackAt = acks.get(r.id) ?? null;
          const isOpen = open === r.id;
          return (
            <div key={r.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${border}` }}>
              <button type="button" onClick={() => setOpen(isOpen ? null : r.id)}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 14px', cursor: 'pointer', color: text }}>
                <div style={{ fontSize: 14, fontWeight: 'bold', lineHeight: 1.5 }}>
                  {r.title}
                  {!ackAt && !tracked && !ended && tag('ホームに出ています', '#e7f1ff', '#084298')}
                  {ended ? tag('掲載終了', isDark ? '#495057' : '#e9ecef', isDark ? '#dee2e6' : '#495057') : tag('掲載中', '#e7f1ff', '#084298')}
                  {!ackAt && tracked && (ended ? tag('まだ確認していません', '#fff3cd', '#856404') : tag('ホームに出ています', '#e7f1ff', '#084298'))}
                </div>
                <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>
                  届いた日 {md(r.starts_at ?? r.created_at)}{'　'}確認した日 {ackAt ? md(ackAt) : '—'}{'　'}掲載 {r.ends_at ? `${md(r.ends_at)}まで` : '期限なし'}
                  <span style={{ marginLeft: 8 }}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>
              {isOpen && (
                <div style={{ padding: '0 14px 12px', fontSize: 13.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: text }}>{r.body}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AnnouncementsHistory;
