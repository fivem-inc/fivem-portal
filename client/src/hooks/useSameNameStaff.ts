// 同じ名前の人がもう登録されていないか（2026-10-08・二重登録の再発防止）。
// スタッフの登録（ユーザー一覧の［新しいスタッフを登録］）と入社予定の登録の2か所で使う。
// 🚨 止めはしない（同姓同名の別人もありうる）。知らせて、確かめてから登録してもらう
// 🚨 名前は空白（全角・半角）を除いて比べる（「山田 花子」と全角の空白の「山田 花子」を同じ人と見る）
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { todayJstStr } from '../lib/breakCalc';

export const normStaffName = (s: string) => s.replace(/\s/g, '');

interface Row { id: string; name: string | null; is_active: boolean | null; hire_date: string | null }

export interface SameNameHit { id: string; name: string; state: '在籍' | '入社予定' | '在籍していない' }

/** name と同じ名前の人。読めなかったときは error（黙って「いない」にしない） */
export function useSameNameStaff(name: string, enabled = true): { hits: SameNameHit[]; error: string } {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || rows) return;
    let alive = true;
    void (async () => {
      const { data, error: e } = await supabase.from('profiles').select('id, name, is_active, hire_date');
      if (!alive) return;
      if (e) { setError(`同じ名前の人がいるかを確かめられませんでした：${e.message}`); return; }
      setRows((data ?? []) as Row[]);
    })();
    return () => { alive = false; };
  }, [enabled, rows]);
  const hits = useMemo(() => {
    const n = normStaffName(name);
    if (!n || !rows) return [];
    const today = todayJstStr();
    return rows.filter(r => normStaffName(r.name ?? '') === n).map(r => ({
      id: r.id, name: r.name ?? '',
      state: r.is_active ? '在籍' as const : r.hire_date && r.hire_date > today ? '入社予定' as const : '在籍していない' as const,
    }));
  }, [name, rows]);
  return { hits, error };
}
