import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export interface FeaturePublishState {
  published: Record<string, boolean>;          // 全公開（値が無いキーは公開扱い）
  publishedLeader: Record<string, boolean>;    // リーダー以上公開（値が無いキーは false）
  publishedPresident: Record<string, boolean>; // 社長のみ公開（値が無いキーは false）新機能の先行テスト用
}

// 役職序列：社長＞マネージャー＞リーダー＞フロア責任者＞一般・パート
// フロア責任者はリーダーより下位のため「リーダー以上」先行公開に含めない（2026-07-19ユーザー決定）
const LEADER_PLUS_ROLES = ['リーダー', 'マネージャー', '社長', '管理者'];
const PRESIDENT_ROLES = ['社長', '管理者'];

// キーが公開されているか判定（管理者は常にtrue）
// 全公開ON → 全員 / リーダー以上ON → リーダー以上 / 社長のみON → 社長・管理者 / 全てOFF → 管理者のみ
export function isFeaturePublished(
  key: string,
  state: FeaturePublishState,
  isAdmin: boolean,
  roleTitle?: string
): boolean {
  const isLeaderPlus = isAdmin || LEADER_PLUS_ROLES.includes(roleTitle ?? '');
  const isPresident = isAdmin || PRESIDENT_ROLES.includes(roleTitle ?? '');
  return isAdmin
    || state.published[key] !== false
    || (state.publishedLeader[key] === true && isLeaderPlus)
    || (state.publishedPresident[key] === true && isPresident);
}

// 機能の公開状態（app_settings の feature_published / feature_published_leader / feature_published_president）
export function useFeaturePublished(): FeaturePublishState {
  const [state, setState] = useState<FeaturePublishState>({ published: {}, publishedLeader: {}, publishedPresident: {} });

  useEffect(() => {
    Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'feature_published').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_leader').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_president').maybeSingle(),
    ]).then(([allRes, leaderRes, presRes]) => {
      setState({
        published: (allRes?.data?.value as Record<string, boolean>) || {},
        publishedLeader: (leaderRes?.data?.value as Record<string, boolean>) || {},
        publishedPresident: (presRes?.data?.value as Record<string, boolean>) || {},
      });
    }, () => {});
  }, []);

  return state;
}
