// 入社予定スタッフの登録・招待メール・パスワード変更の依頼（2026-10-04）
// 設計は docs/計画-入社予定スタッフの登録と招待.md
//
// action:
//   create                  … 管理者。入社予定の人を登録（メールは任意・無ければ仮のアドレス）
//   update                  … 管理者。入社日の変更・メールの差し替え・送るタイミングの変更
//   send                    … 管理者。招待メールを今すぐ送る（再送）
//   request_password_change … 管理者。選んだ人にパスワード変更の依頼（印＋ベル＋メール）。scheduled_for を付けると予約
//   cancel_pw_request       … 管理者。送る前の予約を取り消す
//   pw_requests             … 管理者。依頼の履歴（相手ごとの既読・変更したか）
//   send_due_pw             … service_role だけ（cron pw-request-due）。予約の時刻を過ぎた依頼を送る
//   send_due                … service_role だけ（cron staff-invite-due）。送信予定を過ぎた人へ送る
//
// 🚨 入社予定＝is_active=false かつ hire_date あり かつ retired_at なし（判定は lib/staffState.ts・my_access_state と同じ）
// 🚨 handle_new_user の通知を止める印は app_metadata（user_metadata は本人が書けるので使わない）
// 🚨 supabase の update は0件でもエラーにならない。件数を見る

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkCaller } from '../_shared/callerGate.ts';
import {
  hireDayMorning, inviteMail, isPlaceholderEmail, isValidEmail, normalizeEmail, passwordChangeMail, sendMail, todayJst,
} from '../_shared/staffMail.ts';

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
function cors(req: Request) {
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

type SendMode = 'now' | 'hire_date' | 'none';
interface ProfileRow {
  id: string; name: string | null; email: string | null; employment_type: string | null;
  is_active: boolean | null; hire_date: string | null; retired_at: string | null; retire_date: string | null;
  invite_scheduled_for: string | null; invite_sent_at: string | null; invite_send_count: number | null;
}
const PROFILE_COLS = 'id, name, email, employment_type, is_active, hire_date, retired_at, retire_date, invite_scheduled_for, invite_sent_at, invite_send_count';
const RESEND_MIN_INTERVAL_MS = 60_000;   // 同じ人への招待は1分あける（二度押し）
const RESEND_MAX_TOTAL = 10;             // 招待は1人10回まで

const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const randomPassword = () => {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, '') + 'Aa1!';
};

serve(async (req) => {
  const headers = { ...cors(req), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ success: false, error: '内容を読めませんでした' }, 400); }
  const action = String(body.action ?? '');

  // ── 呼んだ人の確認 ──
  const gate = await checkCaller(req);
  if (action === 'send_due') {
    if (!gate.ok || gate.kind !== 'service') return reply({ success: false, error: 'unauthorized' }, 401);
    return reply(await sendDue(admin));
  }
  if (action === 'send_due_pw') {
    if (!gate.ok || gate.kind !== 'service') return reply({ success: false, error: 'unauthorized' }, 401);
    return reply(await sendDuePw(admin));
  }
  if (!gate.ok || gate.kind !== 'staff') return reply({ success: false, error: 'unauthorized' }, gate.ok ? 403 : gate.status);
  const { data: { user } } = await admin.auth.admin.getUserById(gate.userId);
  // 🚨 システム管理者（app_metadata.role = 'admin'）だけ（create-user と同じ）
  if ((user?.app_metadata as { role?: string } | undefined)?.role !== 'admin') {
    return reply({ success: false, error: '管理者だけが使えます' }, 403);
  }

  try {
    if (action === 'create') return reply(await create(admin, body, gate.userId));
    if (action === 'update') return reply(await update(admin, body, gate.userId));
    if (action === 'send') return reply(await sendNow(admin, String(body.id ?? '')));
    if (action === 'request_password_change') return reply(await requestPasswordChange(admin, body, gate.userId));
    if (action === 'cancel_pw_request') return reply(await cancelPwRequest(admin, String(body.id ?? '')));
    if (action === 'pw_requests') return reply(await listPwRequests(admin));
    return reply({ success: false, error: '知らない操作です' }, 400);
  } catch (e) {
    console.error('[staff-onboard]', action, e);
    return reply({ success: false, error: `処理に失敗しました：${String(e)}` }, 500);
  }
});

