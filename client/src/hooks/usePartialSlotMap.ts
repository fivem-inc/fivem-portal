import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// 受理済みの遅出・早退・勤務地変更の「シフト調整」の欄（components/PartialShiftToggle）の材料：対象の人・日付の相談をまとめて1回で読む（2026-10-20）

export interface PartialSlot { status: string; not_needed: boolean; cause: string }

/** 対象の人・日付の相談をまとめて読む（キー：`${user}|${date}`）。reloadKey を変えると読み直す */
export function usePartialSlotMap(userIds: string[], from: string, to: string, reloadKey = 0): Record<string, PartialSlot> {
  const [map, setMap] = useState<Record<string, PartialSlot>>({});
  const idsKey = [...new Set(userIds)].sort().join(',');
  useEffect(() => {
    let alive = true;
    if (!idsKey || !from || !to) { setMap({}); return; }
    (async () => {
      const { data, error } = await supabase.from('shift_adjust_slots')
        .select('target_user_id, target_date, status, not_needed, cause')
        .in('target_user_id', idsKey.split(','))
        .gte('target_date', from).lte('target_date', to);
      if (!alive) return;
      if (error) { console.error('[シフト調整] 相談を読み込めませんでした:', error.message); return; }
      const m: Record<string, PartialSlot> = {};
      for (const r of (data ?? []) as { target_user_id: string; target_date: string; status: string; not_needed: boolean; cause: string }[]) {
        m[`${r.target_user_id}|${r.target_date}`] = { status: r.status, not_needed: r.not_needed, cause: r.cause };
      }
      setMap(m);
    })();
    return () => { alive = false; };
  }, [idsKey, from, to, reloadKey]);
  return map;
}
