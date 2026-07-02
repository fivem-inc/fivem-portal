import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export interface FeaturePublishState {
  published: Record<string, boolean>;       // 全公開（値が無いキーは公開扱い）
  publishedLeader: Record<string, boolean>; // リーダー以上公開（値が無いキーは false）
}

const LEADER_PLUS_ROLES = ['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'];

// キーが公開されているか判定（管理者は常にtrue）
// 全公開ON → 全員 / 全公開OFF+リーダー以上ON → リーダー以上のみ / 両方OFF → 管理者のみ
export function isFeaturePublished(
  key: string,
  state: FeaturePublishState,
  isAdmin: boolean,
  roleTitle?: string
): boolean {
  const isLeaderPlus = isAdmin || LEADER_PLUS_ROLES.includes(roleTitle ?? '');
  return isAdmin
    || state.published[key] !== false
    || (state.publishedLeader[key] === true && isLeaderPlus);
}

// 機能の公開状態（app_settings の feature_published / feature_published_leader）
export function useFeaturePublished(): FeaturePublishState {
  const [state, setState] = useState<FeaturePublishState>({ published: {}, publishedLeader: {} });

  useEffect(() => {
    Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'feature_published').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_leader').maybeSingle(),
    ]).then(([allRes, leaderRes]) => {
      setState({
        published: (allRes?.data?.value as Record<string, boolean>) || {},
        publishedLeader: (leaderRes?.data?.value as Record<string, boolean>) || {},
      });
    }, () => {});
  }, []);

  return state;
}
