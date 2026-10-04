// パスワード設定のメール（ログイン画面の［はじめての方（パスワードを決める）］と「パスワードを忘れた場合」）（2026-10-04）
// 設計は docs/計画-入社予定スタッフの登録と招待.md
//
// ・ログインする前に呼ぶので、誰でも呼べる（config.toml で verify_jwt = false）
// ・Supabase Auth のメール（送信上限が低い）は使わず、Resend から自前で送る
// ・リンクは /reset-password?token_hash=… を開くだけ。ページの［パスワードを決める］を押して初めて使う
//   （会社のメールの安全確認がリンクを先に開いても、1回きりの鍵が使われない）
// 🚨 アドレスが登録されているかどうかで返事を変えない（誰が在籍しているか探られないため）
// 🚨 同じアドレスへは1分に1回・1日5回まで。全体でも1日50通まで（Resend の1日100通を使い切られないため）

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isValidEmail, normalizeEmail, prehireNotYetMail, sendMail, setupMail, SITE_URL, todayJst } from '../_shared/staffMail.ts';

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
const PER_ADDRESS_INTERVAL_MS = 60_000;
const PER_ADDRESS_DAILY = 5;
const GLOBAL_DAILY = 50;

serve(async (req) => {
  const origin = req.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  // 🚨 いつも同じ返事（登録の有無・上限に当たったかを外に出さない）
  const done = () => new Response(JSON.stringify({ success: true }), { status: 200, headers });

  let email = '';
  try { email = normalizeEmail((await req.json())?.email); } catch { return done(); }
  if (!isValidEmail(email)) return done();

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // 🚨 ilike の % と _ は文字として扱う（打った文字で他の人のアドレスに当たらないように）
    const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data: rows } = await admin.from('profiles')
      .select('id, name, email, is_active, hire_date, retired_at, retire_date, approval_status, setup_mail_last_at, setup_mail_day, setup_mail_count')
      .ilike('email', pattern).limit(2);
    const list = (rows ?? []) as {
      id: string; name: string | null; email: string; is_active: boolean | null; hire_date: string | null;
      retired_at: string | null; retire_date: string | null; approval_status: string | null;
      setup_mail_last_at: string | null; setup_mail_day: string | null; setup_mail_count: number | null;
    }[];
    if (list.length !== 1) return done();
    const p = list[0];

    // 上限（同じアドレス・全体）
    const today = todayJst();
    const countToday = p.setup_mail_day === today ? (p.setup_mail_count ?? 0) : 0;
    if (p.setup_mail_last_at && Date.now() - new Date(p.setup_mail_last_at).getTime() < PER_ADDRESS_INTERVAL_MS) return done();
    if (countToday >= PER_ADDRESS_DAILY) return done();
    const { data: todayRows } = await admin.from('profiles').select('setup_mail_count').eq('setup_mail_day', today);
    const globalToday = ((todayRows ?? []) as { setup_mail_count: number }[]).reduce((s, r) => s + (r.setup_mail_count ?? 0), 0);
    if (globalToday >= GLOBAL_DAILY) { console.error('[password-setup-mail] 1日の上限に達しました'); return done(); }

    // 送る中身を決める
    let mail: { subject: string; text: string } | null = null;
    const prehire = p.is_active === false && !!p.hire_date && !p.retired_at && !p.retire_date && p.approval_status !== 'pending';
    if (p.is_active === true || (await inGrace(admin, p.id))) {
      const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: p.email });
      const hashed = (link as { properties?: { hashed_token?: string } } | null)?.properties?.hashed_token;
      if (error || !hashed) { console.error('[password-setup-mail] generateLink', error?.message); return done(); }
      mail = setupMail({ name: p.name, link: `${SITE_URL}/reset-password?token_hash=${encodeURIComponent(hashed)}&type=recovery` });
    } else if (prehire && p.hire_date) {
      // 入社予定の人：まだ設定できない（有効にする前にリンクを開いても追い出される）。入社日から使えることだけ知らせる
      mail = prehireNotYetMail({ name: p.name, hire_date: p.hire_date });
    }
    if (!mail) return done();

    const sent = await sendMail(p.email, mail.subject, mail.text);
    if (!sent.ok) { console.error('[password-setup-mail] 送信に失敗', sent.error); return done(); }
    const { error: recErr } = await admin.from('profiles').update({
      setup_mail_last_at: new Date().toISOString(), setup_mail_day: today, setup_mail_count: countToday + 1,
    }).eq('id', p.id).select('id');
    if (recErr) console.error('[password-setup-mail] 記録に失敗', recErr.message);
    return done();
  } catch (e) {
    console.error('[password-setup-mail]', e);
    return done();
  }
});

async function inGrace(admin: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await admin.rpc('is_retiree_in_grace', { p_uid: id });
  if (error) { console.error('[password-setup-mail] is_retiree_in_grace', error.message); return false; }
  return data === true;
}
