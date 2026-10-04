// パスワード変更の依頼：送信予約と履歴（2026-10-04 ユーザー確定）
//
// ・予約中の依頼（送る前）は［取り消す］
// ・送った依頼は［詳しく ▼］で、相手ごとに「ベルを読んだか」「パスワードを変えたか（いつ）」
//   🚨 メールを開いたかは分からない（開封は記録していない）。依頼より前に変えていたかも分からない（2026-10-04 から記録）
// ・「まだ変えていない人にもう一度送る」
// 🚨 読み書きは Edge Function staff-onboard だけ（表は画面から直接読めない）。invoke は 4xx/5xx でも throw しない

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { backBtn, primaryBtn, tintBtn } from '../../lib/buttonStyles';

interface Recipient { user_id: string; name: string; read: boolean; changed_at: string | null; mailed: boolean }
interface PwRequest {
  id: string; reason: 'initial' | 'review'; target_count: number; scheduled_for: string | null; sent_at: string | null;
  sent_count: number; mailed_count: number; cancelled_at: string | null; created_at: string; recipients: Recipient[];
}

const REASON_LABEL = { initial: '初期パスワードのままの方へ', review: '安全のための見直し' } as const;
const fmt = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${'日月火水木金土'[d.getUTCDay()]}）${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

const PwRequestHistory: React.FC<{ isDarkMode: boolean; refreshKey: number; onMessage: (msg: string, isError?: boolean) => void }> = ({ isDarkMode, refreshKey, onMessage }) => {
  const [list, setList] = useState<PwRequest[] | null>(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resendFor, setResendFor] = useState<string | null>(null);
  const text = isDarkMode ? '#fff' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';

  const load = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke('staff-onboard', { body: { action: 'pw_requests' } });
    const d = (data ?? {}) as { success?: boolean; error?: string; requests?: PwRequest[] };
    if (error || d.success !== true) { setErr(`履歴を読み込めませんでした：${d.error ?? error?.message ?? ''}`); return; }
    setErr(''); setList(d.requests ?? []);
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const cancel = async (r: PwRequest) => {
    setBusy(r.id);
    const { data, error } = await supabase.functions.invoke('staff-onboard', { body: { action: 'cancel_pw_request', id: r.id } });
    setBusy(null);
    const d = (data ?? {}) as { success?: boolean; error?: string };
    if (error || d.success !== true) { onMessage(`取り消せませんでした：${d.error ?? error?.message ?? ''}`, true); return; }
    onMessage('予約を取り消しました'); void load();
  };
  const resend = async (r: PwRequest) => {
    const ids = r.recipients.filter(x => !x.changed_at).map(x => x.user_id);
    setBusy(r.id);
    const { data, error } = await supabase.functions.invoke('staff-onboard', { body: { action: 'request_password_change', ids, reason: r.reason } });
    setBusy(null); setResendFor(null);
    const d = (data ?? {}) as { success?: boolean; error?: string; flagged?: number; mailed?: number };
    if (error || d.success !== true) { onMessage(`送れませんでした：${d.error ?? error?.message ?? ''}`, true); return; }
    onMessage(`${d.flagged ?? 0}名にもう一度送りました（メール ${d.mailed ?? 0}通）`); void load();
  };

  if (err) return <p style={{ color: '#dc3545', fontSize: 13, textAlign: 'center' }}>{err}</p>;
  const shown = (list ?? []).filter(r => !r.cancelled_at).slice(0, 5);
  if (shown.length === 0) return null;

  return (
    <div style={{ maxWidth: 620, margin: '0 auto 14px', padding: '10px 12px', border: `1px solid ${border}`, borderRadius: 8, textAlign: 'left', color: text, fontSize: 13 }}>
      <div style={{ fontWeight: 'bold', marginBottom: 6 }}>🔑 パスワード変更の依頼</div>
      {shown.map(r => {
        const pending = !r.sent_at;
        const notChanged = r.recipients.filter(x => !x.changed_at).length;
        return (
          <div key={r.id} style={{ padding: '6px 0', borderTop: `1px solid ${border}` }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
              {pending
                ? <span><strong>{r.scheduled_for ? fmt(r.scheduled_for) : ''} 送信予定</strong> ／ {r.target_count}名・{REASON_LABEL[r.reason]}</span>
                : <span>{fmt(r.sent_at!)} 送信済み ／ {r.sent_count}名・{REASON_LABEL[r.reason]}（変更済み {r.sent_count - notChanged}／{r.sent_count}）</span>}
              {pending
                ? <button onClick={() => cancel(r)} disabled={busy === r.id} style={{ ...backBtn(isDarkMode), padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}>取り消す</button>
                : <button onClick={() => setOpenId(openId === r.id ? null : r.id)} style={{ ...backBtn(isDarkMode), padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}>{openId === r.id ? '閉じる ▲' : '詳しく ▼'}</button>}
            </div>
            {openId === r.id && !pending && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11.5, color: sub, marginBottom: 4 }}>既読＝ベルを読んだか。メールを開いたかは分かりません。変更済み＝この依頼のあとにパスワードを変えた日時</div>
                {r.recipients.map(x => (
                  <div key={x.user_id} style={{ display: 'flex', gap: 12, padding: '2px 0', fontSize: 12.5 }}>
                    <span style={{ minWidth: 110 }}>{x.name}</span>
                    <span style={{ minWidth: 50, color: x.read ? text : sub }}>{x.read ? '既読 ✓' : '未読'}</span>
                    <span style={{ color: x.changed_at ? '#28a745' : sub, fontWeight: x.changed_at ? 'bold' : 'normal' }}>{x.changed_at ? `変更済み ${fmt(x.changed_at)}` : 'まだ'}</span>
                    {!x.mailed && <span style={{ color: sub }}>（メールなし）</span>}
                  </div>
                ))}
                {notChanged > 0 && (resendFor === r.id ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                    <span>まだ変えていない{notChanged}名に、同じ理由でもう一度送ります（ベル・メール）。</span>
                    <button onClick={() => setResendFor(null)} disabled={busy === r.id} style={{ ...backBtn(isDarkMode), padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }}>やめる</button>
                    <button onClick={() => resend(r)} disabled={busy === r.id} style={{ ...primaryBtn({ disabled: busy === r.id }), padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>{busy === r.id ? '送っています...' : '送る'}</button>
                  </div>
                ) : (
                  <button onClick={() => setResendFor(r.id)} style={{ ...tintBtn(isDarkMode), padding: '4px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', marginTop: 6 }}>まだ変えていない{notChanged}名にもう一度送る</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PwRequestHistory;
