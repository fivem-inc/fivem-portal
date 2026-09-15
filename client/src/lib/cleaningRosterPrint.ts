// ④ 掃除担当表の PDF（印刷用の画面）を組み立てる（2026-09-15）。
// 🚨 supabase を読まない。別の窓に書き出してブラウザの印刷で「PDF に保存」する（勤務表と同じ openRosterPrint）
// ・紙と同じ A4横1枚（全校）／校を選んで1枚（その校の行だけ・休み・担当なしは出さない）
// ・斜線＝この日は無し。校×曜日の全部が無しなら1本の斜線、全部が同じ1人なら1マスにまとめる（mergedSchoolDay）
// ・赤字（前の日から変わったマス）と ⚠️ は出すときに選ぶ
// 🚨 地の色は足さない（新しい色を足さない決まり）。注意書きは紙と同じ赤字

import { CLEANING_WEEK, cellKey, cellLines, mergedSchoolDay, type CleaningCellValue, type CleaningRow } from './cleaningRoster';
import { ROSTER_DAY_LABEL, minText, toMin, type RosterDayKind } from './shiftRoster';

export interface CleaningPrintOptions {
  applyFrom: string;
  title: string;
  notes: string[];
  rows: CleaningRow[];                 // 出す行（並び順・active だけ）
  valueOf: (rowId: string, day: RosterDayKind) => CleaningCellValue;
  names: Map<string, string>;
  changed: Set<string>;                // cellKey
  redChanges: boolean;
  warn: Set<string>;                   // cellKey（まだ確認していない ⚠️ があるマス）
  showWarn: boolean;
  school: string | null;               // null＝全校
  off?: Partial<Record<RosterDayKind, string[]>>;        // 全校のときだけ
  unassigned?: Partial<Record<RosterDayKind, string[]>>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}/${m}/${d}～`;
}

const schoolShort = (s: string) => s === '四条本校' ? '本校' : s.replace(/校$/, '');

export function buildCleaningPrintHtml(o: CleaningPrintOptions): string {
  const rows = o.rows;
  const schools: string[] = [];
  for (const r of rows) if (!schools.includes(r.school)) schools.push(r.school);

  let body = '';
  for (const school of schools) {
    const sRows = rows.filter(r => r.school === school);
    const noteRows = sRows.filter(r => r.note_below).length;
    const span = sRows.length + noteRows;
    // 🚨 行の下の注意書きがある校はまとめない（注意書きの行と rowspan がぶつかるため）
    const merged = new Map<RosterDayKind, ReturnType<typeof mergedSchoolDay>>();
    if (noteRows === 0) for (const d of CLEANING_WEEK) merged.set(d, mergedSchoolDay(sRows, id => o.valueOf(id, d)));

    sRows.forEach((r, i) => {
      let tr = '<tr>';
      if (i === 0) tr += `<td class="sc" rowspan="${span}">${esc(o.school ? school : schoolShort(school)).split('').join('<br>')}</td>`;
      // 階：同じ階が続くあいだは1つにまとめる
      const prev = sRows[i - 1];
      if (!prev || prev.floor !== r.floor) {
        let fs = 0;
        for (let j = i; j < sRows.length && sRows[j].floor === r.floor; j++) fs += 1 + (sRows[j].note_below ? 1 : 0);
        tr += `<td class="fl" rowspan="${fs}">${esc(r.floor ?? '')}</td>`;
      }
      tr += `<td class="tk">${esc(r.task)}${r.vacuum_mark ? '<span class="mk">＊</span>' : ''}</td>`;
      for (const d of CLEANING_WEEK) {
        const m = merged.get(d);
        if (m) {
          if (i === 0) {
            const text = m.kind === 'one' ? `${esc(o.names.get(m.userId) ?? '')}${m.start ? ` ${minText(toMin(m.start) ?? 0)}` : ''}` : '';
            tr += `<td class="${m.kind === 'none' ? 'none' : 'mg'}" rowspan="${span}">${text}</td>`;
          }
          continue;
        }
        const k = cellKey(r.id, d);
        const v = o.valueOf(r.id, d);
        const red = o.redChanges && o.changed.has(k) ? ' red' : '';
        if (v.is_none) { tr += `<td class="none${red}"></td>`; continue; }
        const w = o.showWarn && o.warn.has(k) ? '⚠️' : '';
        tr += `<td class="c${red}">${w}${cellLines(v, o.names).map(esc).join('<br>')}</td>`;
      }
      tr += '</tr>';
      body += tr;
      if (r.note_below) body += `<tr><td class="nb" colspan="8">${esc(r.note_below)}</td></tr>`;
    });
  }

  if (!o.school && o.off && o.unassigned) {
    const names = (ids?: string[]) => (ids ?? []).map(id => esc(o.names.get(id) ?? '')).join('・');
    body += `<tr class="ft"><td colspan="3">休み</td>${CLEANING_WEEK.map(d => `<td class="sm">${names(o.off?.[d])}</td>`).join('')}</tr>`;
    body += `<tr class="ft"><td colspan="3">担当なし</td>${CLEANING_WEEK.map(d => `<td class="sm">${names(o.unassigned?.[d])}</td>`).join('')}</tr>`;
  }

  const title = o.school ? `${o.school}の掃除担当表` : o.title;
  const css = `
    @page { size: A4 landscape; margin: 7mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; color: #111; font-size: 9px; }
    h1 { font-size: 13px; text-align: center; margin: 0 0 2px; }
    .hd { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; margin-bottom: 2px; }
    .nt { color: #c00; font-weight: bold; font-size: 8.5px; line-height: 1.4; }
    .dt { color: #c00; font-weight: bold; font-size: 12px; white-space: nowrap; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    th, td { border: 0.7px solid #333; padding: 1px 3px; vertical-align: middle; }
    th { background: #eee; font-size: 10px; }
    .sc { width: 22px; text-align: center; font-weight: bold; }
    .fl { width: 22px; text-align: center; font-weight: bold; }
    .tk { width: 190px; font-size: 8px; }
    .mk { color: #c00; font-weight: bold; }
    .c { text-align: center; font-size: 9px; white-space: normal; line-height: 1.25; }
    .mg { text-align: center; font-size: 12px; }
    .none { background: linear-gradient(to top right, transparent calc(50% - 0.6px), #333 50%, transparent calc(50% + 0.6px)); }
    .nb { text-align: center; font-size: 8px; font-weight: bold; }
    .red, .red * { color: #c00 !important; }
    .ft td { font-size: 7.5px; }
    .ft td:first-child { text-align: center; font-size: 10px; font-weight: bold; }
    .sm { white-space: normal; }
    @media screen { body { padding: 12px; background: #f4f4f4; } .page { background: #fff; padding: 7mm; margin: 0 auto; max-width: 297mm; } }
  `;
  const head = `<tr><th colspan="3">曜日／場所&emsp;<span class="mk">＊</span>(掃除機紙パック点検随時)</th>${CLEANING_WEEK.map(d => `<th>${ROSTER_DAY_LABEL[d]}</th>`).join('')}</tr>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)} ${esc(dateLabel(o.applyFrom))}</title><style>${css}</style></head><body><section class="page">`
    + `<h1>${esc(title)}</h1><div class="hd"><div class="nt">${o.notes.map(esc).join('<br>')}</div><div class="dt">${esc(dateLabel(o.applyFrom))}</div></div>`
    + `<table><colgroup><col style="width:22px"><col style="width:22px"><col style="width:190px">${CLEANING_WEEK.map(() => '<col>').join('')}</colgroup>`
    + `<thead>${head}</thead><tbody>${body}</tbody></table></section></body></html>`;
}
