import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { idleLogoutActive, idleState, readCachedIdleConfig, readIdleLastAt, writeIdleLastAt } from '../lib/idleLogout';
import { loadIdleConfig } from '../lib/idleLogoutConfig';

// 共有パソコン用の自動ログアウト（2026-09-14）。決めたことは lib/idleLogout.ts の冒頭を見ること。
//
// 【置き場所】App.tsx の ProtectedLayout（ログイン済みの全ページの親）に1つだけ。
// 【動き】
//   ・マウス・キー・タッチ・スクロールのどれかがあれば「最後の操作」を今にする
//   ・1秒ごとに残りを見て、残り15秒以下なら予告のカード、0 でログアウト
//   ・ログアウトまでの分数は管理者の設定（app_settings）。まず端末の写しで動き始め、本物が読めたら差し替える
//   ・🚨 画面を隠している間も数える（別のタブ・別のアプリに移っても離席は離席）。
//     戻った瞬間に見直すので、隠れている間に時間が過ぎていれば戻ったときに切れる
//   ・🚨 チェックが ON でない／この端末に出さない設定の端末では**何もしない**（描画もしない・イベントも取らない）
//
// 🚨 配色は既存の黄色い注意カードと同じ固定色（#fff3cd / #ffc107 / #856404）。新しい色は足していない。
//    「続ける」は択一トグルの選択中と同じ青（#1976d2）。alert / window.confirm は使わない

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];

const IdleLogout: React.FC = () => {
  const { handleLogout } = useAuth();
  // 端末の写しで即座に動き始め、本物の設定が読めたら差し替える（読めなければ写しのまま）
  const [cfg, setCfg] = useState(() => readCachedIdleConfig());
  useEffect(() => {
    let alive = true;
    void loadIdleConfig().then(c => { if (alive && c) setCfg(c); });
    return () => { alive = false; };
  }, []);

  // 🚨 チェック（端末ごと）はログイン画面でしか変えられないので、ログイン中に変わることはない
  const active = idleLogoutActive(cfg);
  const limitMs = cfg.minutes * 60_000;
  // 🚨 開いたときは「端末に覚えた最後の操作」から数える（電源を切った・閉じた間も時間が経っている）。覚えが無ければ今から
  const lastActivityAt = useRef<number>(readIdleLastAt() ?? Date.now());
  const loggingOut = useRef(false);
  // 予告の区間だけ描き直す（残り秒数）。普段は null で何も描かない
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;

    // 端末に書くのは5秒に1回まで（マウスを動かすたびに書かない）
    let lastWritten = 0;
    const save = (at: number) => { lastWritten = at; writeIdleLastAt(at); };
    const touch = () => {
      const now = Date.now();
      lastActivityAt.current = now;
      if (now - lastWritten >= 5000) save(now);
    };
    const check = () => {
      if (loggingOut.current) return;
      // ほかのタブで操作していれば、そちらの時刻を使う（1つのタブだけ切れないように）
      const stored = readIdleLastAt();
      if (stored && stored > lastActivityAt.current) lastActivityAt.current = stored;
      const st = idleState(lastActivityAt.current, Date.now(), limitMs);
      if (st.expired) {
        loggingOut.current = true;
        // 🚨 下書きは handleLogout の localStorage.clear() で消える（共有PCなので次の人に見せない・ユーザー確定）
        void handleLogout('idle');
        return;
      }
      setRemainingSec(st.warn ? Math.ceil(st.remainingMs / 1000) : null);
    };

    // 開いた直後に1回：前回の最後の操作から時間が過ぎていれば、ここで切れる（電源を切って後日開いたとき）
    check();
    if (!loggingOut.current && !readIdleLastAt()) save(lastActivityAt.current);

    // 🚨 passive にして、スクロールやポインタの動きを重くしない（ref を書くだけ）
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, touch, { passive: true }));
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
      else if (!loggingOut.current) save(lastActivityAt.current); // 隠れる・閉じる直前に最新の操作を書く
    };
    const onHide = () => { if (!loggingOut.current) save(lastActivityAt.current); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);
    const timer = setInterval(check, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, touch));
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
      clearInterval(timer);
    };
  }, [active, limitMs, handleLogout]);

  if (!active || remainingSec === null) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
        zIndex: 10000, maxWidth: 'calc(100vw - 32px)', width: 440,
        padding: '12px 16px', background: '#fff3cd', border: '2px solid #ffc107', borderRadius: 10,
        color: '#856404', fontSize: 15, fontWeight: 'bold',
        display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.4 }}>
        操作がないため、あと <span style={{ fontSize: 20 }}>{remainingSec}</span> 秒で自動的にログアウトします。
        <br /><span style={{ fontSize: 12.5, fontWeight: 'normal' }}>続ける場合は画面を触るか「続ける」を押してください</span>
      </span>
      <button
        type="button"
        onClick={() => { lastActivityAt.current = Date.now(); setRemainingSec(null); }}
        style={{ background: '#1976d2', color: '#fff', border: '2px solid #1565c0', borderRadius: 8, padding: '10px 16px', fontWeight: 'bold', fontSize: 15, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        続ける
      </button>
    </div>
  );
};

export default IdleLogout;
