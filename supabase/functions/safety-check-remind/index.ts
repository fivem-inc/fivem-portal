// 安否確認：自動リマインド（5分毎cronから呼ばれる）
//   next_remind_at を過ぎた進行中の安否確認を atomic に claim し、未回答者へプッシュのみ再送する。
//   ⚠️ 自動リマインドはプッシュのみ（ベル・メールは送らない）。
//   理由：Resendメールの無料枠は1日100通で、46人×6回リマインドをメールに乗せると即座に枠切れし、
//   他の通知メールまで止まってしまうため。督促はホームの赤バナー（未回答の間ずっと出続ける）が担う。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
// ⚠️ バージョンを固定する。'@2'（最新追従）だと配信元の最新版が壊れている時に
//    「Module not found ... auth-js.mjs」でデプロイできなくなる（2026-08-03に実際に発生）
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// 安否を聞くもの＝「安否」、出勤可否・応援のお願い＝「緊急」（safety-check-send と同じ出し分け）
// ⚠️ どちらも実機テスト済みの語。新しい語を使うときは必ず実機で確認してから
const PUSH_TITLE_SAFETY = 'ファイブM 安否';
const PUSH_TITLE_URGENT = 'ファイブM 緊急';
const PUSH_BODY = '新着 1件';

function pushTitleFor(pattern: string): string {
  return (pattern === 'safety3' || pattern === 'safety4') ? PUSH_TITLE_SAFETY : PUSH_TITLE_URGENT;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // service_role のみ（cron・サーバー間呼び出し専用。verify_jwt=false のためここで確認する）
  // ⚠️ キーの文字列一致だけで判定すると、cronがVaultから渡すJWT形式のキーと一致せず401になる。
  //    send-push・safety-check-send と同じく role クレームも見る二段構えにする。
  const authHeader = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  let isServiceRole = authHeader === serviceKey;
  if (!isServiceRole && authHeader) {
    try {
      const payload = JSON.parse(atob(authHeader.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      isServiceRole = payload.role === 'service_role';
    } catch { /* JWTでない場合はfalseのまま */ }
  }
  if (!isServiceRole) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const now = new Date().toISOString();

  // 送る時間帯は発信ごとに決まっている（安否＝24時間／出勤確認・応援＝日中、が既定）。
  // 時間帯の外なら claim されない＝送らずに待つ（回数を消費しないので朝また催促できる）。
  const hourJst = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();

  // atomic claim：次回リマインド時刻を過ぎた進行中のcheckを、リマインド回数を進めつつ取得する
  // （cronが多重起動しても、2回目以降のUPDATEはWHERE条件に一致する行が無くなるため二重送信されない）
  const { data: claimed, error } = await supabase.rpc('claim_safety_check_reminders', {
    p_now: now,
    p_hour_jst: hourJst,
  });

  if (error) {
    console.error('[safety-check-remind] claim error', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const checks = (claimed ?? []) as { id: string; pattern: string }[];
  let totalSent = 0;

  for (const check of checks) {
    const { data: recipients } = await supabase.from('safety_check_recipients').select('user_id').eq('check_id', check.id);
    const { data: responses } = await supabase.from('safety_check_responses').select('user_id').eq('check_id', check.id);
    const answered = new Set((responses ?? []).map((r: { user_id: string }) => r.user_id));
    const unanswered = (recipients ?? []).map((r: { user_id: string }) => r.user_id).filter((id: string) => !answered.has(id));

    if (unanswered.length === 0) continue;

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/send-push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        // urgent: 安否確認は本人の「受信時間帯・休暇日」設定を無視して常に届ける（災害時に止めてはいけない）
        body: JSON.stringify({ user_ids: unanswered, title: pushTitleFor(check.pattern), body: PUSH_BODY, url: '/safety', tag: 'safety-check', urgent: true }),
      });
      const json = await res.json().catch(() => null);
      console.log(`[safety-check-remind] check=${check.id} sent=${json?.sent ?? 0}`);
      totalSent += json?.sent ?? 0;
    } catch (e) {
      console.error('[safety-check-remind] push failed', e);
    }
  }

  return new Response(JSON.stringify({ checks: checks.length, sent: totalSent }), { headers: { 'Content-Type': 'application/json' } });
});
