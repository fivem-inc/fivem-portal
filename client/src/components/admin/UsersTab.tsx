import React, { useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';

// ユーザー追加モーダル
const AddUserModal: React.FC<{
  isDarkMode: boolean;
  masterOptions: { employment_type: string[]; role_title: string[] };
  onClose: () => void;
  onSuccess: () => void;
}> = ({ isDarkMode, masterOptions, onClose, onSuccess }) => {
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
          {(masterOptions.role_title.length > 0 ? masterOptions.role_title : ['一般', 'リーダー', 'マネージャー', '管理者', '社長']).map(v => (
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
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: t.email, subject, html }) }
          );
          if (!response.ok) { failed.push({ name: t.name || t.email, email: t.email }); } else { success++; }
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

const UsersTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, users, loadingUsers, sortedUsers, userSortKey, userSortAsc, handleUserSort, editingUser, editName, setEditName, handleEditName, handleSaveName, handleCancelUserEdit, showRetired, setShowRetired, editingSortOrder, setEditingSortOrder, editSortOrderValue, setEditSortOrderValue, handleSaveSortOrder, masterOptions, isUserEditMode, setIsUserEditMode, confirmChange, setConfirmChange, submissions, fetchUsers, handleToggleActive, handleDeleteUser, setActiveTab } = ctx;

  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedForEmail, setSelectedForEmail] = useState<Set<string>>(new Set());
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailTarget, setEmailTarget] = useState<{ id: string; name: string; email: string }[]>([]);

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
                            await supabase.from('profiles').update({ [confirmChange.field]: confirmChange.newVal }).eq('id', confirmChange.userId);
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
                      {label} {userSortKey === key ? (userSortAsc ? '▲' : '▼') : ''}
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
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 85 }}>最終ログイン</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 55 }}>状態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 140 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map(user => {
                        const regDate = user.registered_at ? new Date(new Date(user.registered_at).getTime() + 9*60*60*1000) : null;
                        const regDateStr = regDate ? `${regDate.getFullYear()}/${String(regDate.getMonth()+1).padStart(2,'0')}/${String(regDate.getDate()).padStart(2,'0')}` : '-';
                        return (
                          <tr key={user.id} style={{ opacity: user.is_active === false ? 0.6 : 1, background: sortedUsers.indexOf(user) % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
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
                              <select
                                value={user.employment_type || '正社員'}
                                disabled={!isUserEditMode}
                                onChange={(e) => {
                                  setConfirmChange({ userId: user.id, field: 'employment_type', label: `${user.name || user.email} の雇用形態`, oldVal: user.employment_type || '正社員', newVal: e.target.value });
                                }}
                                style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                              >
                                {masterOptions.employment_type.map(v => <option key={v}>{v}</option>)}
                              </select>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              <select
                                value={user.role_title || '一般'}
                                disabled={!isUserEditMode}
                                onChange={(e) => {
                                  setConfirmChange({ userId: user.id, field: 'role_title', label: `${user.name || user.email} の役職`, oldVal: user.role_title || '一般', newVal: e.target.value });
                                }}
                                style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                              >
                                {masterOptions.role_title.map(v => <option key={v}>{v}</option>)}
                              </select>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 11 }}>
                              {user.group_names && user.group_names.length > 0 ? user.group_names.join('・') : '-'}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11, whiteSpace: 'nowrap' }}>
                              {user.last_sign_in_at
                                ? (() => {
                                    const d = new Date(new Date(user.last_sign_in_at).getTime() + 9*60*60*1000);
                                    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
                                  })()
                                : <span style={{ color: '#adb5bd' }}>未ログイン</span>
                              }
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              {user.is_active === false ? (
                                <span style={{ color: '#dc3545', fontWeight: 'bold', fontSize: '11px' }}>退職済</span>
                              ) : (
                                <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '11px' }}>現役</span>
                              )}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                                <button style={{ padding: '3px 6px', background: '#17a2b8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => setActiveTab('reports')}>履歴</button>
                                {user.email && user.email !== 'fivem.kyoto@gmail.com' && (
                                  <button style={{ padding: '3px 6px', background: '#6610f2', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleSingleEmail(user)}>メール</button>
                                )}
                                {user.email !== 'fivem.kyoto@gmail.com' && (
                                  <>
                                    <button style={{ padding: '3px 6px', background: user.is_active === false ? '#28a745' : '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleToggleActive(user.id, user.is_active !== false)}>
                                      {user.is_active === false ? '復活' : '退職'}
                                    </button>
                                    {user.is_active === false && (
                                      <button style={{ padding: '3px 6px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleDeleteUser(user.id, user.name || user.email || '')}>削除</button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
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

