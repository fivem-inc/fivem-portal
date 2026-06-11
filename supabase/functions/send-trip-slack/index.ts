import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ALLOWED_ORIGINS = ['https://fivem-portal.vercel.app', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

const CHANNEL_SECRET_MAP: Record<string, string> = {
  kohei:             'SLACK_WEBHOOK_TRIP_KOHEI',
  adult:             'SLACK_WEBHOOK_TRIP_ADULT',
  kids_main:         'SLACK_WEBHOOK_TRIP_KIDS_MAIN',
  kids_nishijin:     'SLACK_WEBHOOK_TRIP_KIDS_NISHIJIN',
  kids_kamikatsura:  'SLACK_WEBHOOK_TRIP_KIDS_KAMIKATSURA',
  kids_rakusaiguchi: 'SLACK_WEBHOOK_TRIP_KIDS_RAKUSAIGUCHI',
  kids_minamisusita: 'SLACK_WEBHOOK_TRIP_KIDS_MINAMISUSITA',
  junior:            'SLACK_WEBHOOK_TRIP_JUNIOR',
  support:           'SLACK_WEBHOOK_TRIP_SUPPORT',
};

async function sendSlack(webhookUrl: string, messageText: string) {
  const payload = {
    text: messageText,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: messageText },
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('Slack送信失敗:', await res.text());
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: getCorsHeaders(req) });
  }

  try {
    const { message, channels } = await req.json();

    const sendPromises: Promise<void>[] = [];

    // チャンネルが1つも選択されていない場合は送信しない
    if (!channels || channels.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // チャンネルが選択されている場合は晃平先生へも自動送信
    const koheiUrl = Deno.env.get('SLACK_WEBHOOK_TRIP_KOHEI');
    if (koheiUrl) sendPromises.push(sendSlack(koheiUrl, message));

    // 選択されたチャンネルへ送信
    for (const ch of channels) {
      const secretName = CHANNEL_SECRET_MAP[ch];
      if (!secretName) continue;
      const url = Deno.env.get(secretName);
      if (url) sendPromises.push(sendSlack(url, message));
    }

    await Promise.all(sendPromises);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