/** メインの部門とグループを確かめる（2026-10-04 ユーザー指示：登録・直すときに一緒に入れる）。
 *  undefined＝触らない／null・空配列＝外す。知らない部門・グループは断る */
async function checkAreaGroups(admin: SupabaseClient, b: Record<string, unknown>): Promise<{ ok: true; areaId: string | null | undefined; groups: string[] | undefined } | { ok: false; error: string }> {
  let areaId: string | null | undefined = undefined;
  if (b.main_area_id !== undefined) {
    areaId = b.main_area_id ? String(b.main_area_id) : null;
    if (areaId) {
      const { data } = await admin.from('shift_work_areas').select('id').eq('id', areaId).eq('active', true).maybeSingle();
      if (!data) return { ok: false, error: 'その部門は見つかりません' };
    }
  }
  let groups: string[] | undefined = undefined;
  if (b.group_names !== undefined) {
    groups = Array.isArray(b.group_names) ? [...new Set((b.group_names as unknown[]).map(String).filter(Boolean))] : [];
    if (groups.length > 0) {
      const { data } = await admin.from('master_options').select('value').eq('category', 'group');
      const known = new Set(((data ?? []) as { value: string }[]).map(r => r.value));
      const unknown = groups.filter(g => !known.has(g));
      if (unknown.length) return { ok: false, error: `知らないグループです：${unknown.join('、')}` };
    }
  }
  return { ok: true, areaId, groups };
}

/** メインの部門を書く（null なら外す）。🚨 staff_main_work_areas は画面からは書けない（シフト管理は shift_patterns_save だけ）ので、ここで service_role で書く */
async function writeMainArea(admin: SupabaseClient, userId: string, areaId: string | null, by: string | null): Promise<string | null> {
  if (areaId === null) {
    const { error } = await admin.from('staff_main_work_areas').delete().eq('user_id', userId);
    return error?.message ?? null;
  }
  const { error } = await admin.from('staff_main_work_areas').upsert({ user_id: userId, area_id: areaId, updated_at: new Date().toISOString(), updated_by: by });
  return error?.message ?? null;
}

async function emailTaken(admin: SupabaseClient, email: string, exceptId?: string): Promise<boolean> {
  let q = admin.from('profiles').select('id').ilike('email', email);
  if (exceptId) q = q.neq('id', exceptId);
  const { data } = await q.limit(1);
  return (data ?? []).length > 0;
}

async function loadProfile(admin: SupabaseClient, id: string): Promise<ProfileRow | null> {
  const { data } = await admin.from('profiles').select(PROFILE_COLS).eq('id', id).maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

/** 招待メールを送り、送った記録を付ける。送信予定は消す */
async function deliverInvite(admin: SupabaseClient, p: ProfileRow): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isPlaceholderEmail(p.email)) return { ok: false, error: 'メールアドレスがまだ登録されていません' };
  const mail = inviteMail({ name: p.name ?? '', email: p.email!, employment_type: p.employment_type, hire_date: p.hire_date });
  const sent = await sendMail(p.email!, mail.subject, mail.text);
  if (!sent.ok) return sent;
  const { error } = await admin.from('profiles').update({
    invite_sent_at: new Date().toISOString(),
    invite_send_count: (p.invite_send_count ?? 0) + 1,
    invite_scheduled_for: null,
    invite_claimed_at: null,
  }).eq('id', p.id).select('id');
  // 🚨 メールは届いているので、記録の失敗は失敗として返さない（もう一度送らせない）。理由は残す
  if (error) console.error('[staff-onboard] 送信記録の保存に失敗', p.id, error.message);
  return { ok: true };
}

