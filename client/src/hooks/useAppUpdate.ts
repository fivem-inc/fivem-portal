import { useCallback, useEffect, useRef, useState } from 'react';

// アプリの新しい版が出ていないかを見張る
//
// 【なぜ必要か】
// デプロイしても、すでに開いているアプリは古いファイルのまま動き続ける。
// Android は画面を引っ張れば読み込み直せるが、
// 🚨 iPhone のホーム画面アプリ（PWA）は閉じても裏でページが生き続け、
//    戻ってきても読み込み直しが走らない。だからタスクキルが要る、という状態だった。
//
// 【仕組み】
// ビルドのたびに番号(__BUILD_ID__)を作り、①アプリに埋め込む ②version.json に書き出す。
// アプリが前面に戻ったときに version.json を取りに行き、番号が違えば「新しい版が出ている」と分かる。
//
// 【気をつけていること】
// ・勝手に読み込み直さない（入力途中の内容が消えるため）。押すかどうかは本人に任せる
// ・取得に失敗したときは何もしない（電波が無いだけで「新しい版があります」と出すと嘘になる）

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 開きっぱなしの人向けの保険

export const useAppUpdate = () => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      // キャッシュを使わず必ずサーバーに聞く（?t= は念のための二重の保険）
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data?.buildId === 'string' && data.buildId !== __BUILD_ID__) {
        setUpdateAvailable(true);
      }
    } catch {
      // 圏外・応答がJSONでない等。黙って何もしない（誤検知を出さない）
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    check();

    // 前面に戻ったとき。iPhone のタスクキル問題を解くのはここ
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      setDismissed(false); // ✕は「今は消す」だけ。開き直したらまた出す
      check();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('focus', onForeground);
    const timer = setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('pageshow', onForeground);
      window.removeEventListener('focus', onForeground);
      clearInterval(timer);
    };
  }, [check]);

  return {
    showUpdate: updateAvailable && !dismissed,
    dismiss: () => setDismissed(true),
  };
};
