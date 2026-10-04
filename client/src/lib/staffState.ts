// 入社予定の判定（2026-10-04）。設計は docs/計画-入社予定スタッフの登録と招待.md
//
// 🚨 判定はここ1か所（画面）と DB の my_access_state / hire_daily だけ。条件を書き写さない
//    入社予定 ＝ is_active=false かつ hire_date あり かつ retired_at なし かつ retire_date なし かつ 承認待ちでない
// 🚨 このファイルは supabase を読まない（判定だけ）

export interface PrehireFields {
  is_active?: boolean | null;
  approval_status?: string | null;
  hire_date?: string | null;
  retired_at?: string | null;
  retire_date?: string | null;
}

export function isPrehire(p: PrehireFields): boolean {
  return p.is_active === false && !!p.hire_date && !p.retired_at && !p.retire_date && p.approval_status !== 'pending';
}

/**
 * シフト管理（勤務表・掃除・勉強会・こども）に出す人か。在籍者と入社予定の人
 * 🚨 入社日からのシフトを先に入れられるようにするため（2026-10-04 ユーザーの要望の中心）
 */
export function isShiftRosterMember(p: PrehireFields): boolean {
  return p.is_active !== false || isPrehire(p);
}

/** 名前の横に出す札（入社予定の人だけ「入社予定 10/6〜」）。それ以外は空 */
export function prehireBadge(p: PrehireFields): string {
  if (!isPrehire(p) || !p.hire_date) return '';
  return `入社予定 ${Number(p.hire_date.slice(5, 7))}/${Number(p.hire_date.slice(8, 10))}〜`;
}

/** profiles から読むときに足す列（isShiftRosterMember に要るもの） */
export const PREHIRE_COLS = 'is_active, approval_status, hire_date, retired_at, retire_date';

/** 招待メールの状態（ユーザー管理の入社予定の欄に出す） */
export function inviteStatusLabel(p: { email?: string | null; invite_scheduled_for?: string | null; invite_sent_at?: string | null; invite_send_count?: number | null }): string {
  const fmt = (iso: string) => {
    const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  const noMail = !p.email || p.email.toLowerCase().endsWith('.invalid');
  if (p.invite_scheduled_for) return `${fmt(p.invite_scheduled_for)} に送信予定`;
  if (p.invite_sent_at) return `${fmt(p.invite_sent_at)} 送信済み${(p.invite_send_count ?? 0) > 1 ? `（${p.invite_send_count}回）` : ''}`;
  return noMail ? 'メール未登録' : '未送信';
}

/** 仮のアドレス（メール未定の人）か */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !email || email.toLowerCase().endsWith('.invalid');
}
