// 安否確認：発信・手動再送
//   - 発信：safety_checks / safety_check_recipients を作成し、ベル・プッシュ・メールを
//     通知設定(notification_settings)を一切通さずに強制送信する。
//   - 手動再送（mode:'remind'）：既存のcheckについて未回答者にのみ再送する。
//
// ⚠️ 認可はこの関数内でのみ担保される（service_roleで書き込むためRLSは効かない）。
//    呼び出し元のJWTから本人のprofilesを引き、role_titleが
//    マネージャー/社長/管理者であることを確認する（gcal-syncと同じ二重の守り）。
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://fivem-portal.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FROM_ADDRESS = 'noreply@five-m.com';
const FROM_NAME = 'ファイブM管理者';
const BOARD_LINK = 'https://fivem-portal.vercel.app/safety';

// プッシュのタイトル・本文は「状態を表す漢字名詞＋件数」固定（Chrome不正通知判定対策）。
// ⚠️ 新しい単語は必ず実機テストしてから使う。Chromeが「不正な疑いのある通知」に差し替えると
//    災害時に通知が沈黙するため、未検証の語を安易に足さないこと。
//   検証済み：「ファイブM 安否」「ファイブM 緊急」（2026-08-03・Android実機で警告化しないことを確認）
//            「ファイブM 連絡板」「新着/本日期限/明日期限/差戻/未承認/取消」
//   NG確定：「確認」を含む語・「依頼」・「〜待ち」・文章形
// 安否を聞くもの＝「安否」、出勤可否・応援のお願い＝「緊急」で見分けられるようにする
const PUSH_TITLE_SAFETY = 'ファイブM 安否';
const PUSH_TITLE_URGENT = 'ファイブM 緊急';
const PUSH_BODY = '新着 1件';

function pushTitleFor(pattern: string): string {
  // safety3/safety4＝安否を聞く／attendance2・support＝業務の急ぎの連絡
  return (pattern === 'safety3' || pattern === 'safety4') ? PUSH_TITLE_SAFETY : PUSH_TITLE_URGENT;
}

type Pattern = 'safety3' | 'safety4' | 'attendance2' | 'support';

// ⚠️ client/src/pages/SafetyCheckPage.tsx の PATTERN_OPTIONS と必ず同じ内容にすること（片方だけ変えない）
const PRESET_OPTIONS: Record<Pattern, { key: string; label: string; color: string }[]> = {
  safety3: [
    { key: 'safe', label: '無事です', color: 'green' },
    { key: 'damaged_ok', label: '被害あり（助けは不要）', color: 'amber' },
    { key: 'damaged_help', label: '被害あり・助けが必要', color: 'red' },
  ],
  safety4: [
    { key: 'safe_can_work', label: '無事・出勤できます', color: 'green' },
    { key: 'safe_late', label: '無事・遅れて出勤します', color: 'blue' },
    { key: 'safe_cannot_work', label: '無事・出勤できません', color: 'amber' },
    { key: 'damaged_help', label: '被害あり・助けが必要', color: 'red' },
  ],
  attendance2: [
    { key: 'can_work', label: '出勤できます', color: 'green' },
    { key: 'cannot_work', label: '出勤できません', color: 'amber' },
  ],
  // 応援要請：安否確認と違い「お願い」なので、答えないこと自体は責めない（催促は既定で送らない運用）
  support: [
    { key: 'can_support', label: '応援に入れます', color: 'green' },
    { key: 'partial_support', label: '一部の時間なら入れます', color: 'blue' },
    { key: 'cannot_support', label: '今回は難しいです', color: 'amber' },
  ],
};

async function sendBatchEmails(emails: string[], subject: string, text: string): Promise<number> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) { console.error('[safety-check-send] RESEND_API_KEY が設定されていません'); return emails.length; }
  let failed = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const payload = chunk.map(to => ({ from: `${FROM_NAME} <${FROM_ADDRESS}>`, to: [to], subject, text }));
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      failed += chunk.length;
      console.error('[safety-check-send] Resendバッチ送信失敗:', res.status, await res.text());
    }
  }
  return failed;
}

