import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { notifyAppRequestChanged } from '../lib/appRequests';
import { BTN_BLUE } from '../lib/buttonStyles';
import ApplicationRequestSheet from './ApplicationRequestSheet';
import { RequestBoxFrame, RequestList, RequestRow } from './RequestBox';

/**
 * 📩 正社員へ 申請を依頼（2026-09-09 ユーザー確定）。［依頼を作る］と、自分が出した依頼の一覧・取り下げ。
 * 🚨 置き場所は2つ（2026-10-15 ユーザー確定）：休暇申請のページと残業・時間のページの、2段目のタブ「📩 申請の依頼」。
 *    どちらもこの部品を置くだけ。中身を2か所に書かない（片方だけ直す事故になる）。
 * 🚨 見た目（見出し・件数・一覧の行・取り下げの確かめ）は components/RequestBox（パートの枠と共用）。
 * 🚨 出すかどうかは管理画面「役職・機能権限」→「📩 申請の依頼」（useAuth の canApplicationRequest）。呼ぶ側で絞る。
 */
interface Props {
  userId: string;
  profileName: string | null;
  isDark: boolean;
  /**
   * パート・アルバイトの方の休暇の案内（説明の2行目）。
   * below＝下に「📋 パート・アルバイトへ」の枠がある（休暇申請のページ）／leavePage＝休暇申請のページへ案内（残業・時間のページ）／none＝パートの方へは出せない（権限なし）
   */
  partNote: 'below' | 'leavePage' | 'none';
  style?: React.CSSProperties;
}

interface MyRequest {
  id: string; recipient_id: string; kind: string; target_dates: string[] | null;
  status: string; recipient_name?: string | null;
  /** 相手が「消す」ときに選んだ理由（2026-09-10）。dismissed のときだけ出す */
  recipient_note?: string | null;
}

const STATUS_TEXT: Record<string, string> = { open: '未申請', applied: '申請済み ✓', dismissed: '対応しない', withdrawn: '依頼を取り下げ済み' };

const AppRequestBox: React.FC<Props> = ({ userId, profileName, isDark, partNote, style }) => {
  const [showRequestSheet, setShowRequestSheet] = useState(false);
  const [myRequests, setMyRequests] = useState<MyRequest[]>([]);
  // 「対応しない」の知らせから ?focus=<依頼ID> で来たとき、依頼一覧の該当行を光らせる（2026-09-11）
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

  /** 取り下げ。失敗したら理由の文を返す（行の中に出す） */
  const withdrawRequest = async (id: string): Promise<string | null> => {
    // 🚨 update は0件でもエラーにならない。件数を見る
    const { data, error } = await supabase.from('application_requests')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'open').select('id');
    if (error) return '取り下げられませんでした：' + error.message;
    if (!data || data.length === 0) { void fetchMyRequests(); return '取り下げられませんでした（すでに申請された可能性があります）'; }
    setMyRequests(prev => prev.map(r => (r.id === id ? { ...r, status: 'withdrawn' } : r)));
    notifyAppRequestChanged();
    return null;
  };

  const openRows = myRequests.filter(r => r.status === 'open');
  const doneRows = myRequests.filter(r => r.status !== 'open');
  // 「対応しない」の知らせから来たとき、光らせる行が「済んだもの」の中にあれば開く（閉じたままだと見つからない）
  const focusInDone = !!reqHighlightId && doneRows.some(r => r.id === reqHighlightId);
  useEffect(() => { if (focusInDone) setShowDoneRequests(true); }, [focusInDone]);
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const row = (r: MyRequest) => (
    <RequestRow key={r.id} isDark={isDark}
      name={r.recipient_name ?? ''}
      details={[
        (r.target_dates ?? []).map(d => d.slice(5).replace('-', '/')).join('・'),
        r.kind === 'leave' ? '休暇' : '残業・勤務変更',
        // 🚨 相手が「対応しない」のときに選んだ理由（2026-09-10）。出さないとなぜ申請が来ないのか分からない
        ...(r.status === 'dismissed' && r.recipient_note ? [`（${r.recipient_note}）`] : []),
      ]}
      status={{ text: STATUS_TEXT[r.status] ?? r.status, tone: r.status === 'open' ? 'open' : r.status === 'applied' ? 'applied' : 'muted' }}
      onWithdraw={r.status === 'open' ? () => withdrawRequest(r.id) : undefined}
      withdrawNote="相手の画面から依頼が消えます"
      highlight={reqHighlightId === r.id}
      rowRef={el => { if (el && reqHighlightId === r.id) reqFocusRef.current = el; }}
    />
  );

  return (
    <>
      <RequestBoxFrame isDark={isDark} style={style}
        title="📩 正社員へ 申請を依頼"
        openCount={openRows.length}
        description={<>
          相談で聞いた内容を伝えて、本人に申請してもらいます（残業・時間管理／休暇）。<br />
          {partNote === 'below' ? 'パート・アルバイトの方の休暇は、下の「📋 パート・アルバイトへ」から依頼してください。'
            : partNote === 'leavePage' ? 'パート・アルバイトの方の休暇は、「休暇申請」のページの「📩 申請の依頼」から依頼してください。'
            : 'パート・アルバイトの方には出せません。'}
        </>}
        action={
          <button onClick={() => setShowRequestSheet(true)}
            style={{ width: '100%', minHeight: 40, padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: BTN_BLUE, color: '#fff' }}>
            依頼を作る
          </button>
        }
        error={requestErr}
      >
        {/* 自分が出した依頼の一覧。🚨 済んだもの（申請済み・対応しない・取り下げ）は折りたたむ（2026-09-26 ユーザー確定）。
            最後の更新から90日で自動で消える（cron purge-application-requests-daily） */}
        {myRequests.length > 0 && (
          <RequestList isDark={isDark}>
            {openRows.map(row)}
            {doneRows.length > 0 && (
              <button type="button" onClick={() => setShowDoneRequests(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, padding: '6px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: sub }}>
                <span>{showDoneRequests ? '▼' : '▶'} 済んだもの {doneRows.length}件（申請済み・対応しない・取り下げ）</span>
              </button>
            )}
            {showDoneRequests && doneRows.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: sub, marginBottom: 2 }}>※ 済んだものは、最後の更新から90日で自動で消えます</div>
                {doneRows.map(row)}
              </>
            )}
          </RequestList>
        )}
      </RequestBoxFrame>

      {showRequestSheet && (
        <ApplicationRequestSheet
          requesterId={userId}
          requesterName={profileName ?? ''}
          isDark={isDark}
          onClose={() => setShowRequestSheet(false)}
          onSubmitted={() => { setShowRequestSheet(false); void fetchMyRequests(); notifyAppRequestChanged(); }}
        />
      )}
    </>
  );
};

export default AppRequestBox;
