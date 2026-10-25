// 通知から開いたページで「どの人の行か」まで絞って光らせるための小さな道具（2026-10-17）
//
// きっかけ：休暇・時間外調整休の受理のお知らせ（上長向け・source_type leave_request:fyi／overtime:fullday_fyi）は
// reference_id に「日付」しか持っておらず、カレンダーではその日の全員の行が光っていた（有休奨励日だと十数人）。
// お知らせの文「…が受理されました「名前（10/31（土））」」に名前が入っているので、押したお知らせの文から名前を引いて絞る。
// 🚨 名前を URL には載せない（ベルからは ?fn=通知のID、スマホ通知からは App が消す前の nids を端末に一時的に控える）

const STASH_KEY = 'fivem_last_push_nids';

/** スマホ通知から開いたとき、App が URL から消す前の nids を控える（そのあと開くページが読む） */
export function stashPushNotifIds(ids: string[]): void {
  try { sessionStorage.setItem(STASH_KEY, JSON.stringify({ ids, at: Date.now() })); } catch { /* 保存できない端末では絞らない（今までどおり日付で光る） */ }
}

/** 控えた nids を1回だけ取り出す（30秒より前のものは使わない） */
export function takePushNotifIds(maxAgeMs = 30_000): string[] {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return [];
    sessionStorage.removeItem(STASH_KEY);
    const v = JSON.parse(raw) as { ids?: unknown; at?: unknown };
    if (typeof v.at !== 'number' || Date.now() - v.at > maxAgeMs || !Array.isArray(v.ids)) return [];
    return v.ids.filter((s): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)).slice(0, 20);
  } catch { return []; }
}

/** お知らせの文から名前を引く（受理のお知らせ「…「阿部 康宏（10/31（土））」」→「阿部 康宏」）。引けなければ null */
export function fyiNameFromMessage(message: string | null | undefined): string | null {
  const msg = message ?? '';
  const m = msg.match(/「(.+?)（\d{1,2}\/\d{1,2}/);
  if (m) return m[1].trim();
  // 欠勤・休日出勤の登録「📅 見本 花子さんの全欠勤が登録されました（11月7日）」・時間調整「⏰ 見本 次郎さんが11月7日に…」→ 名前（2026-10-22）。
  // 文は通知設定のテンプレート（{{対象者名}}さんの…）。先頭の絵文字は飛ばす
  const a = msg.match(/^(?:[^\p{L}\p{N}\s]+\s*)?([^\s、。「」]+(?:\s[^\s、。「」]+)?)さん[のが]/u);
  return a ? a[1].trim() : null;
}

/** 名前を比べる（半角・全角の空白の違いは見ない） */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '');   // \s は全角の空白も含む
  return !!n(a) && n(a) === n(b);
}
