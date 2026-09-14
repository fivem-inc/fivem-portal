import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDarkMode } from '../../hooks/useDarkMode';
import type { AdminAccessReason } from '../../lib/adminTabs';

// 管理画面を開けない理由のカード（2026-09-15）。🚨 行き止まりにしない（必ずホームへ戻る道を添える）
// 出すのはマネージャー以上の方だけ（それ以外の人は /admin を開くとホームへ戻る）。

const TEXT: Partial<Record<AdminAccessReason, { title: string; body: string }>> = {
  not_pc: {
    title: '管理画面はパソコンから開いてください',
    body: 'マネージャー以上の方の管理画面は、パソコン（マウスのある端末）でログインしたときだけ開けます。スマホ・タブレットでは開けません。',
  },
  no_tabs: {
    title: 'いま開ける管理画面のタブはありません',
    body: '管理者が「権限管理」で開くタブを選ぶと、ここから開けるようになります。',
  },
  error: {
    title: '管理画面の設定を読み込めませんでした',
    body: '通信の状態を確かめて、画面を開き直してください。',
  },
};

const AdminAccessNotice: React.FC<{ reason: AdminAccessReason }> = ({ reason }) => {
  const navigate = useNavigate();
  const isDarkMode = useDarkMode();
  const t = TEXT[reason] ?? TEXT.error!;
  return (
    <div style={{ maxWidth: 480, margin: '24px auto', padding: '20px 22px', borderRadius: 12,
      background: isDarkMode ? '#343a40' : 'white', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}` }}>
      <div style={{ fontSize: 15, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333', marginBottom: 8 }}>{t.title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>{t.body}</div>
      <button type="button" onClick={() => navigate('/')}
        style={{ padding: '8px 18px', borderRadius: 8, fontSize: 14, cursor: 'pointer',
          background: 'transparent', color: isDarkMode ? '#fff' : '#333', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}` }}>
        ← ホームへ
      </button>
    </div>
  );
};

export default AdminAccessNotice;
