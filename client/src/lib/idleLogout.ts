// 共有パソコン用の自動ログアウト（2026-09-14）
//
// 【何をするか】
//   「この端末は共有です」にチェックしてログインした端末では、
//   決められた時間なにも操作がないと自動でログアウトする（残り15秒から予告を出す）。
//
// 【決めたこと（2026-09-14 ユーザー確定）】
//   ・チェックは**端末ごと**（ブラウザに記憶）。誰がログインしても効く
//   ・**パソコン（マウスのある端末）だけ**が既定。スマホ・タブレットにも出すかは管理者が決める
//     （管理画面 → 権限管理 → 共有パソコンの自動ログアウト）。出す場合もスマホの初期値は OFF
//   ・ログアウトまでの時間は管理者が決める（1〜720分＝12時間・既定 1分）
//   ・ログイン画面のチェックの**初期値はパソコンで ON**。外すには二段階の確認
//   ・🚨 記憶が無い端末（いまログイン中の全員のスマホ・PC）では**動かない**。
//     次にログイン画面を通ったときに初めて記憶される。出した瞬間に全員が切れる事故を避けるため
//   ・自動ログアウトのときは端末の下書きも消える（共有PCなので次の人に見せない）。
//     🚨 これは既存の handleLogout が localStorage を丸ごと消す作りで、すでにそうなっている。
//        チェックと設定の写しだけは消されないよう handleLogout 側で退避している（安否の未送信と同じ扱い）
//
// 【管理者の設定はどこにあるか】
//   app_settings の key 'idle_logout'（value = { minutes, show_on_mobile }）。
//   🚨 app_settings は**ログイン済みしか読めない**（RLS）。ログイン画面は読めないので、
//      ログイン中に読んだ値を端末に写しておき（IDLE_CONFIG_CACHE_KEY）、ログイン画面はその写しを使う。
//      写しが無い端末（その端末で初めてログインする時）は既定値（1分・パソコンだけ）で出る。
//      🚨 実際に切る時間は、ログイン中に読む本物の値で決まる（写しは表示のためだけ）
//
// 🚨 このファイルは supabase を読まない（画面を開かずに検算できるようにするため）。
//    supabase を読む側は lib/idleLogoutConfig.ts

export const IDLE_LOGOUT_KEY = 'fivem_idle_logout';
export type IdleLogoutSetting = 'on' | 'off';

/** 残りがこれ以下になったら予告のカードを出す（15秒・分数を変えても固定） */
export const IDLE_WARN_MS = 15_000;

/** 管理者が決める設定 */
export interface IdleLogoutConfig {
  /** 操作が無い状態がこの分数続いたらログアウト（1〜720） */
  minutes: number;
  /** スマホ・タブレット（指で触る端末）のログイン画面にもチェックを出すか */
  show_on_mobile: boolean;
}
export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 720; // 12時間
export const DEFAULT_IDLE_CONFIG: IdleLogoutConfig = { minutes: 1, show_on_mobile: false };
/** app_settings の key */
export const IDLE_CONFIG_SETTING_KEY = 'idle_logout';
/** ログイン中に読んだ設定の写し（localStorage の key） */
export const IDLE_CONFIG_CACHE_KEY = 'fivem_idle_logout_cfg';

/** DB や写しから読んだ値を、必ず範囲内の形にそろえる（壊れていれば既定値） */
export function normalizeIdleConfig(raw: unknown): IdleLogoutConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const m = Number(o.minutes);
  const minutes = Number.isFinite(m)
    ? Math.min(IDLE_MINUTES_MAX, Math.max(IDLE_MINUTES_MIN, Math.round(m)))
    : DEFAULT_IDLE_CONFIG.minutes;
  return { minutes, show_on_mobile: o.show_on_mobile === true };
}

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

export function readCachedIdleConfig(): IdleLogoutConfig {
  try {
    const raw = localStorage.getItem(IDLE_CONFIG_CACHE_KEY);
    return raw ? normalizeIdleConfig(JSON.parse(raw)) : DEFAULT_IDLE_CONFIG;
  } catch {
    return DEFAULT_IDLE_CONFIG;
  }
}

export function writeCachedIdleConfig(cfg: IdleLogoutConfig): void {
  try {
    localStorage.setItem(IDLE_CONFIG_CACHE_KEY, JSON.stringify(normalizeIdleConfig(cfg)));
  } catch {
    /* ignore */
  }
}

/**
 * パソコン（マウスのある端末）か。
 * 「指で触る端末」（スマホ・タブレット）は hover が無い／pointer が coarse なので false になる。
 * 🚨 判定できない環境では false（＝スマホ扱い）に倒す。誤って切るより安全
 */
export function isPointerDevice(): boolean {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** この端末のログイン画面にチェックを出すか（パソコンは常に／スマホは管理者の設定しだい） */
export function idleCheckboxVisible(cfg: IdleLogoutConfig): boolean {
  return isPointerDevice() || cfg.show_on_mobile;
}

/** ログイン画面のチェックの初期値（記憶が無いとき）。パソコンは ON、スマホは OFF（ユーザー確定） */
export function defaultIdleSetting(): IdleLogoutSetting {
  return isPointerDevice() ? 'on' : 'off';
}

/** この端末で自動ログアウトを動かすか（チェック ON かつ この端末に出してよい） */
export function idleLogoutActive(cfg: IdleLogoutConfig): boolean {
  return readIdleLogoutSetting() === 'on' && idleCheckboxVisible(cfg);
}

/** 分数を「1分」「1時間」「1時間30分」の形にする（画面の文言用） */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}分`;
  return r === 0 ? `${h}時間` : `${h}時間${r}分`;
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
export function idleState(lastActivityAt: number, now: number, limitMs: number, warnMs = IDLE_WARN_MS): IdleState {
  const elapsed = Math.max(0, now - lastActivityAt);
  const remainingMs = Math.max(0, limitMs - elapsed);
  return { remainingMs, warn: remainingMs <= warnMs, expired: remainingMs <= 0 };
}
