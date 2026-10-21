// 送信できたか確認できていない申請の見せ方（2026-10-21 電波 段4・ユーザー確定）。
// 番号は lib/submitOnce の listPendingSubmits が持っている。ここは「何の申請か・どの画面で送り直すか」を決めるだけ。
// 🚨 種類（slot の名前）を足したら、ここにも足す（足さないとホームのカードに出ない）

export interface PendingSubmitInfo {
  slot: string;
  /** 「交通費（10/21 14:05）」「残業 10/20 の申請」 */
  label: string;
  path: string;
  /** ［交通費を開く］ */
  openLabel: string;
}

const md = (ymd: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[1])}/${Number(m[2])}` : ymd;
};
const mdhm = (at: number): string => {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function describePendingSubmit(slot: string, at: number): PendingSubmitInfo | null {
  if (slot === 'expense') return { slot, label: `交通費（${mdhm(at)}）`, path: '/expense', openLabel: '交通費を開く' };
  if (slot === 'leave') return { slot, label: `休暇申請（${mdhm(at)}）`, path: '/leave', openLabel: '休暇申請を開く' };
  if (slot === 'trip') return { slot, label: `出張報告（${mdhm(at)}）`, path: '/trip-report', openLabel: '出張報告を開く' };
  if (slot.startsWith('ot:')) return { slot, label: `残業 ${md(slot.slice(3))} の申請`, path: '/overtime', openLabel: '残業を開く' };
  if (slot.startsWith('shift_report:')) {
    const date = slot.split(':')[2] ?? '';
    return { slot, label: `勤務変更 ${md(date)} の申請`, path: '/shift-report', openLabel: '勤務変更を開く' };
  }
  return null;
}
