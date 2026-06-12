// 既存の欠勤・遅刻・早退データを一括でGoogleカレンダーに同期（一回限り）
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xaeynaxctiiyqxjyuzfi.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.argv[2]

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('使い方: node backfill-gcal-absence.mjs <SERVICE_ROLE_KEY>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const { data: records, error } = await supabase
  .from('attendance_exceptions')
  .select('id, user_id, date, type, actual_time')
  .order('date', { ascending: true })

if (error) { console.error('取得失敗:', error); process.exit(1) }

const userIds = [...new Set(records.map(r => r.user_id))]
const { data: profilesData } = await supabase.from('profiles').select('id, name').in('id', userIds)
const nameMap = Object.fromEntries((profilesData ?? []).map(p => [p.id, p.name]))

console.log(`欠勤記録: ${records.length}件`)

let ok = 0, fail = 0

for (const rec of records) {
  const name = nameMap[rec.user_id] ?? ''
  const payload = {
    action: 'upsert',
    source_type: 'absence',
    source_id: rec.id,
    dates: [rec.date],
    name,
    absence_type: rec.type,
    time: rec.actual_time ?? undefined,
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/gcal-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (data.success) {
    console.log(`OK  ${rec.date} ${name}｜${rec.type}${rec.actual_time ? ' ' + rec.actual_time : ''} colorId=${data.colorId}`)
    ok++
  } else {
    console.log(`NG  ${rec.date} ${name}｜${rec.type} → ${data.error}`)
    fail++
  }
}

console.log(`\n完了: OK=${ok} NG=${fail}`)
