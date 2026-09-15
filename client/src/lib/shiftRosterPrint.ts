// 勤務表の PDF（印刷用の画面）を組み立てる（2026-09-15）。
// 🚨 supabase を読まない。できた HTML を別の窓に書き出し、ブラウザの印刷で「PDF に保存」する
//    （管理画面の伝票の印刷とぶつからないように、別の窓にする）
// A：1人1ブロック（A4縦・1ページ8人・紙の勤務表と同じ並び・休憩まで入る）
// B：週の一覧（A4横・メインの部門ごと）

import {
  AREA_COLORS, ROSTER_DAY_LABEL, ROSTER_WEEK, deriveFields, mainBand, minText, placeSteps, shortSchool, timeText,
  type RosterDay, type RosterDayKind, type WorkArea,
} from './shiftRoster';

export interface PrintPerson {
  name: string;
  headNote: string;
  mainAreaId: string | null;
  mainAreaName: string;
  days: Partial<Record<RosterDayKind, RosterDay>>;
  /** 前の版から変わった曜日（赤字にする） */
  changedDays: RosterDayKind[];
  /** 勉強会の欄（「12:30(30)濱口・馬場」）。warn＝勤務時間外などの ⚠️ */
  studies: Partial<Record<RosterDayKind, { text: string; warn: boolean }[]>>;
}

export interface PrintOptions {
  layout: 'A' | 'B';
  applyFrom: string;        // "2026-10-01"
  people: PrintPerson[];    // 並べたい順（メインの部門 → 役職順）
  areas: WorkArea[];
  redChanges: boolean;
  /** 勉強会の ⚠️ 印も刷る（初期は刷らない） */
  studyWarn: boolean;
}