/** 送るタイミングから、送信予定の時刻を決める（null＝予定なし）。入社日を過ぎていれば今すぐ扱い */
function scheduleFor(mode: SendMode, hireDate: string | null): { scheduled: string | null; sendNow: boolean } {
  if (mode === 'now') return { scheduled: null, sendNow: true };
  if (mode === 'hire_date' && hireDate) {
    const at = hireDayMorning(hireDate);
    return at <= new Date().toISOString() ? { scheduled: null, sendNow: true } : { scheduled: at, sendNow: false };
  }
  return { scheduled: null, sendNow: false };
}

async function create(admin: SupabaseClient, b: Record<string, unknown>, by: string) {
  const name = String(b.name ?? '').trim();
  const hireDate = b.hire_date;
  const employmentType = String(b.employment_type ?? '正社員');
  const roleTitle = String(b.role_title ?? '一般');
  const email = normalizeEmail(b.email);
  const mode = (['now', 'hire_date', 'none'].includes(String(b.send)) ? String(b.send) : 'none') as SendMode;
  if (!name) return { success: false, error: '名前を入れてください' };
  if (!isYmd(hireDate)) return { success: false, error: '入社日を入れてください' };
  if (email && !isValidEmail(email)) return { success: false, error: 'メールアドレスの形が正しくありません' };
  if (!email && mode !== 'none') return { success: false, error: '招待メールを送るには、メールアドレスが要ります' };
  if (email && await emailTaken(admin, email)) return { success: false, error: 'このメールアドレスは、すでに登録されています' };
  const ag = await checkAreaGroups(admin, b);
  if (!ag.ok) return { success: false, error: ag.error };

  const loginEmail = email || `prehire-${crypto.randomUUID()}@staff.invalid`;
  // 🚨 作る直前に控えに書く（handle_new_user がこれを見て、経理への「新規登録」の通知を止める）。
  //    app_metadata の印だけでは止まらなかった（作った瞬間にはまだ入っていない・2026-10-04 本番で確認）
  const { error: markErr } = await admin.from('admin_provisioning_emails').upsert({ email: loginEmail.toLowerCase() });
  if (markErr) return { success: false, error: `準備に失敗しました：${markErr.message}` };
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password: randomPassword(),
    email_confirm: true,
    app_metadata: { provisioned_by_admin: true },
    user_metadata: { name },
  });
  if (authErr || !created.user) {
    await admin.from('admin_provisioning_emails').delete().eq('email', loginEmail.toLowerCase());
    return { success: false, error: `アカウントを作れませんでした：${authErr?.message ?? '不明'}` };
  }
  const id = created.user.id;

  const { data: maxRow } = await admin.from('profiles').select('sort_order').not('sort_order', 'is', null)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const active = hireDate <= todayJst();
  const sch = scheduleFor(mode, hireDate);
  const { error: profErr } = await admin.from('profiles').upsert({
    id, email: loginEmail, name, employment_type: employmentType, role_title: roleTitle,
    is_active: active, approval_status: 'approved', hire_date: hireDate,
    registered_at: new Date().toISOString(),
    sort_order: ((maxRow as { sort_order?: number } | null)?.sort_order ?? 0) + 1,
    invite_scheduled_for: sch.scheduled,
    ...(ag.groups !== undefined ? { group_names: ag.groups } : {}),
  });
  if (profErr) {
    await admin.auth.admin.deleteUser(id);
    return { success: false, error: `登録に失敗しました：${profErr.message}` };
  }

  // メインの部門（失敗しても登録は済んでいる。理由を返す）
  let areaError: string | null = null;
  if (ag.areaId) areaError = await writeMainArea(admin, id, ag.areaId, by);

  let mailError: string | null = null;
  if (sch.sendNow) {
    const p = await loadProfile(admin, id);
    const r = p ? await deliverInvite(admin, p) : { ok: false as const, error: '登録した内容を読み直せませんでした' };
    if (!r.ok) mailError = r.error;
  }
  return { success: true, id, active, sent: sch.sendNow && !mailError, scheduled_for: sch.scheduled, mail_error: mailError, area_error: areaError };
}

