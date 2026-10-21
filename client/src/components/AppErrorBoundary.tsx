import React from 'react';
import { isChunkLoadError, recoverFromChunkError, isServerReachable, justReloaded } from '../lib/chunkReload';
import { reloadFromNetwork } from '../lib/reloadFromNetwork';

// 画面の「受け止める網」（2026-10-16・2026-10-20 に圏外の扱いを足した）。
// 🚨 これが無いと、どこかで1つ落ちただけで React が画面の中身をまるごと消し、背景の黒（白）だけが残る。
//    いちばん多いのは、新しい版を出した直後に古い画面のまま別のページを開いたとき（lib/chunkReload.ts）。
// ・部品が読み込めなかったとき … サーバーに届けば1回だけ自動で読み込み直す（押したページが新しい版で開く）
//   🚨 圏外・電波が弱いせいなら読み込み直さない（読み込み直すとアプリごと消える）。「通信環境の良い場所で［もう一度開く］」を出す（文は「通信」にそろえる・2026-10-20 ユーザー確定）
// ・それでもだめなとき・ほかの理由で落ちたとき … 案内と［更新する］を出す（行き止まりにしない）
//
// scope='app'   … main.tsx でアプリ全体を包む（最後の網）
// scope='route' … App.tsx の ProtectedLayout でページ（Outlet）だけを包む。部品が読めなかったときだけ受け止め、
//                 ほかのエラーは外の網（scope='app'）へそのまま渡す。🚨 resetKey にページの場所を渡し、ページを移ったら元に戻す

type Phase = 'ok' | 'checking' | 'reloading' | 'offline' | 'failed';
interface Props { children: React.ReactNode; scope?: 'app' | 'route'; resetKey?: string }
interface State { phase: Phase; error: unknown; retrying: boolean; stillOffline: boolean }

class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { phase: 'ok', error: null, retrying: false, stillOffline: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { phase: isChunkLoadError(error) ? 'checking' : 'failed', error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 🚨 黙って握りつぶさない。原因が読めないと、次に起きたとき推測でしか直せない
    console.error('画面の表示が止まりました:', error, info.componentStack);
    if (!isChunkLoadError(error)) return;
    if (justReloaded()) { this.setState({ phase: 'reloading' }); return; }
    void recoverFromChunkError().then(r => {
      this.setState({ phase: r === 'reloading' ? 'reloading' : r === 'offline' ? 'offline' : 'failed' });
    });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.phase !== 'ok') {
      this.setState({ phase: 'ok', error: null, retrying: false, stillOffline: false });
    }
  }

  private retry = async () => {
    this.setState({ retrying: true, stillOffline: false });
    if (await isServerReachable()) { reloadFromNetwork(); return; }
    this.setState({ retrying: false, stillOffline: true });
  };

  render() {
    const { phase, error, retrying, stillOffline } = this.state;
    if (phase === 'ok') return this.props.children;
    // ページだけの網は、部品の読み込み以外のエラーを外の網へ渡す
    if (this.props.scope === 'route' && phase === 'failed' && !isChunkLoadError(error)) throw error;

    const isRoute = this.props.scope === 'route';
    return (
      <div style={{ minHeight: isRoute ? '60vh' : '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', background: isRoute ? undefined : '#f5f6f8' }}>
        <div style={{ background: '#fff', border: '1px solid #d9dee3', borderRadius: 12, padding: '20px 18px', maxWidth: 360, width: '100%', boxSizing: 'border-box', color: '#333', textAlign: 'center' }}>
          {phase === 'checking' || phase === 'reloading' ? (
            <p style={{ fontSize: 14, margin: 0 }}>{phase === 'reloading' ? '新しいバージョンを読み込んでいます…' : '読み込んでいます…'}</p>
          ) : phase === 'offline' ? (
            <>
              <p style={{ fontSize: 15, fontWeight: 'bold', margin: '0 0 8px' }}>通信がつながらないため、このページを開けませんでした</p>
              <p style={{ fontSize: 13, lineHeight: 1.7, margin: '0 0 14px', color: '#555' }}>
                通信環境の良い場所で［もう一度開く］を押してください。
              </p>
              {stillOffline && (
                <p style={{ fontSize: 12.5, margin: '0 0 10px', color: '#856404', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '6px 8px' }}>
                  まだ通信がつながっていません。
                </p>
              )}
              <button type="button" onClick={this.retry} disabled={retrying}
                style={{ display: 'block', width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: retrying ? 'default' : 'pointer', opacity: retrying ? 0.7 : 1 }}>
                {retrying ? '確かめています…' : 'もう一度開く'}
              </button>
              {isRoute && (
                <button type="button" onClick={() => window.history.back()}
                  style={{ display: 'block', width: '100%', marginTop: 8, padding: '10px', borderRadius: 8, border: '1px solid #ced4da', background: '#fff', color: '#333', fontSize: 14, cursor: 'pointer' }}>
                  前の画面に戻る
                </button>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: 15, fontWeight: 'bold', margin: '0 0 8px' }}>画面を読み込めませんでした</p>
              <p style={{ fontSize: 13, lineHeight: 1.7, margin: '0 0 14px', color: '#555' }}>
                新しいバージョンに切り替わった直後などに起きます。［更新する］を押してください。
              </p>
              <button type="button" onClick={() => reloadFromNetwork()}
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
