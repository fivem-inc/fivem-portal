import React, { useState, useEffect } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import { useRoles } from '../../hooks/useRoles';
import { describeUpdate } from '../../lib/statusUpdate';
import { retireState, retireStateLabel, retireStateColor, mdLabel, fetchRetireAccessDefault, type RetireScheduleResult } from '../../lib/retire';
import { todayJstStr } from '../../lib/breakCalc';
import type { AdminUserProfile } from '../../types';

// ユーザー追加モーダル
const AddUserModal: React.FC<{
  isDarkMode: boolean;
  masterOptions: { employment_type: string[]; role_title: string[] };
  onClose: () => void;
  onSuccess: () => void;
}> = ({ isDarkMode, masterOptions, onClose, onSuccess }) => {
  // master_options が空のときの逃げ道は roles から（役職名を直書きしない・2026-09-09）
  const roleNames = useRoles().map(r => r.name);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [employmentType, setEmploymentType] = useState('正社員');
  const [roleTitle, setRoleTitle] = useState('一般');
  const [password, setPassword] = useState('');
  const [passwordManuallyEdited, setPasswordManuallyEdited] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // メール入力時に自動でパスワードをセット（手動変更済みの場合は上書きしない）
  const handleEmailChange = (val: string) => {
    setEmail(val);
    if (!passwordManuallyEdited) {
      const atIdx = val.indexOf('@');
      setPassword(atIdx > 0 ? val.slice(0, atIdx) : val);
    }
  };

  const handleSubmit = async () => {
    if (!email || !name) {
      setError('メールアドレスと名前は必須です');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('メールアドレスの形式が正しくありません');
      return;
    }
    if (password.length < 6) {
      setError('パスワードは6文字以上が必要です');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data: result, error } = await supabase.functions.invoke('create-user', {
        body: { email, password, name, employment_type: employmentType, role_title: roleTitle },
      });

      if (error || result?.error) {
        setError(result?.error || error?.message || '登録に失敗しました');
      } else {
        onSuccess();
        onClose();
      }
    } catch (e) {
      setError('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.5)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
  };
  const modalStyle: React.CSSProperties = {
    background: isDarkMode ? '#343a40' : 'white',
    borderRadius: 10, padding: 24, width: '100%', maxWidth: 420,
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 13, fontWeight: 'bold',
    color: isDarkMode ? '#adb5bd' : '#555', marginBottom: 4, marginTop: 14,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 14, boxSizing: 'border-box',
    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
    background: isDarkMode ? '#495057' : 'white',
    color: isDarkMode ? '#fff' : '#000',
  };
  const selectStyle: React.CSSProperties = { ...inputStyle };

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h4 style={{ margin: '0 0 4px', color: isDarkMode ? '#fff' : '#000', fontSize: 18 }}>👤 新しいスタッフを登録</h4>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888' }}>
          登録後、本人がパスワードを変更することを推奨します
        </p>

        <label style={labelStyle}>メールアドレス <span style={{ color: '#dc3545' }}>*</span></label>
        <input
          type="email" value={email} onChange={e => handleEmailChange(e.target.value)}
          placeholder="例: tanaka@fivem.co.jp" style={inputStyle}
        />

        <label style={labelStyle}>名前 <span style={{ color: '#dc3545' }}>*</span></label>
        <input
          type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="例: 田中 太郎" style={inputStyle}
        />

        <label style={labelStyle}>初期パスワード</label>
        <div style={{ position: 'relative' }}>
          <input
            type={showPassword ? 'text' : 'password'} value={password} onChange={e => { setPassword(e.target.value); setPasswordManuallyEdited(true); }}
            placeholder="メール入力で自動セット" style={{ ...inputStyle, paddingRight: 36 }}
          />
          <button
            type="button" onClick={() => setShowPassword(v => !v)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: isDarkMode ? '#adb5bd' : '#666', padding: 0 }}
            title={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
          >
            {showPassword ? '🙈' : '👁️'}
          </button>
        </div>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#888' }}>
          ※ メールの@前が自動でセットされます（6文字以上必要）
        </p>

        <label style={labelStyle}>雇用形態</label>
        <select value={employmentType} onChange={e => setEmploymentType(e.target.value)} style={selectStyle}>
          {(masterOptions.employment_type.length > 0 ? masterOptions.employment_type : ['正社員', 'パート', 'アルバイト', '契約社員']).map(v => (
            <option key={v}>{v}</option>
          ))}
        </select>

        <label style={labelStyle}>役職</label>
        <select value={roleTitle} onChange={e => setRoleTitle(e.target.value)} style={selectStyle}>
          {roleNames.map(v => (
            <option key={v}>{v}</option>
          ))}
        </select>

        {error && (
          <div style={{ marginTop: 14, padding: '8px 12px', background: '#f8d7da', color: '#842029', borderRadius: 6, fontSize: 13 }}>
            ⚠️ {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose} disabled={loading}
            style={{ padding: '8px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit} disabled={loading}
            style={{ padding: '8px 20px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 'bold', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? '登録中...' : '✅ 登録する'}
          </button>
        </div>
      </div>
    </div>
  );
};

// メール送信確認モーダル
const SendEmailModal: React.FC<{
  isDarkMode: boolean;
  targets: { id: string; name: string; email: string }[];
  onClose: () => void;
  onSent: () => void;
}> = ({ isDarkMode, targets, onClose, onSent }) => {
  const [subject, setSubject] = useState('fivem-portal へのご招待');
  const [body, setBody] = useState(
    `{{name}} さん\n\nfivem-portal をご利用いただけるようになりました。\n\n以下のURLからログインしてください。\nhttps://fivem-portal.vercel.app\n\n初期パスワードはメールの@前の部分です。\nログイン後にパスワードを変更することをお勧めします。\n\n不明な点があればご連絡ください。`
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ success: number; failed: { name: string; email: string }[] } | null>(null);
  const [showAllTargets, setShowAllTargets] = useState(false);

  const sendToTargets = async (sendTargets: { id: string; name: string; email: string }[]) => {
    setLoading(true);
    setProgress(0);
    let success = 0;
    const failed: { name: string; email: string }[] = [];
    let done = 0;

    await Promise.allSettled(
      sendTargets.map(async t => {
        const personalBody = body.replace(/\{\{name\}\}/g, t.name || t.email);
        const html = personalBody.replace(/\n/g, '<br>');
        try {
          const { error } = await supabase.functions.invoke('send-email', { body: { to: t.email, subject, html } });
          if (error) { failed.push({ name: t.name || t.email, email: t.email }); } else { success++; }
        } catch { failed.push({ name: t.name || t.email, email: t.email }); }
        done++;
        setProgress(Math.round((done / sendTargets.length) * 100));
      })
    );
    setLoading(false);
    setResult({ success, failed });
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.5)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
  };
  const modalStyle: React.CSSProperties = {
    background: isDarkMode ? '#343a40' : 'white',
    borderRadius: 10, padding: 24, width: '100%', maxWidth: 500,
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)', maxHeight: '90vh', overflowY: 'auto',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 13, boxSizing: 'border-box',
    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
    background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000',
  };

  if (loading) {
    return (
      <div style={overlayStyle}>
        <div style={modalStyle}>
          <h4 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#000' }}>📧 送信中...</h4>
          <p style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 13, marginBottom: 8 }}>{progress} % 完了</p>
          <progress value={progress} max={100} style={{ width: '100%', height: 12 }} />
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div style={overlayStyle}>
        <div style={modalStyle}>
          <h4 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#000' }}>📧 送信完了</h4>
          <p style={{ color: '#28a745', fontWeight: 'bold' }}>✅ 成功: {result.success}件</p>
          {result.failed.length > 0 && (
            <>
              <p style={{ color: '#dc3545', marginBottom: 8 }}>❌ 失敗: {result.failed.map(f => f.name).join('、')}</p>
              <button
                onClick={() => { setResult(null); sendToTargets(result.failed.map(f => ({ id: '', name: f.name, email: f.email }))); }}
                style={{ padding: '6px 16px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13, marginBottom: 12 }}
              >
                失敗した {result.failed.length} 名に再送する
              </button>
            </>
          )}
          <div>
            <button onClick={() => { onSent(); onClose(); }}
              style={{ padding: '8px 24px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
              閉じる
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h4 style={{ margin: '0 0 4px', color: isDarkMode ? '#fff' : '#000', fontSize: 18 }}>📧 メール送信</h4>
        <div style={{ marginBottom: 16, padding: '8px 12px', background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>
          <p style={{ margin: 0, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>送信先 ({targets.length}名)：</p>
          <div style={{ marginTop: 6, maxHeight: showAllTargets ? 180 : 60, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {targets.map(t => (
              <span key={t.id} style={{ background: isDarkMode ? '#6c757d' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', borderRadius: 4, padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>
                {t.name || t.email}
              </span>
            ))}
          </div>
          {targets.length > 8 && (
            <button onClick={() => setShowAllTargets(v => !v)} style={{ marginTop: 4, background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontSize: 12, padding: 0 }}>
              {showAllTargets ? '▲ 折りたたむ' : `▼ 全${targets.length}名を表示`}
            </button>
          )}
          {targets.length >= 10 && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc3545', fontWeight: 'bold' }}>
              ⚠️ {targets.length}名に送信します
            </p>
          )}
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#555', marginBottom: 4 }}>件名</label>
        <input type="text" value={subject} onChange={e => setSubject(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#555', marginBottom: 4 }}>
          本文 <span style={{ fontWeight: 'normal', color: '#888' }}>（{`{{name}}`} で宛名に置き換わります）</span>
        </label>
        <textarea value={body} onChange={e => setBody(e.target.value)}
          rows={10} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '8px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            キャンセル
          </button>
          <button onClick={() => sendToTargets(targets)}
            style={{ padding: '8px 20px', background: targets.length >= 10 ? '#dc3545' : '#007bff', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
            📧 {targets.length}名に送信する
          </button>
        </div>
      </div>
    </div>
  );
};

// 承認待ちユーザー1件分の行（雇用形態・役職をその場で設定して承認）
const PendingUserRow: React.FC<{
  isDarkMode: boolean;
  pendingUser: { id: string; name?: string | null; email?: string; registered_at?: string | null; signup_ip?: string | null; signup_country?: string | null; signup_city?: string | null };
  masterOptions: { employment_type: string[]; role_title: string[] };
  onApprove: (userId: string, employmentType: string, roleTitle: string) => Promise<void>;
  onReject: (userId: string) => Promise<void>;
}> = ({ isDarkMode, pendingUser, masterOptions, onApprove, onReject }) => {
  const [employmentType, setEmploymentType] = useState(masterOptions.employment_type[0] || '正社員');
  const [roleTitle, setRoleTitle] = useState(masterOptions.role_title.includes('一般') ? '一般' : (masterOptions.role_title[0] || '一般'));
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const location = [pendingUser.signup_country, pendingUser.signup_city].filter(Boolean).join('・');

  // 登録日時と、そこからの経過（放置されている登録に気づけるように）
  const signupInfo = (() => {
    if (!pendingUser.registered_at) return null;
    const s = pendingUser.registered_at;
    const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
    const stamp = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const ago = days >= 1 ? `${days}日前` : '今日';
    return { stamp, ago, stale: days >= 3 };
  })();

  return (
    <div style={{ background: isDarkMode ? '#3a2f0d' : '#fff8e1', border: `1px solid ${isDarkMode ? '#7a5c00' : '#ffe082'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 140 }}>
        <div style={{ fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000', fontSize: 14 }}>{pendingUser.name || '（名前未設定）'}</div>
        <div style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666' }}>{pendingUser.email}</div>
        {signupInfo && (
          <div style={{ fontSize: 11, color: signupInfo.stale ? '#dc3545' : (isDarkMode ? '#adb5bd' : '#666'), fontWeight: signupInfo.stale ? 'bold' : 'normal' }}>
            🕐 {signupInfo.stamp} 登録（{signupInfo.ago}）
          </div>
        )}
        {pendingUser.signup_ip && (
          <div style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666' }}>
            📍 {pendingUser.signup_ip}{location && `（${location}）`}
          </div>
        )}
      </div>
      <select value={employmentType} onChange={e => setEmploymentType(e.target.value)} disabled={busy}
        style={{ padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000' }}>
        {masterOptions.employment_type.map(v => <option key={v}>{v}</option>)}
      </select>
      <select value={roleTitle} onChange={e => setRoleTitle(e.target.value)} disabled={busy}
        style={{ padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000' }}>
        {masterOptions.role_title.map(v => <option key={v}>{v}</option>)}
      </select>
      {showRejectConfirm ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: isDarkMode ? '#3a1f1f' : '#fff5f5', border: `1px solid ${isDarkMode ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#dc3545' }}>この登録を拒否し、アカウントを削除しますか？（元に戻せません）</span>
          <button disabled={busy} onClick={async () => { setBusy(true); await onReject(pendingUser.id); setBusy(false); }}
            style={{ padding: '4px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>拒否して削除</button>
          <button disabled={busy} onClick={() => setShowRejectConfirm(false)}
            style={{ padding: '4px 10px', background: 'none', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, color: isDarkMode ? '#fff' : '#000', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
        </div>
      ) : (
        <>
          <button disabled={busy} onClick={async () => { setBusy(true); await onApprove(pendingUser.id, employmentType, roleTitle); setBusy(false); }}
            style={{ padding: '6px 16px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>承認する</button>
          <button disabled={busy} onClick={() => setShowRejectConfirm(true)}
            style={{ padding: '6px 16px', background: 'none', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>拒否</button>
        </>
      )}
    </div>
  );
};

/** "2026-06-30" → "2026/6/30"（年を残す・退職者の一覧で使う） */
interface RetireDateChange {
  id: string;
  old_retire_date: string | null; new_retire_date: string | null;
  old_access_until: string | null; new_access_until: string | null;
  changed_by: string | null; changed_at: string;
}

const ymdLabel = (ymd: string): string => {
  const [y, mo, d] = ymd.split("-").map(Number);
  return `${y}/${mo}/${d}`;
};

const UsersTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, users, loadingUsers, sortedUsers, pendingUsers, userSortKey, userSortAsc, handleUserSort, editingUser, editName, setEditName, handleEditName, handleSaveName, handleCancelUserEdit, showRetired, setShowRetired, editingSortOrder, setEditingSortOrder, editSortOrderValue, setEditSortOrderValue, handleSaveSortOrder, masterOptions, isUserEditMode, setIsUserEditMode, confirmChange, setConfirmChange, fetchUsers, setErrorMsg, setSuccessMsg, handleRestoreUser, handleDeleteUser, handleApprovePendingUser, handleRejectPendingUser, setActiveTab } = ctx;

  const [showAddModal, setShowAddModal] = useState(false);
  // 退職の予約（2026-09-19・案A「道は1本」）。［退職］を押すとその行の下に入力欄が開く
  const [retireFormFor, setRetireFormFor] = useState<string | null>(null);
  const [retireDate, setRetireDate] = useState('');
  const [retireUntil, setRetireUntil] = useState('');
  const [retireUntilEdited, setRetireUntilEdited] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireErr, setRetireErr] = useState('');
  const [retireCancelFor, setRetireCancelFor] = useState<string | null>(null);
  const todayJst = todayJstStr();
  // ── 退職日・期限を後から直す（2026-09-20・実機の指摘）──
  // 🚨 直しても在籍には戻さない（戻すのは［復活］）。退職の切り替えもやり直さない（付け替えを二度走らせない）
  const [retireEditFor, setRetireEditFor] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editUntil, setEditUntil] = useState('');
  const [editErr, setEditErr] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [changeLog, setChangeLog] = useState<RetireDateChange[]>([]);
  const openRetireEdit = (u: AdminUserProfile) => {
    setRetireEditFor(u.id); setRetireFormFor(null); setRetireCancelFor(null); setEditErr('');
    setEditDate(u.retire_date ?? ''); setEditUntil(u.retiree_access_until ?? '');
    setChangeLog([]);
    // 変更の記録を読む。🚨 読めなくても編集は続けられる（記録が出ないだけ）
    void supabase.from('retire_date_changes')
      .select('id, old_retire_date, new_retire_date, old_access_until, new_access_until, changed_by, changed_at')
      .eq('user_id', u.id).order('changed_at', { ascending: true })
      .then(({ data }) => setChangeLog((data ?? []) as RetireDateChange[]), () => {});
  };
  const submitRetireEdit = async (userId: string, userName: string) => {
    if (!editDate) { setEditErr('退職日を選んでください'); return; }
    if (!editUntil) { setEditErr('ログインできる期限を選んでください'); return; }
    if (editUntil < editDate) { setEditErr('期限は退職日より後にしてください'); return; }
    setEditBusy(true); setEditErr('');
    // 🚨 rpc は 4xx/5xx でも throw しない。error を必ず見る
    const { data, error } = await supabase.rpc('retire_update_dates', { p_user: userId, p_retire_date: editDate, p_access_until: editUntil });
    setEditBusy(false);
    if (error) { setEditErr('直せませんでした：' + error.message); return; }
    const r = data as { changed?: boolean; access_expired?: boolean } | null;
    setRetireEditFor(null);
    setSuccessMsg(r?.changed === false
      ? `${userName}さんの日付は変わっていません（同じ内容でした）。`
      : `${userName}さんの退職日を ${ymdLabel(editDate)}、ログインできる期限を ${ymdLabel(editUntil)} に直しました。`
      + (r?.access_expired ? 'この期限はすでに過ぎているため、ログインはできません。' : ''));
    fetchUsers();
  };
  const openRetireForm = (userId: string) => {
    setRetireFormFor(userId); setRetireDate(''); setRetireUntil(''); setRetireUntilEdited(false); setRetireErr(''); setRetireCancelFor(null);
  };
  // 退職日を変えたら、期限の初期値を DB から取り直す（🚨 画面で計算しない。手で直した期限は上書きしない）
  useEffect(() => {
    if (!retireFormFor || !retireDate || retireUntilEdited) return;
    setRetireUntil('');
    let alive = true;
    void fetchRetireAccessDefault(retireDate).then(d => { if (alive && d) setRetireUntil(d); });
    return () => { alive = false; };
  }, [retireFormFor, retireDate, retireUntilEdited]);
  const submitRetire = async (userId: string, userName: string) => {
    if (!retireDate) { setRetireErr('退職日を選んでください'); return; }
    if (retireUntil && retireUntil < retireDate) { setRetireErr('申請の期限は退職日より後にしてください'); return; }
    setRetireBusy(true); setRetireErr('');
    const { data, error } = await supabase.rpc('retire_schedule', { p_user: userId, p_retire_date: retireDate, p_access_until: retireUntil || null });
    setRetireBusy(false);
    if (error) { setRetireErr('退職の手続きができませんでした：' + error.message); return; }
    const r = data as RetireScheduleResult;
    const moved = r.reassigned > 0 ? `確認者のまま残っていた申請 ${r.reassigned} 件を「管理者」に付け替えました。` : '';
    // 🚨 1段目では退職者はまだログインできないので「申請の期限」は言わない（2026-09-19 UXレビュー）
    setSuccessMsg(r.applied_now
      ? `${userName}さんを退職に切り替えました。${moved}`
      : `${userName}さんの退職日を ${mdLabel(r.retire_date)} で予約しました。翌日の0時に退職に切り替わります。`);
    setRetireFormFor(null);
    fetchUsers();
  };
  const cancelRetire = async (userId: string) => {
    setRetireBusy(true);
    const { error } = await supabase.rpc('retire_cancel', { p_user: userId });
    setRetireBusy(false);
    if (error) { setErrorMsg('退職日を取り消せませんでした：' + error.message); return; }
    setRetireCancelFor(null);
    setSuccessMsg('退職日を取り消しました（退職の手続きのチェックも消しました）');
    fetchUsers();
  };
  const roleNames = useRoles().map(r => r.name);
  const [selectedForEmail, setSelectedForEmail] = useState<Set<string>>(new Set());
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailTarget, setEmailTarget] = useState<{ id: string; name: string; email: string }[]>([]);
  // プッシュ通知を許可している（購読情報が登録済みの）ユーザーID一覧
  const [pushUserIds, setPushUserIds] = useState<Set<string>>(new Set());
  // 緊急連絡先（安否確認用）。初期登録は管理者、以降は本人がアカウント設定から更新する
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [editingPhoneId, setEditingPhoneId] = useState<string | null>(null);
  const [phoneValue, setPhoneValue] = useState('');
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState('');

  useEffect(() => {
    supabase.from('push_subscriptions').select('user_id').then(({ data }) => {
      if (data) setPushUserIds(new Set(data.map(r => r.user_id as string)));
    });
    supabase.from('staff_phone_numbers').select('user_id, phone').then(({ data }) => {
      if (data) setPhones(Object.fromEntries(data.map(r => [r.user_id as string, r.phone as string])));
    });
  }, []);

  const startEditPhone = (userId: string) => {
    setEditingPhoneId(userId);
    setPhoneValue(phones[userId] || '');
    setPhoneError('');
  };

  const savePhone = async (userId: string) => {
    const v = phoneValue.trim();
    setPhoneError('');
    if (!v) {
      // 空で保存＝登録を削除する
      setPhoneSaving(true);
      const { error } = await supabase.from('staff_phone_numbers').delete().eq('user_id', userId);
      setPhoneSaving(false);
      if (error) { setPhoneError('保存できませんでした'); return; }
      setPhones(prev => { const next = { ...prev }; delete next[userId]; return next; });
      setEditingPhoneId(null);
      return;
    }
    setPhoneSaving(true);
    const { error } = await supabase.from('staff_phone_numbers')
      .upsert({ user_id: userId, phone: v }, { onConflict: 'user_id' });
    setPhoneSaving(false);
    if (error) { setPhoneError('保存できませんでした'); return; }
    setPhones(prev => ({ ...prev, [userId]: v }));
    setEditingPhoneId(null);
  };

  const toggleEmailSelect = (id: string) => {
    setSelectedForEmail(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkEmail = () => {
    const targets = sortedUsers
      .filter(u => selectedForEmail.has(u.id) && u.email)
      .map(u => ({ id: u.id, name: u.name || '', email: u.email || '' }));
    setEmailTarget(targets);
    setShowEmailModal(true);
  };

  const handleSingleEmail = (user: typeof sortedUsers[0]) => {
    setEmailTarget([{ id: user.id, name: user.name || '', email: user.email || '' }]);
    setShowEmailModal(true);
  };

  return (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>ユーザー管理</h3>
            {loadingUsers ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : (
              <div>
                {showAddModal && (
                  <AddUserModal
                    isDarkMode={isDarkMode}
                    masterOptions={masterOptions}
                    onClose={() => setShowAddModal(false)}
                    onSuccess={() => { fetchUsers(); }}
                  />
                )}
                {pendingUsers.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <h4 style={{ color: '#fd7e14', fontSize: 15, marginBottom: 8 }}>🆕 承認待ちの新規登録（{pendingUsers.length}件）</h4>
                    {pendingUsers.map(pu => (
                      <PendingUserRow
                        key={pu.id}
                        isDarkMode={isDarkMode}
                        pendingUser={pu}
                        masterOptions={{
                          employment_type: masterOptions.employment_type.length > 0 ? masterOptions.employment_type : ['正社員', 'パート'],
                          role_title: roleNames,   // 役職の一覧は roles から（master_options の役職一覧は廃止）
                        }}
                        onApprove={handleApprovePendingUser}
                        onReject={handleRejectPendingUser}
                      />
                    ))}
                  </div>
                )}
                {showEmailModal && (
                  <SendEmailModal
                    isDarkMode={isDarkMode}
                    targets={emailTarget}
                    onClose={() => setShowEmailModal(false)}
                    onSent={() => setSelectedForEmail(new Set())}
                  />
                )}
                <div style={{ marginBottom: '20px', textAlign: 'center' }}>
                  <p style={{ color: isDarkMode ? '#fff' : '#000' }}>
                    現役: {users.filter(u => u.is_active !== false).length}人 ／ 退職済み: {users.filter(u => u.is_active === false).length}人
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: 8 }}>
                    <button
                      onClick={() => setShowAddModal(true)}
                      style={{ padding: '8px 20px', background: '#28a745', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}
                    >
                      ＋ ユーザー追加
                    </button>
                    {isUserEditMode ? (
                      <>
                        <span style={{ color: '#fd7e14', fontSize: 11, alignSelf: 'center' }}>⚠️ 編集モード中</span>
                        <button onClick={() => setIsUserEditMode(false)} style={{ padding: '8px 14px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}>✅ 編集終了</button>
                      </>
                    ) : (
                      <button onClick={() => setIsUserEditMode(true)} style={{ padding: '8px 14px', background: '#fd7e14', color: 'white', border: '2px solid #e8690b', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}>✏️ 雇用形態・役職を編集</button>
                    )}
                    {selectedForEmail.size > 0 && (
                      <button
                        onClick={handleBulkEmail}
                        style={{ padding: '8px 20px', background: selectedForEmail.size >= 10 ? '#dc3545' : '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}
                      >
                        📧 選択した{selectedForEmail.size}名にメール送信
                      </button>
                    )}
                    {selectedForEmail.size > 0 && (
                      <button
                        onClick={() => setSelectedForEmail(new Set())}
                        style={{ padding: '8px 12px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: 13 }}
                      >
                        選択解除
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => setShowRetired('active')}
                      style={{ padding: '8px 16px', background: showRetired === 'active' ? '#007bff' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      現役のみ
                    </button>
                    <button
                      onClick={() => setShowRetired('retired')}
                      style={{ padding: '8px 16px', background: showRetired === 'retired' ? '#dc3545' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      退職者のみ
                    </button>
                    <button
                      onClick={() => setShowRetired('all')}
                      style={{ padding: '8px 16px', background: showRetired === 'all' ? '#28a745' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      全員表示
                    </button>
                    <button onClick={fetchUsers} style={{ padding: '8px 16px' }}>更新</button>
                  </div>
                </div>

                {/* 変更確認ポップアップ */}
                {confirmChange && (
                  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 8, padding: 24, minWidth: 300, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
                      <h4 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#000' }}>変更の確認</h4>
                      <p style={{ color: isDarkMode ? '#ddd' : '#333', marginBottom: 8 }}>
                        <strong>{confirmChange.label}</strong> を変更します
                      </p>
                      <div style={{ background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 14 }}>
                        <span style={{ color: '#dc3545' }}>「{confirmChange.oldVal}」</span>
                        <span style={{ color: isDarkMode ? '#ddd' : '#666', margin: '0 8px' }}>→</span>
                        <span style={{ color: '#28a745', fontWeight: 'bold' }}>「{confirmChange.newVal}」</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setConfirmChange(null)}
                          style={{ padding: '6px 16px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                        >
                          キャンセル
                        </button>
                        <button
                          onClick={async () => {
                            // 🚨 検査せずに閉じると、保存が権限で弾かれても何も出ないまま
                            //    fetchUsers() で画面が元の値に戻り、
                            //    「保存を押したのに、なぜか変わらない」だけが残る。
                            //    役職は権限に直結するので、失敗は必ず見せる。
                            const res = await supabase.from('profiles')
                              .update({ [confirmChange.field]: confirmChange.newVal })
                              .eq('id', confirmChange.userId).select('id');
                            const fail = describeUpdate(res, '変更', 'missing');
                            if (fail) { setErrorMsg(fail); fetchUsers(); return; }
                            fetchUsers();
                            setConfirmChange(null);
                          }}
                          style={{ padding: '6px 16px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
                        >
                          保存する
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {/* 並び替えボタン */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, justifyContent: 'center' }}>
                  {[
                    { key: 'sort_order', label: 'No.順' },
                    { key: 'name', label: '名前順' },
                    { key: 'registered_at', label: '登録日順' },
                    { key: 'submission_count', label: '申請数順' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => handleUserSort(key as any)}
                      style={{
                        padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: userSortKey === key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                        color: userSortKey === key ? 'white' : (isDarkMode ? '#fff' : '#333'),
                        fontSize: 13, fontWeight: userSortKey === key ? 'bold' : 'normal'
                      }}
                    >
                      {label} {userSortKey === key ? (userSortAsc ? '↑ 昇順' : '↓ 降順') : ''}
                    </button>
                  ))}
                </div>
                <div style={{ overflowX: 'auto', display: 'flex', justifyContent: 'center' }}>
                  <table style={{ width: 'auto', minWidth: 700, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: isDarkMode ? '#495057' : '#f8f9fa' }}>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', width: 30, fontSize: 12 }}>
                          <input type="checkbox"
                            checked={selectedForEmail.size === sortedUsers.filter(u => u.email && u.email !== 'fivem.kyoto@gmail.com').length}
                            onChange={e => {
                              if (e.target.checked) {
                                setSelectedForEmail(new Set(sortedUsers.filter(u => u.email && u.email !== 'fivem.kyoto@gmail.com').map(u => u.id)));
                              } else {
                                setSelectedForEmail(new Set());
                              }
                            }}
                          />
                        </th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', width: 45, fontSize: 12 }}>No.</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 140 }}>名前</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 160 }}>メール</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 80 }}>雇用形態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 90 }}>役職</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 120 }}>グループ</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 85 }}>最終アクセス</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 125 }} title="災害時の安否確認で使う緊急連絡先。初期登録は管理者が行い、以降は本人がアカウント設定から変更できます">緊急連絡先</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 55 }} title="プッシュ通知を許可しているか（アカウント設定で本人が設定）">プッシュ</th>
                                                {/* 🚨 「退職者のみ」で絞っているときだけ出す（ふだんは列を増やさない・2026-09-20 実機の指摘） */}
                        {showRetired === 'retired' && (
                          <>
                            <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 110 }}>退職日／期限</th>
                            <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 85 }}>登録日</th>
                          </>
                        )}
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 55 }}>状態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 140 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map(user => {
                        const rState = retireState(user, todayJst);
                        return (
                          <React.Fragment key={user.id}>
                          <tr style={{ opacity: user.is_active === false ? 0.6 : 1, background: sortedUsers.indexOf(user) % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                            {/* チェックボックス列 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              {user.email !== 'fivem.kyoto@gmail.com' && user.email && (
                                <input type="checkbox"
                                  checked={selectedForEmail.has(user.id)}
                                  onChange={() => toggleEmailSelect(user.id)}
                                />
                              )}
                            </td>
                            {/* No.列 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>
                              {editingSortOrder === user.id ? (
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                  <input
                                    type="number"
                                    value={editSortOrderValue}
                                    onChange={e => setEditSortOrderValue(e.target.value)}
                                    style={{ width: 50, padding: '2px 4px', textAlign: 'center', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: '1px solid #ccc', borderRadius: 4 }}
                                    onKeyPress={e => e.key === 'Enter' && handleSaveSortOrder(user.id)}
                                    autoFocus
                                  />
                                  <button onClick={() => handleSaveSortOrder(user.id)} style={{ padding: '2px 6px', background: '#28a745', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✓</button>
                                  <button onClick={() => setEditingSortOrder(null)} style={{ padding: '2px 6px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✕</button>
                                </div>
                              ) : (
                                <span
                                  onClick={() => { setEditingSortOrder(user.id); setEditSortOrderValue(String(user.sort_order ?? '')); }}
                                  style={{ cursor: 'pointer', fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#666' }}
                                  title="クリックして変更"
                                >
                                  {user.sort_order ?? '-'}
                                </span>
                              )}
                            </td>
                            {/* 名前列 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>
                              {editingUser === user.id ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <input
                                    type="text"
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    style={{ flex: 1, padding: '4px 8px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: '4px', fontSize: '14px', backgroundColor: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000' }}
                                    placeholder="名前を入力"
                                    onKeyPress={(e) => { if (e.key === 'Enter') handleSaveName(user.id); }}
                                  />
                                  <button onClick={() => handleSaveName(user.id)} style={{ padding: '4px 8px', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>保存</button>
                                  <button onClick={handleCancelUserEdit} style={{ padding: '4px 8px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>キャンセル</button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span>{user.name || '未設定'}</span>
                                  <button onClick={() => handleEditName(user.id, user.name || '')} style={{ padding: '2px 6px', background: '#ffc107', color: '#212529', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '11px', marginLeft: '8px' }}>編集</button>
                                </div>
                              )}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#adb5bd' : '#555', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={user.email}>{user.email}</td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              {(() => {
                                const empVal = user.employment_type || '正社員';
                                const empUnknown = !masterOptions.employment_type.includes(empVal);
                                return (
                                  <select
                                    value={empVal}
                                    disabled={!isUserEditMode}
                                    onChange={(e) => {
                                      setConfirmChange({ userId: user.id, field: 'employment_type', label: `${user.name || user.email} の雇用形態`, oldVal: empVal, newVal: e.target.value });
                                    }}
                                    title={empUnknown ? `選択肢にない値「${empVal}」が保存されています。選び直して保存してください。` : undefined}
                                    style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: empUnknown ? '2px solid #dc3545' : `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                                  >
                                    {empUnknown && <option value={empVal}>⚠️ {empVal}（未登録の値）</option>}
                                    {masterOptions.employment_type.map(v => <option key={v}>{v}</option>)}
                                  </select>
                                );
                              })()}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              {(() => {
                                const roleVal = user.role_title || '一般';
                                // 🚨 役職の一覧は roles が唯一の正（master_options の役職一覧は段6で廃止・2026-09-10）
                                const roleUnknown = !roleNames.includes(roleVal);
                                return (
                                  <select
                                    value={roleVal}
                                    disabled={!isUserEditMode}
                                    onChange={(e) => {
                                      setConfirmChange({ userId: user.id, field: 'role_title', label: `${user.name || user.email} の役職`, oldVal: roleVal, newVal: e.target.value });
                                    }}
                                    title={roleUnknown ? `選択肢にない値「${roleVal}」が保存されています。選び直して保存してください。` : undefined}
                                    style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: roleUnknown ? '2px solid #dc3545' : `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                                  >
                                    {roleUnknown && <option value={roleVal}>⚠️ {roleVal}（未登録の値）</option>}
                                    {roleNames.map(v => <option key={v}>{v}</option>)}
                                  </select>
                                );
                              })()}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 11 }}>
                              {user.group_names && user.group_names.length > 0 ? user.group_names.join('・') : '-'}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11, whiteSpace: 'nowrap', textAlign: 'center' }}>
                              {user.last_sign_in_at
                                ? (() => {
                                    const s = user.last_sign_in_at;
                                    const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
                                    return <>{`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`}<br />{`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}</>;
                                  })()
                                : <span style={{ color: '#adb5bd' }}>未ログイン</span>
                              }
                            </td>
                            {/* 緊急連絡先（安否確認用）。クリックで編集、空で保存すると登録を削除 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', fontSize: 11 }}>
                              {editingPhoneId === user.id ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  <input
                                    type="tel"
                                    value={phoneValue}
                                    onChange={e => { setPhoneValue(e.target.value); setPhoneError(''); }}
                                    placeholder="090-1234-5678"
                                    autoFocus
                                    style={{ width: '100%', padding: '3px 5px', fontSize: 11, borderRadius: 4, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#000' }}
                                  />
                                  <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
                                    <button type="button" onClick={() => savePhone(user.id)} disabled={phoneSaving}
                                      style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: 'none', background: '#28a745', color: '#fff', cursor: phoneSaving ? 'default' : 'pointer' }}>
                                      {phoneSaving ? '...' : '保存'}
                                    </button>
                                    <button type="button" onClick={() => { setEditingPhoneId(null); setPhoneError(''); }}
                                      style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: 'none', color: isDarkMode ? '#adb5bd' : '#666', cursor: 'pointer' }}>
                                      取消
                                    </button>
                                  </div>
                                  {phoneError && <span style={{ color: '#dc3545', fontSize: 10 }}>{phoneError}</span>}
                                </div>
                              ) : (
                                <span
                                  onClick={() => startEditPhone(user.id)}
                                  title="クリックで編集"
                                  style={{ cursor: 'pointer', color: phones[user.id] ? (isDarkMode ? '#fff' : '#000') : '#dc3545', whiteSpace: 'nowrap' }}
                                >
                                  {phones[user.id] || '⚠️ 未登録'}
                                </span>
                              )}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              {pushUserIds.has(user.id)
                                ? <span title="プッシュ通知 許可中" style={{ fontSize: 14 }}>🔔</span>
                                : <span title="プッシュ通知 未設定" style={{ color: isDarkMode ? '#6c757d' : '#adb5bd', fontSize: 12 }}>－</span>
                              }
                            </td>
                            {/* 退職者のみのときだけ出す列（退職日・期限・登録日） */}
                            {showRetired === 'retired' && (
                              <>
                                <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap' }}>
                                  <div>{user.retire_date ? ymdLabel(user.retire_date) : '－'}</div>
                                  {user.retiree_access_until && (
                                    <div style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>期限 {ymdLabel(user.retiree_access_until)}</div>
                                  )}
                                </td>
                                <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap' }}>
                                  {user.registered_at ? ymdLabel(user.registered_at.slice(0, 10)) : '－'}
                                </td>
                              </>
                            )}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              {/* 状態の札は lib/retire.ts の1か所（ユーザー管理・退職の手続きで共用） */}
                              <span style={{ color: retireStateColor(user, todayJst, isDarkMode), fontWeight: 'bold', fontSize: '11px' }}>
                                {retireStateLabel(user, todayJst)}
                              </span>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                                <button style={{ padding: '3px 6px', background: '#17a2b8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => setActiveTab('reports')}>履歴</button>
                                {user.email && user.email !== 'fivem.kyoto@gmail.com' && (
                                  <button style={{ padding: '3px 6px', background: '#6610f2', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleSingleEmail(user)}>メール</button>
                                )}
                                {user.email !== 'fivem.kyoto@gmail.com' && (
                                  <>
                                    {/* 退職は「退職日を入れて確定」の1本だけ（2026-09-19・案A）。復活は RPC で退職日も空にする */}
                                    {/* 退職日が入っている人には、日付を直す入口を出す（2026-09-20 実機の指摘）。
                                        🚨 直しても在籍には戻さない（戻すのは［復活］） */}
                                    {user.retire_date && (
                                      <button style={{ padding: '3px 6px', background: 'transparent', color: isDarkMode ? '#90caf9' : '#1565c0', border: `1px solid ${isDarkMode ? '#90caf9' : '#90caf9'}`, borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
                                        onClick={() => openRetireEdit(user)}>退職日を修正</button>
                                    )}
                                    {user.is_active === false ? (
                                      <button style={{ padding: '3px 6px', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleRestoreUser(user.id)}>復活</button>
                                    ) : rState === 'scheduled' ? (
                                      <button style={{ padding: '3px 6px', background: 'transparent', color: isDarkMode ? '#ffc107' : '#b35900', border: `1px solid ${isDarkMode ? '#ffc107' : '#fd7e14'}`, borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => { setRetireCancelFor(user.id); setRetireFormFor(null); }}>退職日を取り消す</button>
                                    ) : (
                                      <button style={{ padding: '3px 6px', background: '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => openRetireForm(user.id)}>退職</button>
                                    )}
                                    {/* 🚨 申請期間中は削除を出さない（退職の手続きのチェックも一緒に消えるため） */}
                                    {user.is_active === false && rState !== 'grace' && (
                                      <button style={{ padding: '3px 6px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleDeleteUser(user.id, user.name || user.email || '')}>削除</button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                          {retireEditFor === user.id && (
                            <tr>
                              <td colSpan={14} style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '10px 12px', background: isDarkMode ? '#1f2d3d' : '#eef6ff' }}>
                                <div style={{ fontSize: 13, color: isDarkMode ? '#fff' : '#212529' }}>
                                  <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{user.name}さんの退職日を直す</div>
                                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      退職日（在籍の最終日）
                                      <input type="date" value={editDate} onChange={e => { setEditDate(e.target.value); setEditErr(''); }}
                                        style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#212529' }} />
                                    </label>
                                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      ログインできる期限
                                      <input type="date" value={editUntil} onChange={e => { setEditUntil(e.target.value); setEditErr(''); }}
                                        style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#212529' }} />
                                    </label>
                                  </div>
                                  <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#6c757d', lineHeight: 1.7, marginBottom: 8 }}>
                                    🚨 日付を直しても<strong>在籍には戻りません</strong>（戻すときは［復活］）。退職の切り替えもやり直しません。
                                  </div>
                                  {changeLog.length > 0 && (
                                    <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#6c757d', lineHeight: 1.8, marginBottom: 8, borderTop: `1px solid ${isDarkMode ? '#495057' : '#cfe2ff'}`, paddingTop: 6 }}>
                                      <div style={{ fontWeight: 'bold' }}>変更の記録（{changeLog.length}件）</div>
                                      {changeLog.map(c => (
                                        <div key={c.id}>
                                          <span style={{ marginRight: 10 }}>{ymdLabel(c.changed_at.slice(0, 10))}</span>
                                          退職日 {c.old_retire_date ? ymdLabel(c.old_retire_date) : '（新規）'} → {c.new_retire_date ? ymdLabel(c.new_retire_date) : '－'}
                                          {c.old_access_until !== c.new_access_until && (
                                            <span style={{ marginLeft: 10 }}>／ 期限 {c.old_access_until ? ymdLabel(c.old_access_until) : '（新規）'} → {c.new_access_until ? ymdLabel(c.new_access_until) : '－'}</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {editErr && (
                                    <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12.5, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', marginBottom: 8 }}>{editErr}</div>
                                  )}
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <button disabled={editBusy} onClick={() => setRetireEditFor(null)}
                                      style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: 'transparent', color: isDarkMode ? '#fff' : '#212529', cursor: 'pointer', fontSize: 12 }}>やめる</button>
                                    <button disabled={editBusy} onClick={() => submitRetireEdit(user.id, user.name || '')}
                                      style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>{editBusy ? '保存中…' : '保存'}</button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                          {(retireFormFor === user.id || retireCancelFor === user.id) && (
                            <tr>
                              <td colSpan={12} style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '10px 12px', background: isDarkMode ? '#3d3520' : '#fff8e1' }}>
                                {retireCancelFor === user.id ? (
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: isDarkMode ? '#fff' : '#212529' }}>
                                    <span>{user.name}さんの退職日（{mdLabel(user.retire_date)}）を取り消します。退職の手続きのチェックで「済み」にした記録も消えます。</span>
                                    <button disabled={retireBusy} onClick={() => setRetireCancelFor(null)} style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: 'transparent', color: isDarkMode ? '#fff' : '#212529', cursor: 'pointer', fontSize: 12 }}>やめる</button>
                                    <button disabled={retireBusy} onClick={() => cancelRetire(user.id)} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#fd7e14', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>取り消す</button>
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 13, color: isDarkMode ? '#fff' : '#212529' }}>
                                    <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{user.name}さんの退職の手続き</div>
                                    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                        退職日（在籍の最終日）
                                        <input type="date" value={retireDate} onChange={e => { setRetireDate(e.target.value); setRetireErr(''); }}
                                          style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#212529' }} />
                                      </label>
                                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                        ログインできる期限
                                        <input type="date" value={retireUntil} onChange={e => { setRetireUntil(e.target.value); setRetireUntilEdited(true); setRetireErr(''); }}
                                          style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#212529' }} />
                                        {!retireUntilEdited && retireUntil && <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#6c757d' }}>（初期値）</span>}
                                        {!retireUntilEdited && retireDate && !retireUntil && <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#6c757d' }}>計算中…</span>}
                                      </label>
                                    </div>
                                    <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#6c757d', lineHeight: 1.7, marginBottom: 8 }}>
                                      ※ 退職日の翌日0時に自動で退職に切り替わります。過去の日を選ぶと、確定した時点で切り替わります。<br />
                                      ※ 切り替わるとき、この方が確認者のまま残っている申請（残業・勤務変更報告・休暇）は「管理者」に付け替えます。<br />
                                      ※ ログインできる期限は、退職後に申請だけできる期間の終わりです（初期値は給与の締めの月の月末）。退職後の申請の仕組みは準備中で、いまは退職日の翌日からログインできなくなります。
                                    </div>
                                    {/* 過去の日は確定と同時に切り替わる。入れ間違いを防ぐため、はっきり知らせる（2026-09-19 UXレビュー） */}
                                    {retireDate && retireDate < todayJst && (
                                      <div style={{ color: '#dc3545', fontSize: 12.5, fontWeight: 'bold', lineHeight: 1.7, marginBottom: 8 }}>
                                        ⚠️ 過去の日付です。［今すぐ退職にする］を押すと、その場で退職に切り替わり、確認者のまま残っている申請は「管理者」に移ります。在籍に戻しても、申請の付け替えは戻りません。
                                      </div>
                                    )}
                                    {retireErr && <div style={{ color: '#dc3545', fontSize: 12, marginBottom: 6 }}>{retireErr}</div>}
                                    <div style={{ display: 'flex', gap: 8 }}>
                                      <button disabled={retireBusy} onClick={() => setRetireFormFor(null)} style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ced4da'}`, background: 'transparent', color: isDarkMode ? '#fff' : '#212529', cursor: 'pointer', fontSize: 12 }}>やめる</button>
                                      <button disabled={retireBusy || !retireDate} onClick={() => submitRetire(user.id, user.name || user.email || '')} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: retireDate ? '#fd7e14' : (isDarkMode ? '#6c757d' : '#ced4da'), color: '#fff', cursor: retireDate ? 'pointer' : 'default', fontSize: 12, fontWeight: 'bold' }}>{retireBusy ? '処理中…' : (retireDate && retireDate < todayJst ? '今すぐ退職にする' : '確定')}</button>
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
  );
};

export default UsersTab;