async function update(admin: SupabaseClient, b: Record<string, unknown>, by: string) {
  const id = String(b.id ?? '');
  const p = await loadProfile(admin, id);
  if (!p) return { success: false, error: 'その人が見つかりません' };
  if (p.retired_at || p.retire_date) return { success: false, error: '退職の手続きがある人は、ここでは変えられません' };

  const ag = await checkAreaGroups(admin, b);
  if (!ag.ok) return { success: false, error: ag.error };
  const patch: Record<string, unknown> = {};
  if (ag.groups !== undefined) patch.group_names = ag.groups;
  // 名前・雇用形態・役職（入社予定の欄の［名前・雇用形態・役職を直す］）
  if (b.name !== undefined) {
    const n = String(b.name ?? '').trim();
    if (!n) return { success: false, error: '名前を入れてください' };
    patch.name = n;
  }
  if (b.employment_type !== undefined) patch.employment_type = String(b.employment_type);
  if (b.role_title !== undefined) patch.role_title = String(b.role_title);
  // メールの差し替え（仮のアドレス → 本物、または打ち間違いの直し）
  if (b.email !== undefined) {
    const email = normalizeEmail(b.email);
    if (!isValidEmail(email)) return { success: false, error: 'メールアドレスの形が正しくありません' };
    if (email !== (p.email ?? '').toLowerCase()) {
      if (await emailTaken(admin, email, id)) return { success: false, error: 'このメールアドレスは、すでに別の人に登録されています' };
      const { error } = await admin.auth.admin.updateUserById(id, { email, email_confirm: true });
      if (error) return { success: false, error: `メールアドレスを変えられませんでした：${error.message}` };
      patch.email = email;
      p.email = email;
    }
  }
  // 入社日の変更（入社予定の人だけ。過ぎた日にすると、その場で在籍にする）
  if (b.hire_date !== undefined) {
    if (!isYmd(b.hire_date)) return { success: false, error: '入社日の形が正しくありません' };
    patch.hire_date = b.hire_date;
    p.hire_date = b.hire_date;
    if (p.is_active === false && b.hire_date <= todayJst()) patch.is_active = true;
    // 入社日の朝に送る予定だったものは、新しい入社日に動かす
    if (p.invite_scheduled_for && b.send === undefined) {
      const sch = scheduleFor('hire_date', b.hire_date);
      patch.invite_scheduled_for = sch.scheduled;
      if (sch.sendNow) b.send = 'now';
    }
  }
  if (ag.areaId !== undefined) {
    const e = await writeMainArea(admin, id, ag.areaId, by);
    if (e) return { success: false, error: `メインの部門を保存できませんでした：${e}` };
  }
  let sendNowFlag = false;
  if (b.send !== undefined) {
    const mode = (['now', 'hire_date', 'none'].includes(String(b.send)) ? String(b.send) : 'none') as SendMode;
    if (mode !== 'none' && isPlaceholderEmail(p.email)) return { success: false, error: '招待メールを送るには、メールアドレスが要ります' };
    const sch = scheduleFor(mode, p.hire_date);
    patch.invite_scheduled_for = sch.scheduled;
    sendNowFlag = sch.sendNow;
  }
  if (Object.keys(patch).length > 0) {
    const { data, error } = await admin.from('profiles').update(patch).eq('id', id).select('id');
    if (error || (data ?? []).length === 0) return { success: false, error: `保存できませんでした：${error?.message ?? '対象が見つかりません'}` };
  }
  let mailError: string | null = null;
  if (sendNowFlag) {
    const fresh = await loadProfile(admin, id);
    const r = fresh ? await deliverInvite(admin, fresh) : { ok: false as const, error: '読み直せませんでした' };
    if (!r.ok) mailError = r.error;
  }
  return { success: true, sent: sendNowFlag && !mailError, mail_error: mailError };
}

