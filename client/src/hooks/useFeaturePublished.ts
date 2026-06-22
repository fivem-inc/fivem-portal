import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export interface FeaturePublishState {
  published: Record<string, boolean>;       // 全公開（値が無いキーは公開扱い）
  publishedLeader: Record<string, boolean>; // リーダー以上公開（値が無いキーは false）
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
