// 共有パソコン用の自動ログアウト（2026-09-14）
//
// 【何をするか】
//   「このパソコンは共有です」にチェックしてログインした端末では、
//   1分間なにも操作がないと自動でログアウトする（残り15秒から予告を出す）。
//
// 【決めたこと（2026-09-14 ユーザー確定）】
//   ・設定は**端末ごと**（ブラウザに記憶）。誰がログインしても効く。DB は触らない
//   ・**パソコン（マウスのある端末）だけ**の仕組み。スマホ・タブレットではチェックを出さず、
//     動かない（スマホは1人1台で、1分で切れると毎回ログインし直しになる）
//   ・ログイン画面のチェックの**初期値は ON**。外すには二段階の確認
//   ・🚨 記憶が無い端末（いまログイン中の全員のスマホ・PC）では**動かない**。
//     次にログイン画面を通ったときに初めて記憶される。出した瞬間に全員が切れる事故を避けるため
//   ・自動ログアウトのときは端末の下書きも消える（共有PCなので次の人に見せない）。
//     🚨 これは既存の handleLogout が localStorage を丸ごと消す作りで、すでにそうなっている。
//        この設定だけは消されないよう handleLogout 側で退避している（安否の未送信と同じ扱い）
//
// 🚨 このファイルは supabase を読まない（画面を開かずに検算できるようにするため）

export const IDLE_LOGOUT_KEY = 'fivem_idle_logout';
export type IdleLogoutSetting = 'on' | 'off';

/** 操作が無い状態がこれだけ続いたらログアウト（1分・ユーザー確定） */
export const IDLE_LOGOUT_MS = 60_000;
/** 残りがこれ以下になったら予告のカードを出す（15秒） */
export const IDLE_WARN_MS = 15_000;

export function readIdleLogoutSetting(): IdleLogoutSetting | null {
  try {
    const v = localStorage.getItem(IDLE_LOGOUT_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function writeIdleLogoutSetting(v: IdleLogoutSetting): void {
  try {
    localStorage.setItem(IDLE_LOGOUT_KEY, v);
  } catch {
    /* 保存できない端末では何もしない（自動ログアウトが効かないだけ） */
  }
}

/**
 * パソコン（マウスのある端末）か。
 * 「指で触る端末」（スマホ・タブレット）は hover が無い／pointer が coarse なので false になる。
 * 🚨 判定できない環境では false（＝スマホ扱い＝何もしない）に倒す。誤って切るより安全
 */
export function isPointerDevice(): boolean {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** この端末で自動ログアウトを動かすか（設定 ON かつ パソコン） */
export function idleLogoutActive(): boolean {
  return isPointerDevice() && readIdleLogoutSetting() === 'on';
}

export interface IdleState {
  /** ログアウトまでの残り（ミリ秒・0 以上） */
  remainingMs: number;
  /** 予告を出す区間か（残り 15 秒以下） */
  warn: boolean;
  /** 時間切れ（ログアウトする） */
  expired: boolean;
}

/**
 * 最後の操作時刻と今の時刻から、残り時間・予告・時間切れを出す（純粋な計算）。
 * 🚨 画面を隠している間（別のアプリ・別のタブ）も数える。離席中に切るのが目的なので、
 *    「見ていない間は止める」（usePolling）とは逆の扱い
 */
export function idleState(lastActivityAt: number, now: number, limitMs = IDLE_LOGOUT_MS, warnMs = IDLE_WARN_MS): IdleState {
  const elapsed = Math.max(0, now - lastActivityAt);
  const remainingMs = Math.max(0, limitMs - elapsed);
  return { remainingMs, warn: remainingMs <= warnMs, expired: remainingMs <= 0 };
}
