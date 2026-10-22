// ［表で見る］と同じ中身の Excel（残業・勤務変更で共用・2026-10-22 ユーザー指示）。
// ・1つのファイルに、シート「一覧」（全員の記載のある日を 名前→対象日 の順に・人ごとに合計の行）と、1人1シート（画面の表と同じ形）
// ・今ある一覧の Excel・CSV 出力はそのまま（混ざらないよう、こちらは［表で見る］の中のボタンだけ）
// 🚨 時間は画面と同じ文字（「-1:30」「（2:00）」）を文字として入れ、計算用に「時間数（分）」の数字の列を別に付ける
//    （文字の「-1:30」を数として入れると Excel が数式と取り違える＝OvertimeAdminTab の Excel の注意と同じ）
import { SHEET_DOW, dowOf, sheetMd, sheetHm, daysWithEntries, type PersonSheet, type SheetPerson, type SheetDay } from './payrollSheet';

type Row = (string | number | null)[];

const HEAD = ['日付', '曜日', '通常シフト時間', '労働時間(休憩)', '変更(実務)シフト時間', '時間数', '時間数（分）', '理由', '確認サイン'];

/** 表の行（1日に記載が2つあれば2行。日付・通常シフトは1行目だけ） */
function dayRows(day: SheetDay): Row[] {
  const dw = dowOf(day.date);
  const entries = day.entries.length ? day.entries : [null];
  return entries.map((en, i) => [
    i === 0 ? sheetMd(day.date) : '',
    i === 0 ? SHEET_DOW[dw] : '',
    i === 0 ? (day.nsLines.length ? day.nsLines.join(' / ') : day.offLabel) : '',
    i === 0 ? day.laborText : '',
    en?.actual ?? '',
    en?.time ?? '',
    en?.minutes ?? null,
    en ? (en.strike ? `（二重に数えない）${en.reason}` : en.reason) : '',
    en?.sign ?? '',
  ]);
}

/** シート名（31文字まで・使えない記号を外す・重ならないように） */
function sheetName(base: string, used: Set<string>): string {
  let n = base.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'シート';
  let i = 2;
  while (used.has(n)) { const suf = `(${i++})`; n = n.slice(0, 31 - suf.length) + suf; }
  used.add(n);
  return n;
}

export async function exportPayrollSheetsXlsx(opts: {
  kindLabel: string;
  periodLabel: string;
  people: SheetPerson[];
  sheetFor: (id: string) => PersonSheet | null;
}): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const all = opts.people.map(p => ({ p, s: opts.sheetFor(p.id) })).filter((x): x is { p: SheetPerson; s: PersonSheet } => !!x.s);

  // 「一覧」：記載のある日だけ。人ごとに合計の行
  const list: Row[] = [[`${opts.kindLabel} ${opts.periodLabel}`], [], ['従業員番号', '名前', ...HEAD]];
  for (const { p, s } of all) {
    const days = daysWithEntries(s.days);
    if (days.length === 0) continue;
    for (const d of days) for (const r of dayRows(d)) list.push([p.employee_no ?? '', p.name, ...r]);
    list.push([p.employee_no ?? '', p.name, '合計', '', '', '', '', s.total == null ? '' : sheetHm(s.total), s.total, [s.plannedText, s.totalNote, s.absenceDays > 0 ? `欠勤 ${s.absenceDays}日` : ''].filter(Boolean).join('／'), '']);
    list.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(list);
  ws['!cols'] = [10, 14, 7, 5, 22, 14, 22, 9, 9, 40, 18].map(wch => ({ wch }));
  const used = new Set<string>();
  XLSX.utils.book_append_sheet(wb, ws, sheetName('一覧', used));

  // 1人1シート（画面の表と同じ形・期の全日）
  for (const { p, s } of all) {
    const rows: Row[] = [
      [p.employee_no ?? '番号なし', p.name],
      ['合計時間', s.total == null ? '' : sheetHm(s.total), s.total],
    ];
    if (s.plannedText) rows.push([s.plannedText]);
    rows.push([s.totalNote + (s.absenceDays > 0 ? `／欠勤 ${s.absenceDays}日` : '')]);
    if (s.pendingText) rows.push([s.pendingText]);
    rows.push([], HEAD);
    for (const d of s.days) rows.push(...dayRows(d));
    const w = XLSX.utils.aoa_to_sheet(rows);
    w['!cols'] = [7, 5, 22, 14, 22, 9, 9, 40, 18].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, w, sheetName(`${p.employee_no ?? ''} ${p.name}`.trim(), used));
  }
  XLSX.writeFile(wb, `${opts.kindLabel}_表_${opts.periodLabel}.xlsx`.replace(/[\\/:*?"<>|]/g, ''));
}
