// シフトExcel（勤務表.xlsx）の読み取り
// 書式：シート名＝適用開始日（例 2026.7.16）。左右2ブロック×縦に繰り返し。
//   名前セルの1行下に「曜日/出勤/退勤/…」ヘッダー、月〜日の曜日行（各2行構成）が続く。
//   出勤・退勤が空欄（または0:00）＝休み。勤務時間・休憩・労働時間の列は読まない（アプリ側で自動計算）。
// xlsxライブラリは重いため動的importで遅延読み込みする。

import type { DayKind } from './breakCalc';

export type ImportDayKind = Exclude<DayKind, 'holiday' | 'work_on_closed'>;
export const IMPORT_DAYS: ImportDayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_LABEL_TO_KIND: Record<string, ImportDayKind> = {
  '月': 'mon', '火': 'tue', '水': 'wed', '木': 'thu', '金': 'fri', '土': 'sat', '日': 'sun',
};

export interface ParsedDay {
  startMin: number | null;  // null = 休み（1つ目の時間帯）
  endMin: number | null;
  startMin2: number | null; // 2つ目の時間帯（外出・戻り・テレワーク）。無ければnull
  endMin2: number | null;
  location: string;         // 校（空欄は四条本校）
}

export const DEFAULT_LOCATION = '四条本校';

// 校名の略称→正式名。出勤列2段目の記載（例「本校大10～14:30→上桂」）から校を抽出するのに使う。
const SCHOOL_ALIASES: [RegExp, string][] = [
  [/四条本校|本校/, '四条本校'],
  [/西陣/,   '西陣校'],
  [/上桂/,   '上桂校'],
  [/洛西口/, '洛西口校'],
  [/南草津/, '南草津校'],
];

// 出勤列2段目のセルから校を解析する。
// 「→」があれば移動とみなし「四条本校→上桂校」のように前後の校をつなぐ（案1）。
// 「大10」等のコース・時刻表記は校ではないので無視。校が1つも見つからなければ四条本校。
export function parseSchoolCell(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_LOCATION;
  const parts = raw.split(/[→⇒>]/).map(s => s.trim()).filter(Boolean);
  const schools: string[] = [];
  for (const part of parts) {
    for (const [re, full] of SCHOOL_ALIASES) {
      if (re.test(part)) { schools.push(full); break; }
    }
  }
  if (schools.length === 0) return DEFAULT_LOCATION;
  const uniq = schools.filter((s, i) => i === 0 || s !== schools[i - 1]); // 連続重複を除去
  return uniq.join('→');
}

export interface ParsedPerson {
  rawName: string;        // Excelの表記そのまま（「東　日菜  1/17～」等）
  name: string;           // 注記を除いた名前
  normalizedName: string; // 照合用（空白除去）
  anchor: string;         // 見つかったセル位置（重複時の説明用）
  days: Record<ImportDayKind, ParsedDay>;
  isDuplicate: boolean;   // 同名ブロックが複数あり、これは後勝ちで採用された方
}

export interface ParsedSheet {
  sheetName: string;
  applyFrom: string | null; // シート名から読み取った適用開始日（YYYY-MM-DD）
  people: ParsedPerson[];
  duplicateNames: string[]; // 同一シートに複数ブロックがあった名前（最後のブロックを採用）
}

/** 名前の照合用正規化：全半角スペース除去 */
export function normalizeName(s: string): string {
  return s.replace(/[\s　]+/g, '');
}

/** 名前セルから注記（「1/17～」等の日付メモ）を除去 */
function cleanName(s: string): string {
  return s.replace(/[0-9０-９].*$/, '').trim();
}

/** シート名 "2026.7.16" → "2026-07-16" */
export function sheetNameToDate(sheetName: string): string | null {
  const m = /(\d{4})[.．](\d{1,2})[.．](\d{1,2})/.exec(sheetName);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

type CellValue = string | number | boolean | Date | undefined;

function toMin(v: CellValue): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const m = Math.round(v * 24 * 60); // Excelの時刻は1日=1の小数
    return m > 0 ? m : null;           // 0:00 は休み扱い
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const min = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return min > 0 ? min : null;
}

