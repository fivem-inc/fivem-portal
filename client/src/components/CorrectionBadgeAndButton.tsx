import React, { useState } from 'react';
import CorrectionRequestModal from './CorrectionRequestModal';
import type { CorrectionField } from './CorrectionRequestModal';
import { withdrawCorrectionRequest } from '../lib/correctionRequest';
import type { CorrectionRequestRow, CorrectionTargetType, CorrectionRequestKind } from '../lib/correctionRequest';

// 本人の履歴カードに置く「依頼中/対応済み/対応不可バッジ ＋ 依頼ボタン(修正/取消) ＋ 取り下げ ＋ モーダル」一式。
// 3つの本人ビュー（休暇・勤務変更・残業）で共通利用する。
interface Props {
  targetType: CorrectionTargetType;
  targetId: string;
  targetLabel: string;
  fields: CorrectionField[];
  requesterName: string;
  isDark: boolean;
  latest: CorrectionRequestRow | null;   // この申請に紐づく最新の依頼（無ければnull）
  canRequest: boolean;                    // 依頼ボタンを出す条件（承認後など）
  onSubmitted: () => void;                // 送信・取り下げ後に親が再取得する
}

const PURPLE = '#534AB7';
const RED = '#A32D2D';

const CorrectionBadgeAndButton: React.FC<Props> = ({
  targetType, targetId, targetLabel, fields, requesterName, isDark, latest, canRequest, onSubmitted,
}) => {
  const [modalKind, setModalKind] = useState<CorrectionRequestKind | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const isOpenReq = latest?.status === 'open';

  const badge = (() => {
    if (!latest) return null;
    const kindWord = latest.request_kind === 'cancel' ? '取消依頼' : '修正依頼';
    if (latest.status === 'open') return { label: `📩 ${kindWord}中`, bg: isDark ? '#3C3489' : '#EEEDFE', fg: isDark ? '#CECBF6' : '#26215C' };
    if (latest.status === 'resolved') return { label: `✓ ${kindWord} 対応済み`, bg: isDark ? '#0F6E56' : '#E1F5EE', fg: isDark ? '#9FE1CB' : '#0F6E56' };
    if (latest.status === 'withdrawn') return null; // 取り下げ済みはバッジ不要（再依頼できる）
    return { label: `${kindWord} 対応不可`, bg: isDark ? '#791F1F' : '#FCEBEB', fg: isDark ? '#F7C1C1' : '#A32D2D' };
  })();

  const handleWithdraw = async () => {
    setWithdrawing(true);
    await withdrawCorrectionRequest(latest!.id);
    setWithdrawing(false);
    onSubmitted();
  };

  const canReRequest = canRequest && !isOpenReq;   // open中は二重送信させない

  return (
    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {badge && (
        <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: badge.bg, color: badge.fg, fontWeight: 'bold' }}>
          {badge.label}
        </span>
      )}
      {latest?.status === 'declined' && latest.admin_reply && (
        <span style={{ fontSize: 12, color: isDark ? '#f5c6cb' : '#a32d2d' }}>理由：{latest.admin_reply}</span>
      )}

      {/* open中：取り下げのみ（他の依頼に出し直したいとき用） */}
      {isOpenReq && (
        <button type="button" onClick={handleWithdraw} disabled={withdrawing}
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, background: 'transparent', color: isDark ? '#adb5bd' : '#6c757d', cursor: withdrawing ? 'default' : 'pointer' }}>
          {withdrawing ? '取り下げ中…' : '依頼を取り下げる'}
        </button>
      )}

      {/* 未依頼 or 対応済み/不可/取下げ後：修正を依頼（主）＋取消を依頼（サブ） */}
      {canReRequest && (
        <>
          <button type="button" onClick={() => setModalKind('edit')}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: `1px solid ${PURPLE}`, background: 'transparent', color: PURPLE, fontWeight: 'bold', cursor: 'pointer' }}>
            📩 {latest ? 'もう一度 修正を依頼' : '管理者に修正を依頼'}
          </button>
          <button type="button" onClick={() => setModalKind('cancel')}
            style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, border: 'none', background: 'transparent', color: RED, textDecoration: 'underline', cursor: 'pointer' }}>
            取消を依頼
          </button>
        </>
      )}

      {modalKind && (
        <CorrectionRequestModal
          targetType={targetType}
          targetId={targetId}
          targetLabel={targetLabel}
          fields={fields}
          requesterName={requesterName}
          isDarkMode={isDark}
          initialKind={modalKind}
          onClose={() => setModalKind(null)}
          onSubmitted={() => { setModalKind(null); onSubmitted(); }}
        />
      )}
    </div>
  );
};

export default CorrectionBadgeAndButton;
