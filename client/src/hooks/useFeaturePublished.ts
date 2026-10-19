import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { writtenSince } from '../lib/writeWatch';
import { attrsFor } from '../lib/roleAttrs';
import type { RoleRow } from '../lib/roleAttrs';
import { useRoles } from './useRoles';
import { parseNavRollout, NAV_ROLLOUT_OFF, type NavRollout } from '../lib/navItems';

export interface FeaturePublishState {
  published: Record<string, boolean>;          // 全公開（値が無いキーは公開扱い）
  publishedLeader: Record<string, boolean>;    // リーダー以上公開（値が無いキーは false）
  publishedPresident: Record<string, boolean>; // 社長のみ公開（値が無いキーは false）新機能の先行テスト用
  /** 上のナビの、管理者が決めた全員の初めの並び（app_settings 'nav_order'・空＝今の並び・2026-10-17） */
  navOrder: string[];
  /** 上のナビの「試してから広げる」切り替え（app_settings 'nav_rollout'・読めないときは全部オフ） */
  navRollout: NavRollout;
  /** 役職の一覧（属性つき）。「リーダー以上」「社長のみ」の判定に使う（2026-09-09 属性化） */
  roles: RoleRow[];
}

// 🚨 役職名の配列（旧 LEADER_PLUS_ROLES / PRESIDENT_ROLES）は書かない。
//    「リーダー以上」＝ roles.is_leader_plus（フロア責任者は含めない・2026-07-19 ユーザー決定）
//    「社長のみ」　　＝ roles.is_org_wide（経営。社長・管理者）
//    改名や役職の新設は管理画面の属性で吸収される（2026-09-09 に改名で壊れた反省）。

// キーが公開されているか判定（管理者は常にtrue）
// 全公開ON → 全員 / リーダー以上ON → リーダー以上 / 社長のみON → 経営 / 全てOFF → 管理者のみ
export function isFeaturePublished(
  key: string,
  state: FeaturePublishState,
  isAdmin: boolean,
  roleTitle?: string
): boolean {
  const a = attrsFor(state.roles, roleTitle);
  const isLeaderPlus = isAdmin || a.is_leader_plus;
  const isPresident = isAdmin || a.is_org_wide;
  return isAdmin
    || state.published[key] !== false
    || (state.publishedLeader[key] === true && isLeaderPlus)
    || (state.publishedPresident[key] === true && isPresident);
}

// 🚨 ホームでは3か所がこのフックを呼び、画面を開くたびに3本ずつ（計9本）読んでいた（2026-09-27・通信量の見直し）。
//    同時の呼び出しは1本にまとめ、読んだ値は 10 分使い回す（2026-10-19 に 30秒 → 10分・通信量の見直し②）。
//    設定を変えても、ほかの人の画面には長くて 10 分で行き渡る。自分が書き込んだあと（lib/writeWatch の 'admin'）はすぐ読み直す
type PublishedValues = Omit<FeaturePublishState, 'roles'>;
const PUBLISHED_TTL_MS = 10 * 60 * 1000;
const PUBLISHED_REFRESH_TOPICS = ['admin'] as const;
let publishedCache: { at: number; value: PublishedValues } | null = null;
let publishedInflight: Promise<PublishedValues> | null = null;
// 🚨 2026-10-17：5つの設定を1本で読む（前は3本を別々に読んでいた）。退職者は RLS で読めるキーが限られるので、
//    来なかったキーは今までどおりの既定値（公開扱い・ナビは今の並び・切り替えはオフ）になる
const PUBLISHED_KEYS = ['feature_published', 'feature_published_leader', 'feature_published_president', 'nav_order', 'nav_rollout'];
// ナビの並びと切り替えは端末にも覚えておく（開くたびに一瞬「今の並び」に戻って見えないように）。権限ではなく見た目だけ
const NAV_LOCAL_KEY = 'fivem_nav_settings';
function readNavLocal(): { navOrder: string[]; navRollout: NavRollout } {
  try {
    const o = JSON.parse(localStorage.getItem(NAV_LOCAL_KEY) || 'null') as { navOrder?: unknown; navRollout?: unknown } | null;
    return {
      navOrder: Array.isArray(o?.navOrder) ? (o!.navOrder as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      navRollout: parseNavRollout(o?.navRollout),
    };
  } catch { return { navOrder: [], navRollout: NAV_ROLLOUT_OFF }; }
}
function loadPublished(): Promise<PublishedValues> {
  if (publishedCache && Date.now() - publishedCache.at < PUBLISHED_TTL_MS && !writtenSince(PUBLISHED_REFRESH_TOPICS, publishedCache.at)) return Promise.resolve(publishedCache.value);
  if (publishedInflight) return publishedInflight;
  publishedInflight = Promise.resolve(supabase.from('app_settings').select('key, value').in('key', PUBLISHED_KEYS))
    .then(({ data, error }) => {
      if (error) throw error;
      const m = new Map(((data ?? []) as { key: string; value: unknown }[]).map(r => [r.key, r.value]));
      const navKeys = (m.get('nav_order') as { keys?: unknown } | undefined)?.keys;
      const value: PublishedValues = {
        published: (m.get('feature_published') as Record<string, boolean>) || {},
        publishedLeader: (m.get('feature_published_leader') as Record<string, boolean>) || {},
        publishedPresident: (m.get('feature_published_president') as Record<string, boolean>) || {},
        navOrder: Array.isArray(navKeys) ? navKeys.filter((k): k is string => typeof k === 'string') : [],
        navRollout: parseNavRollout(m.get('nav_rollout')),
      };
      publishedCache = { at: Date.now(), value };
      try { localStorage.setItem(NAV_LOCAL_KEY, JSON.stringify({ navOrder: value.navOrder, navRollout: value.navRollout })); } catch { /* 容量超過などは無視 */ }
      return value;
    }).finally(() => { publishedInflight = null; });
  return publishedInflight;
}

/** 管理画面でナビの設定を変えたあと、すぐ読み直す（10分の使い回しを捨てる） */
export function invalidatePublishedCache(): void {
  publishedCache = null;
}

// 機能の公開状態（app_settings の feature_published / feature_published_leader / feature_published_president）
export function useFeaturePublished(): FeaturePublishState {
  const roles = useRoles();
  const [state, setState] = useState<PublishedValues>(() => publishedCache?.value ?? { published: {}, publishedLeader: {}, publishedPresident: {}, ...readNavLocal() });

  useEffect(() => {
    let alive = true;
    loadPublished().then(v => { if (alive) setState(v); }, () => {});
    return () => { alive = false; };
  }, []);

  return { ...state, roles };
}
