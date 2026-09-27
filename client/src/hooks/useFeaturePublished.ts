import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { attrsFor } from '../lib/roleAttrs';
import type { RoleRow } from '../lib/roleAttrs';
import { useRoles } from './useRoles';

export interface FeaturePublishState {
  published: Record<string, boolean>;          // 全公開（値が無いキーは公開扱い）
  publishedLeader: Record<string, boolean>;    // リーダー以上公開（値が無いキーは false）
  publishedPresident: Record<string, boolean>; // 社長のみ公開（値が無いキーは false）新機能の先行テスト用
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
//    同時の呼び出しは1本にまとめ、読んだ値は 30 秒だけ使い回す。設定を変えても長くて 30 秒で全画面に行き渡る
type PublishedValues = Omit<FeaturePublishState, 'roles'>;
const PUBLISHED_TTL_MS = 30 * 1000;
let publishedCache: { at: number; value: PublishedValues } | null = null;
let publishedInflight: Promise<PublishedValues> | null = null;
function loadPublished(): Promise<PublishedValues> {
  if (publishedCache && Date.now() - publishedCache.at < PUBLISHED_TTL_MS) return Promise.resolve(publishedCache.value);
  if (publishedInflight) return publishedInflight;
  publishedInflight = Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'feature_published').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_leader').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_president').maybeSingle(),
    ]).then(([allRes, leaderRes, presRes]) => {
      const value: PublishedValues = {
        published: (allRes?.data?.value as Record<string, boolean>) || {},
        publishedLeader: (leaderRes?.data?.value as Record<string, boolean>) || {},
        publishedPresident: (presRes?.data?.value as Record<string, boolean>) || {},
      };
      publishedCache = { at: Date.now(), value };
      return value;
    }).finally(() => { publishedInflight = null; });
  return publishedInflight;
}

// 機能の公開状態（app_settings の feature_published / feature_published_leader / feature_published_president）
export function useFeaturePublished(): FeaturePublishState {
  const roles = useRoles();
  const [state, setState] = useState<PublishedValues>(() => publishedCache?.value ?? { published: {}, publishedLeader: {}, publishedPresident: {} });

  useEffect(() => {
    let alive = true;
    loadPublished().then(v => { if (alive) setState(v); }, () => {});
    return () => { alive = false; };
  }, []);

  return { ...state, roles };
}
