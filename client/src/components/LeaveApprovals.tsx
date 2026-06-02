import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import type { AuthUser } from '../types';

interface Props {
  user: AuthUser;
  profileName: string | null;
  isAdmin: boolean;
  roleTitle?: string;
}

interface LeaveReq {
  id: string;
  user_id: string;
  leave_type: string;
  leave_type_other: string | null;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: string;
  created_at: string;
  rejected_reason: string | null;
  approver_id: string | null;
  approver2_id: string | null;
  requester?: { name: string } | null;
}

interface Approver {
  id: string;
  name: string;
  role_title: string;
}

// ステータスラベル
const STATUS_LABEL: Record<string, string> = {
  pending:          '承認待ち（一人目）',
  step2_pending:    '承認待ち（マネージャー）',
  manager_approved: 'マネージャー承認済み',
  admin_approved:   '経理承認済み',
  approved:         '承認完了',
  rejected:         '却下',
};

const LeaveApprovals: React.FC<Props> = ({ user, isAdmin, roleTitle }) => {
  const isPresident = roleTitle === '社長';
  const navigate = useNavigate();
  const [requests, setRequests] = useState<LeaveReq[]>([]);
  const [loading, setLoading] = useState(false);

  // 却下モーダル
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // 一人目承認 → マネージャー選択モーダル
  const [selectingManagerFor, setSelectingManagerFor] = useState<LeaveReq | null>(null);
  const [managers, setManagers] = useState<Approver[]>([]);
  const [selectedManagerId, setSelectedManagerId] = useState('');

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const borderColor = isDark ? '#6c757d' : '#ddd';
  const inputBg = isDark ? '#495057' : 'white';

  // マネージャー一覧取得
  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, name, role_title')
      .eq('role_title', 'マネージャー')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => {
        if (data) {
          setManagers(data);
          if (data.length > 0) setSelectedManagerId(data[0].id);
        }
      });
  }, []);

  const fetchRequests = useCallback(async () => {
    // isPresidentをcallback内でも参照できるよう依存に含める
    setLoading(true);
    try {
      let query = supabase
        .from('leave_requests')
        .select('*')
        .not('status', 'in', '("approved","rejected")')
        .order('created_at', { ascending: false });

      if (!isAdmin) {
        // 自分の番 + 自分が却下したもの + 社長は admin_approved も表示
        const orConditions = [
          `and(status.eq.pending,approver_id.eq.${user.id})`,
          `and(status.eq.step2_pending,approver2_id.eq.${user.id})`,
          `and(status.eq.rejected,approver_id.eq.${user.id})`,
          `and(status.eq.rejected,approver2_id.eq.${user.id})`,
        ];
        if (isPresident) {
          orConditions.push(`status.eq.admin_approved`);
        }
        query = query.or(orConditions.join(','));
      }

      const { data, error } = await query;
      if (error) { console.error('leave_requests取得エラー:', error); return; }
      if (!data || data.length === 0) { setRequests([]); return; }

      // 申請者名を取得
      const userIds = [...new Set(data.map((r: any) => r.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, name')
        .in('id', userIds);

      const profileMap: Record<string, { name: string }> = {};
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

      setRequests(data.map((r: any) => ({ ...r, requester: profileMap[r.user_id] || null })));
    } finally {
      setLoading(false);
    }
  }, [user.id, isAdmin, isPresident]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // 承認ボタンを押したときの処理
  const handleApproveClick = (req: LeaveReq) => {
    if (req.status === 'pending') {
      // 一人目承認 → マネージャー選択モーダルを出す
      setSelectingManagerFor(req);
      if (managers.length > 0) setSelectedManagerId(managers[0].id);
    } else {
      // それ以外は直接次へ進める
      handleApprove(req);
    }
  };

  // 承認実行（一人目以外）
  const handleApprove = async (req: LeaveReq) => {
    const nextMap: Record<string, string> = {
      step2_pending:    'manager_approved',
      manager_approved: 'admin_approved',
      admin_approved:   'approved',
    };
    const next = nextMap[req.status] || 'manager_approved';
    const label = next === 'approved' ? '最終承認（完了）' : '承認';
    if (!window.confirm(`${label}しますか？`)) return;
    await supabase.from('leave_requests').update({ status: next }).eq('id', req.id);
    fetchRequests();
  };

  // 一人目承認 + マネージャー指定
  const handleApproveWithManager = async () => {
    if (!selectingManagerFor || !selectedManagerId) return;
    await supabase.from('leave_requests').update({
      status: 'step2_pending',
      approver2_id: selectedManagerId,
    }).eq('id', selectingManagerFor.id);
    setSelectingManagerFor(null);
    fetchRequests();
  };

  const handleReject = async (id: string) => {
    await supabase.from('leave_requests').update({ status: 'rejected', rejected_reason: rejectReason || null }).eq('id', id);
    setRejectingId(null);
    setRejectReason('');
    fetchRequests();
  };

  const calcDays = (s: string, e: string) => {
    const diff = Math.floor((new Date(e).getTime() - new Date(s).getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return diff > 0 ? diff : 0;
  };

  // 承認ボタンのラベル
  const getApproveLabel = (status: string) => {
    if (status === 'pending') return '✅ 承認してマネージャーへ送る';
    if (status === 'step2_pending') return '✅ マネージャー承認';
    if (status === 'manager_approved') return '✅ 経理承認へ進める';
    if (status === 'admin_approved') return '✅ 最終承認（完了）';
    return '✅ 承認';
  };

  // このユーザーが承認できるかチェック（管理者は常に可）
  const canApprove = (req: LeaveReq) => {
    if (isAdmin) return true;
    if (req.status === 'pending' && req.approver_id === user.id) return true;
    if (req.status === 'step2_pending' && req.approver2_id === user.id) return true;
    if (req.status === 'admin_approved' && isPresident) return true;
    return false;
  };

  return (
    <div style={{ maxWidth: 680, margin: '20px auto', padding: '0 12px' }}>
      <div style={{ padding: 24, background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 20, color: text }}>🌿 休暇申請 承認待ち一覧</h2>
          <button
            onClick={() => navigate('/')}
            style={{ width: 24, height: 24, borderRadius: '50%', border: 'none', background: isDark ? '#6c757d' : '#dee2e6', color: text, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        {isAdmin && (
          <p style={{ marginBottom: 20, fontSize: 13, color: subText, background: isDark ? '#495057' : '#f8f9fa', padding: '8px 12px', borderRadius: 8 }}>
            管理者として全ての申請を確認・承認できます。承認が止まっている場合は強制的に次のステップへ進められます。
          </p>
        )}

        {loading ? (
          <p style={{ textAlign: 'center', color: subText }}>読み込み中...</p>
        ) : requests.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <p style={{ color: subText }}>承認待ちの申請はありません</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {requests.map(req => {
              const days = calcDays(req.start_date, req.end_date);
              const approvable = canApprove(req);
              return (
                <div
                  key={req.id}
                  style={{ padding: 16, borderRadius: 10, border: `1px solid ${borderColor}`, background: isDark ? '#495057' : '#fafafa' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
                    <div>
                      <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>
                        {req.requester?.name || '不明'}
                      </span>
                      <span style={{ marginLeft: 8, fontSize: 14, color: subText }}>
                        {req.leave_type === 'その他' ? req.leave_type_other : req.leave_type}
                      </span>
                    </div>
                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 'bold', background: '#ffc107', color: '#333' }}>
                      {STATUS_LABEL[req.status] || req.status}
                    </span>
                  </div>

                  <div style={{ color: subText, fontSize: 14, marginBottom: 6 }}>
                    {req.start_date} ～ {req.end_date}（{days}日間）
                  </div>
                  {req.reason && (
                    <div style={{ color: subText, fontSize: 13, marginBottom: 8 }}>理由: {req.reason}</div>
                  )}
                  <div style={{ color: isDark ? '#6c757d' : '#aaa', fontSize: 12, marginBottom: 12 }}>
                    申請日: {new Date(req.created_at).toLocaleDateString('ja-JP')}
                  </div>

                  {req.status === 'rejected' ? (
                    <div>
                      <div style={{ padding: '6px 10px', background: isDark ? '#5a1a1a' : '#f8d7da', borderRadius: 6, color: isDark ? '#f5c6cb' : '#721c24', fontSize: 13, marginBottom: 8 }}>
                        却下済み{req.rejected_reason ? `：${req.rejected_reason}` : ''}
                      </div>
                      <button
                        onClick={async () => {
                          if (!window.confirm('却下を取り消して自分の承認待ちに戻しますか？')) return;
                          // 自分が一人目か二人目かでステータスを分ける
                          const backStatus = req.approver2_id === user.id ? 'step2_pending' : 'pending';
                          await supabase.from('leave_requests').update({ status: backStatus, rejected_reason: null }).eq('id', req.id);
                          fetchRequests();
                        }}
                        style={{ width: '100%', padding: '8px', background: '#6c757d', color: 'white', border: '2px solid #545b62', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
                      >↩ 却下を取り消す</button>
                    </div>
                  ) : approvable ? (
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        onClick={() => handleApproveClick(req)}
                        style={{ flex: 1, padding: '8px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
                      >
                        {getApproveLabel(req.status)}
                      </button>
                      <button
                        onClick={() => { setRejectingId(req.id); setRejectReason(''); }}
                        style={{ flex: 1, padding: '8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
                      >
                        ❌ 却下
                      </button>
                    </div>
                  ) : (
                    <div style={{ padding: '8px 12px', background: isDark ? '#343a40' : '#e9ecef', borderRadius: 6, fontSize: 13, color: subText, textAlign: 'center' }}>
                      別の承認者の順番です
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 一人目承認 → マネージャー選択モーダル */}
      {selectingManagerFor && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, maxWidth: 380, width: '100%' }}>
            <h3 style={{ marginBottom: 8, color: text }}>次の承認者（マネージャー）を選択</h3>
            <p style={{ marginBottom: 16, fontSize: 13, color: subText }}>
              承認後、選んだマネージャーに申請が送られます
            </p>
            {managers.length === 0 ? (
              <p style={{ color: '#dc3545', fontSize: 14 }}>マネージャーが登録されていません</p>
            ) : (
              <select
                value={selectedManagerId}
                onChange={e => setSelectedManagerId(e.target.value)}
                style={{ width: '100%', padding: '10px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text, marginBottom: 16 }}
              >
                {managers.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setSelectingManagerFor(null)}
                style={{ flex: 1, padding: '10px', background: isDark ? '#495057' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', color: text }}
              >
                キャンセル
              </button>
              <button
                onClick={handleApproveWithManager}
                disabled={!selectedManagerId || managers.length === 0}
                style={{ flex: 1, padding: '10px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold' }}
              >
                承認して送る
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 却下モーダル */}
      {rejectingId && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, maxWidth: 380, width: '100%' }}>
            <h3 style={{ marginBottom: 12, color: text }}>却下理由（任意）</h3>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="却下理由を入力してください"
              rows={3}
              style={{ width: '100%', padding: '10px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: inputBg, color: text, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button
                onClick={() => setRejectingId(null)}
                style={{ flex: 1, padding: '10px', background: isDark ? '#495057' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', color: text }}
              >
                キャンセル
              </button>
              <button
                onClick={() => handleReject(rejectingId)}
                style={{ flex: 1, padding: '10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold' }}
              >
                却下する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveApprovals;