function studyLines(p: PrintPerson, k: RosterDayKind, o: PrintOptions): string {
  return (p.studies[k] ?? []).map(s => `<div class="stl">${o.studyWarn && s.warn ? '⚠️' : ''}${esc(s.text)}</div>`).join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "2026-10-01" → "2026.10.1～" */
export function applyFromLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}.${m}.${d}～`;
}

function chip(areas: WorkArea[], areaId: string | null | undefined, text: string): string {
  const a = areas.find(x => x.id === areaId);
  const c = AREA_COLORS[a?.color ?? 'gray'] ?? AREA_COLORS.gray;
  return `<span class="chip" style="background:${c.bg};color:${c.fg}">${esc(text)}</span>`;
}

function placeLine(day: RosterDay, areas: WorkArea[], mainAreaId: string | null): string {
  const steps = placeSteps(day, areas, mainAreaId);
  if (steps.length === 0) return '';
  const multi = steps.length > 1;
  return steps.map(s => {
    const label = `${s.school}${s.area ? `（${s.area.short_name}）` : ''}${multi ? ` ${timeText(s.start)}～${timeText(s.end)}` : ''}`;
    return chip(areas, s.area?.id, label);
  }).join('<span class="arrow">→</span>');
}

function blockA(p: PrintPerson, o: PrintOptions): string {
  let total = 0;
  const rows = ROSTER_WEEK.map(k => {
    const day = p.days[k];
    const f = day ? deriveFields(day.segments) : null;
    const red = o.redChanges && p.changedDays.includes(k) ? ' red' : '';
    // 🚨 掃除の欄は④で入れる（いまは空欄）
    const tail = `<td class="cl"></td><td class="st">${studyLines(p, k, o)}</td>`;
    if (!day || !f || f.bands.length === 0) {
      return `<tr class="off"><td class="dk">${ROSTER_DAY_LABEL[k]}</td><td></td><td></td><td></td><td></td><td></td><td class="memo${red}">${esc(day?.note ?? '')}</td>${tail}</tr>`;
    }
    total += f.laborMinutes;
    const span = f.bands.reduce((s, b) => s + (b.e - b.s), 0);
    // 🚨 出勤・退勤は本務（長いほうの時間帯）。テレワークなど短いほうは小さく添える（紙の勤務表の2行目と同じ）
    const main = mainBand(f.bands)!;
    const other = f.bands.find(b => b !== main);
    // 校の区切りが2つ以上なら、区切りの側に時刻が出るので重ねて書かない
    const band2 = other && placeSteps(day, o.areas, p.mainAreaId).length < 2 ? `<div class="sub">${minText(other.s)}～${minText(other.e)}</div>` : '';
    return `<tr><td class="dk">${ROSTER_DAY_LABEL[k]}</td>`
      + `<td class="t${red}">${minText(main.s)}</td>`
      + `<td class="t${red}">${minText(main.e)}</td>`
      + `<td class="t">${minText(span)}</td><td class="t">${minText(f.breakMinutes)}</td><td class="t">${minText(f.laborMinutes)}</td>`
      + `<td class="memo${red}">${band2}${placeLine(day, o.areas, p.mainAreaId)}${day.note ? `<div class="note">${esc(day.note)}</div>` : ''}</td>${tail}</tr>`;
  }).join('');
  return `<div class="block"><div class="bh"><b>${esc(p.name)}</b><span class="hn">${esc(p.headNote)}</span></div>`
    + `<table><thead><tr><th>曜日</th><th>出勤</th><th>退勤</th><th>勤務時間</th><th>休憩</th><th>労働時間</th><th class="memoh">校・部門・書き添え</th><th class="cl">掃除</th><th class="st">勉強会</th></tr></thead>`
    + `<tbody>${rows}<tr class="sum"><td colspan="5" class="r">合計</td><td class="t"><b>${minText(total)}</b></td><td></td><td></td><td></td></tr></tbody></table></div>`;
}

function layoutA(o: PrintOptions): string {
  const pages: string[] = [];
  for (let i = 0; i < o.people.length; i += 8) {
    const chunk = o.people.slice(i, i + 8).map(p => blockA(p, o)).join('');
    pages.push(`<section class="page a"><div class="ph">${esc(applyFromLabel(o.applyFrom))}</div><div class="grid">${chunk}</div></section>`);
  }
  return pages.join('');
}

function layoutB(o: PrintOptions): string {
  const groups = new Map<string, PrintPerson[]>();
  for (const p of o.people) {
    const key = p.mainAreaName || 'メインの部門なし';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const head = `<tr><th class="nm">名前</th>${ROSTER_WEEK.map(k => `<th>${ROSTER_DAY_LABEL[k]}</th>`).join('')}<th>週合計</th></tr>`;
  let body = '';
  for (const [area, people] of groups) {
    body += `<tr class="grp"><td colspan="9">${esc(area)}</td></tr>`;
    for (const p of people) {
      let total = 0;
      const cells = ROSTER_WEEK.map(k => {
        const day = p.days[k];
        const f = day ? deriveFields(day.segments) : null;
        const red = o.redChanges && p.changedDays.includes(k) ? ' red' : '';
        if (!day || !f || f.bands.length === 0) return `<td class="off${red}">休${day?.note ? `<div class="note">${esc(day.note)}</div>` : ''}${studyLines(p, k, o)}</td>`;
        total += f.laborMinutes;
        const times = f.bands.map(b => `${minText(b.s)}-${minText(b.e)}`).join('<br>');
        const places = placeSteps(day, o.areas, p.mainAreaId)
          .map(s => chip(o.areas, s.area?.id, `${shortSchool(s.school)}${s.area ? `(${s.area.short_name})` : ''}`)).join('→');
        return `<td class="${red.trim()}"><div class="t">${times}</div>${places}${day.note ? `<div class="note">${esc(day.note)}</div>` : ''}${studyLines(p, k, o)}</td>`;
      }).join('');
      body += `<tr><td class="nm">${esc(p.name)}${p.headNote ? `<div class="note">${esc(p.headNote)}</div>` : ''}</td>${cells}<td class="t">${minText(total)}</td></tr>`;
    }
  }
  return `<section class="page b"><div class="ph">${esc(applyFromLabel(o.applyFrom))}&emsp;通常シフト一覧</div><table class="list"><thead>${head}</thead><tbody>${body}</tbody></table></section>`;
}

export function buildRosterPrintHtml(o: PrintOptions): string {
  const portrait = o.layout === 'A';
  const css = `
    @page { size: A4 ${portrait ? 'portrait' : 'landscape'}; margin: 8mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; color: #111; font-size: 9px; }
    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .ph { color: #c00; font-weight: bold; font-size: 11px; margin-bottom: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
    .block { break-inside: avoid; }
    .bh { display: flex; justify-content: space-between; gap: 6px; font-size: 10px; margin-bottom: 1px; }
    .hn { color: #333; font-size: 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 0.6px solid #555; padding: 1px 2px; vertical-align: top; }
    th { background: #eee; font-weight: bold; font-size: 8px; }
    .dk { text-align: center; width: 18px; font-weight: bold; }
    .t { text-align: center; white-space: nowrap; }
    .r { text-align: right; }
    .memo { font-size: 8px; }
    .memoh { width: 30%; }
    .cl { width: 9%; }
    .st { width: 17%; font-size: 7.5px; }
    .stl { font-size: 7.5px; white-space: nowrap; }
    .sub { font-size: 8px; color: #333; }
    .note { font-size: 7.5px; color: #333; }
    .off td, td.off { color: #999; }
    .red, .red * { color: #c00 !important; }
    .chip { display: inline-block; padding: 0 2px; border-radius: 2px; font-size: 7.5px; }
    .arrow { margin: 0 1px; }
    .sum td { border-top: 1px solid #111; }
    .list th, .list td { font-size: 8px; }
    .list .nm { text-align: left; white-space: nowrap; width: 90px; }
    .list td { text-align: center; }
    .grp td { background: #f3f3f3; font-weight: bold; text-align: left; }
    @media screen { body { padding: 12px; background: #f4f4f4; } .page { background: #fff; padding: 8mm; margin: 0 auto 12px; max-width: ${portrait ? '210mm' : '297mm'}; } }
  `;
  const body = o.layout === 'A' ? layoutA(o) : layoutB(o);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>勤務表 ${esc(applyFromLabel(o.applyFrom))}</title><style>${css}</style></head><body>${body}</body></html>`;
}

/** 別の窓に書き出して印刷する。🚨 ボタンを押した処理の中で呼ぶ（そうしないと窓が開かない端末がある） */
export function openRosterPrint(html: string): string | null {
  const w = window.open('', '_blank');
  if (!w) return '印刷用の窓を開けませんでした。ポップアップを許可してから、もう一度お試しください';
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return null;
}
