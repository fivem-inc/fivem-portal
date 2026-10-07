// 大人シフト表の PDF（印刷用の画面・2026-10-07・docs/計画-大人シフト表.md §3）。
// 🚨 supabase を読まない。別の窓に書き出してブラウザの印刷で「PDF に保存」する（こども・勤務表・掃除担当表と同じ openRosterPrint）
// ・紙と同じく 縦＝時刻の帯・横＝月〜土（日は中身があるとき）＋曜日ごとに出張の細い列。A4 横 1枚
// ・マス＝上 時刻とクラス名／担当（大きい字・入らなければ字を縮める）／補助、下 別の仕事［P］［映］［事］と勉強会［勉］
// ・Jr合同は灰色の帯・濃い灰色の太字（赤は使わない）。表の下に「こども」「休み」の行
// ・変わった所の印（薄い黄色の帯・変わった名前は濃いピンク・抜けたものは「前：」）は出すときに選ぶ
// 🚨 マスの文字は lib/adultShift.ts の adultLines（画面と同じ）。色と見分け方は lib/changeMark.ts

import { ROSTER_DAY_LABEL, type RosterDayKind } from './shiftRoster';
import { CHANGE_MARK_PRINT_CSS, diffLines } from './changeMark';
import type { KidsBand } from './kidsShiftBands';
import type { AdultLine } from './adultShift';

export interface AdultPrintOptions {
  title: string;
  asOf: string;
  notes: string[];
  days: RosterDayKind[];
  bands: KidsBand[];
  hasTrip: boolean;
  /** 帯ごとのマス（いまの行と比べる先の行・勉強会の行） */
  cellOf: (day: RosterDayKind, band: number) => { lines: AdultLine[]; base: AdultLine[]; study: string[] };
  tripOf: (day: RosterDayKind, band: number) => { lines: AdultLine[]; base: AdultLine[] };
  kidsRow: (day: RosterDayKind) => string[];
  offRow: (day: RosterDayKind) => string[];
  dayNotes: (day: RosterDayKind) => string[];
  markChanges: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function asOfLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `（${y}.${m}.${d}時点）`;
}

/** 担当の行は大きい字。長いときは字を縮めて1行に収める（2026-10-06 ユーザー確定：名前は今の呼び名・入らなければ自動で縮める） */
function staffClass(text: string): string {
  const n = [...text].length;
  return n <= 7 ? 'st' : n <= 10 ? 'st st2' : 'st st3';
}

function linesHtml(lines: AdultLine[], base: AdultLine[], mark: boolean): { html: string; changed: boolean } {
  const changed = mark && lines.map(l => l.text).join('\n') !== base.map(l => l.text).join('\n');
  const m = changed ? diffLines(lines.map(l => l.text), base.map(l => l.text)) : null;
  const body = lines.map((l, i) => {
    const inner = m ? m.lines[i].map(p => (p.hit ? `<span class="chg">${esc(p.text)}</span>` : esc(p.text))).join('') : esc(l.text);
    const cls = [l.kind === 'staff' ? staffClass(l.text) : l.kind, l.jr ? 'jr' : '',
      l.kind === 'job' && i > 0 && lines[i - 1].kind !== 'job' && lines[i - 1].kind !== 'note' ? 'jobtop' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}">${inner}</div>`;
  }).join('');
  const gone = m && m.removed.length > 0 ? `<div class="note">前：${m.removed.map(r => `<span class="chg gone">${esc(r)}</span>`).join('・')}</div>` : '';
  return { html: body + gone, changed };
}

export function buildAdultPrintHtml(o: AdultPrintOptions): string {
  const head = '<th class="tm">時刻</th>' + o.days.map(d =>
    `<th>${esc(ROSTER_DAY_LABEL[d])}</th>${o.hasTrip ? '<th class="trip">出張</th>' : ''}`).join('');
  const rows = o.bands.map((b, bi) => {
    const cells = o.days.map(d => {
      const c = o.cellOf(d, bi);
      const h = linesHtml(c.lines, c.base, o.markChanges);
      const study = c.study.map((s, i) => `<div class="job${i === 0 && c.lines.length > 0 ? ' jobtop' : ''}">${esc(s)}</div>`).join('');
      let td = `<td${h.changed ? ' class="chgcell"' : ''}>${h.html}${study}${h.html || study ? '' : '&nbsp;'}</td>`;
      if (o.hasTrip) {
        const t = o.tripOf(d, bi);
        const th = linesHtml(t.lines, t.base, o.markChanges);
        td += `<td class="trip${th.changed ? ' chgcell' : ''}">${th.html || '&nbsp;'}</td>`;
      }
      return td;
    }).join('');
    return `<tr><td class="tm">${esc(b.label)}</td>${cells}</tr>`;
  }).join('');
  const span = o.hasTrip ? ' colspan="2"' : '';
  const footRow = (label: string, f: (d: RosterDayKind) => string[], sep: string) =>
    `<tr class="foot"><td class="tm">${esc(label)}</td>${o.days.map(d => `<td${span}>${f(d).map(esc).join(sep) || '&nbsp;'}</td>`).join('')}</tr>`;
  const hasNotes = o.days.some(d => o.dayNotes(d).length > 0);

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${esc(o.title)}</title>
<style>
  @page { size: A4 landscape; margin: 6mm; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif; color: #000; margin: 0; }
  h1 { font-size: 12pt; margin: 0 0 2mm; }
  .asof { font-size: 8pt; font-weight: normal; margin-left: 4px; }
  .notes { font-size: 7pt; margin: 0 0 2mm; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 0.4pt solid #000; padding: 0.5mm 0.7mm; font-size: 6.5pt; vertical-align: top; word-break: break-all; }
  th { text-align: center; font-size: 8pt; }
  th.tm, td.tm { width: 10mm; text-align: center; font-weight: bold; white-space: nowrap; }
  th.trip, td.trip { width: 11mm; font-size: 5.6pt; border-left: 0.4pt dashed #000; }
  .head { font-size: 6pt; }
  .st { font-size: 9pt; font-weight: bold; line-height: 1.15; }
  .st2 { font-size: 7.5pt; }
  .st3 { font-size: 6.3pt; }
  .assist { font-size: 6.3pt; }
  .job { font-size: 6.3pt; }
  .jobtop { border-top: 0.4pt dashed #000; margin-top: 0.4mm; }
  .note { font-size: 5.6pt; }
  .jr { background: #d9d8d3; color: #444441; font-weight: bold; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr.foot td { font-size: 6pt; }
  ${CHANGE_MARK_PRINT_CSS}
  @media screen { body { padding: 10px; background: #fff; } .hint { font-size: 12px; color: #555; margin-bottom: 8px; } }
  @media print { .hint { display: none; } }
</style></head><body>
<div class="hint">この画面をブラウザの印刷（Ctrl+P）で「PDF に保存」してください。用紙は A4・横向きです。</div>
<h1>${esc(o.title)}<span class="asof">${asOfLabel(o.asOf)}</span></h1>
${o.notes.length > 0 ? `<div class="notes">${o.notes.map(esc).join(' ／ ')}</div>` : ''}
<table><thead><tr>${head}</tr></thead>
<tbody>${rows}
${hasNotes ? footRow('書き添え', o.dayNotes, ' ／ ') : ''}
${footRow('こども', o.kidsRow, '<br>')}
${footRow('休み', o.offRow, '・')}
</tbody></table>
</body></html>`;
}
