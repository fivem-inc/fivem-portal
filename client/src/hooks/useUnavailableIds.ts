/**
 * いま休職中で、申請先・宛先の候補に出さない人の id（2026-10-20・段3の4）。
 * 初めは空（＝外さない）で描き、読めたら外す。読み込みは lib/staffLeave の fetchUnavailableIds（10分使い回し）
 */
import { useEffect, useState } from 'react';
import { fetchUnavailableIds } from '../lib/staffLeave';

export function useUnavailableIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    void fetchUnavailableIds().then(s => { if (alive) setIds(s); });
    return () => { alive = false; };
  }, []);
  return ids;
}
