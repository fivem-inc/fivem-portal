import React from 'react';
import { isChunkLoadError, reloadOnceForChunkError } from '../lib/chunkReload';

// アプリ全体の「受け止める網」（2026-10-16）。
// 🚨 これが無いと、どこかで1つ落ちただけで React が画面の中身をまるごと消し、背景の黒（白）だけが残る。
//    いちばん多いのは、新しい版を出した直後に古い画面のまま別のページを開いたとき（lib/chunkReload.ts）。
// ・部品が読み込めなかったとき … 1回だけ自動で読み込み直す（押したページが新しい版で開く）
// ・それでもだめなとき・ほかの理由で落ちたとき … 案内と［更新する］を出す（行き止まりにしない）

interface State { failed: boolean; reloading: boolean }

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { failed: false, reloading: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 🚨 黙って握りつぶさない。原因が読めないと、次に起きたとき推測でしか直せない
    console.error('画面の表示が止まりました:', error, info.componentStack);
    if (isChunkLoadError(error) && reloadOnceForChunkError()) this.setState({ reloading: true });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', background: '#f5f6f8' }}>
        <div style={{ background: '#fff', border: '1px solid #d9dee3', borderRadius: 12, padding: '20px 18px', maxWidth: 360, width: '100%', boxSizing: 'border-box', color: '#333', textAlign: 'center' }}>
          {this.state.reloading ? (
            <p style={{ fontSize: 14, margin: 0 }}>新しいバージョンを読み込んでいます…</p>
          ) : (
            <>
              <p style={{ fontSize: 15, fontWeight: 'bold', margin: '0 0 8px' }}>画面を読み込めませんでした</p>
              <p style={{ fontSize: 13, lineHeight: 1.7, margin: '0 0 14px', color: '#555' }}>
                新しいバージョンに切り替わった直後などに起きます。［更新する］を押してください。
              </p>
              <button type="button" onClick={() => window.location.reload()}
                style={{ display: 'block', width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                更新する
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
