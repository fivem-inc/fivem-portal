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

/** 表示用の時刻。先頭の0は付けない（例: 06:30 → 6:30） */
function hm(t: unknown): string {
  return String(t ?? '').slice(0, 5).replace(/^0/, '')
}

// 勤怠の時間帯（[{start,end,location}]）→ '9:00〜12:00［四条本校］/ 14:00〜18:00［洛西口校］'
// client/src/lib/attendanceTypes.ts の formatSegments と同じ書式（両方直すこと）
function formatWorkSegments(segments: unknown): string {
  if (!Array.isArray(segments)) return ''
  return segments
    .filter((s) => s && typeof s === 'object' && s.start && s.end)
    .map((s) => `${hm(s.start)}〜${hm(s.end)}${s.location ? `［${s.location}］` : ''}`)
    .join(' / ')
}

// 欠勤種別 → タイトル生成・色
function buildAbsenceTitle(type: string, name: string, time?: string, segments?: unknown): string {
  switch (type) {
    case 'absent':      return `${name}｜休み`
    case 'late':        return `${name}｜遅刻｜${hm(time)}〜`
    case 'late_start':  return `${name}｜遅出(調整)｜${hm(time)}〜`
    case 'early_leave': return `${name}｜早退｜〜${hm(time)}`
    case 'early_end':   return `${name}｜早退(調整)｜〜${hm(time)}`
    case 'holiday_work': {
      // 例: 椿原 凜大｜休日出勤｜09:00〜12:00［四条本校］/ 14:00〜18:00［洛西口校］
      const segLabel = formatWorkSegments(segments)
      return segLabel ? `${name}｜休日出勤｜${segLabel}` : `${name}｜休日出勤`
    }
    // 勤務地変更は「どこに・いつ行くか」が分かればよいので、変更前の校は出さない。
    // 校が変わると勤務時間も変わるため、時間帯があれば一緒に出す。
    // 例: 椿原 凜大｜勤務地変更｜09:00〜18:00［洛西口校］
    case 'location_change': {
      const segLabel = formatWorkSegments(segments)
      return segLabel ? `${name}｜勤務地変更｜${segLabel}` : `${name}｜勤務地変更`
    }
    // 勤務時間変更は校が普段どおりで、変わるのは時間だけ。校は時間帯ごとの［校］に含まれる
    // 例: 椿原 凜大｜勤務時間変更｜12:45〜16:50［四条本校］
    case 'time_change': {
      const segLabel = formatWorkSegments(segments)
      return segLabel ? `${name}｜勤務時間変更｜${segLabel}` : `${name}｜勤務時間変更`
    }
    default:            return `${name}｜欠勤`
  }
}

// 残業ページと色を揃える：休日出勤=濃緑(10)・勤務地変更=紫(3)・勤務時間変更=グラファイト(8)。
// 遅刻・早退系は調整色(2)、その他は休み色(4)。
function absenceColorId(type: string): string {
  if (type === 'holiday_work') return '10'
  if (type === 'location_change') return '3'
  if (type === 'time_change') return '8'
  return ['late', 'late_start', 'early_leave', 'early_end'].includes(type) ? '2' : '4'
}

// 休日出勤・勤務地変更・勤務時間変更はタイトルに時間帯ごとの［校］を埋め込むため、末尾への［校］後付けをしない
// （時間帯が無い古いデータのみ、呼び出し側の locations から末尾に付ける）
function skipLocationSuffix(type: string, segments?: unknown): boolean {
  if (!['holiday_work', 'location_change', 'time_change'].includes(type)) return false
  return Array.isArray(segments) && segments.length > 0
}

