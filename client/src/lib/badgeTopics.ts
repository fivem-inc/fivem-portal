// 通知の行から「話題」を決める純粋な関数（2026-09-27・通信量の見直し 段1）
// supabase を読まない＝node で検算できるように、badgeLedger.ts から分けてある

import type { RefreshTopic } from './refreshBus';

/** 1 回に読む行数。2 回の読みの間に 30 件を超える新着が来ることは無い前提（1 人あたり 1 日数件） */
export const LEDGER_LIMIT = 30;

export interface LedgerRow { id: string; event_key: string | null; source_type: string | null }

/**
 * 通知の行 → 話題。event_key の先頭区切りを優先し、無ければ source_type で見る。
 * 🚨 どの話題にも当たらない行は 'bell' だけ（ベルの数字にだけ関係する）。
 * 🚨 話題を足したら refreshBus.ts の RefreshTopic も足す。数え方（各フックの中身）は触らない
 */
export function topicOf(eventKey: string | null, sourceType: string | null): RefreshTopic {
  const head = (eventKey ?? '').split(':')[0];
  const src = sourceType ?? '';
  if (head === 'board' || head === 'reminder') return 'board';
  if (head === 'safety' || src.startsWith('safety_check')) return 'safety';
  if (head === 'leave' || src.startsWith('leave')) return 'leave';
  if (head === 'shift_report' || src.startsWith('shift_report')) return 'shift_report';
  if (head === 'overtime' || src.startsWith('overtime')) return 'overtime';
  if (head === 'application_request' || src.startsWith('application_request')) return 'application_request';
  if (head === 'purchase_request' || src.startsWith('purchase_request')) return 'purchase_request';
  if (src === 'admin_setup') return 'admin';
  return 'bell';
}

/** 前回読んだ id に無い行の話題（新着があればベルも必ず入れる） */
export function newRowTopics(seen: ReadonlySet<string>, rows: readonly LedgerRow[]): Set<RefreshTopic> {
  const topics = new Set<RefreshTopic>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    topics.add(topicOf(r.event_key, r.source_type));
    topics.add('bell');
  }
  return topics;
}

/**
 * ページ → そのページを出入りしたときに数え直す話題（2026-09-27・段2）。
 * 「減る側」（他の人が処理した・自分が答えた）は通知の行が入らないので、ページを移ったときに
 * 出たページと入ったページの両方の話題を数え直す＝「開けば正しい」「答えて戻れば減っている」にする。
 * 🚨 ページを足したらここにも足す。どれにも当たらないページ（ホームなど）は何もしない
 */
const ROUTE_TOPICS: Record<string, readonly RefreshTopic[]> = {
  '/board': ['board'],
  '/leave': ['leave', 'application_request'],
  '/leave-approvals': ['leave', 'application_request'],
  '/shift-report': ['shift_report'],
  '/overtime': ['overtime', 'application_request'],
  '/purchase': ['purchase_request'],
  '/safety': ['safety'],
  '/admin': ['admin'],
};
export function routeTopics(fromPath: string | null, toPath: string): Set<RefreshTopic> {
  const out = new Set<RefreshTopic>();
  for (const p of [fromPath, toPath]) {
    if (!p) continue;
    (ROUTE_TOPICS[p] ?? []).forEach(t => out.add(t));
  }
  return out;
}

// 各フックが購読する話題（hooks/useRefreshOn.ts）。毎回作ると購読し直しになるので、ここで1回だけ作る
export const TOPICS_BOARD = ['board'] as const;
export const TOPICS_LEAVE = ['leave'] as const;
export const TOPICS_SHIFT_REPORT = ['shift_report'] as const;
export const TOPICS_OVERTIME = ['overtime'] as const;
export const TOPICS_APPLICATION_REQUEST = ['application_request'] as const;
export const TOPICS_PURCHASE_REQUEST = ['purchase_request'] as const;
export const TOPICS_SAFETY = ['safety'] as const;
export const TOPICS_ADMIN = ['admin'] as const;
export const TOPICS_BELL = ['bell'] as const;
