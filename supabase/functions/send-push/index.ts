import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://fivem-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };
}

// VAPID署名を生成してプッシュ通知を送信する
async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url?: string; tag?: string },
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
) {
  const { endpoint, p256dh, auth } = subscription;

  // payloadをJSONにエンコード
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadStr);

  // VAPID JWTを生成
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp: expiration, sub: vapidSubject };

  const base64url = (data: Uint8Array | string) => {
    const str =
      typeof data === "string"
        ? data
        : String.fromCharCode(...new Uint8Array(data instanceof ArrayBuffer ? data : data));
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const headerB64 = base64url(JSON.stringify(header));
  const claimsB64 = base64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  // 秘密鍵をインポート
  const privateKeyBytes = Uint8Array.from(
    atob(vapidPrivateKey.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64url(new Uint8Array(sigBytes))}`;

  // 受信者の公開鍵・authをデコード
  const recipientPublicKeyBytes = Uint8Array.from(
    atob(p256dh.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );
  const authBytes = Uint8Array.from(
    atob(auth.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );

  // ECDH鍵ペアを生成
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  // 受信者公開鍵をインポート
  const recipientKey = await crypto.subtle.importKey(
    "raw",
    recipientPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 共有シークレットを導出
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientKey },
    serverKeyPair.privateKey,
    256
  );

  // サーバー公開鍵をエクスポート
  const serverPublicKeyRaw = await crypto.subtle.exportKey(
    "raw",
    serverKeyPair.publicKey
  );

  // HKDF でコンテンツ暗号化鍵とnonceを導出
  const prk = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(sharedSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // authシークレット
  const authInfo = new TextEncoder().encode("Content-Encoding: auth\0");
  const authSecret = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: authBytes,
      info: authInfo,
    },
    prk,
    256
  );

  const context = new Uint8Array([
    ...new TextEncoder().encode("P-256\0"),
    0,
    65,
    ...recipientPublicKeyBytes,
    0,
    65,
    ...new Uint8Array(serverPublicKeyRaw),
  ]);

  const cekInfo = new Uint8Array([
    ...new TextEncoder().encode("Content-Encoding: aesgcm\0"),
    ...context,
  ]);
  const nonceInfo = new Uint8Array([
    ...new TextEncoder().encode("Content-Encoding: nonce\0"),
    ...context,
  ]);

  const authKey = await crypto.subtle.importKey(
    "raw",
    authSecret,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: cekInfo },
    authKey,
    128
  );
  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: nonceInfo },
    authKey,
    96
  );

  const cek = await crypto.subtle.importKey(
    "raw",
    cekBits,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  // パディング（先頭2バイトはパディング長）
  const padded = new Uint8Array([0, 0, ...payloadBytes]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceBits },
    cek,
    padded
  );

  // Crypto-Key ヘッダー用のVAPID公開鍵
  const vapidPublicKeyBytes = Uint8Array.from(
    atob(vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );

  const b64urlServer = base64url(new Uint8Array(serverPublicKeyRaw));
  const b64urlSalt = base64url(salt);
  const b64urlVapid = base64url(vapidPublicKeyBytes);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aesgcm",
      Authorization: `vapid t=${jwt},k=${b64urlVapid}`,
      Encryption: `salt=${b64urlSalt}`,
      "Crypto-Key": `dh=${b64urlServer};p256ecdsa=${b64urlVapid}`,
      TTL: "86400",
    },
    body: encrypted,
  });

  return response;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req) });
  }

  const corsHeaders = getCorsHeaders(req);

  try {
    const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@five-m.com";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const { user_ids, title, body, url, tag } = await req.json();

    if (!user_ids || !title || !body) {
      return new Response(
        JSON.stringify({ error: "user_ids, title, body は必須です" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 対象ユーザーの購読情報を取得
    const { data: subscriptions, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("user_id", user_ids);

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ sent: 0, message: "購読者なし" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 全購読者に送信
    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        sendWebPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          { title, body, url: url || "/board", tag: tag || "fivem-notification" },
          VAPID_PRIVATE_KEY,
          VAPID_PUBLIC_KEY,
          VAPID_SUBJECT
        )
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    // 410 Gone（購読期限切れ）の場合はDBから削除
    const expiredEndpoints: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && (r.value as Response).status === 410) {
        expiredEndpoints.push(subscriptions[i].endpoint);
      }
    }
    if (expiredEndpoints.length > 0) {
      await supabase
        .from("push_subscriptions")
        .delete()
        .in("endpoint", expiredEndpoints);
    }

    return new Response(
      JSON.stringify({ sent, failed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