async function sendNow(admin: SupabaseClient, id: string) {
  const p = await loadProfile(admin, id);
  if (!p) return { success: false, error: 'その人が見つかりません' };
  if (p.invite_sent_at && Date.now() - new Date(p.invite_sent_at).getTime() < RESEND_MIN_INTERVAL_MS) {
    return { success: false, error: 'いま送ったばかりです。1分ほどあけてください' };
  }
  if ((p.invite_send_count ?? 0) >= RESEND_MAX_TOTAL) return { success: false, error: `招待メールは1人${RESEND_MAX_TOTAL}回までです` };
  const r = await deliverInvite(admin, p);
  return r.ok ? { success: true } : { success: false, error: r.error };
}

interface PwRequestRow { id: string; reason: 'initial' | 'review'; user_ids: string[]; created_by: string | null }

/** 依頼を受け付ける。予約（未来の時刻）なら記録だけ。そうでなければすぐ送る */
async function requestPasswordChange(admin: SupabaseClient, b: Record<string, unknown>, by: string) {
  const ids = Array.isArray(b.ids) ? [...new Set((b.ids as unknown[]).map(String).filter(Boolean))] : [];
  if (ids.length === 0) return { success: false, error: '送る相手を選んでください' };
  // 送る理由（2026-10-04 ユーザー確定）：initial＝初期パスワードのままの方へ／review＝安全のための見直し（全員へ）
  const reason: 'initial' | 'review' = b.reason === 'review' ? 'review' : 'initial';
  let scheduledFor: string | null = null;
  if (b.scheduled_for) {
    const t = new Date(String(b.scheduled_for));
    if (Number.isNaN(t.getTime())) return { success: false, error: '送る日時が正しくありません' };
    if (t.getTime() <= Date.now()) return { success: false, error: 'この日時はもう過ぎています' };
    scheduledFor = t.toISOString();
  }
  const { data: req, error } = await admin.from('pw_change_requests')
    .insert({ reason, user_ids: ids, scheduled_for: scheduledFor, created_by: by }).select('id, reason, user_ids, created_by').single();
  if (error || !req) return { success: false, error: `受け付けられませんでした：${error?.message ?? '不明'}` };
  if (scheduledFor) return { success: true, scheduled_for: scheduledFor, request_id: (req as PwRequestRow).id };
  return await deliverPwRequest(admin, req as PwRequestRow);
}

/** 依頼を実際に送る：印＋ベル＋メール、送った相手を記録する。
 *  🚨 送る瞬間に在籍しているかを確かめ直す（予約のあとに辞めた人・入社予定の人には送らない） */