export async function listSheetNames(buf: ArrayBuffer): Promise<string[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { bookSheets: true });
  return wb.SheetNames;
}

export async function parseShiftSheet(buf: ArrayBuffer, sheetName: string): Promise<ParsedSheet> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[sheetName];
  const result: ParsedSheet = {
    sheetName,
    applyFrom: sheetNameToDate(sheetName),
    people: [],
    duplicateNames: [],
  };
  if (!ws || !ws['!ref']) return result;

  const range = XLSX.utils.decode_range(ws['!ref']);
  const cellVal = (r: number, c: number): CellValue => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? (cell.v as CellValue) : undefined;
  };

  const found: ParsedPerson[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (String(cellVal(r, c) ?? '').trim() !== '曜日') continue;
      // ヘッダー行を発見。名前は1行上・同ブロック内の最初の文字列セル
      let rawName = '';
      for (let nc = c; nc <= c + 4; nc++) {
        const v = cellVal(r - 1, nc);
        if (typeof v === 'string' && v.trim()) { rawName = v.trim(); break; }
      }
      if (!rawName) continue;
      const name = cleanName(rawName);
      if (!name) continue;

      const days = {} as Record<ImportDayKind, ParsedDay>;
      for (const k of IMPORT_DAYS) days[k] = { startMin: null, endMin: null, startMin2: null, endMin2: null, location: DEFAULT_LOCATION };
      let foundDays = 0;
      // ヘッダー直下から最大20行の範囲で月〜日を拾う（各曜日は2行構成：1段目=本務、2段目=外出/戻り・校）
      for (let dr = r + 1; dr <= Math.min(range.e.r, r + 20) && foundDays < 7; dr++) {
        const label = String(cellVal(dr, c) ?? '').trim();
        const kind = DAY_LABEL_TO_KIND[label];
        if (!kind) continue;
        const start = toMin(cellVal(dr, c + 1));
        const end = toMin(cellVal(dr, c + 2));
        // 2段目（次の物理行）の出勤列：時刻なら第2時間帯（外出/戻り）、文字列なら校（勤務地・移動）。
        // ★校は掃除列ではなく出勤列の2段目に入る。掃除列は掃除当番の校/受付で別物。
        const row2 = dr + 1;
        const band2Raw = cellVal(row2, c + 1);
        const start2 = toMin(band2Raw);
        const end2 = toMin(cellVal(row2, c + 2));
        const hasBand2 = start2 != null && end2 != null && end2 > start2;
        const location = parseSchoolCell(typeof band2Raw === 'string' ? band2Raw : undefined);
        const hasBand1 = start != null && end != null && end > start;
        days[kind] = {
          startMin: hasBand1 ? start : null,
          endMin: hasBand1 ? end : null,
          startMin2: hasBand2 ? start2 : null,
          endMin2: hasBand2 ? end2 : null,
          location: hasBand1 ? location : DEFAULT_LOCATION,
        };
        foundDays++;
      }
      found.push({
        rawName, name, normalizedName: normalizeName(name),
        anchor: XLSX.utils.encode_cell({ r, c }),
        days, isDuplicate: false,
      });
    }
  }

  // 同名ブロックは「あとに出てくる方（＝下に追記された新しい方）」を採用
  const byName = new Map<string, ParsedPerson>();
  const dupes = new Set<string>();
  for (const p of found) {
    if (byName.has(p.normalizedName)) dupes.add(p.name);
    byName.set(p.normalizedName, p);
  }
  result.people = [...byName.values()].map(p => ({ ...p, isDuplicate: dupes.has(p.name) }));
  result.duplicateNames = [...dupes];
  return result;
}
