import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { insertNotificationChecked } from '../lib/notifications';
import { notifyAppRequestChanged } from '../lib/appRequests';
import { BTN_BLUE } from '../lib/buttonStyles';
import { RequestBoxFrame, RequestList, RequestRow } from './RequestBox';

/**
 * 📋 パート・アルバイトへ 休暇申請を依頼（もとは「📨 パート・アルバイトへ 休暇申請フォームを送信」）。
 * 選んだパートの方の休暇申請の画面に、申請フォームを出す（profiles.leave_request_enabled）。本人が申請すると自動で消える
 * （LeaveRequest の clear_own_leave_request_enabled）。
 * 2026-10-15 ユーザー確定で作り直した：
 * ・見た目は「📩 正社員へ 申請を依頼」と同じ（components/RequestBox）。件数「未申請 N件」・一覧の行・取り下げの確かめ方
 * ・依頼したら本人にお知らせ（ベル・スマホ）を送る（前は何も届かなかった）
 * ・🐛 リーダーには一覧が出ていなかった（leave_enabled_by を読んでいなかった）／取り下げの失敗を見ていなかった／本人が申請しても開き直すまで残った
 * 🚨 置き場所：休暇申請のページの「📩 申請の依頼」タブと、管理画面の休暇のタブ。中身を2か所に書かない
 * 🚨 書き込みは RPC set_leave_request_enabled（リーダー以上か管理者。DB で確かめる）
 */
interface Props {
  userId: string;
  profileName: string | null;
  isDark: boolean;
  /** ほかの上長が出したものも見る・取り下げられる（マネージャー以上・管理者） */
  canSeeAll: boolean;
  style?: React.CSSProperties;
}

interface PartUser {
  id: string; name: string | null; email: string | null;
  leave_request_enabled: boolean | null; leave_enabled_by: string | null;
}

