// 勤務する場所の選択肢（校・出張先・園指導先）と、自由入力の文から場所を読み取る部品（2026-10-08）
// 🚨 校が途中で変わる日を「その他（自由入力）」に「四条本校→15:30までに南草津校へ移動」のように1行で書く人がいて、
//    書き方が人ごとにばらばら・何時に移るかが無い記録もあった。場所の一覧と読み取りをここ1か所にまとめる
// 🚨 supabase を読まない（画面を開かずに node で検算できるように）。読み込みは呼ぶ側（CalendarPage）で行う

export interface PlaceGroup {
  /** 見出し（校・出張・園指導 など） */
  label: string;
  items: string[];
}

/** master_options の category（workplace／trip_category／trip_location_◯◯）の行を読むときの条件（PostgREST の or。like の「*」は「%」と同じ意味） */
export const PLACE_OPTION_FILTER = 'category.eq.workplace,category.eq.trip_category,category.like.trip_location_*';

/**
 * 選択肢の一覧を作る。並び＝校（行き先リストの workplace）→ 出張の区分ごとの行き先（trip_category の並び・終了したものは出さない）。
 * 出張先は管理画面の「区分・行き先リスト管理」に足せば、ここにも自動で出る。rows は sort_order の順で渡す
 */
export function placeGroupsFromRows(rows: { category: string; value: string; ended_at?: string | null }[]): PlaceGroup[] {
  const live = rows.filter(r => !r.ended_at);
  const groups: PlaceGroup[] = [{ label: '校', items: live.filter(r => r.category === 'workplace').map(r => r.value) }];
  for (const cat of live.filter(r => r.category === 'trip_category')) {
    const items = live.filter(r => r.category === `trip_location_${cat.value}`).map(r => r.value);
    if (items.length > 0) groups.push({ label: cat.value, items });
  }
  return groups;
}

/** 一覧のすべての場所（「その他」かどうかの見分けに使う） */
export const allPlaces = (groups: PlaceGroup[]): string[] => groups.flatMap(g => g.items);

/** 呼び方の揺れ（「四条本校」を「本校」、「西陣校」を「西陣」と書くなど）。校は「校」を取った形でも当てる */
function aliasesOf(groups: PlaceGroup[]): { alias: string; name: string }[] {
  const out: { alias: string; name: string }[] = [];
  for (const g of groups) {
    for (const name of g.items) {
      out.push({ alias: name, name });
      if (g.label === '校') {
        const short = name.replace(/校$/, '');
        if (short.length >= 2 && short !== name) out.push({ alias: short, name });
        if (name === '四条本校') out.push({ alias: '本校', name }); // 「四条」だけは JEUGIA 四条（出張）と紛れるので当てない
      }
    }
  }
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

/**
 * 自由入力の文に書かれている場所を、書かれている順に重なりなく返す。
 * 例）「四条本校→15:30までに南草津校へ移動」→ ['四条本校', '南草津校']
 */
export function placesInText(text: string, groups: PlaceGroup[]): string[] {
  const t = text ?? '';
  const used: boolean[] = new Array(t.length).fill(false);
  const hits: { at: number; name: string }[] = [];
  for (const { alias, name } of aliasesOf(groups)) {
    let from = 0;
    for (;;) {
      const at = t.indexOf(alias, from);
      if (at < 0) break;
      from = at + alias.length;
      if (used.slice(at, at + alias.length).some(Boolean)) continue;
      for (let i = at; i < at + alias.length; i++) used[i] = true;
      hits.push({ at, name });
    }
  }
  const seen = new Set<string>();
  return hits.sort((a, b) => a.at - b.at).map(h => h.name).filter(n => (seen.has(n) ? false : (seen.add(n), true)));
}

/** 移動を表す書き方（矢印・「移動」）があるか */
export const hasMoveWords = (text: string): boolean => /→|⇨|⇒|➡|->|移動|移る/.test(text ?? '');

/** 文の中の時刻（「15:30」「15：30」「14時」）を書かれている順に 'HH:MM' で返す */
export function timesInText(text: string): string[] {
  const out: string[] = [];
  const re = /(\d{1,2})\s*[:：]\s*(\d{2})|(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/g;
  for (let m = re.exec(text ?? ''); m; m = re.exec(text ?? '')) {
    const h = Number(m[1] ?? m[3]);
    const mi = Number(m[2] ?? m[4] ?? 0);
    if (h <= 29 && mi < 60) out.push(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  }
  return out;
}
