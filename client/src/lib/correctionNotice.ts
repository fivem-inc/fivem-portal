import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { CorrectionRequestRow, CorrectionTargetType } from './correctionRequest';

// 元の申請の行に出す修正依頼（components/CorrectionNotice）の読み込みと文（2026-10-16）

/** その種類の修正依頼を、申請ごとに「いちばん新しい1件」で。取り下げ（withdrawn）は数えない。
 *  🚨 申請の id で絞らずに種類だけで読む（一覧の申請が多いと .in() の URL が長くなりすぎるため。修正依頼そのものは少ない）。
 *  見えるのは RLS の範囲だけ（管理者＝全部／上長＝自分が受理・確認する申請の分／本人＝自分の分）。 */
export function useLatestCorrections(type: CorrectionTargetType, enabled = true): Map<string, CorrectionRequestRow> {
  const [map, setMap] = useState<Map<string, CorrectionRequestRow>>(new Map());
  const load = useCallback(async () => {
    if (!enabled) { setMap(new Map()); return; }
    const { data, error } = await supabase
      .from('correction_requests')
      .select('*')
      .eq('target_type', type)
      .neq('status', 'withdrawn')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) { console.error('修正依頼の読み込みに失敗:', error.message); return; }
    const m = new Map<string, CorrectionRequestRow>();
    for (const r of (data as CorrectionRequestRow[] | null) ?? []) if (!m.has(r.target_id)) m.set(r.target_id, r);
    setMap(m);
  }, [type, enabled]);
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('correction-pending-changed', h);
    return () => window.removeEventListener('correction-pending-changed', h);
  }, [load]);
  return map;
}

/** 依頼の中身を1行に（例「日付：12/5→12/6」・取消は「この申請の取り消し」・項目が無ければ本人の一言） */
export const correctionSummary = (r: CorrectionRequestRow) => {
  if (r.request_kind === 'cancel') return 'この申請の取り消し';
  if (r.requested_changes && r.requested_changes.length > 0) return r.requested_changes.map(c => `${c.label}：${c.from}→${c.to}`).join('／');
  return r.message;
};

