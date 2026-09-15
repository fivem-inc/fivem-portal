// 表に書く短い名前（2026-09-15）。勤務表の勉強会の欄・④掃除担当表・⑤こどもシフト表で共通に使う。
// 🚨 名字だけにし、同じ名字の人がいるときだけフルネーム（ユーザー確定）
// 🚨 同じ名字かどうかは「在籍者全体」で決める（マスごとに決めると、同じ人がマスによって違う書き方になる）
// 🚨 名前に空白が無い（「管理者」などシステム用）はそのまま
// 🚨 このファイルは supabase を読まない

export interface NamedStaff {
  id: string;
  name: string;
  is_active?: boolean | null;
}

const SPACE = /[\s\u3000]+/;

/** "太田（全角空白）恭子" → "太田"（空白が無ければそのまま） */
export function familyName(name: string): string {
  const parts = name.trim().split(SPACE);
  return parts.length > 1 ? parts[0] : name.trim();
}

/** "太田（全角空白）恭子" → "太田 恭子"（空白を1つにそろえる） */
export function fullName(name: string): string {
  return name.trim().split(SPACE).join(' ');
}

/**
 * user_id → 表に書く短い名前（④ 2026-09-15 から呼び名つき）
 * ・呼び名（staff_display_names）があればそれ
 * ・無ければ名字。🚨 ほかの在籍者の「表に出る名前」（呼び名・名字）とかぶるときだけフルネーム
 *   （森本 千佳子さんが呼び名「尾上」なら、森本 純矢さんは「森本」のまま）
 * ・呼び名どうしがかぶったとき（DB が止めるが、退職から戻った人など）は両方フルネーム
 * @param labels user_id → 呼び名
 */
export function shortNameMap(staff: NamedStaff[], labels: Map<string, string> = new Map()): Map<string, string> {
  const active = staff.filter(s => s.is_active !== false);
  const labelCount = new Map<string, number>();
  const familyCount = new Map<string, number>();
  for (const s of active) {
    const l = labels.get(s.id);
    if (l) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
    else if (SPACE.test(s.name.trim())) familyCount.set(familyName(s.name), (familyCount.get(familyName(s.name)) ?? 0) + 1);
  }
  return new Map(staff.map(s => {
    const l = labels.get(s.id);
    if (l) return [s.id, (labelCount.get(l) ?? 0) > 1 ? fullName(s.name) : l];
    if (!SPACE.test(s.name.trim())) return [s.id, fullName(s.name)];
    const f = familyName(s.name);
    const clash = (familyCount.get(f) ?? 0) > 1 || (labelCount.get(f) ?? 0) > 0;
    return [s.id, clash ? fullName(s.name) : f];
  }));
}
