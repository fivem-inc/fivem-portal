import { useState, useEffect, useCallback } from 'react';
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

  useEffect(() => {
    fetchAlerts();
    // 入力してすぐ確認したいので、他のバッジと同じく30秒ごとに数え直す
    const t = setInterval(fetchAlerts, 30000);
    const onChanged = () => fetchAlerts();
    window.addEventListener('admin-setup-changed', onChanged);
    return () => { clearInterval(t); window.removeEventListener('admin-setup-changed', onChanged); };
  }, [fetchAlerts]);

  return {
    alerts,
    badgeCount: alerts.filter(a => BADGE_KEYS.includes(a.key)).length,
  };
};
