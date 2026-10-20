import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// 電波が弱いとき・圏外のときの備え（2026-10-20・計画 docs/計画-電波が弱いとき.md の段0）。App.tsx の ProtectedLayout で1回だけ呼ぶ。
//
// ① 安否確認のページの部品を、ログインのあと手の空いたときに先に読んでおく
//    🚨 ページの部品は初めて開くときに読む作り。読んでいないまま圏外で安否確認を開くと、開けない。
//       先に読んでおけば、アプリを開いている間は圏外でも安否確認のページ（端末の控え・未送信の保存）にたどり着ける。
//       読むのは Vercel からで、Supabase の通信量は増えない。退職者は安否確認を開けないので読まない
// ② スマホのお知らせを押したとき、開いている画面の中で移る（public/sw.js から 'fivem-navigate' が届く）
//    🚨 前は sw.js が画面をまるごと読み直していた。電波が弱いと、それまで使えていた画面まで消えていた。
//       受け取ったら返事（ports[0] に 'ok'）をする。返事が無い古い画面のときは、sw.js が今までどおり読み直す

export const useOfflinePrep = (userId: string | undefined, prefetchSafety: boolean) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!userId || !prefetchSafety) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      import('../pages/SafetyCheckPage').catch(() => { /* 読めなくても困らない（開いたときにもう一度読む） */ });
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    const timer = window.setTimeout(() => {
      if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 10000 });
      else run();
    }, 5000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [userId, prefetchSafety]);

  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (!data || data.type !== 'fivem-navigate' || typeof data.url !== 'string') return;
      let to: URL;
      try { to = new URL(data.url, window.location.origin); } catch { return; }
      if (to.origin !== window.location.origin) return;   // よその場所へは移らない
      navigate(to.pathname + to.search + to.hash);
      e.ports?.[0]?.postMessage('ok');
    };
    sw.addEventListener('message', onMessage);
    sw.startMessages?.();
    return () => sw.removeEventListener('message', onMessage);
  }, [navigate]);
};
