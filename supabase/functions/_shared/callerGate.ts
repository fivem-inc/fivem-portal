// Edge Function の入口の門（2026-09-22）
//
// 【何のためか】
//   Edge Function は service_role（全権）で動くので、データベース側の権限の仕組みを通らない。
//   そのため、呼んでいる人が在籍者かどうかを**関数の入口で自分で確かめる**必要がある。
//   設計書 docs/計画-退職者の申請期間.md §8-6 / §9-5。
//
// 【調べて分かったこと（2026-09-22）】
//   🚨 対象の7本のうち5本は、Authorization のヘッダーが付いているかを見るだけで、
//      **誰が呼んでいるかを一度も確かめていなかった**。
//      たとえば slack-notify は受け取った本文の名前をそのまま Slack に流すので、
//      ログインできる人なら誰でも好きな名前で通知を流せる状態だった。
//      この門は「退職者を止める」と「呼び主を確かめる」を同時に果たす。
//
// 【判定を書かない】
//   🚨 在籍・退職者の判定はデータベースの **my_access_state() 1本**に集約済み（2026-09-20）。
//      ここで条件を書き直さない。書くと「画面では入れるのに関数では弾かれる」食い違いになる。
//
// 【通す相手】
//   ・service_role（cron・他の Edge Function からの呼び出し）… 素通り
//   ・staff（在籍）… 通す
//   ・retiree_grace（期限内の退職者）… 通す。退職者も交通費などを申請できる必要があるため
//   ・それ以外（期限切れの退職者・承認待ち・ログインしていない）… 断る
//
// 🚨 立場を読めなかったときは**通さない**。「分からない＝通す」にすると門の意味が無くなる。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type GateResult =
  | { ok: true; kind: 'service'; userId: null }
  | { ok: true; kind: 'staff' | 'retiree_grace'; userId: string }
  | { ok: false; status: number; reason: string };

export async function checkCaller(req: Request): Promise<GateResult> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return { ok: false, status: 401, reason: '認証がありません' };
  }
  const token = auth.slice('Bearer '.length).trim();

  // cron や他の Edge Function からの呼び出し（service_role）は素通りさせる。
  // 🚨 これが無いと、毎晩のリマインドや他の関数からの呼び出しが全部止まる
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceKey && token === serviceKey) {
    return { ok: true, kind: 'service', userId: null };
  }

  try {
    // 呼んだ人の鍵でつなぐ（その人として読む）
    const sb = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );

    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) {
      return { ok: false, status: 401, reason: 'ログインが確認できませんでした' };
    }

    const { data, error: rpcErr } = await sb.rpc('my_access_state');
    if (rpcErr) {
      // 🚨 理由を残す（読めない原因が分からないと直せない）
      console.error('callerGate my_access_state error:', rpcErr.message);
      return { ok: false, status: 401, reason: '立場を確かめられませんでした' };
    }

    const mode = (data as { mode?: string } | null)?.mode;
    if (mode === 'staff' || mode === 'retiree_grace') {
      return { ok: true, kind: mode, userId: user.id };
    }
    return { ok: false, status: 403, reason: '在籍している方、または期限内の退職者だけが使えます' };
  } catch (e) {
    console.error('callerGate error:', e);
    return { ok: false, status: 401, reason: '立場を確かめられませんでした' };
  }
}
