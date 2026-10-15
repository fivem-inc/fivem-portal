import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import ApplicationRequestSheet from './ApplicationRequestSheet';

/**
 * 📩 正社員へ 申請を依頼（2026-09-09 ユーザー確定）。［依頼を作る］と、自分が出した依頼の一覧・取り下げ。
 * 🚨 置き場所は2つ（2026-10-15 ユーザー確定・案A）：休暇の受理ページと、残業の確認ページ。
 *    どちらもこの部品を置くだけ。中身を2か所に書かない（片方だけ直す事故になる）。
 *    休暇の受理ページだけでは、残業の依頼を作りたい上長が場所に迷った（10/15 実機）。
 * 🚨 出すかどうかは管理画面「役職・機能権限」→「📩 申請の依頼」（useAuth の canApplicationRequest）。呼ぶ側で絞る。
 */
interface Props {
  userId: string;
  profileName: string | null;
  isDark: boolean;
  /** 下に「パート・アルバイトへ フォームを送信」の枠があるか（休暇の受理ページ）。説明の文が変わる */
  partFormBelow?: boolean;
  style?: React.CSSProperties;
}

interface MyRequest {
  id: string; recipient_id: string; kind: string; target_dates: string[] | null;
  status: string; recipient_name?: string | null;
  /** 相手が「消す」ときに選んだ理由（2026-09-10）。dismissed のときだけ出す */
  recipient_note?: string | null;
}

