// お客様データ（スコラプラス）の読み取り。
//
// CSV と Excel の両方を同じ仕組みで読む（SheetJS は CSV もシートとして開ける）。
// xlsx は重いので、勤務表の取り込み（shiftExcelImport.ts）と同じく動的importにする。
//
// 🚨 列の並びを決め打ちにしない。出力の書式が変わるたびに開発者へ依頼することに
//    なるため、見出しから当てにいき、外れたら画面で選び直せるようにする。
// 🚨 読めなかった行を黙って捨てない。理由をつけて件数を返し、画面で見せる。

import { toHiragana } from './roomBooking';
/** 取り込みで使う項目 */
export type CustomerField =
  | 'member_no' | 'full_name' | 'last_name' | 'first_name'
  | 'full_kana' | 'last_kana' | 'first_kana'
  | 'display_name' | 'birth_date'
  | 'phone' | 'mobile' | 'email' | 'guardian_name';

export const FIELD_LABEL: Record<CustomerField, string> = {
  member_no: '会員番号',
  full_name: '氏名（1列のとき）',
  last_name: '姓',
  first_name: '名',
  full_kana: 'フリガナ（1列のとき）',
  last_kana: 'フリガナ（姓）',
  first_kana: 'フリガナ（名）',
  display_name: '表示名',
  birth_date: '生年月日',
  phone: '固定電話',
  mobile: '携帯番号',
  email: 'メール',
  guardian_name: '保護者名',
};

/** 必須（これが無いと1行も取り込めない） */
export const REQUIRED_FIELDS: CustomerField[] = ['member_no'];

/**
 * 見出しから項目を当てるための手がかり。
 * スコラプラスの出力に限らず、社内で作り直した表でも通るように広めに取る。
 */
// 🚨 長い手がかりから先に当てる（guessMapping 側で並べ替えている）。
//    「フリガナ（姓）」を「フリガナ」より先に当てないと、姓のふりがなが
//    「フリガナ1列」の扱いになってしまう。
const HEADER_HINTS: Record<CustomerField, string[]> = {
  member_no:     ['会員番号', '会員no', '会員ｎｏ', '会員', 'member_no', 'memberno', '番号', 'id'],
  last_name:     ['姓', '名字', '苗字', 'lastname', 'せい'],
  first_name:    ['名', 'firstname', 'めい'],
  last_kana:     ['姓カナ', 'セイカナ', 'フリガナ姓', 'カナ姓', 'せいかな', 'lastkana'],
  first_kana:    ['名カナ', 'メイカナ', 'フリガナ名', 'カナ名', 'めいかな', 'firstkana'],
  full_kana:     ['フリガナ', 'ふりがな', 'カナ', 'かな', 'kana', 'ヨミ', 'よみ', '読み'],
  full_name:     ['氏名', '名前', '生徒名', '会員名', 'name', 'お名前'],
  display_name:  ['表示名', '呼び名', '表示'],
  birth_date:    ['生年月日', '誕生日', 'birth', 'birthday', '生年'],
  phone:         ['固定電話', '自宅電話', '自宅', '電話', 'tel', 'phone'],
  mobile:        ['携帯電話', '携帯番号', '携帯', 'ケータイ', 'mobile', 'cell'],
  email:         ['メール', 'mail', 'email', 'eメール'],
  guardian_name: ['保護者', '保護者名', '親', 'guardian'],
};

/** 比べやすい形にする（全角→半角・小文字・空白と記号を落とす） */
const norm = (s: string): string =>
  s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s_\-()（）[\]【】:：/／]/g, '');

