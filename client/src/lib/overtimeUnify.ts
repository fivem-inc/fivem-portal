import { useEffect, useState } from 'react';
import { getAppSetting } from './appSettings';

// 休暇申請の「時間調整」「調整休（時間外調整休・振替休日）」を残業申請にまとめる（2026-10-13 ユーザー確定）。
// ・区切りの日 overtime_unify_cutoff（10/16）：この日以降の勤務日は残業申請だけ。休暇申請は案内に変わる
// ・片付けの日 overtime_unify_cleanup（11/16）：休暇申請から時間調整タブと調整休をなくし、案内・注意事項の日付の言葉を取る
// 🚨 値は app_settings（"YYYY-MM-DD"）。DB の守り（enforce_leave_adjust_moved）も区切りの日を読む。
//    日付で判定するので、その日が来れば自動で切り替わる（夜中に設定を書き換える仕組みは使わない）。
//    延ばす・戻すときは値を変えるだけ（deploy 不要）

/** app_settings の日付の設定（"YYYY-MM-DD"）。読めない・空なら null。出張報告からの申請（trip_apply_start）も使う */
export function useAppDateSetting(key: string): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // 🚨 読み込みは lib/appSettings（同じ瞬間の頼みを1回に・画面の中で10分使い回す・2026-10-28 ログの量の見直し）
    void getAppSetting(key).then(r => {
      if (!alive) return;
      if (!r.ok) { console.error(`[残業へのまとめ] ${key} を読めませんでした`, r.error); return; }
      const x = r.value;
      setV(typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
    });
    return () => { alive = false; };
  }, [key]);
  return v;
}

/** 区切りの日（"YYYY-MM-DD"）。読めない・設定が無いときは null＝今までどおり */
export const useOvertimeUnifyCutoff = (): string | null => useAppDateSetting('overtime_unify_cutoff');
/** 片付けの日（"YYYY-MM-DD"）。この日からは時間調整タブ・調整休を出さず、日付の言葉も取る。null＝片付けない */
export const useOvertimeUnifyCleanup = (): string | null => useAppDateSetting('overtime_unify_cleanup');

/** "2026-10-16" → "10/16" */
export const cutoffLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
