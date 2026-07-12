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

function b64urlDecode(str: string): Uint8Array {
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function b64urlEncode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bits: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bits
  );
  return new Uint8Array(derived);
}

// VAPID JWT（署名付きトークン）を生成する
// 秘密鍵はweb-push等で生成される「生32バイトのbase64url」形式を想定し、
// 公開鍵からx/yを取り出してJWK形式で読み込む（旧実装のpkcs8読み込みは
// 形式不一致で例外になり、全送信が失敗していた）
async function createVapidJwt(
  endpoint: string,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
): Promise<string> {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp: expiration, sub: vapidSubject };

  const headerB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const publicKeyBytes = b64urlDecode(vapidPublicKey);
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) {
    throw new Error("VAPID公開鍵の形式が不正です（65バイトの非圧縮ポイントではない）");
  }
  const x = b64urlEncode(publicKeyBytes.slice(1, 33));
  const y = b64urlEncode(publicKeyBytes.slice(33, 65));

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: vapidPrivateKey, x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlEncode(sigBytes)}`;
}

// RFC 8291 (aes128gcm) でペイロードを暗号化してプッシュ通知を送信する
// （旧実装のaesgcm方式はApple(iPhone)のプッシュサーバーが受け付けない）
async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url?: string; tag?: string },
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
): Promise<Response> {
  const { endpoint, p256dh, auth } = subscription;

  const jwt = await createVapidJwt(endpoint, vapidPrivateKey, vapidPublicKey, vapidSubject);

  const recipientPublicKeyBytes = b64urlDecode(p256dh);
  const authBytes = b64urlDecode(auth);

  // 送信側のECDH鍵ペアを生成し、受信者公開鍵と共有シークレットを導出
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const recipientKey = await crypto.subtle.importKey(
    "raw",
    recipientPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipientKey },
      serverKeyPair.privateKey,
      256
    )
  );
  const serverPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeyPair.publicKey)
  );

  // RFC 8291: IKM = HKDF(salt=auth, ikm=ecdh_secret, info="WebPush: info"||0x00||ua_pub||as_pub)
  const keyInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...recipientPublicKeyBytes,
    ...serverPublicKeyRaw,
  ]);
  const ikm = await hkdf(authBytes, sharedSecret, keyInfo, 256);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    128
  );
  const nonce = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: nonce\0"),
    96
  );

  const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);

  // 末尾に0x02（最終レコードの区切りバイト）を付けて暗号化
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const padded = new Uint8Array([...payloadBytes, 2]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, padded)
  );

  // aes128gcmのボディヘッダー: salt(16) + recordSize(4) + keyIdLen(1) + serverPublicKey(65)
  const recordSize = 4096;
  const body = new Uint8Array(16 + 4 + 1 + 65 + encrypted.length);
  body.set(salt, 0);
  new DataView(body.buffer).setUint32(16, recordSize);
  body[20] = 65;
  body.set(serverPublicKeyRaw, 21);
  body.set(encrypted, 86);

  return await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
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

    let sent = 0;
    const errors: string[] = [];
    const expiredEndpoints: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        errors.push(`endpoint[${i}]: ${String(r.reason)}`);
        continue;
      }
      const res = r.value as Response;
      if (res.ok) {
        sent++;
      } else {
        const text = await res.text().catch(() => "");
        errors.push(`endpoint[${i}]: HTTP ${res.status} ${text.slice(0, 200)}`);
        // 購読期限切れ・無効はDBから削除
        if (res.status === 404 || res.status === 410) {
          expiredEndpoints.push(subscriptions[i].endpoint);
        }
      }
    }

    if (expiredEndpoints.length > 0) {
      await supabase
        .from("push_subscriptions")
        .delete()
        .in("endpoint", expiredEndpoints);
    }

    console.log(`[send-push] sent=${sent} failed=${errors.length}`, errors);

    return new Response(
      JSON.stringify({ sent, failed: errors.length, errors, removed: expiredEndpoints.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
