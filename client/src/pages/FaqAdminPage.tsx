import React from 'react';
import FaqTab from '../components/admin/FaqTab';
import { useDarkMode } from '../hooks/useDarkMode';

// Q&A編集専用アカウント向けのページ。
// このアカウントは管理画面（/admin）に入れないため、FAQ管理だけを単独のページとして出す。
// 「ログインするとQ&A編集画面だけが見える」という運用をこの1ページで実現している。
// 管理者は従来どおり /admin の「FAQ管理」タブから同じ画面を使える（中身は同じ部品）。
const FaqAdminPage: React.FC = () => {
  const isDark = useDarkMode();
  const text = isDark ? '#fff' : '#1a1a2e';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '16px 16px 40px' }}>
      <h2 style={{ fontSize: 20, textAlign: 'center', color: text, margin: '0 0 4px' }}>💡 FAQ管理</h2>
      <p style={{ fontSize: 12, textAlign: 'center', color: isDark ? '#adb5bd' : '#666', margin: '0 0 20px' }}>
        ファイブM スタッフサイト
      </p>
      {/* 専用アカウントは編集者の追加・削除はできない（管理者のみ） */}
      <FaqTab />
    </div>
  );
};

export default FaqAdminPage;