const PartLeaveFormBox: React.FC<Props> = ({ userId, profileName, isDark, canSeeAll, style }) => {
  const [parts, setParts] = useState<PartUser[]>([]);
  const [senderNames, setSenderNames] = useState<Map<string, string>>(new Map());
  const [loadErr, setLoadErr] = useState('');
  const [pickId, setPickId] = useState('');
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [sentMsg, setSentMsg] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('profiles')
      .select('id, name, email, leave_request_enabled, leave_enabled_by')
      .eq('employment_type', 'パート').eq('is_active', true).order('name');
    // 🚨 読めなかったときは空で上書きしない（「だれにも出していない」と嘘をつくため）
    if (error) { setLoadErr('パート・アルバイトの方の一覧を読み込めませんでした：' + error.message); return; }
    setLoadErr('');
    const rows = (data ?? []) as PartUser[];
    setParts(rows);
    // 送った人の名前（上長はパートの一覧に入っていないので別に読む）。読めなくても一覧は出す
    const ids = [...new Set(rows.map(r => r.leave_enabled_by).filter((x): x is string => !!x && x !== userId))];
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
      setSenderNames(new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name])));
    } else {
      setSenderNames(new Map());
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);
  // 本人が申請すると自動で消えるので、画面に戻ったときに読み直す（開きっぱなしだと残って見える）
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  const nameOf = (u: PartUser | undefined) => (u ? (u.name || u.email || '') : '');
  // 一覧に出すのは：マネージャー以上は全員分・リーダーは自分が出したものだけ
  const visible = parts.filter(u => u.leave_request_enabled && (canSeeAll || u.leave_enabled_by === userId));
  // マネージャー以上はほかの上長の分も数えるので、タブの数字（自分の分だけ）と合わせて「うち自分 N件」を添える
  const mineCount = visible.filter(u => u.leave_enabled_by === userId).length;
  const picked = parts.find(u => u.id === pickId);

  const send = async () => {
    if (!picked) return;
    setSending(true); setSendErr(''); setSentMsg('');
    const { error } = await supabase.rpc('set_leave_request_enabled', { p_user_id: picked.id, p_enabled: true });
    if (error) { setSending(false); setSendErr('依頼できませんでした：' + error.message); return; }
    // 本人へのお知らせ（2026-10-15 ユーザー確定 A）。ベルを押すと休暇申請のページが開く。
    // 🚨 種類は休暇の申請依頼と同じ（application_request:received:leave）＝スマホの文・通知の設定もそれに従う
    const notifyErr = await insertNotificationChecked(
      picked.id,
      // 文の形は休暇の申請依頼（ApplicationRequestSheet）とそろえる
      `📩 ${profileName ? `${profileName}さんより` : '上長より'}申請依頼：休暇`,
      '「休暇申請」のページの「🌿 休暇」から申請してください',
      'application_request:received:leave',
      undefined,
      'application_request:received:leave',
    );
    setSending(false); setAsking(false); setPickId('');
    setSentMsg(notifyErr
      ? `${nameOf(picked)}さんに休暇申請を依頼しました。お知らせは送れなかったので、直接お声がけください。`
      : `${nameOf(picked)}さんに休暇申請を依頼しました。本人にお知らせが届きます。`);
    notifyAppRequestChanged();
    await load();
  };

  const withdraw = async (u: PartUser): Promise<string | null> => {
    const { error } = await supabase.rpc('set_leave_request_enabled', { p_user_id: u.id, p_enabled: false });
    // 🚨 rpc は失敗しても throw しない。error を見る（前は見ておらず、失敗しても消えたように見えた）
    if (error) return '取り下げられませんでした：' + error.message;
    setSentMsg('');
    notifyAppRequestChanged();
    await load();
    return null;
  };

  const border = isDark ? '#6c757d' : '#ced4da';
  return (
    <RequestBoxFrame isDark={isDark} style={style}
      title="📋 パート・アルバイトへ 休暇申請を依頼"
      openCount={visible.length}
      openCountNote={canSeeAll && mineCount !== visible.length ? `うち自分 ${mineCount}件` : undefined}
      description={<>選んだ方の「休暇申請」のページに申請フォームが出ます。本人が申請すると、フォームとこの一覧から自動で消えます。<br />本人にはお知らせ（ベル・スマホ）が届きます。</>}
      action={<>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={pickId} onChange={e => { setPickId(e.target.value); setAsking(false); setSendErr(''); setSentMsg(''); }}
            aria-label="パート・アルバイトの方を選ぶ"
            style={{ flex: '1 1 150px', minWidth: 0, minHeight: 40, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#495057' : '#fff', color: isDark ? '#fff' : '#212529', fontSize: 14 }}>
            <option value="">名前を選んでください</option>
            {parts.map(u => (
              // 🚨 依頼済みの方も灰色で出す（前は一覧から消え、ほかの上長が出したものだと見つけられなかった）
              <option key={u.id} value={u.id} disabled={!!u.leave_request_enabled}>
                {nameOf(u)}{u.leave_request_enabled ? '（依頼済み）' : ''}
              </option>
            ))}
          </select>
          <button type="button" disabled={!pickId || sending}
            onClick={() => { setSendErr(''); setAsking(true); }}
            style={{ flex: '1 0 auto', minHeight: 40, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: pickId ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 'bold', background: BTN_BLUE, color: '#fff', opacity: pickId ? 1 : 0.5, whiteSpace: 'nowrap' }}>
            依頼する
          </button>
        </div>
        {asking && picked && (
          <div style={{ marginTop: 8, padding: '9px 11px', borderRadius: 8, background: isDark ? '#3a2e1a' : '#fff8e1', border: '1px solid #f0ad4e' }}>
            <div style={{ fontSize: 12.5, color: isDark ? '#fff' : '#333' }}>{nameOf(picked)}さんに休暇申請を依頼しますか？</div>
            <div style={{ fontSize: 11.5, color: isDark ? '#adb5bd' : '#6c757d', marginTop: 2 }}>本人の画面に申請フォームが出て、お知らせが届きます</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" disabled={sending} onClick={() => setAsking(false)}
                style={{ flex: 1, minHeight: 36, borderRadius: 8, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: isDark ? '#dee2e6' : '#495057' }}>やめる</button>
              <button type="button" disabled={sending} onClick={() => void send()}
                style={{ flex: 2, minHeight: 36, borderRadius: 8, fontSize: 13, fontWeight: 'bold', cursor: sending ? 'not-allowed' : 'pointer', border: 'none', background: BTN_BLUE, color: '#fff', opacity: sending ? 0.6 : 1 }}>
                {sending ? '依頼中…' : '依頼する'}
              </button>
            </div>
          </div>
        )}
        {sentMsg && (
          <div style={{ marginTop: 8, padding: '8px 11px', borderRadius: 8, fontSize: 12.5, background: isDark ? '#14532d' : '#f0fdf4', border: `1px solid ${isDark ? '#166534' : '#86efac'}`, color: isDark ? '#bbf7d0' : '#166534' }}>✓ {sentMsg}</div>
        )}
      </>}
      error={loadErr || sendErr}
    >
      {visible.length > 0 && (
        <RequestList isDark={isDark}>
          {visible.map(u => (
            <RequestRow key={u.id} isDark={isDark}
              name={nameOf(u)}
              details={[
                '休暇',
                // マネージャー以上は、ほかの上長が出したものも見えるので「送った人」を添える
                ...(u.leave_enabled_by && u.leave_enabled_by !== userId ? [`送った人：${senderNames.get(u.leave_enabled_by) ?? '—'}`] : []),
              ]}
              status={{ text: '未申請', tone: 'open' }}
              onWithdraw={() => withdraw(u)}
              withdrawNote="本人の画面から申請フォームが消えます"
            />
          ))}
        </RequestList>
      )}
    </RequestBoxFrame>
  );
};

export default PartLeaveFormBox;
