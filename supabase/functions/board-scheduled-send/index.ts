import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkCaller } from '../_shared/callerGate.ts';

// 連絡板のメールを送る（2026-10-26 から・送信の取り消しと一緒に作り直した）。
// 🚨 送信済みにする・ベルを作るのは DB の board_deliver（送信予約・取り消し待ち・ふつうの送信の全部が通る1か所）。
//    この関数は board_deliver が積んだ board_email_queue を受け取って、メールだけを送る。
//    呼ぶのは DB（毎分のジョブ cron_every_minute と、10秒たって画面が届けたときの board_kick_email）だけ
// 宛先は board_email_claim が返す（送った本人は board_deliver の時点で除いてある・.invalid と空のアドレスも除いてある）

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://fivem-portal.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FROM_ADDRESS = 'noreply@five-m.com';
const FROM_NAME = 'ファイブM管理者';

// Resendのバッチ送信API（宛先ごとに個別のtoを持つメールを1リクエストでまとめて送る。1リクエスト最大100件）
// 全員に同一内容だが宛先だけ別々にすることで、他の受信者のメールアドレスが見えるのを防ぐ
async function sendBatchEmails(emails: string[], subject: string, text: string): Promise<string | null> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) return 'RESEND_API_KEY が設定されていません';

  const errors: string[] = [];
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const payload = chunk.map(to => ({
      from: `${FROM_NAME} <${FROM_ADDRESS}>`,
      to: [to],
      subject,
      text,
    }));
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) errors.push(`${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return errors.length > 0 ? errors.join(' / ') : null;
}

const applyVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(.+?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);

type Claimed = { id: string; event_key: string; vars: Record<string, string>; emails: string[] | null };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  // 🚨 門（2026-10-16・セキュリティ点検）：cron・ほかの処理（サーバー用の鍵）からだけ呼べる。ログインしている人も断る。
  //    これが無いと、公開の鍵だけで誰でも呼べて、メールを何度でも送らせられた
  const gate = await checkCaller(req);
  if (!gate.ok || gate.kind !== 'service') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: gate.ok ? 403 : gate.status, headers: { 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // メールの文面（管理画面の通知設定）。オフ・文面が空の種類は送らない（今までと同じ）
  const { data: settings, error: setErr } = await supabase
    .from('notification_settings')
    .select('event_key, enabled, subject, template')
    .in('event_key', ['board:notice', 'board:group_message', 'board:dm_message'])
    .eq('channel', 'email');
  if (setErr) {
    console.error('[board-scheduled-send] 通知設定を読めませんでした:', setErr.message);
    return new Response(JSON.stringify({ error: 'settings' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const tplOf = new Map((settings ?? []).map((s: { event_key: string; enabled: boolean; subject: string | null; template: string | null }) => [s.event_key, s]));

  let sent = 0, skipped = 0, failed = 0;
  // 1回の呼び出しで最大4回（200件）。残りは次の毎分のジョブで拾う
  for (let round = 0; round < 4; round++) {
    const { data: rows, error } = await supabase.rpc('board_email_claim', { p_limit: 50 });
    if (error) { console.error('[board-scheduled-send] 送信待ちを受け取れませんでした:', error.message); break; }
    const list = (rows ?? []) as Claimed[];
    if (list.length === 0) break;

    for (const q of list) {
      const s = tplOf.get(q.event_key);
      const emails = (q.emails ?? []).filter(Boolean);
      let err: string | null = null;
      if (!s?.enabled || !s.template || emails.length === 0) {
        skipped++;
      } else {
        err = await sendBatchEmails(emails, applyVars(s.subject || '', q.vars ?? {}), applyVars(s.template, q.vars ?? {}));
        if (err) failed++; else sent++;
      }
      // 🚨 失敗したものは sent_at を空のまま＝10分後にもう一度（3回まで）。update の失敗も記録に出す
      const { error: upErr } = await supabase.from('board_email_queue')
        .update(err ? { error: err } : { sent_at: new Date().toISOString(), error: null })
        .eq('id', q.id);
      if (upErr) console.error('[board-scheduled-send] 記録の更新に失敗:', q.id, upErr.message);
      if (err) console.error('[board-scheduled-send] メールの送信に失敗:', q.event_key, err);
    }
    if (list.length < 50) break;
  }

  return new Response(JSON.stringify({ sent, skipped, failed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
