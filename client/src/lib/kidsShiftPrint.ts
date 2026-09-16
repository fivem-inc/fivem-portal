// ⑤ こどもシフト表の PDF（印刷用の画面）を組み立てる（2026-09-16）。
// 🚨 supabase を読まない。別の窓に書き出してブラウザの印刷で「PDF に保存」する（勤務表・掃除担当表と同じ openRosterPrint）
// ・紙と同じ A4横1枚。段は「月・火」「水・木」「金・土・日」
// ・その曜日に中身がある列だけ出す（ユーザー確定 案A）。校の見出しの役割は列の上に、曜日の書き添えと社員休みは段の下に
// ・赤字（前の日から変わったマス）と 追加必要の「（ ）」は出すときに選ぶ
// 🚨 新しい色は足さない（赤字だけ・地の色は付けない）

import { KIDS_WEEK, type KidsCellValue, type KidsPlace } from './kidsShift';
import { ROSTER_DAY_LABEL, type RosterDayKind } from './shiftRoster';

export interface KidsPrintOptions {
  title: string;                       // 例：2026年10月～ こどもシフト表 案2
  asOf: string;                        // 例：2026-09-16（「（2026.9.16時点）」と出す）
  notes: string[];                     // 表全体の書き添え
  places: KidsPlace[];                 // 有効な置き場所（列・見出し）すべて
  columnsOf: (day: RosterDayKind) => KidsPlace[];              // その曜日に出す列
  linesOf: (placeId: string, day: RosterDayKind) => string[];  // マスの文字（すでに「（ ）」込み）
  headOf: (school: string, day: RosterDayKind) => string[];    // 校の見出しの役割
  changed: Set<string>;                // `${placeId}|${day}`
  redChanges: boolean;
  offStaff: Partial<Record<RosterDayKind, string[]>>;          // 社員休み
  dayNotes: Partial<Record<RosterDayKind, string[]>>;          // 曜日の書き添え
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BANDS: RosterDayKind[][] = [['mon', 'tue'], ['wed', 'thu'], ['fri', 'sat', 'sun']];

function asOfLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `（${y}.${m}.${d}時点）`;
}

export function buildKidsPrintHtml(o: KidsPrintOptions): string {
  const schoolOf = (p: KidsPlace) => p.school ?? '';
  const dayBlock = (day: RosterDayKind): string => {
    const cols = o.columnsOf(day);
    if (cols.length === 0) return '';
    // 校ごとに見出しをまとめる（本校の 3F・5F・6F は1つの見出し）
    const groups: { school: string; cols: KidsPlace[] }[] = [];
    for (const c of cols) {
      const s = schoolOf(c);
      const last = groups.at(-1);
      if (last && last.school === s) last.cols.push(c);
      else groups.push({ school: s, cols: [c] });
    }
    const head = groups.map(g => {
      const roles = g.school ? o.headOf(g.school, day) : [];
      return `<th colspan="${g.cols.length}"><b>${esc(g.school || '園指導')}</b>`
        + (roles.length > 0 ? `<span class="role">${roles.map(esc).join('　')}</span>` : '')
        + '</th>';
    }).join('');
    const sub = cols.map(c => `<th class="sub">${esc(c.floor ?? '')}</th>`).join('');
    const body = cols.map(c => {
      const lines = o.linesOf(c.id, day);
      const red = o.redChanges && o.changed.has(`${c.id}|${day}`);
      return `<td class="${red ? 'red' : ''}">${lines.map(l => `<div>${esc(l)}</div>`).join('') || '&nbsp;'}</td>`;
    }).join('');
    const off = (o.offStaff[day] ?? []);
    const notes = (o.dayNotes[day] ?? []);
    const foot = [
      off.length > 0 ? `（社員休み）${off.join('・')}` : '',
      ...notes,
    ].filter(Boolean);
    return `<div class="day">
      <div class="dayname">${ROSTER_DAY_LABEL[day]}</div>
      <table><thead><tr>${head}</tr>${cols.some(c => c.floor) ? `<tr>${sub}</tr>` : ''}</thead>
      <tbody><tr>${body}</tr></tbody></table>
      ${foot.length > 0 ? `<div class="foot">${foot.map(esc).join('　／　')}</div>` : ''}
    </div>`;
  };

  const bands = BANDS.map(b => {
    const blocks = b.map(dayBlock).filter(Boolean).join('');
    return blocks ? `<div class="band">${blocks}</div>` : '';
  }).filter(Boolean).join('');

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${esc(o.title)}</title>
<style>
  @page { size: A4 landscape; margin: 6mm; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif; color: #000; margin: 0; }
  h1 { font-size: 13pt; margin: 0 0 2mm; }
  .asof { font-size: 8pt; font-weight: normal; margin-left: 4px; }
  .notes { font-size: 7.5pt; margin: 0 0 2mm; }
  .band { display: flex; gap: 3mm; align-items: flex-start; margin-bottom: 2mm; }
  .day { flex: 1; min-width: 0; }
  .dayname { font-size: 9pt; font-weight: bold; border-bottom: 1px solid #000; margin-bottom: 1mm; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 0.4pt solid #000; padding: 0.6mm 0.8mm; font-size: 6.2pt; vertical-align: top; word-break: break-all; }
  th { text-align: center; font-size: 6.6pt; }
  th.sub { font-weight: normal; }
  .role { display: block; font-weight: normal; font-size: 5.8pt; }
  .foot { font-size: 6.2pt; margin-top: 0.8mm; }
  .red { color: #d32f2f; }
  @media screen { body { padding: 10px; background: #fff; } .hint { font-size: 12px; color: #555; margin-bottom: 8px; } }
  @media print { .hint { display: none; } }
</style></head><body>
<div class="hint">この画面をブラウザの印刷（Ctrl+P）で「PDF に保存」してください。用紙は A4・横向きです。</div>
<h1>${esc(o.title)}<span class="asof">${asOfLabel(o.asOf)}</span></h1>
${o.notes.length > 0 ? `<div class="notes">${o.notes.map(esc).join('　／　')}</div>` : ''}
${bands}
</body></html>`;
}

/** その曜日に中身があるか（列の出し分けに使う） */
export function dayHasContent(value: KidsCellValue | null | undefined): boolean {
  return !!value && value.length > 0;
}

export { KIDS_WEEK };
