// 通知の表（notifications）を「変わったかどうかの目印」として1本だけ読む（2026-09-27・通信量の見直し 段1）
//
// いつ読むかは lib/refreshBus.ts が決める。ここは「読んで、新しく来た行の話題を返す」だけ。
// 計画：docs/計画-自動更新の見直し.md
//
// 🚨 新着の判定は **id の差分**（前回読んだ id に無い行）。時刻（created_at）では判定しない。
//    一斉送信は同じ時刻で入り、また取引の順で「過去の時刻の行」が後から見えることがあるため。
// 🚨 本文（message）は読まない。1 回あたり id・event_key・source_type の 30 行だけ（約 3 KB）。
// 🚨 利用者が変わったら（ログアウト→別の人）覚えている id を捨てて読み直す。

import { supabase } from './supabaseClient';
import { setTicker, type RefreshTopic } from './refreshBus';
import { LEDGER_LIMIT, newRowTopics, type LedgerRow } from './badgeTopics';

let seededUser: string | null = null;
let seen = new Set<string>();

async function readLedger(): Promise<Set<RefreshTopic> | null> {
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user.id ?? null;
  if (!uid) { seededUser = null; seen = new Set(); return new Set(); }
  const { data, error } = await supabase.from('notifications')
    .select('id, event_key, source_type')
    .eq('user_id', uid)
    .eq('dismissed', false)
    .order('created_at', { ascending: false })
    .limit(LEDGER_LIMIT);
  if (error || !data) {
    console.error('[badgeLedger] 通知の表を読めませんでした:', error?.message);
    return null;
  }
  const rows = data as LedgerRow[];
  // 初回・利用者が変わったとき：いまの行を覚えるだけ（各フックが自分で読むので新着として扱わない）
  if (seededUser !== uid) {
    seededUser = uid;
    seen = new Set(rows.map(r => r.id));
    return new Set();
  }
  const topics = newRowTopics(seen, rows);
  seen = new Set(rows.map(r => r.id));
  return topics;
}

setTicker(readLedger);
