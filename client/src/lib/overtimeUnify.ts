import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

// 休暇申請の「時間調整」「調整休（時間外調整休・振替休日）」を残業申請にまとめる区切りの日（2026-10-13 ユーザー確定・10/16 から）。
// 🚨 値は app_settings の overtime_unify_cutoff（"YYYY-MM-DD"）。DB の守り（enforce_leave_adjust_moved）も同じ値を読む。
//    日付で判定するので、その日が来れば自動で切り替わる（夜中に設定を書き換える仕組みは使わない）。
//    戻すときは値を遠い未来にするだけ（deploy 不要）

/** 区切りの日（"YYYY-MM-DD"）。読めない・設定が無いときは null＝今までどおり */
export function useOvertimeUnifyCutoff(): string | null {
  const [cutoff, setCutoff] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    supabase.from('app_settings').select('value').eq('key', 'overtime_unify_cutoff').maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { console.error('[残業へのまとめ] 区切りの日を読めませんでした', error.message); return; }
        const v = (data as { value?: unknown } | null)?.value;
        setCutoff(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      });
    return () => { alive = false; };
  }, []);
  return cutoff;
}

/** "2026-10-16" → "10/16" */
export const cutoffLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
