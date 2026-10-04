// 入社予定スタッフの招待・パスワード設定・パスワード変更の依頼のメール（2026-10-04）
// 設計は docs/計画-入社予定スタッフの登録と招待.md
//
// 🚨 文面はここ1か所（staff-onboard と password-setup-mail が同じものを使う）
// 🚨 招待メールの文面は 2026-10-04 ユーザー確定（計画書 §5）。変えるときは必ずユーザーに見せる
// 🚨 Supabase Auth のメール（送信上限が低い）は使わない。送り元はお知らせと同じ Resend（noreply@five-m.com）

export const SITE_URL = 'https://fivem-portal.vercel.app';
const FROM = 'ファイブM管理者 <noreply@five-m.com>';
/** 問い合わせ先の一文（2026-10-04 ユーザー指示：管理者 → マネージャー） */
const CONTACT_LINE = 'ご不明な点は、マネージャーまでお問い合わせください。';

/** 仮のアドレス（入社予定でメールが未定の人）。.invalid は届かない予約済みの名前 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !email || email.toLowerCase().endsWith('.invalid');
}

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !isPlaceholderEmail(email);
}

/** 今日（JST）の YYYY-MM-DD */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** "2026-10-15" → "10/15（木）" */
export function mdWeek(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(d.getTime() + 9 * 3600_000).getUTCDay()];
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${w}）`;
}

/** 入社日の朝10時（JST）の時刻 */
export function hireDayMorning(ymd: string): string {
  return new Date(`${ymd}T10:00:00+09:00`).toISOString();
}

function familyName(name: string): string {
  return (name ?? '').trim().split(/[\s　]+/)[0] || (name ?? '').trim();
}

/** Resend で1通送る。失敗したら理由を返す（🚨 throw しない＝呼び出し側が必ず見る） */
export async function sendMail(to: string, subject: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isPlaceholderEmail(to)) return { ok: false, error: 'メールアドレスが登録されていません' };
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'RESEND_API_KEY が設定されていません' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as { message?: string }).message || `メールを送れませんでした（${res.status}）` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `メールを送れませんでした：${String(e)}` };
  }
}

/** 招待メール（計画書 §5・ユーザー確定）。入社日を過ぎていれば日付の部分を外す */
export function inviteMail(p: { name: string; email: string; employment_type: string | null; hire_date: string | null }): { subject: string; text: string } {
  const today = todayJst();
  const before = !!p.hire_date && p.hire_date > today;
  const date = p.hire_date ? mdWeek(p.hire_date) : '';
  const use = p.employment_type === 'パート'
    ? '社内の連絡、交通費の申請、勤務変更の報告などに使います。'
    : '社内の連絡、交通費・残業の申請などに使います。';
  const lines = [
    `${p.name}さん`,
    '',
    `ファイブMの社内スタッフサイトに、${familyName(p.name)}さんのアカウントを用意しました。`,
    use,
    before ? `入社日（${date}）から使えますので、必ず登録をお願いします。` : '必ず登録をお願いします。',
    '',
    before ? `■ 登録のしかた（${date}から）` : '■ 登録のしかた',
    `① ${SITE_URL} を開く`,
    `② ［はじめての方（パスワードを決める）］を押し、このメールアドレス（${p.email}）を入れる`,
    '③ 届いたメールのボタンからパスワードを決め、ログインする',
    '',
    '■ スマートフォンのホーム画面に追加（通知を受け取るために必要です）',
    'iPhone：Safari の下の共有ボタン（□に↑）→「ホーム画面に追加」→ 追加されたアイコンから開き直す',
    'Android：Chrome の右上の ⋮ →「ホーム画面に追加」',
    '※ LINE の中で開いた場合は、メニューから「Safari で開く」を選んでください',
    '',
    '■ 通知の許可',
    'アイコンから開いたあと、右上のアイコン →「アカウント設定」→「許可する」',
    '',
    '■ メールが届かないとき',
    'パスワードのメールは1時間有効です。過ぎたときや届かないときは、もう一度［はじめての方］を押してください。',
    CONTACT_LINE,
  ];
  return { subject: '【ファイブM】スタッフサイトへの登録のお願い', text: lines.join('\n') };
}

/** パスワード設定のメール（ログイン画面の［はじめての方（パスワードを決める）］と「パスワードを忘れた場合」）。✅ 文面はユーザー確定（2026-10-04） */
export function setupMail(p: { name: string | null; link: string }): { subject: string; text: string } {
  const lines = [
    p.name ? `${p.name}さん` : '',
    '',
    'ファイブMのスタッフサイトのパスワード設定のご案内です。',
    '次のリンクを開き、［パスワードを決める］を押してください。',
    '',
    p.link,
    '',
    'このリンクは1時間有効です。過ぎたときは、ログイン画面からもう一度お手続きください。',
    'お心当たりのない場合は、このメールは破棄してください。パスワードは変わりません。',
  ].filter((l, i) => !(i === 0 && !l));
  return { subject: '【ファイブM】パスワード設定のご案内', text: lines.join('\n') };
}

/** 入社予定の人が［はじめての方］を押したとき（まだ設定できない）。✅ 文面はユーザー確定（2026-10-04） */
export function prehireNotYetMail(p: { name: string | null; hire_date: string }): { subject: string; text: string } {
  const lines = [
    p.name ? `${p.name}さん` : '',
    '',
    `ファイブMのスタッフサイトは、入社日（${mdWeek(p.hire_date)}）から使えます。`,
    `当日になったら、もう一度 ${SITE_URL} の［はじめての方（パスワードを決める）］からお手続きください。`,
  ].filter((l, i) => !(i === 0 && !l));
  return { subject: '【ファイブM】スタッフサイトは入社日から使えます', text: lines.join('\n') };
}

/** パスワード変更の依頼。✅ 文面はユーザー確定（2026-10-04）。送る理由で出し分ける（initial＝初期パスワードのままの方へ／review＝安全のための見直し） */
export function passwordChangeMail(p: { name: string; email: string; reason: 'initial' | 'review' }): { subject: string; text: string } {
  const initial = p.reason !== 'review';
  const lines = [
    `${p.name}さん`,
    '',
    'いつもお疲れさまです。',
    ...(initial
      ? ['スタッフサイトのパスワードが、最初に設定されたもののままになっている方へ、変更をお願いしています。',
         'お手数ですが、ご自身で決めたパスワードへの変更をお願いします。']
      : ['スタッフサイトの安全のため、皆さんにパスワードの変更をお願いしています。',
         'お手数ですが、新しいパスワードへの変更をお願いします。']),
    '',
    '■ 変更のしかた',
    `① ${SITE_URL} を開いてログインする`,
    `② ホームの「${initial ? 'パスワードの変更をお願いします' : 'パスワードの見直しをお願いします'}」を押し、新しいパスワードを決める`,
    '',
    ...(initial ? ['※ すでにご自身で変更済みの方も、お手数ですが、もう一度新しいパスワードへの変更をお願いします（変更するとホームのお知らせが消えます）。'] : []),
    `※ パスワードが分からないときは、ログイン画面の「パスワードを忘れた場合」に、このメールアドレス（${p.email}）を入れてください。`,
    '',
    CONTACT_LINE,
  ];
  return { subject: initial ? '【ファイブM】パスワード変更のお願い' : '【ファイブM】パスワード見直しのお願い', text: lines.join('\n') };
}