async function deliverPwRequest(admin: SupabaseClient, req: PwRequestRow) {
  const { data: rows, error } = await admin.from('profiles').select('id, name, email').in('id', req.user_ids).eq('is_active', true);
  if (error) return { success: false, error: `読み込めませんでした：${error.message}` };
  const targets = (rows ?? []) as { id: string; name: string | null; email: string | null }[];
  const now = new Date().toISOString();
  if (targets.length > 0) {
    const { error: updErr } = await admin.from('profiles')
      .update({ must_change_password: true, pw_change_requested_at: now, pw_change_reason: req.reason }).in('id', targets.map(t => t.id)).select('id');
    if (updErr) return { success: false, error: `保存できませんでした：${updErr.message}` };
  }
  // ベル（🚨 banner_dismissed=true：ホームには印のバナーを別に出すので、同じ知らせを2つ並べない）
  const notifByUser = new Map<string, string>();
  let bellError: string | null = null;
  if (targets.length > 0) {
    const { data: notifs, error: nErr } = await admin.from('notifications').insert(targets.map(t => ({
      user_id: t.id,
      message: req.reason === 'review' ? '🔑 パスワードの見直しをお願いします' : '🔑 パスワードの変更をお願いします',
      sub_message: req.reason === 'review' ? '安全のため、パスワードの変更をお願いしています' : 'ご自身で決めたパスワードへの変更をお願いします',
      source_type: 'account:password_change',
      event_key: 'account:password_change',
      created_by: req.created_by,
      banner_dismissed: true,
    }))).select('id, user_id');
    if (nErr) { bellError = nErr.message; console.error('[staff-onboard] ベルの通知に失敗', nErr.message); }
    for (const n of (notifs ?? []) as { id: string; user_id: string }[]) notifByUser.set(n.user_id, n.id);
  }
  const mailedSet = new Set<string>();
  const failed: string[] = [];
  for (const t of targets) {
    if (isPlaceholderEmail(t.email)) continue;
    const m = passwordChangeMail({ name: t.name ?? '', email: t.email!, reason: req.reason });
    const r = await sendMail(t.email!, m.subject, m.text);
    if (r.ok) mailedSet.add(t.id); else failed.push(t.name ?? t.id);
  }
  if (targets.length > 0) {
    const { error: recErr } = await admin.from('pw_change_request_recipients').upsert(targets.map(t => ({
      request_id: req.id, user_id: t.id, notification_id: notifByUser.get(t.id) ?? null, mailed: mailedSet.has(t.id),
    })));
    if (recErr) console.error('[staff-onboard] 送った相手の記録に失敗', recErr.message);
  }
  const { error: doneErr } = await admin.from('pw_change_requests')
    .update({ sent_at: now, sent_count: targets.length, mailed_count: mailedSet.size, claimed_at: null }).eq('id', req.id).select('id');
  if (doneErr) console.error('[staff-onboard] 送った記録に失敗', doneErr.message);
  return {
    success: true,
    flagged: targets.length,
    skipped: req.user_ids.length - targets.length,
    mailed: mailedSet.size,
    mail_failed: failed,
    bell_error: bellError,
  };
}

async function cancelPwRequest(admin: SupabaseClient, id: string) {
  const { data, error } = await admin.from('pw_change_requests').update({ cancelled_at: new Date().toISOString() })
    .eq('id', id).is('sent_at', null).is('cancelled_at', null).is('claimed_at', null).select('id');
  if (error) return { success: false, error: error.message };
  if ((data ?? []).length === 0) return { success: false, error: 'もう送り始めているか、取り消し済みです' };
  return { success: true };
}

/** 依頼の履歴（新しい順に20件）。相手ごとに「ベルを読んだか」「パスワードを変えたか（いつ）」 */
async function listPwRequests(admin: SupabaseClient) {
  const { data: reqs, error } = await admin.from('pw_change_requests')
    .select('id, reason, user_ids, scheduled_for, sent_at, sent_count, mailed_count, cancelled_at, created_at')
    .order('created_at', { ascending: false }).limit(20);
  if (error) return { success: false, error: error.message };
  const list = (reqs ?? []) as { id: string; reason: string; user_ids: string[]; scheduled_for: string | null; sent_at: string | null; sent_count: number; mailed_count: number; cancelled_at: string | null; created_at: string }[];
  const reqIds = list.map(r => r.id);
  const recRes = reqIds.length ? await admin.from('pw_change_request_recipients').select('request_id, user_id, notification_id, mailed').in('request_id', reqIds) : { data: [] };
  const recRows = (recRes.data ?? []) as { request_id: string; user_id: string; notification_id: string | null; mailed: boolean }[];
  const userIds = [...new Set(recRows.map(r => r.user_id))];
  const notifIds = recRows.map(r => r.notification_id).filter((x): x is string => !!x);
  const profRes = userIds.length ? await admin.from('profiles').select('id, name, pw_changed_at').in('id', userIds) : { data: [] };
  const notifRes = notifIds.length ? await admin.from('notifications').select('id, read').in('id', notifIds) : { data: [] };
  const profMap = new Map(((profRes.data ?? []) as { id: string; name: string | null; pw_changed_at: string | null }[]).map(p => [p.id, p]));
  const readMap = new Map(((notifRes.data ?? []) as { id: string; read: boolean | null }[]).map(n => [n.id, !!n.read]));
  return {
    success: true,
    requests: list.map(r => ({
      id: r.id, reason: r.reason, target_count: r.user_ids.length, scheduled_for: r.scheduled_for, sent_at: r.sent_at,
      sent_count: r.sent_count, mailed_count: r.mailed_count, cancelled_at: r.cancelled_at, created_at: r.created_at,
      recipients: recRows.filter(x => x.request_id === r.id).map(x => {
        const p = profMap.get(x.user_id);
        // 依頼を送ったあとに変えたときだけ「変更済み」（それより前の変更は依頼に応えたものではない）
        const changedAt = p?.pw_changed_at && r.sent_at && new Date(p.pw_changed_at).getTime() >= new Date(r.sent_at).getTime() ? p.pw_changed_at : null;
        return { user_id: x.user_id, name: p?.name ?? '（削除された方）', read: x.notification_id ? (readMap.get(x.notification_id) ?? false) : false, changed_at: changedAt, mailed: x.mailed };
      }).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ja')),
    })),
  };
}