// 残業種別 → ラベル・色・同期可否・優先度（source_type='overtime' 用）
// sync=false の種別（打刻ズレ）はカレンダーに出さない。
// 色: 残業/早出=9(濃青)・休日出勤=10(濃緑)・勤務地変更=3(紫)・調整系=2(既存の調整色)
// sync         … そもそもカレンダーに出せる種別か
// defaultShare … overtime_reports.show_on_calendar が null（本人が選んでいない）ときに出すか
//                遅刻・早退だけ false。これまで出していなかったので、
//                チェック欄を使わない人の見え方を変えないため。
// 🚨 同じ表が client/src/lib/overtimeTypes.ts の OT_CALENDAR にもある（2箇所管理）。
//    片方だけ直すと「アプリでは載る予定なのにカレンダーに出ない」という食い違いになる。
const OVERTIME_TYPES: Record<string, { label: string; colorId: string; sync: boolean; defaultShare: boolean; priority: number }> = {
  holiday_work:    { label: '休日出勤',    colorId: '10', sync: true,  defaultShare: true,  priority: 1 },
  overtime:        { label: '残業',        colorId: '9',  sync: true,  defaultShare: true,  priority: 2 },
  early_start:     { label: '早出',        colorId: '9',  sync: true,  defaultShare: true,  priority: 3 },
  late_start_adj:  { label: '遅出(調整)',  colorId: '2',  sync: true,  defaultShare: true,  priority: 4 },
  early_end_adj:   { label: '早退(調整)',  colorId: '2',  sync: true,  defaultShare: true,  priority: 5 },
  location_change: { label: '勤務地変更',  colorId: '3',  sync: true,  defaultShare: true,  priority: 6 },
  // 事前に分かっている遅刻・早退は本人が選べば出せる（既定では出さない）
  tardiness:       { label: '遅刻',        colorId: '2',  sync: true,  defaultShare: false, priority: 7 },
  early_leave:     { label: '早退',        colorId: '2',  sync: true,  defaultShare: false, priority: 8 },
  // 終日種別（単独付与・時刻なしタイトル）。現状の休暇/欠勤の見た目を維持: 調整休=「調整休」・欠勤=「休み」・colorId 4
  chosei_off:      { label: '調整休',      colorId: '4',  sync: true,  defaultShare: true,  priority: 9 },
  furikae_off:     { label: '振休',        colorId: '4',  sync: true,  defaultShare: true,  priority: 10 },
  absence:         { label: '休み',        colorId: '4',  sync: true,  defaultShare: true,  priority: 11 },
  // 打刻ズレ（打刻が遅れただけ・残業なし）。労働時間は通常どおりなので
  // カレンダーには出さない（出すと「何もなかった日」でカレンダーが埋まる）
  clock_only:      { label: '打刻ズレ',    colorId: '',   sync: false, defaultShare: false, priority: 12 },
}

// 終日種別は事後報告でもカレンダーに出す（「誰が休んだか」は事後でも周知価値があるため）
const OVERTIME_FULL_DAY = ['chosei_off', 'furikae_off', 'absence']

