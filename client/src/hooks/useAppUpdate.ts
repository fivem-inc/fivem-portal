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
// アプリを開いたとき・前面に戻ったときに version.json を取りに行き、
// 番号が違えば「新しい版が出ている」と分かる。
//
// 【自動更新とバナーの役割分担（2026-08-08 決定）】
// ・立ち上げ時（タスクキル後の起動）＝ まだ何も入力していない → 自動で読み込み直す
// ・前面復帰・開きっぱなし ＝ 入力の途中かもしれない → 読み込み直さず、消せないバナーでお願いする
//   （旧バージョンのまま報告が送られて休憩計算がズレる実害が出たため、バナーの✕は廃止済み）
//
// 【気をつけていること】
// ・自動リロードは「1回だけ」。version.json が index.html に化ける既知の事故が起きても
//   無限リロードにならないよう、sessionStorage の印でガードし、2回目からはバナーに切り替える
// ・取得に失敗したときは何もしない（電波が無いだけで「新しい版があります」と出すと嘘になる）

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 開きっぱなしの人向けの保険

// sessionStorage はタブ（PWAの1起動）単位。リロードしても残り、タスクキルで消える
// ＝「この起動で1回自動更新した」の印にちょうどよい
const AUTO_RELOAD_KEY = 'fivem_update_auto_reloaded';

export const useAppUpdate = () => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const checking = useRef(false);

  const check = useCallback(async (isLaunch = false) => {
    if (checking.current) return;
    checking.current = true;
    try {
      // キャッシュを使わず必ずサーバーに聞く（?t= は念のための二重の保険）
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data?.buildId !== 'string') return;
      if (data.buildId !== __BUILD_ID__) {
        // 立ち上げ直後なら自動で最新に読み込み直す（まだ何も入力していないので安全）。
        // すでに1回試していたら（＝リロードしても新しくならなかった）バナーに切り替える
        let alreadyTried = true;
        try { alreadyTried = sessionStorage.getItem(AUTO_RELOAD_KEY) === '1'; } catch { /* 読めない環境ではバナーに倒す */ }
        if (isLaunch && !alreadyTried) {
          try { sessionStorage.setItem(AUTO_RELOAD_KEY, '1'); } catch { /* 保存できなくてもリロード自体はする */ }
          window.location.reload();
          return;
        }
        setUpdateAvailable(true);
      } else {
        // 最新になっている。次の更新でまた自動リロードできるように印を消す
        try { sessionStorage.removeItem(AUTO_RELOAD_KEY); } catch { /* 何もしない */ }
      }
    } catch {
      // 圏外・応答がJSONでない等。黙って何もしない（誤検知を出さない）
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    check(true); // 立ち上げ時だけ自動更新の対象

    // 前面に戻ったとき。入力の途中かもしれないので自動更新はせずバナーを出す
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      setDismissed(false); // 開き直したらまた出す
      check();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('focus', onForeground);
    const timer = setInterval(() => check(), CHECK_INTERVAL_MS);

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
