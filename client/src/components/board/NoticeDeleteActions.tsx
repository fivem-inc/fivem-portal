// お知らせの完全削除の確認のボタン（2026-10-30 段2-3・見本の④・ユーザー確定）。受信トレイと送信トレイの詳細の2か所が使う。
// ご提案（申請につなぐ）を使うアンケートで、承諾済み・申請待ちの方がいれば、依頼を残すか取り下げるかを選ぶ。
// ・［やめる］を左・［依頼は残して削除する］・［依頼も取り下げて削除する（◯人にお知らせが届きます）］（赤）。名前は3人まで・残りは「ほか◯人」
// 🚨 選んだ値は deleteNoticeRows → DB の board_survey_offer_release に渡る（ほかの行を消すより前に片付ける）

import React, { useEffect, useState } from 'react';
import { loadOfferStates } from '../../lib/boardOfferApi';

interface Props {
  messageId: string;
  surveyOnegai: boolean;
  isDark: boolean;
  border: string;
  subColor: string;
  profiles: { id: string; name: string | null }[];
  deleteLabel: string;
  onCancel: () => void;
  onDelete: (keepOfferRequests: boolean) => void;
}

const NoticeDeleteActions: React.FC<Props> = ({ messageId, surveyOnegai, isDark, border, subColor, profiles, deleteLabel, onCancel, onDelete }) => {
  const [pending, setPending] = useState<string[] | null>(surveyOnegai ? null : []);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!surveyOnegai) return;
    let alive = true;
    void loadOfferStates(messageId).then(r => {
      if (!alive) return;
      if (r.error) { setErr(r.error); setPending([]); return; }
      setPending(r.states.filter(s => s.label === 'accepted_unapplied').map(s => s.recipient_id));
    });
    return () => { alive = false; };
  }, [messageId, surveyOnegai]);

  const cancelBtn = (
    <button type="button" onClick={onCancel}
      style={{ flex: 1, padding: '10px 0', minHeight: 44, background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>やめる</button>
  );
  if (pending === null) {
    return <div style={{ display: 'flex', gap: 8 }}>{cancelBtn}<span style={{ flex: 1, fontSize: 13, color: subColor, alignSelf: 'center' }}>確かめています…</span></div>;
  }
  if (pending.length === 0) {
    return (
      <div>
        {err && <div style={{ fontSize: 12, color: '#dc3545', marginBottom: 8 }}>ご提案の状態を{err}（削除すると、承諾済みの依頼は残ります）</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          {cancelBtn}
          <button data-net="write" type="button" onClick={() => onDelete(true)}
            style={{ flex: 1, padding: '10px 0', minHeight: 44, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{deleteLabel}</button>
        </div>
      </div>
    );
  }
  const names = pending.map(id => profiles.find(p => p.id === id)?.name || '不明');
  const shown = names.slice(0, 3).join('・') + (names.length > 3 ? ` ほか${names.length - 3}人` : '');
  return (
    <div>
      <div style={{ background: isDark ? '#4a3a1a' : '#fff3cd', border: '1px solid #ffe08a', borderRadius: 8, padding: '8px 10px', color: isDark ? '#ffcf8f' : '#664d03', fontSize: 13, marginBottom: 6 }}>
        承諾済みで、まだ申請していない方が <b>{pending.length}人</b> います（{shown}）。<br />申請の依頼をどうしますか？
      </div>
      <div style={{ fontSize: 12, color: subColor, marginBottom: 8 }}>申請済みの申請は、どちらを選んでも消えません。</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button data-net="write" type="button" onClick={() => onDelete(true)}
          style={{ padding: '10px 0', minHeight: 44, background: 'none', border: `1px solid ${border}`, color: isDark ? '#f8f9fa' : '#212529', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>依頼は残して削除する</button>
        <button data-net="write" type="button" onClick={() => onDelete(false)}
          style={{ padding: '10px 0', minHeight: 44, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>依頼も取り下げて削除する（{pending.length}人にお知らせが届きます）</button>
        {cancelBtn}
      </div>
    </div>
  );
};

export default NoticeDeleteActions;