const AppRequestBox: React.FC<Props> = ({ userId, profileName, isDark, partFormBelow, style }) => {
  const [showRequestSheet, setShowRequestSheet] = useState(false);
  const [myRequests, setMyRequests] = useState<MyRequest[]>([]);
  // 「対応しない」の知らせから ?focus=<依頼ID> で来たとき、依頼一覧の該当行を光らせる（2026-09-11）。
  // 🚨 休暇の受理ページでは休暇申請用のフックと2つ並ぶが噛み合わない：どちらも同じ ?focus= を読むが、
  //    合致する行があるほうだけが focusRef を受け取る（ID は別々の表の UUID）
  const { highlightId: reqHighlightId, focusRef: reqFocusRef } = useFocusHighlight(myRequests);
  const [requestErr, setRequestErr] = useState('');
  const [showDoneRequests, setShowDoneRequests] = useState(false); // 済んだ依頼を開いているか（既定は閉じる）

  const fetchMyRequests = useCallback(async () => {
    const { data, error } = await supabase.from('application_requests')
      .select('id, recipient_id, kind, target_dates, status, recipient_note')
      .eq('requester_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    // 🚨 読めなかったときは空で上書きしない（「依頼が無い」と嘘をつくため）
    if (error) { setRequestErr('依頼の一覧を読み込めませんでした：' + error.message); return; }
    setRequestErr('');
    const rows = (data ?? []) as MyRequest[];
    const ids = [...new Set(rows.map(r => r.recipient_id))];
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
      const nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p2 => [p2.id, p2.name]));
      setMyRequests(rows.map(r => ({ ...r, recipient_name: nameOf.get(r.recipient_id) ?? null })));
    } else {
      setMyRequests(rows);
    }
  }, [userId]);

  useEffect(() => { fetchMyRequests(); }, [fetchMyRequests]);

  const withdrawRequest = async (id: string) => {
    setRequestErr('');
    // 🚨 update は0件でもエラーにならない。件数を見る
    const { data, error } = await supabase.from('application_requests')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'open').select('id');
    if (error) { setRequestErr('取り下げできませんでした：' + error.message); return; }
    if (!data || data.length === 0) { setRequestErr('取り下げできませんでした（すでに申請された可能性があります）'); fetchMyRequests(); return; }
    setMyRequests(prev => prev.map(r => (r.id === id ? { ...r, status: 'withdrawn' } : r)));
  };

  const sub = isDark ? '#adb5bd' : '#6c757d';
  return (
    <>
      <div style={{ background: isDark ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, ...style }}>
        {/* 🚨 「パート・アルバイトへ」の枠と、見出しの形（◯◯へ ＋ 何をするか）と
            並び（見出し → 説明 → 横いっぱいのボタン）をそろえる（2026-09-09 実機指摘） */}
        <p style={{ fontWeight: 'bold', fontSize: 13, color: isDark ? '#fff' : '#333', marginBottom: 6 }}>📩 正社員へ 申請を依頼</p>
        <p style={{ fontSize: 12, color: sub, margin: '0 0 10px', lineHeight: 1.7 }}>
          相談で聞いた内容を伝えて、本人に申請してもらいます（残業・時間管理／休暇）。<br />
          {partFormBelow
            ? 'パート・アルバイトの方には出せません（休暇は下の「フォームを送信」をお使いください）。'
            : 'パート・アルバイトの方には出せません（休暇は、休暇の受理ページの「フォームを送信」をお使いください）。'}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setShowRequestSheet(true)}
            style={{ flex: 1, minWidth: 160, padding: '8px 18px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
            依頼を作る
          </button>
          {myRequests.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap', color: myRequests.some(r => r.status === 'open') ? '#b7770d' : sub }}>
              未申請 {myRequests.filter(r => r.status === 'open').length}件
            </span>
          )}
        </div>
        {/* 自分が出した依頼の一覧。出しっぱなしにせず、状態と取り下げをここで見る。
            🚨 済んだもの（申請済み・対応しない・取り下げ）は折りたたむ（2026-09-26 ユーザー確定）。
               最後の更新から90日で自動で消える（cron purge-application-requests-daily） */}
        {myRequests.length > 0 && (
          <div style={{ marginTop: 10, borderTop: `1px solid ${isDark ? '#495057' : '#dee2e6'}`, paddingTop: 8 }}>
            {myRequests.filter(r => r.status !== 'open').length > 0 && (
              <button type="button" onClick={() => setShowDoneRequests(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, padding: '3px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: sub }}>
                <span>{showDoneRequests ? '▼' : '▶'} 済んだもの {myRequests.filter(r => r.status !== 'open').length}件（申請済み・対応しない・取り下げ）</span>
              </button>
            )}
            {showDoneRequests && myRequests.some(r => r.status !== 'open') && (
              <div style={{ fontSize: 11, color: sub, marginBottom: 4 }}>※ 済んだものは、最後の更新から90日で自動で消えます</div>
            )}
            {myRequests.filter(r => r.status === 'open' || showDoneRequests).map(r => (
              <div key={r.id}
                ref={el => { if (el && reqHighlightId === r.id) reqFocusRef.current = el; }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '5px 0', fontSize: 12, color: isDark ? '#dee2e6' : '#495057',
                  // 🚨 色は既存のハイライトと同じ（新しい色は足さない）
                  background: reqHighlightId === r.id ? (isDark ? '#4a4423' : '#fff9c4') : 'transparent', transition: 'background 0.6s' }}>
                <span style={{ fontWeight: 'bold' }}>{r.recipient_name ?? ''}</span>
                <span>{(r.target_dates ?? []).map(d => d.slice(5).replace('-', '/')).join('・')}</span>
                <span>{r.kind === 'leave' ? '休暇' : '残業・勤務変更'}</span>
                <span style={{ color: r.status === 'open' ? '#b7770d' : r.status === 'applied' ? '#1e8449' : sub }}>
                  {r.status === 'open' ? '未申請' : r.status === 'applied' ? '申請済み ✓' : r.status === 'dismissed' ? '対応しない' : '依頼を取り下げ済み'}
                </span>
                {/* 🚨 相手が「消す」ときに選んだ理由を出す（2026-09-10）。出さないとなぜ申請が来ないのか分からない */}
                {r.status === 'dismissed' && r.recipient_note && (
                  <span style={{ color: sub }}>（{r.recipient_note}）</span>
                )}
                {r.status === 'open' && (
                  <button onClick={() => withdrawRequest(r.id)}
                    style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11, cursor: 'pointer', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, background: 'transparent', color: sub }}>
                    依頼を取り下げる
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {requestErr && <div style={{ marginTop: 8, fontSize: 12, color: '#dc3545' }}>{requestErr}</div>}
      </div>

      {showRequestSheet && (
        <ApplicationRequestSheet
          requesterId={userId}
          requesterName={profileName ?? ''}
          isDark={isDark}
          onClose={() => setShowRequestSheet(false)}
          onSubmitted={() => { setShowRequestSheet(false); fetchMyRequests(); }}
        />
      )}
    </>
  );
};

export default AppRequestBox;
