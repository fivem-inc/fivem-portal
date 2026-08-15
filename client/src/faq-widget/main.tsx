import React from 'react';
import ReactDOM from 'react-dom/client';
import FaqWidget from './FaqWidget';

// お客様向けFAQウィジェットの入口。
// スタッフ用アプリ（App.tsx）とは完全に別のエントリで、認証・AuthContext を一切通らない。
// ホームページ（WordPress）に iframe で埋め込まれる前提。

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FaqWidget />
  </React.StrictMode>,
);
