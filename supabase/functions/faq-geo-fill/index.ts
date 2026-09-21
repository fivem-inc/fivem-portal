// お客様向けFAQの記録に「都道府県」を入れる（2026-09-22）
//
// 毎晩の cron から呼ばれる。都道府県が空でIPが入っている記録を集め、MaxMind GeoLite2 で引いて書き込む。
//
// 【なぜ夜にまとめて引くのか】
//   🚨 記録するその場で引くと、お客様がFAQを開くたびに外部と通信することになり画面が遅くなる。
//      失敗したときに記録そのものが落ちる恐れもある。表示に使うのは社内の集計だけなので、
//      その晩のうちに入っていれば足りる。
//
// 【枠の節約】
//   🚨 GeoLite2 の無料枠は **1日1,000件**。同じ方が何度も見るのでIPは重複する
//      （実測：記録22件に対して別々のIPは11種類）。**同じIPは1回だけ引き、同じIPの行をまとめて更新する**。
//   🚨 1回の実行で引くIPは MAX_IPS 件まで（暴走しても枠を使い切らないように）。
//
// 【引けなかったとき】
//   🚨 空のままにすると**毎晩ずっと引き直して枠を無駄に使い続ける**ので、'不明' を入れて二度と引かない。
//      集計では「未調査（まだ引いていない）」と「不明（引いたが分からなかった）」が見分けられる。
//      海外・社内IP・予約済みIPはここに入る。

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** 1回の実行で引く「別々のIP」の上限 */
const MAX_IPS = 200;
/** 引けなかったIPに入れる値。🚨 null（未調査）と区別するために必ず何か入れる */
const UNKNOWN = '不明';

async function lookupRegion(ip: string, accountId: string, licenseKey: string): Promise<string> {
  try {
    const res = await fetch(`https://geolite.info/geoip/v2.1/city/${encodeURIComponent(ip)}`, {
      headers: {
        Authorization: `Basic ${btoa(`${accountId}:${licenseKey}`)}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // 🚨 理由をそのまま残す（IP_ADDRESS_RESERVED＝社内IPなど／AUTHORIZATION_INVALID＝鍵違い／
      //    OUT_OF_QUERIES＝1日の上限）。鍵の値は出さない
      console.error('faq-geo-fill lookup failed:', ip, res.status, (await res.text()).slice(0, 200));
      return UNKNOWN;
    }
    const geo = await res.json();
    // 🚨 日本語の都道府県名を優先（「京都府」）。無ければ英語 → それも無ければ不明
    const sub = Array.isArray(geo?.subdivisions) ? geo.subdivisions[0] : null;
    return sub?.names?.ja || sub?.names?.en || UNKNOWN;
  } catch (e) {
    console.error('faq-geo-fill lookup error:', ip, e);
    return UNKNOWN;
  }
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const accountId = Deno.env.get('MAXMIND_ACCOUNT_ID');
  const licenseKey = Deno.env.get('MAXMIND_LICENSE_KEY');
  // 🚨 鍵が無いときは何も書かずに終わる。'不明' で埋めてしまうと、鍵を入れ直しても二度と引き直せない
  if (!accountId || !licenseKey) {
    console.error('faq-geo-fill: MaxMind の鍵（MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY）が設定されていません');
    return new Response(JSON.stringify({ error: 'MaxMind の鍵が設定されていません' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { data, error } = await supabase
      .from('faq_public_event')
      .select('ip')
      .is('region', null)
      .not('ip', 'is', null)
      .limit(5000);
    // 🚨 読めなかったときは書かずに終わる（0件と区別する）
    if (error) {
      console.error('faq-geo-fill select error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ips = [...new Set((data ?? []).map((r: { ip: string }) => r.ip))].slice(0, MAX_IPS);
    let filled = 0;
    let unknown = 0;
    let failed = 0;

    for (const ip of ips) {
      const region = await lookupRegion(ip, accountId, licenseKey);
      // 🚨 update は0件でもエラーにならない。件数を見ないと「書いたつもり」で終わる
      const { data: rows, error: upErr } = await supabase
        .from('faq_public_event')
        .update({ region })
        .eq('ip', ip)
        .is('region', null)
        .select('id');
      if (upErr || !rows) {
        console.error('faq-geo-fill update error:', ip, upErr?.message ?? '（件数を取れませんでした）');
        failed++;
        continue;
      }
      if (region === UNKNOWN) unknown += rows.length; else filled += rows.length;
    }

    const result = { ips: ips.length, filled, unknown, failed };
    console.log('faq-geo-fill done:', JSON.stringify(result));
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('faq-geo-fill error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
