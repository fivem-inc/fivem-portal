import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 休暇種別 → タイトル・色
const LEAVE_CONFIG: Record<string, { label: string; colorId: string }> = {
  '有給休暇':           { label: '有給',  colorId: '4' }, // Flamingo（ピンク）
  'バースデー休暇（有給）': { label: '有給',  colorId: '4' },
  '慶弔休暇':           { label: '休み',  colorId: '4' },
  '調整休':             { label: '調整休', colorId: '4' },
  'その他':             { label: '休み',  colorId: '4' },
}

// 欠勤種別 → タイトル生成・色
function buildAbsenceTitle(type: string, name: string, time?: string): string {
  switch (type) {
    case 'absent':      return `${name}｜休み`
    case 'late':        return `${name}｜遅刻｜${time}〜`
    case 'late_start':  return `${name}｜遅出(調整)｜${time}〜`
    case 'early_leave': return `${name}｜早退｜〜${time}`
    case 'early_end':   return `${name}｜早退(調整)｜〜${time}`
    default:            return `${name}｜欠勤`
  }
}

function absenceColorId(type: string): string {
  return ['late', 'late_start', 'early_leave', 'early_end'].includes(type) ? '2' : '4'
}

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson)
  const now = Math.floor(Date.now() / 1000)

  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const signingInput = `${encode(header)}.${encode(payload)}`

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const binaryKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const jwt = `${signingInput}.${signatureB64}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    throw new Error(`トークン取得失敗: ${JSON.stringify(tokenData)}`)
  }
  return tokenData.access_token
}

async function createEvent(
  token: string,
  calendarId: string,
  summary: string,
  date: string,
  colorId: string
): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        start: { date },
        end: { date: nextDay(date) },
        colorId: colorId,
      }),
    }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(`イベント作成失敗: ${JSON.stringify(data)}`)
  return data.id
}

async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  summary: string,
  date: string,
  colorId: string
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        start: { date },
        end: { date: nextDay(date) },
        colorId: colorId,
      }),
    }
  )
  if (!res.ok) {
    const data = await res.json()
    throw new Error(`イベント更新失敗: ${JSON.stringify(data)}`)
  }
}

async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok && res.status !== 410) {
    throw new Error(`イベント削除失敗: status=${res.status}`)
  }
}

function nextDay(date: string): string {
  const d = new Date(date)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const serviceAccountJson = Deno.env.get('GCAL_SERVICE_ACCOUNT_JSON')!
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 書き込み先カレンダーを app_settings のモードで切り替える（管理画面のワンクリックトグル）。
    // mode='production' → GCAL_CALENDAR_ID_PROD（本番）、それ以外/未設定/失敗時 → GCAL_CALENDAR_ID（テスト・現行維持）。
    let calendarId = Deno.env.get('GCAL_CALENDAR_ID')!
    try {
      const { data: modeRow } = await supabase
        .from('app_settings').select('value').eq('key', 'gcal_calendar_mode').maybeSingle()
      const mode = (modeRow?.value as { mode?: string } | null)?.mode
      if (mode === 'production') calendarId = Deno.env.get('GCAL_CALENDAR_ID_PROD') ?? calendarId
    } catch (e) {
      console.error('[gcal-sync] カレンダーモード取得失敗、テストカレンダーを使用:', e)
    }

    const token = await getAccessToken(serviceAccountJson)

    const body = await req.json()
    const { action, source_type, source_id, dates, name, leave_type, absence_type, time, locations } = body
    // タイトル用の名前は姓名間の全角スペースを半角に正規化（DBのprofiles.nameは変更しない）
    const normName = String(name ?? '').replace(/　/g, ' ')
    // locations: 日付→校 の対応表（省略可。無ければ従来どおり校なしタイトル）
    const locationByDate = (locations ?? {}) as Record<string, string>

    // action: 'upsert' | 'delete'
    if (action === 'delete') {
      // 既存イベントをすべて削除
      const { data: existing } = await supabase
        .from('gcal_events')
        .select('event_id')
        .eq('source_type', source_type)
        .eq('source_id', source_id)

      for (const row of existing ?? []) {
        await deleteEvent(token, calendarId, row.event_id)
      }

      await supabase
        .from('gcal_events')
        .delete()
        .eq('source_type', source_type)
        .eq('source_id', source_id)

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // action: 'upsert' — 日付ごとにイベントを作成or更新
    const baseSummary =
      source_type === 'leave'
        ? `${normName}｜${LEAVE_CONFIG[leave_type]?.label ?? '休み'}`
        : buildAbsenceTitle(absence_type, normName, time)

    const colorId =
      source_type === 'leave'
        ? (LEAVE_CONFIG[leave_type]?.colorId ?? '11')
        : absenceColorId(absence_type)

    for (const date of dates as string[]) {
      // 校が指定されている日は末尾に［校名］を付ける（例：椿原 凜大｜休み［四条本校］）
      const loc = locationByDate[date]
      const summary = loc ? `${baseSummary}［${loc}］` : baseSummary
      const { data: existing } = await supabase
        .from('gcal_events')
        .select('id, event_id')
        .eq('source_type', source_type)
        .eq('source_id', source_id)
        .eq('date', date)
        .maybeSingle()

      if (existing) {
        // PUTではcolorIdが反映されないケースがあるため削除→再作成
        await deleteEvent(token, calendarId, existing.event_id)
        const newEventId = await createEvent(token, calendarId, summary, date, colorId)
        await supabase
          .from('gcal_events')
          .update({ event_id: newEventId, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
      } else {
        const eventId = await createEvent(token, calendarId, summary, date, colorId)
        await supabase.from('gcal_events').insert({
          source_type,
          source_id,
          calendar_id: calendarId,
          event_id: eventId,
          date,
        })
      }
    }

    return new Response(
      JSON.stringify({ success: true, colorId }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