/** 見出し行から「項目 → 列番号」を推測する。当たらなかった項目は入れない */
export function guessMapping(headers: string[]): Partial<Record<CustomerField, number>> {
  const map: Partial<Record<CustomerField, number>> = {};
  const used = new Set<number>();
  // 手がかりが長いものから当てる（「会員番号」を「番号」より先に取る）
  for (const field of Object.keys(HEADER_HINTS) as CustomerField[]) {
    const hints = [...HEADER_HINTS[field]].sort((a, b) => b.length - a.length);
    for (const hint of hints) {
      const h = norm(hint);
      // 🚨 1文字の手がかり（「姓」「名」）は、含まれているかで見ると
      //    「氏名」「名前」まで当たってしまう。1文字のときはぴったり一致だけにする
      const hit = (raw: unknown) => {
        const t = norm(String(raw ?? ''));
        return h.length <= 1 ? t === h : t.includes(h);
      };
      const idx = headers.findIndex((raw, i) => !used.has(i) && hit(raw));
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }
  return map;
}

/**
 * 生年月日をいろいろな書き方から 'YYYY-MM-DD' に直す。
 * Excel は日付をシリアル値で持つことがあるので、Date もそのまま受ける。
 * 🚨 ここで toISOString() を使わないこと。UTCに直され、日本時間の朝が前日になる。
 */
export function parseBirthDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
  // 2020-04-01 / 2020/4/1 / 2020.4.1 / 2020年4月1日
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 実在する日付か確かめる（2月30日のような値を弾く）
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** 姓だけ取り出して「田中様」を作る。表示名が無いときの既定値 */
export function defaultDisplayName(fullName: string): string {
  const t = fullName.trim().replace(/[\s　]+/g, ' ');
  if (!t) return '';
  return `${t.split(' ')[0]}様`;
}

export interface ParsedCustomer {
  member_no: string;
  display_name: string;
  full_name: string | null;
  last_name: string | null;
  first_name: string | null;
  /** ひらがなに直して入れる（元がカタカナでも） */
  last_kana: string | null;
  first_kana: string | null;
  birth_date: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  guardian_name: string | null;
}

/**
 * 「田中 太郎」「田中　太郎」「田中太郎」を 姓と名に分ける。
 * 🚨 空白が無いときは分けない（「田中太郎」を「田」「中太郎」と割るような
 *    当てずっぽうはしない）。分けられなければ姓だけにして、名は空にする。
 */
export function splitName(full: string): { last: string; first: string } {
  const t = full.replace(/[\s　]+/g, ' ').trim();
  if (!t) return { last: '', first: '' };
  const parts = t.split(' ');
  if (parts.length >= 2) return { last: parts[0], first: parts.slice(1).join(' ') };
  return { last: t, first: '' };
}

export interface ParseResult {
  headers: string[];
  rows: unknown[][];
}

/** ファイルを読んで、見出し行と中身の行に分ける */
export async function readTable(file: File): Promise<ParseResult> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { headers: [], rows: [] };
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as unknown[][];
  if (grid.length === 0) return { headers: [], rows: [] };
  // 見出しは最初の「2つ以上の値が入った行」。上に表題が入っていることがあるため
  let headerIdx = 0;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const filled = grid[i].filter(c => String(c ?? '').trim() !== '').length;
    if (filled >= 2) { headerIdx = i; break; }
  }
  return {
    headers: grid[headerIdx].map(c => String(c ?? '').trim()),
    rows: grid.slice(headerIdx + 1),
  };
}

export interface BuildResult {
  ok: ParsedCustomer[];
  /** 取り込めなかった行（1始まりの行番号と理由） */
  ng: { line: number; reason: string }[];
}

/** 対応づけに沿って、行を取り込む形に組み立てる */
export function buildCustomers(
  rows: unknown[][],
  map: Partial<Record<CustomerField, number>>,
): BuildResult {
  const ok: ParsedCustomer[] = [];
  const ng: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  const at = (row: unknown[], f: CustomerField): string => {
    const i = map[f];
    return i === undefined ? '' : String(row[i] ?? '').trim();
  };

  rows.forEach((row, i) => {
    const line = i + 1;
    if (row.every(c => String(c ?? '').trim() === '')) return;   // 空行は数えない
    const memberNo = at(row, 'member_no');
    if (!memberNo) { ng.push({ line, reason: '会員番号がありません' }); return; }
    if (seen.has(memberNo)) { ng.push({ line, reason: `会員番号 ${memberNo} が重なっています` }); return; }
    seen.add(memberNo);

    // 姓と名。「姓」「名」の列があればそれを使い、無ければ「氏名」を空白で分ける
    const fullName = at(row, 'full_name');
    const nameParts = splitName(fullName);
    const lastName = at(row, 'last_name') || nameParts.last;
    const firstName = at(row, 'first_name') || nameParts.first;

    // ふりがな。🚨 元がカタカナでもひらがなに直して入れる。
    //    漢字からは作れないので、フリガナの列が無ければ空のままにする
    const fullKana = at(row, 'full_kana');
    const kanaParts = splitName(fullKana);
    const lastKana = toHiragana(at(row, 'last_kana') || kanaParts.last);
    const firstKana = toHiragana(at(row, 'first_kana') || kanaParts.first);

    const display = at(row, 'display_name')
      || (lastName ? `${lastName}様` : '')
      || defaultDisplayName(fullName)
      || `${memberNo} 様`;

    const rawBirth = map.birth_date === undefined ? '' : row[map.birth_date];
    const birth = parseBirthDate(rawBirth);
    if (map.birth_date !== undefined && String(rawBirth ?? '').trim() !== '' && !birth) {
      // 🚨 読めない生年月日は黙って空にしない。学年が出なくなる理由が分からなくなる
      ng.push({ line, reason: `生年月日「${String(rawBirth)}」が読めません` });
      return;
    }

    ok.push({
      member_no: memberNo,
      display_name: display,
      full_name: fullName || null,
      last_name: lastName || null,
      first_name: firstName || null,
      last_kana: lastKana || null,
      first_kana: firstKana || null,
      birth_date: birth,
      phone: at(row, 'phone') || null,
      mobile: at(row, 'mobile') || null,
      email: at(row, 'email') || null,
      guardian_name: at(row, 'guardian_name') || null,
    });
  });

  return { ok, ng };
}
