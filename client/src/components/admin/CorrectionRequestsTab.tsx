import React, { useCallback, useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { resolveCorrectionRequest, declineCorrectionRequest } from '../../lib/correctionRequest';
import type { CorrectionRequestRow } from '../../lib/correctionRequest';
import { OT_TYPE_INFO, isOvertimeType } from '../../lib/overtimeTypes';

const PURPLE = '#534AB7';
const RED = '#A32D2D';
const TYPE_LABEL: Record<string, string> = { leave: '休暇', shift: '勤務変更', overtime: '残業' };
const TYPE_TAB: Record<string, string> = { leave: 'leave_requests', shift: 'shift_reports', overtime: 'overtime_admin' };

// 状態の日本語。飛ぶ前に「もう取り消し済みか」が分かるようにするため
const STATUS_LABEL: Record<string, string> = {
  pending: '確認待ち', step2_pending: '確認待ち', manager_approved: '経理確認待ち', admin_approved: '社長確認待ち',
  approved: '受理済み', rejected: '差し戻し', cancelled: '取消済み',
  resubmitted: '再提出', confirmed: '受理済み', returned: '差し戻し',
  requested: '申請中', request_confirmed: '事前受理', reported: '実績報告済み',
};

// 対象の申請の要約（日付・種別・状態）。依頼カードに出して取り違えを防ぐ
type TargetInfo = { dateLabel: string; typeLabel: string; status: string };

const mdJp = (d: string) => {
  const p = d.split('-');
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : d;
};
const datesLabel = (leaveDates: string | null, start: string | null) => {
  let list: string[] = [];
  try { list = leaveDates ? JSON.parse(leaveDates) : []; } catch { list = []; }
  if (list.length === 0) return start ? mdJp(start) : '日付不明';
  return list.length === 1 ? mdJp(list[0]) : `${mdJp(list[0])} 他${list.length - 1}日`;
};

const CorrectionRequestsTab: React.FC = () => {
  const { supabase, isDarkMode, setActiveTab, setSuccessMsg, setFocusTarget } = useAdminPanel() as any;

  const [rows, setRows] = useState<CorrectionRequestRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  // target_id → 対象の申請の要約。キーが無い＝対象がもう存在しない（削除済み）
  const [targets, setTargets] = useState<Record<string, TargetInfo>>({});
  const [loading, setLoading] = useState(true);
  const [showHandled, setShowHandled] = useState(false);
  // 行ごとの操作状態
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [declineText, setDeclineText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#2b3035' : '#fff';
  const innerBg = isDarkMode ? '#343a40' : '#f8f9fa';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('correction_requests')
      .select('*')
      .order('created_at', { ascending: false });
    const list = (data as CorrectionRequestRow[] | null) ?? [];
    setRows(list);
    const ids = [...new Set(list.map(r => r.requester_id))];
    if (ids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, name, email').in('id', ids);
      const map: Record<string, string> = {};
      for (const p of (profs as any[] | null) ?? []) map[p.id] = p.name || p.email || '不明';
      setNames(map);
    }

    // 対象の申請の日付・種別・状態を取ってカードに出す。
    // 「どの申請への依頼か」が分からないと、飛んだ先で取り違えるため（実際に取り違えが起きた）
    const info: Record<string, TargetInfo> = {};
    const idsOf = (t: string) => [...new Set(list.filter(r => r.target_type === t).map(r => r.target_id))];

    const leaveIds = idsOf('leave');
    if (leaveIds.length) {
      const { data: lv } = await supabase.from('leave_requests')
        .select('id, leave_type, leave_type_other, chosei_sub_type, leave_dates, start_date, status').in('id', leaveIds);
      for (const r of (lv as any[] | null) ?? []) {
        const sub = r.chosei_sub_type === 'zangyou' ? '時間外調整休' : r.chosei_sub_type === 'furikae' ? '振替休日' : null;
        info[r.id] = {
          dateLabel: datesLabel(r.leave_dates, r.start_date),
          typeLabel: sub ?? (r.leave_type === 'その他' && r.leave_type_other ? r.leave_type_other : r.leave_type),
          status: STATUS_LABEL[r.status] ?? r.status,
        };
      }
    }

    const shiftIds = idsOf('shift');
    if (shiftIds.length) {
      const { data: sr } = await supabase.from('shift_reports')
        .select('id, work_date, status').in('id', shiftIds);
      for (const r of (sr as any[] | null) ?? []) {
        info[r.id] = { dateLabel: mdJp(r.work_date), typeLabel: '勤務変更', status: STATUS_LABEL[r.status] ?? r.status };
      }
    }

    const otIds = idsOf('overtime');
    if (otIds.length) {
      const { data: ot } = await supabase.from('overtime_reports')
        .select('id, work_date, application_types, status').in('id', otIds);
      for (const r of (ot as any[] | null) ?? []) {
        const labels = ((r.application_types ?? []) as string[]).filter(isOvertimeType).map(t => OT_TYPE_INFO[t].label);
        info[r.id] = {
          dateLabel: mdJp(r.work_date),
          typeLabel: labels.length ? labels.join('＋') : '残業',
          status: STATUS_LABEL[r.status] ?? r.status,
        };
      }
    }
    setTargets(info);
    setLoading(false);
  }, [supabase]);

  // 対象の申請のタブへ移動して、その行を光らせる。
  // 飛び先では絞り込みを解除する（受理済みは既定の「確認待ち」フィルタに隠れて見つけられなかった）
  const jumpToTarget = (r: CorrectionRequestRow) => {
    setFocusTarget({ type: r.target_type as 'leave' | 'shift' | 'overtime', id: r.target_id });
    setActiveTab(TYPE_TAB[r.target_type]);
  };

  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('correction-pending-changed', h);
    return () => window.removeEventListener('correction-pending-changed', h);
  }, [load]);

  const open = rows.filter(r => r.status === 'open');
  // withdrawn（本人が取り下げ）は対応履歴に出さない
  const handled = rows.filter(r => r.status === 'resolved' || r.status === 'declined');

  const doResolve = async (id: string) => {
    setErr(''); setBusy(true);
    const { error } = await resolveCorrectionRequest(id, replyText);
    setBusy(false);
    if (error) { setErr(error); return; }
    setReplyFor(null); setReplyText('');
    setSuccessMsg?.('修正依頼を対応済みにしました');
    load();
  };

  const doDecline = async (id: string) => {
    setErr('');
    if (!declineText.trim()) { setErr('対応不可の理由を入力してください'); return; }
    setBusy(true);
    const { error } = await declineCorrectionRequest(id, declineText.trim());
    setBusy(false);
    if (error) { setErr(error); return; }
    setDeclineFor(null); setDeclineText('');
    setSuccessMsg?.('修正依頼に返答しました');
    load();
  };

  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({
    padding: '8px 12px', borderRadius: 8, border: bg === 'transparent' ? `1px solid ${border}` : 'none',
    background: bg, color: fg, fontWeight: 'bold', fontSize: 13, cursor: busy ? 'default' : 'pointer',
  });
  const inputStyle: React.CSSProperties = {
    width: '100%', minHeight: 48, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`,
    background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 14, boxSizing: 'border-box', resize: 'vertical',
  };

  const renderCard = (r: CorrectionRequestRow) => {
    const isOpen = r.status === 'open';
    const isCancel = r.request_kind === 'cancel';
    const accent = isCancel ? RED : PURPLE;
    const kindChip = isCancel
      ? { label: '取消依頼', bg: isDarkMode ? '#791F1F' : '#FCEBEB', fg: isDarkMode ? '#F7C1C1' : '#A32D2D' }
      : { label: '📋 修正依頼', bg: isDarkMode ? '#3C3489' : '#EEEDFE', fg: isDarkMode ? '#CECBF6' : '#26215C' };
    const tgt = targets[r.target_id];
    const statusChip = isOpen
      ? { label: '未対応', bg: isDarkMode ? '#3C3489' : '#EEEDFE', fg: isDarkMode ? '#CECBF6' : '#26215C' }
      : r.status === 'resolved'
        ? { label: '対応済み', bg: isDarkMode ? '#0F6E56' : '#E1F5EE', fg: isDarkMode ? '#9FE1CB' : '#0F6E56' }
        : { label: '対応不可', bg: isDarkMode ? '#791F1F' : '#FCEBEB', fg: isDarkMode ? '#F7C1C1' : '#A32D2D' };
    return (
      <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: kindChip.bg, color: kindChip.fg, fontWeight: 'bold' }}>{kindChip.label}</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>{names[r.requester_id] ?? '…'}・{TYPE_LABEL[r.target_type] ?? r.target_type}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: statusChip.bg, color: statusChip.fg, fontWeight: 'bold' }}>{statusChip.label}</span>
            <span style={{ fontSize: 11, color: sub, whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</span>
          </div>
        </div>

        {/* どの申請への依頼かを明記する。日付が出ないと飛び先で取り違える */}
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          {tgt ? (
            <span style={{ color: text }}>
              対象：<strong>{tgt.dateLabel}</strong>（{tgt.typeLabel}）
              <span style={{ color: sub, marginLeft: 6 }}>／{tgt.status}</span>
            </span>
          ) : (
            <span style={{ color: '#A32D2D', fontWeight: 'bold' }}>対象の申請は削除済みです（対応済みにして片付けてください）</span>
          )}
        </div>

        {r.requested_changes && r.requested_changes.length > 0 && (
          <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 13, color: text }}>
            {r.requested_changes.map((c, i) => (
              <div key={i}><span style={{ color: sub }}>{c.label}：</span>{c.from} → <span style={{ color: PURPLE, fontWeight: 'bold' }}>{c.to}</span></div>
            ))}
          </div>
        )}
        {r.message && <div style={{ fontSize: 13, color: text, marginBottom: 8 }}><span style={{ color: sub }}>{isCancel ? '取消理由：' : '補足：'}</span>{r.message}</div>}
        {!isOpen && r.admin_reply && <div style={{ fontSize: 13, color: sub, marginBottom: 8 }}>返答：{r.admin_reply}</div>}

        {isOpen && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {tgt && (
                <button type="button" style={btn(accent)} disabled={busy}
                  onClick={() => jumpToTarget(r)}>
                  {isCancel ? `${TYPE_LABEL[r.target_type]}タブで取り消す` : `${TYPE_LABEL[r.target_type]}タブで修正する`}
                </button>
              )}
              <button type="button" style={btn('transparent', text)} disabled={busy}
                onClick={() => { setReplyFor(replyFor === r.id ? null : r.id); setDeclineFor(null); setReplyText(''); setErr(''); }}>
                対応済みにする
              </button>
              <button type="button" style={btn('transparent', text)} disabled={busy}
                onClick={() => { setDeclineFor(declineFor === r.id ? null : r.id); setReplyFor(null); setDeclineText(''); setErr(''); }}>
                対応不可…
              </button>
            </div>

            {replyFor === r.id && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: sub, marginBottom: 4 }}>本人への一言（任意）</div>
                <textarea value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="修正して受理しました 等" style={inputStyle} />
                {err && <div style={{ color: '#dc3545', fontSize: 13, marginTop: 6 }}>{err}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button type="button" style={btn('transparent', text)} onClick={() => setReplyFor(null)} disabled={busy}>やめる</button>
                  <button type="button" style={btn('#0F6E56')} onClick={() => doResolve(r.id)} disabled={busy}>{busy ? '処理中…' : '対応済みにする'}</button>
                </div>
              </div>
            )}

            {declineFor === r.id && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: sub, marginBottom: 4 }}>対応不可の理由（本人へ通知・必須）</div>
                <textarea value={declineText} onChange={e => setDeclineText(e.target.value)} placeholder="この日は既に締め処理済みのため 等" style={inputStyle} />
                {err && <div style={{ color: '#dc3545', fontSize: 13, marginTop: 6 }}>{err}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button type="button" style={btn('transparent', text)} onClick={() => setDeclineFor(null)} disabled={busy}>やめる</button>
                  <button type="button" style={btn('#A32D2D')} onClick={() => doDecline(r.id)} disabled={busy}>この理由で返答</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ textAlign: 'left' }}>
      <h3 style={{ color: text, marginTop: 0 }}>📩 修正依頼</h3>
      <p style={{ fontSize: 13, color: sub, marginTop: 0 }}>
        スタッフが申請後に送った「ここを直してほしい」の一覧です。ボタンを押すと該当タブの対象の行が黄色く光ります。反映したあと「対応済み」にしてください。
      </p>

      {loading ? (
        <p style={{ color: sub }}>読み込み中…</p>
      ) : (
        <>
          {open.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: sub, fontSize: 14, background: innerBg, borderRadius: 8 }}>未対応の修正依頼はありません</div>
          ) : (
            open.map(renderCard)
          )}

          {handled.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <button type="button" onClick={() => setShowHandled(s => !s)}
                style={{ background: 'transparent', border: `1px solid ${border}`, color: sub, borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer' }}>
                対応済み・対応不可（{handled.length}件）{showHandled ? 'を閉じる' : 'を表示'}
              </button>
              {showHandled && <div style={{ marginTop: 10 }}>{handled.map(renderCard)}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CorrectionRequestsTab;
