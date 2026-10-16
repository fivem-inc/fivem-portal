import React, { useState } from 'react';
import type { CorrectionRequestRow } from '../lib/correctionRequest';
import { correctionSummary } from '../lib/correctionNotice';

// 管理画面の一覧・上長の受理待ち／確認待ちで、元の申請の行に「修正依頼が来ている」ことを出す（2026-10-16 ユーザー確定）。
// それまでは修正依頼のタブにしか出ず、元の申請の行には何も出なかった（休暇・残業・勤務変更とも）。
// 🚨 本人の履歴のバッジ（CorrectionBadgeAndButton）とは別。こちらは「見る側」の表示だけ（依頼の対応は修正依頼のタブで行う）
// 🚨 5つの画面（管理画面の休暇・残業・勤務変更／上長の休暇の受理待ち・残業の確認待ち）が同じものを使う。書き写さない

const mdOf = (iso: string | null) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
};

interface Props {
  latest: CorrectionRequestRow | null | undefined;
  isDark: boolean;
  /** 管理画面：押すと修正依頼のタブのその依頼へ。無いとき（上長の画面）は、その場で依頼の中身を開く */
  onOpen?: () => void;
}

const CorrectionNotice: React.FC<Props> = ({ latest, isDark, onOpen }) => {
  const [expanded, setExpanded] = useState(false);
  if (!latest) return null;
  const word = latest.request_kind === 'cancel' ? '取消依頼' : '修正依頼';

  // 対応が済んだもの：灰色で小さく（対応不可も同じ形・本人の画面の言葉にそろえる）
  if (latest.status !== 'open') {
    const label = latest.status === 'resolved' ? '対応済み' : '対応不可';
    return (
      <div style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, background: isDark ? '#343a40' : '#e9ecef', color: isDark ? '#adb5bd' : '#6c757d', textAlign: 'left' }}>
        📩 {word}：{label}（{mdOf(latest.resolved_at ?? latest.created_at)}）
      </div>
    );
  }

  // 対応待ち：黄色（🎨🔒 固定色・ダークでも同じ）
  const linkBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', padding: 0, marginLeft: 6, color: '#856404', fontWeight: 'bold',
    textDecoration: 'underline', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  };
  return (
    <div style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404', textAlign: 'left', lineHeight: 1.6 }}>
      <b>📩 {word}あり（対応待ち）</b>：{correctionSummary(latest)}
      {onOpen ? (
        <button type="button" style={linkBtn} onClick={onOpen}>依頼を見る ›</button>
      ) : (
        <button type="button" style={linkBtn} onClick={() => setExpanded(v => !v)}>{expanded ? '閉じる' : '依頼を見る ▾'}</button>
      )}
      {!onOpen && expanded && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px dashed #ffc107' }}>
          {latest.requested_changes?.map((c, i) => <div key={i}>{c.label}：{c.from} → <b>{c.to}</b></div>)}
          {latest.message && <div>{latest.request_kind === 'cancel' ? '取消理由' : '補足'}：{latest.message}</div>}
          <div>送った日：{mdOf(latest.created_at)}／対応は経理が行います</div>
        </div>
      )}
    </div>
  );
};

export default CorrectionNotice;
