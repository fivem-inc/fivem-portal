import { useState, useEffect, useCallback } from 'react';
import { useRefreshOn } from './useRefreshOn';
import { TOPICS_ADMIN } from '../lib/badgeTopics';
import { supabase } from '../lib/supabaseClient';

export type AdminSetupAlert = {
  key: string;
  title: string;
  detail: string;
  link: string;
};

/**
 * 管理者の「入力もれ」を数える。
 *
 * 判定は DB の admin_setup_alerts() 1本に集約している。
 * 週1回の通知（Edge Function remind-admin-setup）も同じ関数を呼ぶので、
 * 「バッジは出ているのに通知が来ない」といった食い違いが起きない。
 *
 * バッジに使うのは「対応すれば消えるもの」だけ（shift_review は時期で出るだけなので除く）。
 * 対応しても消えないバッジは、ただのノイズになってしまうため。
 */
const BADGE_KEYS = ['company_calendar'];

export const useAdminSetupAlerts = (enabled: boolean) => {
  const [alerts, setAlerts] = useState<AdminSetupAlert[]>([]);

  const fetchAlerts = useCallback(async () => {
    if (!enabled) { setAlerts([]); return; }
    const { data, error } = await supabase.rpc('admin_setup_alerts');
    if (error || !data) return; // 取れないときは前回の値を保つ（0件に落として見落とさせない）
    setAlerts(data as AdminSetupAlert[]);
  }, [enabled]);

  // 入力してすぐの確認は admin-setup-changed で即時。それ以外は管理画面を出入りしたとき・前面復帰の全件で数え直す（2026-09-27 までは 30 秒ごと）
  // 🚨 30 秒ごとをやめ、通知の表にこの話題の新しい行が来たとき・ページを出入りしたときだけ数え直す（2026-09-27・通信量の見直し 段2・hooks/useRefreshOn.ts）
  useRefreshOn(fetchAlerts, TOPICS_ADMIN);
  useEffect(() => {
    const onChanged = () => fetchAlerts();
    window.addEventListener('admin-setup-changed', onChanged);
    return () => { window.removeEventListener('admin-setup-changed', onChanged); };
  }, [fetchAlerts]);

  return {
    alerts,
    badgeCount: alerts.filter(a => BADGE_KEYS.includes(a.key)).length,
  };
};