async function sendPushDirect(supabaseUrl: string, serviceKey: string, userIds: string[], pattern: string) {
  if (userIds.length === 0) return;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: userIds, title: pushTitleFor(pattern), body: PUSH_BODY, url: '/safety', tag: 'safety-check' }),
    });
    const json = await res.json().catch(() => null);
    console.log('[safety-check-send] push result', json);
  } catch (e) {
    console.error('[safety-check-send] push send failed', e);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 認可：マネージャー以上のみ（Edge Functionはservice_roleで書くのでRLSが効かない＝ここが唯一の防壁）
    const authToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let callerId: string | null = null;
    if (authToken === serviceKey) {
      // サーバー間呼び出し（将来の自動発信用）。役職チェックは不要
      callerId = null;
    } else {
      const { data: userData, error: userErr } = await supabase.auth.getUser(authToken);
      if (userErr || !userData?.user) {
        console.error('[safety-check-send] getUser failed', userErr);
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      callerId = userData.user.id;
      const { data: profile } = await supabase.from('profiles').select('role_title, is_active').eq('id', callerId).single();
      const isAuthorized = profile?.is_active && ['マネージャー', '社長', '管理者'].includes(profile.role_title || '');
      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: '発信できるのはマネージャー以上のみです' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    const body = await req.json();

    if (body.mode === 'remind') {
      // 手動再送：既存checkの未回答者にのみプッシュ（＋任意でメール）を再送
      const checkId = body.check_id as string;
      const { data: check } = await supabase.from('safety_checks').select('id, title, pattern').eq('id', checkId).single();
      if (!check) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { data: recipients } = await supabase.from('safety_check_recipients').select('user_id').eq('check_id', checkId);
      const { data: responses } = await supabase.from('safety_check_responses').select('user_id').eq('check_id', checkId);
      const answered = new Set((responses ?? []).map((r: { user_id: string }) => r.user_id));
      const unanswered = (recipients ?? []).map((r: { user_id: string }) => r.user_id).filter((id: string) => !answered.has(id));

      await sendPushDirect(supabaseUrl, serviceKey, unanswered, check.pattern);

      if (unanswered.length > 0) {
        await supabase.from('notifications').insert(
          unanswered.map((uid: string) => ({
            user_id: uid, message: '安否確認の再送です', sub_message: check.title,
            source_type: 'safety_check', reference_id: checkId, event_key: null, read: false,
          }))
        );
      }

      return new Response(JSON.stringify({ resent: unanswered.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 発信
    const {
      pattern, title, message, is_test, target_user_ids,
      remind_interval_min, remind_max,
    } = body as {
      pattern: Pattern; title: string; message: string; is_test: boolean;
      target_user_ids: string[]; remind_interval_min?: number; remind_max?: number;
    };

    if (!pattern || !PRESET_OPTIONS[pattern]) {
      return new Response(JSON.stringify({ error: 'invalid pattern' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (!message || !Array.isArray(target_user_ids) || target_user_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'message and target_user_ids required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const intervalMin = Math.max(15, remind_interval_min ?? 60);
    const maxCount = Math.max(0, Math.min(24, remind_max ?? 6));

    const { data: created, error: insertErr } = await supabase.from('safety_checks').insert({
      title: title || (is_test ? '【テスト】安否確認' : '安否確認'),
      body: message,
      pattern,
      options: PRESET_OPTIONS[pattern],
      is_test: !!is_test,
      created_by: callerId ?? target_user_ids[0],   // service_role呼び出し（将来の自動発信）では宛先の先頭を仮の発信者にする
      remind_interval_min: intervalMin,
      remind_max: maxCount,
      next_remind_at: maxCount > 0 ? new Date(Date.now() + intervalMin * 60000).toISOString() : null,
    }).select('id').single();

    if (insertErr || !created) {
      return new Response(JSON.stringify({ error: insertErr?.message || 'failed to create' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const checkId = created.id as string;

    const { error: recipErr } = await supabase.from('safety_check_recipients').insert(
      target_user_ids.map((uid: string) => ({ check_id: checkId, user_id: uid }))
    );
    if (recipErr) console.error('[safety-check-send] recipients insert error', recipErr);

    // ベル通知（event_key は必ず null＝push-dispatchパイプラインに乗せない。プッシュはこの関数から直送するため）
    const titlePrefix = is_test ? '【テスト】' : '';
    await supabase.from('notifications').insert(
      target_user_ids.map((uid: string) => ({
        user_id: uid,
        message: `${titlePrefix}安否確認が届きました`,
        sub_message: message,
        source_type: 'safety_check', reference_id: checkId, event_key: null, read: false,
      }))
    );

    // プッシュ直送
    await sendPushDirect(supabaseUrl, serviceKey, target_user_ids, pattern);

    // メール（Resendバッチ）
    const { data: recipientProfiles } = await supabase.from('profiles').select('email').in('id', target_user_ids);
    const emails = (recipientProfiles ?? []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[];
    if (emails.length > 0) {
      const subject = `${titlePrefix}【安否確認】${title || 'ファイブM'}`;
      const text = `${message}\n\n下記のリンクから回答してください。\n${BOARD_LINK}?check=${checkId}`;
      const failed = await sendBatchEmails(emails, subject, text);
      if (failed > 0) console.error(`[safety-check-send] ${failed}/${emails.length}件のメール送信に失敗`);
    }

    return new Response(JSON.stringify({ check_id: checkId, recipients: target_user_ids.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[safety-check-send] error', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
