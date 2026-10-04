// ユーザー管理の［メールを直す］（2026-10-04・案A ユーザー確定）
//
// ・在籍している人のメールアドレスを、管理者がその場で変える（「メールが変わったので直してほしい」と頼まれたとき）
// ・ログイン用のアドレス（auth.users）とスタッフの名簿（profiles）を同時に変える＝Edge Function staff-onboard の update
//   （本人が自分で変えたときは DB のトリガー on_auth_user_email_changed が名簿を合わせる）
// ・変えたあと、そのまま招待メール（［はじめての方］からパスワードを決める案内）を送ることもできる
// 🚨 打ち間違い対策：保存の前に新しいアドレスを大きく見せて確かめる
// 🚨 supabase.functions.invoke は 4xx/5xx でも throw しない。error と success を見る

import React, { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { primaryBtn, backBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import type { AdminUserProfile } from '../../types';

const EmailEditRow: React.FC<{
  user: AdminUserProfile;
  isDarkMode: boolean;
  colSpan: number;
  onClose: () => void;
  onDone: (message: string, isError?: boolean) => void;
}> = ({ user, isDarkMode, colSpan, onClose, onDone }) => {
  const [email, setEmail] = useState('');
  const [send, setSend] = useState<'none' | 'now'>('none');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const text = isDarkMode ? '#fff' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';

  const next = async () => {
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setErr('メールアドレスの形が正しくありません'); return; }
    if (v.toLowerCase() === (user.email ?? '').toLowerCase()) { setErr('今のメールアドレスと同じです'); return; }
    if (!confirming) { setErr(''); setConfirming(true); return; }
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('staff-onboard', { body: { action: 'update', id: user.id, email: v, send } });
    setBusy(false);
    const d = (data ?? {}) as { success?: boolean; error?: string; mail_error?: string | null };
    if (error || d.success !== true) { setErr(d.error ?? error?.message ?? '保存できませんでした'); setConfirming(false); return; }
    if (d.mail_error) { onDone(`メールアドレスは変えましたが、案内のメールを送れませんでした：${d.mail_error}`, true); return; }
    onDone(send === 'now' ? `${user.name ?? ''}さんのメールアドレスを変えて、案内のメールを送りました` : `${user.name ?? ''}さんのメールアドレスを変えました`);
  };

  return (
    <tr>
      <td colSpan={colSpan} style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '10px 12px', background: isDarkMode ? '#1f2d3d' : '#eef6ff' }}>
        <div style={{ fontSize: 13, color: text, maxWidth: 520 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 6 }}>{user.name}さんのメールアドレスを直す</div>
          <div style={{ fontSize: 12, color: sub, marginBottom: 8, wordBreak: 'break-all' }}>今：{user.email}</div>
          {!confirming ? (
            <>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="新しいメールアドレス"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#000' }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {([['none', '案内のメールは送らない'], ['now', '新しいアドレスに案内のメールを送る']] as const).map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setSend(v)}
                    style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', border: `1px solid ${send === v ? TOGGLE_BLUE : (isDarkMode ? '#6c757d' : '#ccc')}`, background: send === v ? TOGGLE_BLUE : 'transparent', color: send === v ? '#fff' : text, fontWeight: send === v ? 'bold' : 'normal' }}>
                    {l}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: sub, marginTop: 6 }}>案内のメールは「ログイン画面の［はじめての方］から、新しいアドレスでパスワードを決めてください」という内容です。</div>
            </>
          ) : (
            <div style={{ padding: '8px 10px', borderRadius: 6, border: `2px solid ${TOGGLE_BLUE}` }}>
              <div style={{ fontSize: 12, color: sub }}>このアドレスに変えますか？（打ち間違いがないか確かめてください）</div>
              <div style={{ fontSize: 18, fontWeight: 'bold', wordBreak: 'break-all' }}>{email.trim()}</div>
              <div style={{ fontSize: 12.5 }}>{send === 'now' ? '変えたあと、このアドレスに案内のメールを送ります' : '案内のメールは送りません'}</div>
            </div>
          )}
          {err && <p style={{ color: '#dc3545', margin: '8px 0 0' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={() => confirming ? setConfirming(false) : onClose()} disabled={busy} style={{ ...backBtn(isDarkMode), flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer' }}>{confirming ? '戻る' : 'やめる'}</button>
            <button onClick={next} disabled={busy} style={{ ...primaryBtn({ disabled: busy }), flex: 2, padding: '7px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
              {busy ? '保存しています...' : confirming ? (send === 'now' ? '変えて送る' : '変える') : '確認へ'}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
};

export default EmailEditRow;
