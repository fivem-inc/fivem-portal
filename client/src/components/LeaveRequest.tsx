import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import type { AuthUser } from '../types';

interface Props {
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
}

interface Approver {
  id: string;
  name: string;
  role_title: string;
}

interface LeaveRecord {
  id: string;
  leave_type: string;
  leave_type_other: string | null;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: string;
  created_at: string;
  rejected_reason: string | null;
  approver?: { name: string; role_title: string } | null;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending:          { label: '承認待ち（一人目）', color: '#856404' },
  step2_pending:    { label: '承認待ち（マネージャー）', color: '#856404' },
  manager_approved: { label: 'マネージャー承認済み', color: '#0c5460' },
  admin_approved:   { label: '経理承認済み', color: '#0c5460' },
  approved:         { label: '承認完了', color: '#155724' },
  rejected:         { label: '却下', color: '#721c24' },
};

const LeaveRequestForm: React.FC<Props> = ({ user, profileName, roleTitle: _roleTitle }) => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'form' | 'history'>('form');

  // フォーム用state
  const [leaveType, setLeaveType] = useState<'有給' | '特別休暇' | 'その他'>('有給');
  const [leaveTypeOther, setLeaveTypeOther] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState('');

  // 履歴用state
  const [history, setHistory] = useState<LeaveRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // リーダー・マネージャー一覧を取得
  useEffect(() => {
    const fetchApprovers = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, role_title')
        .in('role_title', ['リーダー', 'マネージャー'])
        .eq('is_active', true)
        .order('role_title', { ascending: false })
        .order('name');
      if (!error && data) {
        setApprovers(data);
        if (data.length > 0) setSelectedApproverId(data[0].id);
      }
    };
    fetchApprovers();
  }, []);

  // 履歴取得
  useEffect(() => {
    if (tab !== 'history') return;
    const fetchHistory = async () => {
      setLoadingHistory(true);
      const { data, error } = await supabase
        .from('leave_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!error && data) {
        // approver_id から profiles を別取得してマージ
        const approverIds = [...new Set(data.map((r: any) => r.approver_id).filter(Boolean))];
        let profileMap: Record<string, { name: string; role_title: string }> = {};
        if (approverIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, name, role_title')
            .in('id', approverIds);
          if (profiles) {
            profiles.forEach((p: any) => { profileMap[p.id] = p; });
          }
        }
        setHistory(data.map((r: any) => ({ ...r, approver: profileMap[r.approver_id] || null })));
      }
      setLoadingHistory(false);
    };
    fetchHistory();
  }, [tab, user.id]);

  const selectedApprover = approvers.find(a => a.id === selectedApproverId);

  const calcDays = (s: string, e: string) => {
    if (!s || !e) return 0;
    const diff = Math.floor((new Date(e).getTime() - new Date(s).getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return diff > 0 ? diff : 0;
  };

  const getInitialStatus = () => 'pending';
  const getInitialApproverRole = () => 'first';

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const { error } = await supabase.from('leave_requests').insert({
        user_id: user.id,
        leave_type: leaveType,
        leave_type_other: leaveType === 'その他' ? leaveTypeOther : null,
        start_date: startDate,
        end_date: endDate,
        reason: reason || null,
        status: getInitialStatus(),
        current_approver: getInitialApproverRole(),
        approver_id: selectedApproverId,
      });
      if (error) throw error;
      setSubmitted(true);
      setShowConfirm(false);
    } catch (err: any) {
      alert('送信に失敗しました。\n' + (err?.message || JSON.stringify(err)));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setLeaveType('有給');
    setLeaveTypeOther('');
    setStartDate('');
    setEndDate('');
    setReason('');
    setSubmitted(false);
    if (approvers.length > 0) setSelectedApproverId(approvers[0].id);
  };

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const inputBg = isDark ? '#495057' : 'white';
  const borderColor = isDark ? '#6c757d' : '#ddd';

  // 申請完了画面
  if (submitted) {
    return (
      <div style={{ maxWidth: 500, margin: '40px auto', padding: 24, background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: '#28a745', marginBottom: 8 }}>申請しました</h2>
        <p style={{ color: subText, marginBottom: 24 }}>承認者に通知されます。</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button onClick={() => navigate('/')} style={{ padding: '10px 24px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
            🏠 ホームに戻る
          </button>
          <button onClick={handleReset} style={{ padding: '10px 24px', background: '#007bff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
            続けて申請する
          </button>
          <button onClick={() => { handleReset(); setTab('history'); }} style={{ padding: '10px 24px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
            申請履歴を確認
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 600, margin: '20px auto', padding: '0 12px' }}>
      {/* タブ切替 */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
        <button
          onClick={() => setTab('form')}
          style={{ flex: 1, padding: '12px', background: tab === 'form' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'form' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'form' ? 'bold' : 'normal' }}
        >
          🌿 新規申請
        </button>
        <button
          onClick={() => setTab('history')}
          style={{ flex: 1, padding: '12px', background: tab === 'history' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'history' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'history' ? 'bold' : 'normal' }}
        >
          📋 申請履歴
        </button>
      </div>

      {/* 申請フォーム */}
      {tab === 'form' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
          <h2 style={{ marginBottom: 20, fontSize: 20, color: text }}>🌿 休暇申請</h2>

          {/* 申請者 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>申請者</label>
            <div style={{ padding: '10px 14px', background: isDark ? '#495057' : '#f8f9fa', borderRadius: 8, color: text }}>
              {profileName || user.email}
            </div>
          </div>

          {/* 申請先 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>申請先 *</label>
            {approvers.length === 0 ? (
              <div style={{ padding: '10px 14px', background: '#fff3cd', borderRadius: 8, color: '#856404', fontSize: 14 }}>
                承認者が登録されていません
              </div>
            ) : (
              <select
                value={selectedApproverId}
                onChange={e => setSelectedApproverId(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
              >
                {approvers.map(a => (
                  <option key={a.id} value={a.id}>{a.name}（{a.role_title}）</option>
                ))}
              </select>
            )}
          </div>

          {/* 休暇種別 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>休暇種別 *</label>
            <select
              value={leaveType}
              onChange={e => setLeaveType(e.target.value as '有給' | '特別休暇' | 'その他')}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
            >
              <option value="有給">有給休暇</option>
              <option value="特別休暇">特別休暇</option>
              <option value="その他">その他</option>
            </select>
            {leaveType === 'その他' && (
              <input
                type="text"
                value={leaveTypeOther}
                onChange={e => setLeaveTypeOther(e.target.value)}
                placeholder="種別を入力"
                style={{ width: '100%', marginTop: 8, padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', background: inputBg, color: text }}
              />
            )}
          </div>

          {/* 開始日 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>開始日 *</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', background: inputBg, color: text }}
            />
          </div>

          {/* 終了日 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>終了日 *</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              min={startDate}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', background: inputBg, color: text }}
            />
            {calcDays(startDate, endDate) > 0 && (
              <div style={{ marginTop: 6, color: '#007bff', fontSize: 14 }}>{calcDays(startDate, endDate)}日間</div>
            )}
          </div>

          {/* 理由 */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>理由・備考</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="任意"
              rows={3}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
            />
          </div>

          <button
            onClick={() => {
              if (!selectedApproverId) { alert('申請先を選んでください'); return; }
              if (!startDate || !endDate) { alert('開始日・終了日を入力してください'); return; }
              if (leaveType === 'その他' && !leaveTypeOther) { alert('種別を入力してください'); return; }
              setShowConfirm(true);
            }}
            style={{ width: '100%', padding: '12px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}
          >
            申請内容を確認する
          </button>
        </div>
      )}

      {/* 申請履歴 */}
      {tab === 'history' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
          <h2 style={{ marginBottom: 20, fontSize: 20, color: text }}>📋 休暇申請履歴</h2>
          {loadingHistory ? (
            <p style={{ textAlign: 'center', color: subText }}>読み込み中...</p>
          ) : history.length === 0 ? (
            <p style={{ textAlign: 'center', color: subText }}>申請履歴はありません</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {history.map(req => {
                const days = calcDays(req.start_date, req.end_date);
                const st = STATUS_LABEL[req.status] || { label: req.status, color: '#333' };
                const isApproved = req.status === 'approved';
                const isRejected = req.status === 'rejected';
                const isPending = !isApproved && !isRejected;
                return (
                  <div
                    key={req.id}
                    style={{
                      padding: 16,
                      borderRadius: 10,
                      border: `2px solid ${isApproved ? '#28a745' : isRejected ? '#dc3545' : borderColor}`,
                      background: isApproved ? (isDark ? '#1b4d1b' : '#f0fff4') : isRejected ? (isDark ? '#5a1a1a' : '#fff5f5') : (isDark ? '#495057' : '#fafafa'),
                    }}
                  >
                    {/* ヘッダー行 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap', gap: 4 }}>
                      <div style={{ fontWeight: 'bold', fontSize: 16, color: text }}>
                        {req.leave_type === 'その他' ? req.leave_type_other : req.leave_type}
                      </div>
                      <span style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 'bold',
                        background: isApproved ? '#28a745' : isRejected ? '#dc3545' : '#ffc107',
                        color: isPending ? '#333' : 'white',
                      }}>
                        {st.label}
                      </span>
                    </div>

                    {/* 日付・日数 */}
                    <div style={{ color: subText, fontSize: 14, marginBottom: 6 }}>
                      {req.start_date} ～ {req.end_date}（{days}日間）
                    </div>

                    {/* 申請先 */}
                    {req.approver && (
                      <div style={{ color: subText, fontSize: 13, marginBottom: 4 }}>
                        申請先: {req.approver.name}（{req.approver.role_title}）
                      </div>
                    )}

                    {/* 理由 */}
                    {req.reason && (
                      <div style={{ color: subText, fontSize: 13, marginBottom: 4 }}>
                        理由: {req.reason}
                      </div>
                    )}

                    {/* 却下理由 */}
                    {isRejected && req.rejected_reason && (
                      <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? '#721c24' : '#f8d7da', borderRadius: 6, color: isDark ? '#f5c6cb' : '#721c24', fontSize: 13 }}>
                        却下理由: {req.rejected_reason}
                      </div>
                    )}

                    {/* 申請日 */}
                    <div style={{ color: isDark ? '#6c757d' : '#aaa', fontSize: 12, marginTop: 8 }}>
                      申請日: {new Date(req.created_at).toLocaleDateString('ja-JP')}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', color: text }}>
            <h3 style={{ marginBottom: 16, color: text }}>申請内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <tbody>
                <tr><td style={{ padding: '8px 0', color: subText, width: '40%' }}>申請者</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{profileName || user.email}</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText }}>申請先</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{selectedApprover?.name}（{selectedApprover?.role_title}）</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText }}>休暇種別</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{leaveType === 'その他' ? leaveTypeOther : leaveType}</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText }}>開始日</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{startDate}</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText }}>終了日</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{endDate}</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText }}>日数</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#007bff' }}>{calcDays(startDate, endDate)}日間</td></tr>
                {reason && <tr><td style={{ padding: '8px 0', color: subText }}>理由</td><td style={{ padding: '8px 0', color: text }}>{reason}</td></tr>}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', background: isDark ? '#495057' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 15, color: text }}
              >
                修正する
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', background: isSubmitting ? '#6c757d' : '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 'bold' }}
              >
                {isSubmitting ? '送信中...' : '申請する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveRequestForm;