/** 分 → "HH:MM"（1440以上は翌日表記） */
function otMinToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  const hh = String(Math.floor(m / 60)).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  return min >= 1440 ? `翌${hh}:${mm}` : `${hh}:${mm}`
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
  // 404/410 は「もう存在しない」＝目的は達成できているので成功として扱う。
  // 人がGoogleカレンダー側で手作業で消したイベントは404を返し、以前はここで例外になって
  // アプリ側の削除・取消が丸ごと失敗していた
  if (!res.ok && res.status !== 404 && res.status !== 410) {
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

    // 認可ゲート：サービスキー（overtime-approve等のサーバー間呼び出し）か、
    // ログイン済みの本物のユーザーのみ許可。未ログイン・公開anonキーだけの直接呼び出しは 401 で拒否。
    // （config.toml の verify_jwt=true でも公開anonキーは通るため、ここで role を確認する二重の守り）
    const authToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    let authorized = !!authToken && authToken === supabaseKey
    if (!authorized && authToken) {
      const { data: { user } } = await supabase.auth.getUser(authToken)
      authorized = !!user
    }
    if (!authorized) {
      return new Response(
        JSON.stringify({ success: false, error: 'unauthorized' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

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
    const { action, source_type, source_id, dates, name, leave_type, absence_type, time, locations, work_segments } = body
    // タイトル用の名前は姓名間の全角スペースを半角に正規化（DBのprofiles.nameは変更しない）
    const normName = String(name ?? '').replace(/　/g, ' ')
    // locations: 日付→校 の対応表（省略可。無ければ従来どおり校なしタイトル）
    const locationByDate = (locations ?? {}) as Record<string, string>

    // action: 'sync'（source_type='overtime'）— overtime_reports の現在状態から同期先を再計算する冪等処理。
    // 受理/自己受理/実績報告/取消/差戻し/管理者修正/削除、どこから呼んでも「あるべき状態」に揃える。
    if (action === 'sync' && source_type === 'overtime') {
      const { data: report } = await supabase
        .from('overtime_reports')
        .select('id, applicant_id, work_date, entry_type, is_post_hoc, status, location, application_types, show_on_calendar, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
        .eq('id', source_id)
        .maybeSingle()

      // 同期対象になる条件：手動行・申請済み（申請中/事前確定/実績確認待ち/実績確定）・同期可の種別が1つ以上。
      // 事後報告は原則出さないが、終日種別（調整休・振替・欠勤）だけは事後でも出す。
      // ※reported を含めるのは、事前受理でカレンダーに出た予定が実績報告の瞬間に消えるのを防ぐため
      // ※requested（未受理）を含めるのは、上長の受理が遅れても予定が共有されるようにするため（2026-08-25）。
      //   未受理と分かるようタイトル先頭に【申請中】を付け、色もグレーにする。
      //   差し戻し・取消は shouldExist=false になり自動で消える。
      // 🚨 終日（欠勤・調整休・振替休日）も申請中から出す（ユーザー判断・2026-08-25）。
      //   レビューでは「却下されたらシフトに穴が空く」ため除外を勧められたが、
      //   実務では欠勤の申請が却下されることはほぼ無く、
      //   逆に受理を忘れられて「休むのに誰も知らない」ほうが事故る、という判断。
      //   除外したくなったら shouldExist の requested 許可に !otIsFullDay を足す
      const syncTypes: string[] = (report?.application_types ?? [])
        .filter((t: string) => OVERTIME_TYPES[t]?.sync)
        .sort((a: string, b: string) => OVERTIME_TYPES[a].priority - OVERTIME_TYPES[b].priority)
      const otIsFullDay = (report?.application_types ?? []).some((t: string) => OVERTIME_FULL_DAY.includes(t))

      // 本人が選んだ掲載可否。null は「選んでいない」＝これまでどおりの動き。
      //   遅刻・早退は defaultShare=false なので、選ばれない限り出さない（従来と同じ）。
      //   終日種別は選ばせず必ず出す（その日いないことは他の人のシフトに関わるため）。
      const otDefaultShare = syncTypes.some((t: string) => OVERTIME_TYPES[t]?.defaultShare)
      const otShare = otIsFullDay || (report?.show_on_calendar ?? otDefaultShare)

      const shouldExist = !!report
        && report.entry_type === 'manual'
        && ['requested', 'request_confirmed', 'reported', 'confirmed'].includes(report.status)
        && (!report.is_post_hoc || otIsFullDay)
        && syncTypes.length > 0
        && otShare

      const { data: existing } = await supabase
        .from('gcal_events')
        .select('id, event_id, date')
        .eq('source_type', 'overtime')
        .eq('source_id', source_id)

      if (!shouldExist) {
        for (const row of existing ?? []) await deleteEvent(token, calendarId, row.event_id)
        await supabase.from('gcal_events').delete().eq('source_type', 'overtime').eq('source_id', source_id)
        return new Response(JSON.stringify({ success: true, synced: false }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
      }

      // タイトル生成：名前｜種別(最大2つ)｜時刻［校］。実績があれば実績、なければ予定の時間帯を使う。
      const { data: prof } = await supabase.from('profiles').select('name').eq('id', report.applicant_id).maybeSingle()
      const otName = String(prof?.name ?? '').replace(/　/g, ' ')
      const segs = (report.segments ?? []) as { phase: string; seg_no: number; start_min: number; end_min: number }[]
      const actual = segs.filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no)
      const planned = segs.filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no)
      const use = actual.length > 0 ? actual : planned
      const firstStart = use.length > 0 ? use[0].start_min : null
      const lastEnd = use.length > 0 ? use[use.length - 1].end_min : null

      const labels = syncTypes.slice(0, 2).map(t => OVERTIME_TYPES[t].label).join('＋')
      const primary = syncTypes[0]
      let timeStr = ''
      if (firstStart != null && lastEnd != null) {
        if (syncTypes.length >= 2 || primary === 'holiday_work') timeStr = `${otMinToTime(firstStart)}〜${otMinToTime(lastEnd)}`
        // 終わりの時刻が大事なもの（残業・早退）は「〜18:00」
        else if (primary === 'overtime' || primary === 'early_end_adj' || primary === 'early_leave') timeStr = `〜${otMinToTime(lastEnd)}`
        // 始まりの時刻が大事なもの（早出・遅出・遅刻）は「13:00〜」
        else if (primary === 'early_start' || primary === 'late_start_adj' || primary === 'tardiness') timeStr = `${otMinToTime(firstStart)}〜`
      }
      // 🚨 未受理は先頭に【申請中】を付ける。受理されると消える（受理時に再同期されるため）。
      //    先頭に置くのは、Googleカレンダーの月表示は幅が狭く後半が「…」で切れるため。
      //    末尾や種別の後ろに付けると、肝心の「申請中」が見えない
      let summary = `${report.status === 'requested' ? '【申請中】' : ''}${otName}｜${labels}`
      if (timeStr && primary !== 'location_change') summary += `｜${timeStr}`
      if (report.location) summary += `［${report.location}］`
      // 🚨 申請中はグレー（colorId 8 = Graphite）で統一する。
      //    タイトルの【申請中】だけだと、他の予定に紛れて見落とされるため色でも区別する。
      //    受理されると本来の色（残業=濃青9 / 休日出勤=濃緑10 など）に戻る（受理時に再同期される）
      const otColorId = report.status === 'requested' ? '8' : OVERTIME_TYPES[primary].colorId

      // 日付が変わった場合の旧イベントを掃除しつつ、work_date に1件だけ立てる（色反映のため削除→再作成）
      for (const row of existing ?? []) {
        await deleteEvent(token, calendarId, row.event_id)
        await supabase.from('gcal_events').delete().eq('id', row.id)
      }
      const newEventId = await createEvent(token, calendarId, summary, report.work_date, otColorId)
      await supabase.from('gcal_events').insert({
        source_type: 'overtime',
        source_id,
        calendar_id: calendarId,
        event_id: newEventId,
        date: report.work_date,
      })

      return new Response(JSON.stringify({ success: true, synced: true, summary }),
        { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
    }

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
        : buildAbsenceTitle(absence_type, normName, time, work_segments)

    const colorId =
      source_type === 'leave'
        ? (LEAVE_CONFIG[leave_type]?.colorId ?? '11')
        : absenceColorId(absence_type)

    for (const date of dates as string[]) {
      // 校が指定されている日は末尾に［校名］を付ける（例：椿原 凜大｜休み［四条本校］）
      // 休日出勤は時間帯ごとに［校］がタイトルへ入っているので後付けしない
      const loc = locationByDate[date]
      const summary = (loc && !(source_type !== 'leave' && skipLocationSuffix(absence_type, work_segments)))
        ? `${baseSummary}［${loc}］`
        : baseSummary
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
