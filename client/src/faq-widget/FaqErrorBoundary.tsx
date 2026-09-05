import React from 'react';
import { CONTACT_PHONE, CONTACT_FORM_URL } from './FaqWidget';

// お客様向けFAQウィジェット専用の「受け止める網」。
//
// 🚨 なぜ要るか
// このウィジェットはホームページ（WordPress）に別オリジンの iframe として埋め込まれる。
// ブラウザの追跡防止やCookieブロックの設定によっては、sessionStorage を読むだけで
// 例外が飛ぶことがある。React は例外を受け止める仕組みが無いと画面の中身をすべて消すので、
// 記録という補助機能のために、お客様の画面が真っ白になってしまう。
//
// 🚨 落ちたときも行き止まりにしない（このウィジェットの一貫した方針）。
//    読み込み失敗のときと同じく、電話・問い合わせフォームへ逃げられるようにする。
//    電話番号とURLは FaqWidget.tsx の定数をそのまま使う（2か所に書かない）。
//
// 🚨 これは faq-widget 専用。社内アプリ側（App.tsx / main.tsx）には手を入れていないので、
//    2人開発の共通ファイルには影響しない。

const BORDER = '#d9dee3';
const TEXT = '#333';
const BLUE = '#1976d2';

interface State { failed: boolean }

class FaqErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 🚨 黙って握りつぶさない。原因が読めないと、次に起きたとき推測でしか直せない
    console.error('FAQウィジェットが停止しました:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{
        background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
        padding: '16px 18px', color: TEXT, boxSizing: 'border-box',
      }}>
        <p style={{ fontSize: 14, lineHeight: 1.8, margin: '0 0 10px' }}>
          ただいまこちらのご案内を表示できません。お手数ですが、お電話またはお問い合わせフォームからご連絡ください。
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={`tel:${CONTACT_PHONE.replace(/-/g, '')}`}
            style={{ display: 'inline-block', padding: '9px 14px', fontSize: 13, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, textDecoration: 'none' }}>
            📞 {CONTACT_PHONE}（四条本校 総合受付）
          </a>
          <a href={CONTACT_FORM_URL} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', padding: '9px 14px', fontSize: 13, borderRadius: 8, border: 'none', background: BLUE, color: '#fff', textDecoration: 'none' }}>
            お問い合わせフォーム
          </a>
        </div>
      </div>
    );
  }
}

export default FaqErrorBoundary;
