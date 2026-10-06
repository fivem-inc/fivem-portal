// ⑤ こどもシフト表の PDF（印刷用の画面）を組み立てる（2026-09-16・2026-10-06 時刻の列に作り直し）。
// 🚨 supabase を読まない。別の窓に書き出してブラウザの印刷で「PDF に保存」する（勤務表・掃除担当表と同じ openRosterPrint）
// ・画面と同じく「左に時刻の列」（2026-10-06 ユーザー確定 案E）。曜日ごとに、その日のクラスの時刻から帯を作る（lib/kidsShiftBands.ts）
// ・本校 3F・5F の帯のすぐ下に「共通 名前… 他業務：名前…」（PDF は人数を刷らない・色も付けない）
// ・紙は出すときに選ぶ：A4横1枚（詰める）／A4横2枚（月〜水・木〜日）。A3 は要らない（プリンターで拡大できる）
// ・その曜日に中身がある列だけ出す（ユーザー確定 案A）。校の見出しの役割は列の上に、曜日の書き添えと社員休みは段の下に
// ・変わった所の印（薄い黄色の帯・変わった名前は濃いピンク・抜けたものは「前：」）と 追加必要の「（ ）」は出すときに選ぶ
// 🚨 変わった所の色と見分け方は lib/changeMark.ts 1か所

import { type KidsPlace } from './kidsShift';
import { ROSTER_DAY_LABEL, type RosterDayKind } from './shiftRoster';
import { CHANGE_MARK_PRINT_CSS, diffLines } from './changeMark';
import type { KidsBand } from './kidsShiftBands';

export type KidsPrintLayout = 'one' | 'two';

export interface KidsPoolPrintRow {
  /** 共通の行を出す列（その校の 3F・5F・並んでいる） */
  placeIds: string[];
  common: string;       // 例：小出・幾田17:00まで・阿部
  other: string;        // 例：貴子・尾上（6F）
  baseCommon: string;   // 比べる先（変わった所の印に使う）
  baseOther: string;
}

export interface KidsPrintOptions {
  title: string;                       // 例：2026年10月～ こどもシフト表 案2
  asOf: string;                        // 例：2026-09-16（「（2026.9.16時点）」と出す）
  notes: string[];                     // 表全体の書き添え
  columnsOf: (day: RosterDayKind) => KidsPlace[];              // その曜日に出す列
  bandsOf: (day: RosterDayKind) => KidsBand[];                 // その曜日の時刻の帯
  /** 帯ごとのマスの文字（いまの文字と、比べる先の文字。どちらも「（ ）」込み・同じ作り方） */
  cellOf: (placeId: string, day: RosterDayKind, band: number) => { lines: string[]; base: string[] };
  /** 帯の下の共通の行（出さない帯は null） */
  poolOf: (day: RosterDayKind, band: number) => KidsPoolPrintRow | null;
  headOf: (school: string, day: RosterDayKind) => string[];    // 校の見出しの役割
  /** 変わった所に印（薄い黄色の帯・濃いピンク）を付けるか */
  markChanges: boolean;
  offStaff: Partial<Record<RosterDayKind, string[]>>;          // 社員休み
  dayNotes: Partial<Record<RosterDayKind, string[]>>;          // 曜日の書き添え
  layout: KidsPrintLayout;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 紙ごとの曜日の並べ方。1枚＝3段（月火／水木／金土日）、2枚＝1枚目（月火／水）・2枚目（木金／土日） */
const PAGES: Record<KidsPrintLayout, RosterDayKind[][][]> = {
  one: [[['mon', 'tue'], ['wed', 'thu'], ['fri', 'sat', 'sun']]],
  two: [[['mon', 'tue'], ['wed']], [['thu', 'fri'], ['sat', 'sun']]],
};

function asOfLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `（${y}.${m}.${d}時点）`;
}

/** 文字を、変わった所だけ濃いピンクにした HTML にする（抜けたものは返す） */
function markedHtml(lines: string[], base: string[]): { html: string; removed: string[] } {
  const m = diffLines(lines, base);
  return {
    html: m.lines.map(ps => `<div>${ps.map(p => (p.hit ? `<span class="chg">${esc(p.text)}</span>` : esc(p.text))).join('')}</div>`).join(''),
    removed: m.removed,
  };
}
const goneHtml = (removed: string[]) =>
  (removed.length > 0 ? `<div>前：${removed.map(r => `<span class="chg gone">${esc(r)}</span>`).join('・')}</div>` : '');