async function sendDuePw(admin: SupabaseClient) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: due, error } = await admin.from('pw_change_requests').select('id, reason, user_ids, created_by')
    .not('scheduled_for', 'is', null).lte('scheduled_for', now).is('sent_at', null).is('cancelled_at', null).limit(5);
  if (error) return { success: false, error: error.message };
  let sent = 0;
  for (const r of (due ?? []) as PwRequestRow[]) {
    // 🚨 先に取り押さえる（cron が重なっても二重に送らない）
    const { data: claimed } = await admin.from('pw_change_requests').update({ claimed_at: now })
      .eq('id', r.id).is('sent_at', null).is('cancelled_at', null)
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`).select('id');
    if ((claimed ?? []).length === 0) continue;
    const res = await deliverPwRequest(admin, r) as { success: boolean; error?: string };
    if (res.success) sent++;
    else console.error('[staff-onboard] 予約の依頼を送れませんでした', r.id, res.error);
  }
  return { success: true, sent };
}

async function sendDue(admin: SupabaseClient) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: due, error } = await admin.from('profiles').select(PROFILE_COLS)
    .not('invite_scheduled_for', 'is', null).lte('invite_scheduled_for', now)
    .not('email', 'ilike', '%.invalid').limit(20);
  if (error) return { success: false, error: error.message };
  let sent = 0;
  const failures: string[] = [];
  for (const p of (due ?? []) as ProfileRow[]) {
    // 🚨 先に取り押さえる（cron が重なっても二重に送らない）。取れなかったら他の回が送っている
    const { data: claimed } = await admin.from('profiles').update({ invite_claimed_at: now })
      .eq('id', p.id).not('invite_scheduled_for', 'is', null)
      .or(`invite_claimed_at.is.null,invite_claimed_at.lt.${stale}`).select('id');
    if ((claimed ?? []).length === 0) continue;
    const r = await deliverInvite(admin, p);
    if (r.ok) { sent++; continue; }
    failures.push(`${p.id}: ${r.error}`);
    // 管理者・社長にベルで知らせる（2026-10-05・通知設定の staff:invite_failed）。🚨 失敗しても送信の処理は続ける
    const { error: nErr } = await admin.rpc('notify_event', {
      p_event: 'staff:invite_failed', p_subjects: [p.id],
      p_message: `⚠️ ${(p.name ?? '').replace(/[\s　]+/g, ' ')}さんへの招待メールを送れませんでした`,
      p_sub: `${r.error}（1時間後にもう一度送ります。アドレスが違うときは［メールを直す］から）`,
      p_source: 'staff:invite_failed', p_exclude: null, p_created_by: null,
    });
    if (nErr) console.error('[staff-onboard] 失敗の通知に失敗', nErr.message);
    // 失敗したら1時間後にもう一度（15分ごとに同じ失敗を繰り返さない）
    await admin.from('profiles').update({
      invite_claimed_at: null,
      invite_scheduled_for: new Date(Date.now() + 3600_000).toISOString(),
    }).eq('id', p.id).select('id');
  }
  if (failures.length) console.error('[staff-onboard] send_due の失敗', failures);
  return { success: true, sent, failed: failures.length };
}
