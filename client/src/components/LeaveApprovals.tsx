import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { sendLeaveSlack } from '../lib/leaveSlack';
import { insertNotification } from '../lib/notifications';
import { shouldSend, getNotificationTemplate, getNotificationRecipient, dispatchEmail, dispatchSiteNotification, getUserEmail } from '../lib/notificationDispatch';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import type { AuthUser, AdminLeaveRequest } from '../types';

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
  leave_dates?: string | null;
  leave_locations?: string | null; // 日付→校のJSON（旧申請はnull）
  chosei_origin_locations?: string | null; // 振替元の日付→校のJSON（調整休・振替休日のみ）
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
  pending:          '確認中（一人目）',
  step2_pending:    '確認中（マネージャー）',
  manager_approved: 'マネージャー受理済み',
  admin_approved:   '経理受理済み',
  approved:         '受理済み',
  rejected:         '差し戻し',
};

const LeaveApprovals: React.FC<Props> = ({ user, profileName, isAdmin, roleTitle }) => {
  const isPresident = roleTitle === '社長';
  const navigate = useNavigate();
  const [requests, setRequests] = useState<LeaveReq[]>([]);
  // 通知バナーから ?focus=<申請ID> で来たとき該当カードを強調
  const { highlightId, focusRef } = useFocusHighlight(requests);
  const [loading, setLoading] = useState(false);

  // 差し戻しモーダル
  const [rejectingReq, setRejectingReq] = useState<LeaveReq | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNewType, setRejectNewType] = useState('');

  const LEAVE_TYPES = ['有給休暇', 'BD休暇', '慶弔休', '調整休', 'その他', '病欠'];

  // 一人目承認 → マネージャー選択モーダル
  const [selectingManagerFor, setSelectingManagerFor] = useState<LeaveReq | null>(null);
  const [managers, setManagers] = useState<Approver[]>([]);
  const [selectedManagerId, setSelectedManagerId] = useState('');

  // パートへフォーム送信
  const [partUsers, setPartUsers] = useState<any[]>([]);
  const [partSendSuccess, setPartSendSuccess] = useState<string | null>(null);

  const isDark = useDarkMode();
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

  // パート一覧取得
  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, name, email, employment_type, leave_request_enabled')
      .eq('employment_type', 'パート')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => { if (data) setPartUsers(data); });
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
      const userIds = [...new Set(data.map((r: AdminLeaveRequest) => r.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, name')
        .in('id', userIds);

      const profileMap: Record<string, { name: string }> = {};
      (profiles || []).forEach((p: { id: string; name: string }) => { profileMap[p.id] = p; });

      setRequests(data.map((r: AdminLeaveRequest) => ({
        ...r,
        leave_type_other: r.leave_type_other ?? null,
        start_date: r.start_date ?? '',
        end_date: r.end_date ?? '',
        reason: (r as unknown as { reason?: string | null }).reason ?? null,
        rejected_reason: r.rejected_reason ?? null,
        approver_id: r.approver_id ?? null,
        approver2_id: r.approver2_id ?? null,
        requester: profileMap[r.user_id] || null,
      })));
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
    // 調整給はマネージャー受理で完了（経理・社長ステップをスキップ）
    const isChosei = req.leave_type === '調整休';
    const nextMap: Record<string, string> = {
      step2_pending:    isChosei ? 'approved' : 'manager_approved',
      manager_approved: 'admin_approved',
      admin_approved:   'approved',
    };
    const next = nextMap[req.status] || 'manager_approved';
    const label = next === 'approved' ? '最終受理（完了）' : '受理';
    if (!window.confirm(`${label}しますか？`)) return;
    await supabase.from('leave_requests').update({ status: next }).eq('id', req.id);

    // マネージャー受理時（step2_pending → manager_approved）にGoogleカレンダーへ書き込む
    // 調整休はstep2_pending → approvedのためそのままapprovedも対象
    if (next === 'manager_approved' || next === 'approved') {
      try {
        const dates: string[] = req.leave_dates ? JSON.parse(req.leave_dates) : [];
        // 日付→校の対応表（校なしの旧申請はundefined→従来どおり校なしタイトル）
        let locations: Record<string, string> | undefined;
        try { locations = req.leave_locations ? JSON.parse(req.leave_locations) : undefined; } catch { locations = undefined; }
        if (dates.length > 0) {
          await supabase.functions.invoke('gcal-sync', {
            body: {
              action: 'upsert',
              source_type: 'leave',
              source_id: req.id,
              dates,
              name: req.requester?.name ?? '',
              leave_type: req.leave_type === 'その他' ? 'その他' : req.leave_type,
              locations,
            },
          });
        }
      } catch (e) {
        console.error('[gcal-sync] 書き込み失敗:', e);
      }
    }

    const typeName = req.leave_type === 'その他' ? (req.leave_type_other || 'その他') : req.leave_type;

    if (req.status === 'step2_pending') {
      const daysCount = req.leave_dates ? (() => { try { return String(JSON.parse(req.leave_dates!).length); } catch { return ''; } })() : '';
      const vars = { 休暇種別: typeName, 申請日数: daysCount, リンク: 'https://fivem-portal.vercel.app/leave?tab=history' };
      const applicantEmail = await getUserEmail(req.user_id) ?? '';
      // 社長（宛先で「社長」を選んだ場合の届け先。複数人いても全員に届ける）
      const { data: presidents } = await supabase
        .from('profiles').select('id, email').eq('role_title', '社長').eq('is_active', true);
      const presidentIds = (presidents ?? []).map((p: { id: string }) => p.id);
      const presidentEmails = (presidents ?? []).map((p: { email: string | null }) => p.email).filter((e): e is string => !!e);
      // サイト内通知（申請者本人は従来どおり直接送信）
      if (await shouldSend('leave:manager_approved', 'site')) {
        const t = await getNotificationTemplate('leave:manager_approved', 'site', vars);
        await insertNotification(req.user_id, t?.template ?? `休暇申請がマネージャーに受理されました`, t?.subject || `種別：${typeName}`, 'leave_request', req.id);
      }
      // 宛先で「社長」を選んでいれば、社長にもサイト通知（applicantは上で送信済みのため重複しない）
      await dispatchSiteNotification('leave:manager_approved', vars, { president: presidentIds }, insertNotification, 'leave_request', req.id);
      // Slack通知
      if (await shouldSend('leave:manager_approved', 'slack')) {
        await sendLeaveSlack('manager_approved', profileName || '承認者', 'マネージャー');
      }
      // メール（申請者本人＋「社長」を選んでいれば社長にも）
      await dispatchEmail('leave:manager_approved', vars, { applicant: applicantEmail, president: presidentEmails });
    } else if (req.status === 'manager_approved') {
      if (await shouldSend('leave:manager_approved', 'slack')) {
        await sendLeaveSlack('accounting_approved', profileName || '経理担当者', '管理者');
      }
    }

    window.dispatchEvent(new CustomEvent('leave-pending-changed'));
    fetchRequests();
  };

  // 一人目承認 + マネージャー指定
  const handleApproveWithManager = async () => {
    if (!selectingManagerFor || !selectedManagerId) return;
    await supabase.from('leave_requests').update({
      status: 'step2_pending',
      approver2_id: selectedManagerId,
    }).eq('id', selectingManagerFor.id);

    // Slack通知（リーダーが受理 → マネージャーへ）
    if (await shouldSend('leave:leader_approved', 'slack')) {
      const selectedManager = managers.find(m => m.id === selectedManagerId);
      await sendLeaveSlack('leader_approved', profileName || '承認者', roleTitle || 'リーダー', selectedManager?.name || '', 'マネージャー');
    }
    // サイト通知・メール
    const leaderDays = selectingManagerFor.leave_dates ? (() => { try { return String(JSON.parse(selectingManagerFor.leave_dates!).length); } catch { return ''; } })() : '';
    const leaderVars = { 休暇種別: selectingManagerFor.leave_type === 'その他' ? (selectingManagerFor.leave_type_other || 'その他') : selectingManagerFor.leave_type, 申請日数: leaderDays, リンク: 'https://fivem-portal.vercel.app/leave-approvals' };
    const applicantEmail = await getUserEmail(selectingManagerFor.user_id) ?? '';
    const managerEmail = await getUserEmail(selectedManagerId) ?? '';
    // 同じイベントでも宛先によって役割が違う（マネージャーは要対応、申請者はFYI）ため、source_typeを分けて別々に送る
    await dispatchSiteNotification('leave:leader_approved', leaderVars, { manager: selectedManagerId }, insertNotification, 'leave_request:pending_approval', selectingManagerFor.id);
    await dispatchSiteNotification('leave:leader_approved', leaderVars, { applicant: selectingManagerFor.user_id }, insertNotification, 'leave_request', selectingManagerFor.id);
    // recipient設定が'approver'の場合も解決できるよう、manager宛のメールアドレスをapproverキーにも渡す
    await dispatchEmail('leave:leader_approved', leaderVars, { applicant: applicantEmail, manager: managerEmail, approver: managerEmail });

    setSelectingManagerFor(null);
    window.dispatchEvent(new CustomEvent('leave-pending-changed'));
    fetchRequests();
  };

  const handleReject = async () => {
    if (!rejectingReq) return;
    const finalReason = rejectNewType
      ? `種別を「${rejectNewType}」に変更しました。${rejectReason ? `　理由：${rejectReason}` : ''}`
      : (rejectReason || null);
    const update: Record<string, string | null> = { status: 'rejected', rejected_reason: finalReason };
    if (rejectNewType) update.leave_type = rejectNewType;
    await supabase.from('leave_requests').update(update).eq('id', rejectingReq.id);

    // 差し戻し時にGoogleカレンダーのイベントを削除
    try {
      await supabase.functions.invoke('gcal-sync', {
        body: { action: 'delete', source_type: 'leave', source_id: rejectingReq.id },
      });
    } catch (e) {
      console.error('[gcal-sync] 削除失敗:', e);
    }

    // 申請者へ差し戻し通知（サイト内通知・Slack・メール）
    const rejectTypeName = rejectingReq.leave_type === 'その他' ? (rejectingReq.leave_type_other || 'その他') : rejectingReq.leave_type;
    const rejectVars = { 申請者名: rejectingReq.requester?.name || '', 休暇種別: rejectTypeName, 差し戻し理由: rejectReason || '', リンク: 'https://fivem-portal.vercel.app/leave?tab=history' };
    if (await shouldSend('leave:rejected', 'site')) {
      const t = await getNotificationTemplate('leave:rejected', 'site', rejectVars);
      await insertNotification(rejectingReq.user_id, t?.template ?? `休暇申請が差し戻されました`, t?.subject || rejectReason || undefined, 'leave_request:pending_resubmit', rejectingReq.id, 'leave:rejected');
    }
    if (await shouldSend('leave:rejected', 'slack')) {
      const targetChannel = await getNotificationRecipient('leave:rejected', 'slack');
      await sendLeaveSlack('rejected', profileName || '承認者', roleTitle || '承認者', undefined, undefined, targetChannel ?? 'leader');
    }
    const rejectedEmail = await getUserEmail(rejectingReq.user_id) ?? '';
    await dispatchEmail('leave:rejected', rejectVars, { applicant: rejectedEmail });

    setRejectingReq(null);
    setRejectReason('');
    setRejectNewType('');
    window.dispatchEvent(new CustomEvent('leave-pending-changed'));
    fetchRequests();
  };

  const calcDays = (s: string, e: string) => {
    const diff = Math.floor((new Date(e).getTime() - new Date(s).getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return diff > 0 ? diff : 0;
  };

  // 受理ボタンのラベル
  const getApproveLabel = (status: string) => {
    if (status === 'pending') return '✅ 受理してマネージャーへ送る';
    if (status === 'step2_pending') return '✅ マネージャー受理';
    if (status === 'manager_approved') return '✅ 経理受理へ進める';
    if (status === 'admin_approved') return '✅ 最終受理（完了）';
    return '✅ 受理';
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
      {partSendSuccess && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 240 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{partSendSuccess}</span>
          <button type="button" onClick={() => setPartSendSuccess(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}

      {/* パートへ申請フォーム送信 */}
      {(() => {
        const canSeeAll = isAdmin || roleTitle === 'マネージャー' || roleTitle === '社長' || roleTitle === '管理者';
        const isLeader = roleTitle === 'リーダー';
        // リーダーは自分が送ったものだけ表示
        const visibleEnabled = partUsers.filter(u =>
          u.leave_request_enabled && (canSeeAll ? true : u.leave_enabled_by === user.id)
        );
        return (
          <div style={{ background: isDark ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
            <p style={{ fontWeight: 'bold', fontSize: 13, color: isDark ? '#fff' : '#333', marginBottom: 8 }}>📨 パート・アルバイトへ休暇申請フォームを送信</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select id="part-leave-target-approvals" style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : 'white', color: isDark ? '#fff' : '#000', fontSize: 13 }}>
                <option value="">-- パート・アルバイトを選択 --</option>
                {partUsers.filter(u => !u.leave_request_enabled).map(u => (
                  <option key={u.id} value={u.id}>{u.name || u.email}</option>
                ))}
              </select>
              <button
                onClick={async () => {
                  const sel = document.getElementById('part-leave-target-approvals') as HTMLSelectElement;
                  const userId = sel?.value;
                  if (!userId) { alert('パートを選択してください'); return; }
                  const target = partUsers.find(u => u.id === userId);
                  if (!target) return;
                  if (!window.confirm(`「${target.name || target.email}」さんに申請フォームを送信しますか？`)) return;
                  const { error } = await supabase.from('profiles').update({ leave_request_enabled: true, leave_enabled_by: user.id }).eq('id', userId);
                  if (error) { alert('送信に失敗しました: ' + error.message); return; }
                  setPartUsers(prev => prev.map(u => u.id === userId ? { ...u, leave_request_enabled: true, leave_enabled_by: user.id } : u));
                  setPartSendSuccess(`「${target.name || target.email}」さんに送信しました`);
                  setTimeout(() => setPartSendSuccess(null), 3000);
                }}
                style={{ padding: '6px 16px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13, whiteSpace: 'nowrap' }}
              >送信</button>
            </div>
            {visibleEnabled.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#666', marginBottom: 4 }}>
                  現在フォーム表示中{isLeader ? '（自分が送ったもの）' : ''}：
                </p>
                {visibleEnabled.map(u => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: isDark ? '#fff' : '#333' }}>✅ {u.name || u.email}</span>
                    {(canSeeAll || u.leave_enabled_by === user.id) && (
                      <button
                        onClick={async () => {
                          await supabase.from('profiles').update({ leave_request_enabled: false, leave_enabled_by: null }).eq('id', u.id);
                          setPartUsers(prev => prev.map(p => p.id === u.id ? { ...p, leave_request_enabled: false, leave_enabled_by: null } : p));
                        }}
                        style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11 }}
                      >取り消し</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ padding: 24, background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 20, color: text }}>🌿 休暇申請 確認待ち一覧</h2>
          <button
            onClick={() => navigate('/')}
            style={{ width: 24, height: 24, borderRadius: '50%', border: 'none', background: isDark ? '#6c757d' : '#dee2e6', color: text, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        {isAdmin && (
          <p style={{ marginBottom: 20, fontSize: 13, color: subText, background: isDark ? '#495057' : '#f8f9fa', padding: '8px 12px', borderRadius: 8 }}>
            管理者として全ての申請を確認・受理できます。処理が止まっている場合は強制的に次のステップへ進められます。
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
              const isFocused = highlightId === req.id;
              return (
                <div
                  key={req.id}
                  ref={el => { if (el && isFocused) focusRef.current = el; }}
                  style={{ padding: 16, borderRadius: 10, border: `1px solid ${isFocused ? '#f0c000' : borderColor}`, background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : (isDark ? '#495057' : '#fafafa'), transition: 'background 0.6s, border-color 0.6s' }}
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
                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 'bold', background: '#e67e22', color: 'white' }}>
                      {STATUS_LABEL[req.status] || req.status}
                    </span>
                  </div>

                  <div style={{ color: subText, fontSize: 14, marginBottom: 6 }}>
                    {req.start_date} ～ {req.end_date}（{days}日間）
                  </div>
                  {/* 勤務校（日付ごと・1日1行。校なしの旧申請は非表示） */}
                  {(() => {
                    const parseLocs = (s?: string | null): Record<string, string> | undefined => {
                      try { return s ? JSON.parse(s) : undefined; } catch { return undefined; }
                    };
                    const renderLocs = (label: string, locs?: Record<string, string>) => {
                      if (!locs || Object.keys(locs).length === 0) return null;
                      const entries = Object.keys(locs).sort();
                      const uniq = [...new Set(Object.values(locs).filter(Boolean))];
                      return (
                        <div style={{ color: subText, fontSize: 13, marginBottom: 6 }}>
                          {label}: {entries.length === 1 || uniq.length === 1 ? (
                            <span>{uniq[0] ?? '—'}{entries.length > 1 ? '（全日）' : ''}</span>
                          ) : (
                            entries.map(d => (
                              <div key={d} style={{ paddingLeft: 8 }}>
                                {parseInt(d.slice(5, 7))}/{parseInt(d.slice(8, 10))}（{'日月火水木金土'[new Date(d + 'T00:00:00').getDay()]}）　{locs[d] || '—'}
                              </div>
                            ))
                          )}
                        </div>
                      );
                    };
                    return (
                      <>
                        {renderLocs('校', parseLocs(req.leave_locations))}
                        {renderLocs('振替元校', parseLocs(req.chosei_origin_locations))}
                      </>
                    );
                  })()}
                  {req.reason && (
                    <div style={{ color: subText, fontSize: 13, marginBottom: 8 }}>
                      {(() => {
                        const displayReason = req.reason.replace(/[\s　]?【再申請】元申請ID: \S+/g, '').trim();
                        const isReapply = req.reason.includes('【再申請】');
                        return (
                          <>
                            {displayReason && <>理由: {displayReason}</>}
                            {isReapply && <span style={{ marginLeft: 6, fontSize: 11, background: '#007bff', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>再申請</span>}
                          </>
                        );
                      })()}
                    </div>
                  )}
                  <div style={{ color: isDark ? '#6c757d' : '#aaa', fontSize: 12, marginBottom: 12 }}>
                    申請日: {new Date(req.created_at).toLocaleDateString('ja-JP')}
                  </div>

                  {req.status === 'rejected' ? (
                    <div>
                      <div style={{ padding: '6px 10px', background: isDark ? '#5a1a1a' : '#f8d7da', borderRadius: 6, color: isDark ? '#f5c6cb' : '#721c24', fontSize: 13, marginBottom: 8 }}>
                        差し戻し済み{req.rejected_reason ? `：${req.rejected_reason}` : ''}
                      </div>
                      <button
                        onClick={async () => {
                          if (!window.confirm('差し戻しを取り消して自分の確認待ちに戻しますか？')) return;
                          // 自分が一人目か二人目かでステータスを分ける
                          const backStatus = req.approver2_id === user.id ? 'step2_pending' : 'pending';
                          await supabase.from('leave_requests').update({ status: backStatus, rejected_reason: null }).eq('id', req.id);
                          window.dispatchEvent(new CustomEvent('leave-pending-changed'));
                          fetchRequests();
                        }}
                        style={{ width: '100%', padding: '8px', background: '#6c757d', color: 'white', border: '2px solid #545b62', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
                      >↩ 差し戻しを取り消す</button>
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
                        onClick={() => { setRejectingReq(req); setRejectReason(''); setRejectNewType(''); }}
                        style={{ flex: 1, padding: '8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
                      >
                        ↩ 差し戻し
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
                受理して送る
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 差し戻しモーダル */}
      {rejectingReq && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%' }}>
            <h3 style={{ marginBottom: 4, color: text }}>差し戻し</h3>
            <div style={{ fontSize: 13, color: subText, marginBottom: 16 }}>
              {rejectingReq.requester?.name}　{rejectingReq.leave_type === 'その他' ? rejectingReq.leave_type_other : rejectingReq.leave_type}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: subText, marginBottom: 6 }}>種別を変更する（任意）</div>
              <select value={rejectNewType} onChange={e => setRejectNewType(e.target.value)}
                style={{ width: '100%', padding: '8px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: text }}>
                <option value="">変更しない</option>
                {LEAVE_TYPES.filter(t => t !== (rejectingReq.leave_type === 'その他' ? rejectingReq.leave_type_other : rejectingReq.leave_type)).map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {rejectNewType && (
                <div style={{ fontSize: 12, color: '#e65100', marginTop: 4 }}>
                  「{rejectingReq.leave_type}」→「{rejectNewType}」に変更して差し戻します
                </div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: subText, marginBottom: 6 }}>差し戻し理由（任意）</div>
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                placeholder="差し戻し理由を入力してください" rows={3}
                style={{ width: '100%', padding: '10px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: inputBg, color: text, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setRejectingReq(null); setRejectReason(''); setRejectNewType(''); }}
                style={{ flex: 1, padding: '10px', background: isDark ? '#495057' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', color: text }}>
                キャンセル
              </button>
              <button onClick={handleReject}
                style={{ flex: 1, padding: '10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold' }}>
                差し戻す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveApprovals;
