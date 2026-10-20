/**
 * 休職中の本人のホームの1行（2026-10-20・計画 docs/計画-休職と手続き.md）
 * ・休職の間はずっと出す（閉じられない）。日付は出さない。🚨 「休職」という言葉は使わない（画面を人に見られることがあるため）
 * ・「ご利用いただける機能を見る ›」で、使える機能の名前だけを開く
 * ・老眼の方にも読めるよう、うすい灰色の文字にしない（UI/UX レビュー）
 */
import React, { useState } from 'react';
import { leaveFeatureLabels } from '../lib/staffLeave';

const LeaveHomeNotice: React.FC<{ isDark: boolean; featureKeys: string[] }> = ({ isDark, featureKeys }) => {
  const [open, setOpen] = useState(false);
  const labels = leaveFeatureLabels(featureKeys);
  return (
    <div role="status" style={{ margin: '0 0 10px', padding: '10px 12px', borderRadius: 8, textAlign: 'left',
      background: isDark ? '#2b3035' : '#fff', border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, color: isDark ? '#f8f9fa' : '#212529' }}>
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>ℹ️ 現在、一部の機能のみご利用いただけます。</div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ background: 'none', border: 'none', padding: '4px 0 0', cursor: 'pointer', fontSize: 13.5, color: isDark ? '#90caf9' : '#0d6efd' }}>
        {open ? 'ご利用いただける機能を閉じる ▴' : 'ご利用いただける機能を見る ›'}
      </button>
      {open && (
        <div style={{ fontSize: 13.5, lineHeight: 1.7, marginTop: 4 }}>
          {labels.length > 0 ? labels.join('・') : 'ホーム・設定'}
        </div>
      )}
    </div>
  );
};

export default LeaveHomeNotice;