export function buildKidsPrintHtml(o: KidsPrintOptions): string {
  const schoolOf = (p: KidsPlace) => p.school ?? '';
  const dayBlock = (day: RosterDayKind): string => {
    const cols = o.columnsOf(day);
    if (cols.length === 0) return '';
    const bands = o.bandsOf(day);
    // 校ごとに見出しをまとめる（本校の 3F・5F・6F は1つの見出し）
    const groups: { school: string; cols: KidsPlace[] }[] = [];
    for (const c of cols) {
      const s = schoolOf(c);
      const last = groups.at(-1);
      if (last && last.school === s) last.cols.push(c);
      else groups.push({ school: s, cols: [c] });
    }
    const head = '<th class="tm" rowspan="' + (cols.some(c => c.floor) ? 2 : 1) + '">時刻</th>' + groups.map(g => {
      const roles = g.school ? o.headOf(g.school, day) : [];
      return `<th colspan="${g.cols.length}"><b>${esc(g.school || '園指導')}</b>`
        + (roles.length > 0 ? `<span class="role">${roles.map(esc).join('\u3000')}</span>` : '')
        + '</th>';
    }).join('');
    const sub = cols.map(c => `<th class="sub">${esc(c.floor ?? '')}</th>`).join('');

    const rows = bands.map((b, bi) => {
      const pool = o.poolOf(day, bi);
      const poolIds = new Set(pool?.placeIds ?? []);
      const cells = cols.map(c => {
        const { lines, base } = o.cellOf(c.id, day, bi);
        const span = pool && !poolIds.has(c.id) ? ' rowspan="2"' : '';
        const changed = o.markChanges && lines.join('\n') !== base.join('\n');
        if (!changed) return `<td${span}>${lines.map(l => `<div>${esc(l)}</div>`).join('') || '&nbsp;'}</td>`;
        const m = markedHtml(lines, base);
        return `<td${span} class="chgcell">${m.html}${goneHtml(m.removed)}</td>`;
      }).join('');
      const timeTd = `<td class="tm"${pool ? ' rowspan="2"' : ''}>${esc(b.label)}</td>`;
      let poolTr = '';
      if (pool) {
        const changed = o.markChanges && (pool.common !== pool.baseCommon || pool.other !== pool.baseOther);
        const c1 = changed ? markedHtml([pool.common], [pool.baseCommon]) : { html: esc(pool.common), removed: [] as string[] };
        const c2 = changed ? markedHtml([pool.other], [pool.baseOther]) : { html: esc(pool.other), removed: [] as string[] };
        const strip = (h: string) => h.replace(/^<div>/, '').replace(/<\/div>$/, '');
        poolTr = `<tr><td class="pool${changed ? ' chgcell' : ''}" colspan="${pool.placeIds.length}">`
          + `<b>共通</b>\u3000${strip(c1.html) || 'なし'}`
          + (pool.other || c2.removed.length > 0 ? `\u3000<b>他業務</b>\u3000${strip(c2.html)}` : '')
          + goneHtml([...c1.removed, ...c2.removed])
          + '</td></tr>';
      }
      return `<tr>${timeTd}${cells}</tr>${poolTr}`;
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
      <tbody>${rows}</tbody></table>
      ${foot.length > 0 ? `<div class="foot">${foot.map(esc).join('\u3000／\u3000')}</div>` : ''}
    </div>`;
  };

  const pages = PAGES[o.layout].map((page, pi) => {
    const bands = page.map(b => {
      const blocks = b.map(dayBlock).filter(Boolean).join('');
      return blocks ? `<div class="band">${blocks}</div>` : '';
    }).filter(Boolean).join('');
    if (!bands) return '';
    const titleHtml = pi === 0
      ? `<h1>${esc(o.title)}<span class="asof">${asOfLabel(o.asOf)}</span></h1>${o.notes.length > 0 ? `<div class="notes">${o.notes.map(esc).join('\u3000')}</div>` : ''}`
      : `<h1>${esc(o.title)}（つづき）</h1>`;
    return `<div class="page">${titleHtml}${bands}</div>`;
  }).filter(Boolean).join('');

  // 🚨 1枚に詰めるときは字を小さくする（紙が足りないため）。2枚のときは今までと同じくらいの字
  const fs = o.layout === 'one' ? { cell: 5.2, th: 5.6, role: 5, foot: 5.2 } : { cell: 6.4, th: 6.8, role: 6, foot: 6.4 };

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${esc(o.title)}</title>
<style>
  @page { size: A4 landscape; margin: 6mm; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif; color: #000; margin: 0; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 12pt; margin: 0 0 2mm; }
  .asof { font-size: 8pt; font-weight: normal; margin-left: 4px; }
  .notes { font-size: 7pt; margin: 0 0 2mm; }
  .band { display: flex; gap: 3mm; align-items: flex-start; margin-bottom: 2mm; }
  .day { flex: 1; min-width: 0; }
  .dayname { font-size: 9pt; font-weight: bold; border-bottom: 1px solid #000; margin-bottom: 1mm; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 0.4pt solid #000; padding: 0.5mm 0.7mm; font-size: ${fs.cell}pt; vertical-align: top; word-break: break-all; }
  th { text-align: center; font-size: ${fs.th}pt; }
  th.sub { font-weight: normal; }
  th.tm, td.tm { width: 10mm; text-align: center; font-weight: bold; white-space: nowrap; }
  td.pool { border-top: 0.4pt dashed #000; }
  .role { display: block; font-weight: normal; font-size: ${fs.role}pt; }
  .foot { font-size: ${fs.foot}pt; margin-top: 0.8mm; }
  ${CHANGE_MARK_PRINT_CSS}
  @media screen { body { padding: 10px; background: #fff; } .hint { font-size: 12px; color: #555; margin-bottom: 8px; } .page { margin-bottom: 16px; } }
  @media print { .hint { display: none; } }
</style></head><body>
<div class="hint">この画面をブラウザの印刷（Ctrl+P）で「PDF に保存」してください。用紙は A4・横向きです。</div>
${pages}
</body></html>`;
}
