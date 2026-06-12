// 受理済み休暇申請を一括でGoogleカレンダーに同期する（一回限り）
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xaeynaxctiiyqxjyuzfi.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.argv[2]

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('使い方: node backfill-gcal.mjs <SERVICE_ROLE_KEY>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const { data: requests, error } = await supabase
  .from('leave_requests')
  .select('id, user_id, leave_type, leave_type_other, leave_dates')
  .eq('status', 'approved')

// 名前を別途取得
const userIds = [...new Set(requests?.map(r => r.user_id) ?? [])]
const { data: profilesData } = await supabase
  .from('profiles')
  .select('id, name')
  .in('id', userIds)
const nameMap = Object.fromEntries((profilesData ?? []).map(p => [p.id, p.name]))

if (error) { console.error('取得失敗:', error); process.exit(1) }

console.log(`受理済み申請: ${requests.length}件`)

let ok = 0, skip = 0, fail = 0

for (const req of requests) {
  const dates = (() => { try { return JSON.parse(req.leave_dates ?? '[]') } catch { return [] } })()
  if (dates.length === 0) { console.log(`SKIP ${req.id} (日付なし)`); skip++; continue }

  const name = nameMap[req.user_id] ?? ''
  const leave_type = req.leave_type ?? 'その他'

  const payload = { action: 'upsert', source_type: 'leave', source_id: req.id, dates, name, leave_type }
  console.log(`送信:`, JSON.stringify(payload))
  const res = await fetch(`${SUPABASE_URL}/functions/v1/gcal-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (data.success) {
    console.log(`OK  ${req.id} ${name}｜${leave_type} [${dates.join(', ')}] colorId=${data.colorId}`)
    ok++
  } else {
    console.log(`NG  ${req.id} ${name}｜${leave_type} → ${data.error}`)
    fail++
  }
}

console.log(`\n完了: OK=${ok} SKIP=${skip} NG=${fail}`)
