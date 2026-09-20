// メール（Resend）の使用量を返す。管理画面の右上に「今月 ◯通 / 3,000通」を出すために使う。
//
// 【なぜ作ったか】メールが無料枠の上限に当たって止まっても、いまは誰も気づけない。
//   受理・差し戻しの連絡が届かなくなるので、ストレージ・DB と同じように見えるようにする。
//
// 【記録を貯めない】Resend 側の数字をその場で聞く。DB に表を作らないので、掃除の cron も要らない。
//
// 🚨 GET /usage は「限定公開（private beta）」と説明書に書かれている。使えないアカウントもあるので、
//    使えなかったときは GET /emails（正式公開）を数える形に自動で切り替える。
//    どちらもだめなら「取れませんでした」と返す。**0通と嘘をつかない**。
//
// 🚨 APIキーは Supabase の Secrets（RESEND_API_KEY）から読む。画面にもログにも出さない。

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// 🚨 Resend は User-Agent が無い要求を 403（エラー1010）で断る。必ず付ける
const UA = 'fivem-portal/1.0';

/** 無料プランの上限。GET /usage が使えるときは Resend が返す値を優先する（プラン変更に自動で追従する） */
const FALLBACK_DAILY_LIMIT = 100;
const FALLBACK_MONTHLY_LIMIT = 3000;

interface EmailRow { id: string; created_at: string }

/** Resend の日時を読む。
 *  🚨 返ってくるのは「2026-04-03 22:13:42.674981+00」の形。
 *     ① 真ん中が空白（T ではない）② 時差が「+00」で**2桁しかない**。
 *     JavaScript の Date は「+00」を読めず NaN を返す（＝1件も数えられず「0通」になる）。
 *     2026-09-20 に実際にこれで 0通 と出た。必ず「+00:00」に直してから読むこと */
const parseAt = (s: string): number => {
  const v = String(s ?? '').trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(v);
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }
  const corsHeaders = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Function 内で認証を確かめる（プラットフォームの verify_jwt には頼らない）
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) return json({ error: 'Unauthorized' }, 401);

  // 🚨 システム管理者（app_metadata.role = 'admin'）だけ。使用量は経営の情報なので役職では開けない
  if ((user.app_metadata as { role?: string } | null)?.role !== 'admin') {
    return json({ error: 'Forbidden: 管理者のみ実行可能です' }, 403);
  }

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) return json({ error: 'RESEND_API_KEY が設定されていません' }, 500);
  const headers = { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'User-Agent': UA };

  try {
    // ── ① 使用量の窓口（限定公開）を試す ─────────────────────
    const usageRes = await fetch('https://api.resend.com/usage', { headers });
    if (usageRes.ok) {
      const u = await usageRes.json();
      const daily = u?.emails?.daily;
      const monthly = u?.emails?.monthly;
      if (daily && monthly) {
        return json({
          source: 'usage',
          daily: { used: daily.used ?? daily.sent ?? 0, limit: daily.limit ?? FALLBACK_DAILY_LIMIT, resets_at: daily.resets_at ?? null },
          monthly: { used: monthly.used ?? monthly.sent ?? 0, limit: monthly.limit ?? FALLBACK_MONTHLY_LIMIT, resets_at: monthly.resets_at ?? null },
          partial: false,
        });
      }
    }
    // 使えなかった理由は残しておく（画面には出さないが、調べるときの手がかりになる）
    const usageReason = `${usageRes.status} ${(await usageRes.text()).slice(0, 200)}`;

    // ── ② 送信の一覧を数える（正式公開の窓口）─────────────────
    // 🚨 日付で絞る指定が無いので、新しい順に取りながら「今月より前」に届いたら止める。
    //    1ページ100件・最大10ページ（＝1,000通）まで。それを超えたら partial を立てて正直に断る
    const now = new Date();
    // 🚨 Resend の締めは UTC（説明書の resets_at が UTC）。JST で切らない
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    let monthlyUsed = 0;
    let dailyUsed = 0;
    let after: string | null = null;
    let partial = false;
    let reachedOlder = false;
    let seen = 0;        // 受け取った行の数
    let unreadable = 0;  // 日時が読めなかった行の数

    for (let page = 0; page < 10; page++) {
      const url = `https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return json({
          error: 'メールの使用量を取れませんでした',
          detail: `usage: ${usageReason} / emails: ${res.status}`,
        }, 502);
      }
      const body = await res.json();
      const rows: EmailRow[] = Array.isArray(body?.data) ? body.data : [];
      if (rows.length === 0) { reachedOlder = true; break; }

      for (const r of rows) {
        seen++;
        const t = parseAt(r.created_at);
        if (Number.isNaN(t)) { unreadable++; continue; }
        if (t < monthStart) { reachedOlder = true; break; }
        monthlyUsed++;
        if (t >= dayStart) dailyUsed++;
      }
      if (reachedOlder) break;
      if (!body?.has_more) { reachedOlder = true; break; }
      after = rows[rows.length - 1].id;
      if (page === 9) partial = true;   // 数え切れなかった
    }

    // 🚨 日時が1つも読めなかったのに「0通」と出すと、止まる寸前でも気づけない。
    //    数えられなかったときは、数字を出さずに正直に断る
    if (seen > 0 && unreadable === seen) {
      return json({ error: '日時を読めませんでした（Resend の返し方が変わった可能性があります）' }, 502);
    }

    return json({
      source: 'emails',
      daily: { used: dailyUsed, limit: FALLBACK_DAILY_LIMIT, resets_at: null },
      monthly: { used: monthlyUsed, limit: FALLBACK_MONTHLY_LIMIT, resets_at: null },
      partial,
      note: partial ? '1,000通まで数えました（それより前は数えていません）' : null,
    });

  } catch (e) {
    return json({ error: 'メールの使用量を取れませんでした：' + String(e) }, 500);
  }
})
