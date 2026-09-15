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

/** user_id → 表に書く短い名前 */
export function shortNameMap(staff: NamedStaff[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const s of staff) {
    if (s.is_active === false) continue;
    const f = familyName(s.name);
    count.set(f, (count.get(f) ?? 0) + 1);
  }
  return new Map(staff.map(s => {
    const hasSpace = SPACE.test(s.name.trim());
    const f = familyName(s.name);
    return [s.id, !hasSpace || (count.get(f) ?? 0) > 1 ? fullName(s.name) : f];
  }));
}
