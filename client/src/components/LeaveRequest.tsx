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

const LeaveRequestForm: React.FC<Props> = ({ user, profileName, roleTitle: _roleTitle }) => {
  const navigate = useNavigate();
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

  const selectedApprover = approvers.find(a => a.id === selectedApproverId);

  // 日数計算
  const calcDays = () => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diff = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return diff > 0 ? diff : 0;
  };

  // 申請先の役職によって最初のステータスを決める
  const getInitialStatus = () => {
    if (!selectedApprover) return 'pending';
    return selectedApprover.role_title === 'マネージャー' ? 'pending_manager' : 'pending';
  };

  const getInitialApproverRole = () => {
    if (!selectedApprover) return 'leader';
    return selectedApprover.role_title === 'マネージャー' ? 'manager' : 'leader';
  };

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
      console.error('送信エラー詳細:', err);
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

  if (submitted) {
    return (
      <div style={{ maxWidth: 500, margin: '40px auto', padding: 24, background: 'white', borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: '#28a745', marginBottom: 8 }}>申請しました</h2>
        <p style={{ color: '#666', marginBottom: 24 }}>承認者に通知されます。</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={() => navigate('/')}
            style={{ padding: '10px 24px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}
          >
            🏠 ホームに戻る
          </button>
          <button
            onClick={handleReset}
            style={{ padding: '10px 24px', background: '#007bff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}
          >
            続けて申請する
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 500, margin: '20px auto', padding: 24, background: 'white', borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
      <h2 style={{ marginBottom: 20, fontSize: 20, color: '#333' }}>🌿 休暇申請</h2>

      {/* 申請者 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>申請者</label>
        <div style={{ padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, color: '#333' }}>
          {profileName || user.email}
        </div>
      </div>

      {/* 申請先 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>申請先 *</label>
        {approvers.length === 0 ? (
          <div style={{ padding: '10px 14px', background: '#fff3cd', borderRadius: 8, color: '#856404', fontSize: 14 }}>
            承認者が登録されていません
          </div>
        ) : (
          <select
            value={selectedApproverId}
            onChange={e => setSelectedApproverId(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15 }}
          >
            {approvers.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.role_title}）
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 休暇種別 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>休暇種別 *</label>
        <select
          value={leaveType}
          onChange={e => setLeaveType(e.target.value as '有給' | '特別休暇' | 'その他')}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15 }}
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
            style={{ width: '100%', marginTop: 8, padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }}
          />
        )}
      </div>

      {/* 開始日 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>開始日 *</label>
        <input
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }}
        />
      </div>

      {/* 終了日 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>終了日 *</label>
        <input
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
          min={startDate}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }}
        />
        {calcDays() > 0 && (
          <div style={{ marginTop: 6, color: '#007bff', fontSize: 14 }}>
            {calcDays()}日間
          </div>
        )}
      </div>

      {/* 理由 */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: '#444' }}>理由・備考</label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="任意"
          rows={3}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical' }}
        />
      </div>

      {/* 送信ボタン */}
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

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'white', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', color: '#333' }}>
            <h3 style={{ marginBottom: 16, color: '#333' }}>申請内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <tbody>
                <tr><td style={{ padding: '8px 0', color: '#666', width: '40%' }}>申請者</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#333' }}>{profileName || user.email}</td></tr>
                <tr><td style={{ padding: '8px 0', color: '#666' }}>申請先</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#333' }}>{selectedApprover?.name}（{selectedApprover?.role_title}）</td></tr>
                <tr><td style={{ padding: '8px 0', color: '#666' }}>休暇種別</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#333' }}>{leaveType === 'その他' ? leaveTypeOther : leaveType}</td></tr>
                <tr><td style={{ padding: '8px 0', color: '#666' }}>開始日</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#333' }}>{startDate}</td></tr>
                <tr><td style={{ padding: '8px 0', color: '#666' }}>終了日</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#333' }}>{endDate}</td></tr>
                <tr><td style={{ padding: '8px 0', color: '#666' }}>日数</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: '#007bff' }}>{calcDays()}日間</td></tr>
                {reason && <tr><td style={{ padding: '8px 0', color: '#666' }}>理由</td><td style={{ padding: '8px 0', color: '#333' }}>{reason}</td></tr>}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 8, cursor: 'pointer', fontSize: 15, color: '#333' }}
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
