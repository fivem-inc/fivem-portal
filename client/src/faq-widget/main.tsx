import React from 'react';
import ReactDOM from 'react-dom/client';
import FaqWidget from './FaqWidget';
import FaqErrorBoundary from './FaqErrorBoundary';

// お客様向けFAQウィジェットの入口。
// スタッフ用アプリ（App.tsx）とは完全に別のエントリで、認証・AuthContext を一切通らない。
// ホームページ（WordPress）に iframe で埋め込まれる前提。
//
// 🚨 FaqErrorBoundary で包んでいる。何かで落ちても画面を真っ白にせず、
//    電話・問い合わせフォームへの逃げ道を出す（行き止まりを作らない方針）。

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FaqErrorBoundary>
      <FaqWidget />
    </FaqErrorBoundary>
  </React.StrictMode>,
);
