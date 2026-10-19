import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import { fetchGcalMode, type GcalMode } from '../../lib/gcalCalendarConfig';
import { ENC_REASON_MARK } from '../../lib/encouragementDay';
import { toJstDateStr } from '../../lib/breakCalc';
import { backBtn, primaryBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import SaveBar, { SaveNotice, type SaveMsg } from './SaveBar';
import {
  ENC_CAL_DEFAULT, ENC_CAL_KEY, ENC_CAL_TYPES, normalizeEncCalendarSetting, syncEncouragementCalendar,
  type EncCalendarMode, type EncCalendarSetting, type EncCalendarType,
} from '../../lib/gcalEncouragement';

// 有休奨励日の休みを Google カレンダーにどう出すか（2026-10-19 ユーザー確定・計画 docs/計画-有休奨励日のカレンダー.md）
// ・出し方（出さない／まとめて1件／1人ずつ）・出す休み（有休・調整休・その他）・名前（まとめて1件のときだけ）
// ・［変更する］→ 選ぶ →［保存］。保存したら、これからの奨励日の予定をその場で作り直す（gcal-sync の sync_encouragement）
// ・「見え方」は次の奨励日の実際の人数で、選んだ内容ですぐ変わる
// 🚨 まとめの本文の形は supabase/functions/gcal-sync/encouragement.ts の encDescription と同じ（両方直す）
// 🚨 絵文字は使わない（計画のレビューで確定）

const MODE_OPTIONS: { value: EncCalendarMode; label: string; sub: string }[] = [
  { value: 'off', label: '出さない', sub: 'Google カレンダーには出しません（勤怠カレンダーには出ます）' },
  { value: 'summary', label: 'まとめて1件', sub: 'その日に予定を1つ作り、中に名前を並べます' },
  { value: 'each', label: '1人ずつ', sub: 'ふだんの休暇と同じ形（「名前｜有休」）で1人1件' },
];
const TYPE_SUB: Record<EncCalendarType, string> = { '有休': '回答「有休」', '調整休': '回答「調整休」', 'その他': '回答「定休日」「その他（休む）」' };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const fmtMdDow = (d: string) => { const x = new Date(d + 'T00:00:00Z'); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}（${DOW[x.getUTCDay()]}）`; };
const encTypeOf = (leaveType: string): EncCalendarType =>
  leaveType === '有給休暇' || leaveType === 'バースデー休暇（有給）' ? '有休' : leaveType === '調整休' ? '調整休' : 'その他';
const eachLabel = (t: EncCalendarType) => (t === 'その他' ? '休み' : t);

interface NextDay { date: string; people: { name: string; type: EncCalendarType }[] }

/** まとめの本文（gcal-sync の encDescription と同じ形） */
function summaryText(next: NextDay, s: EncCalendarSetting): { text: string; total: number } {
  const lines: string[] = [];
  let total = 0;
  for (const t of ENC_CAL_TYPES) {
    if (!s.types.includes(t)) continue;
    const names = next.people.filter(p => p.type === t).map(p => p.name).sort((a, b) => a.localeCompare(b, 'ja'));
    if (names.length === 0) continue;
    total += names.length;
    lines.push(`【${t} ${names.length}人】`);
    if (s.names) lines.push(names.join('、'));
  }
  if (total === 0) return { text: '', total: 0 };
  lines.push('', `合計 ${total}人`);
  return { text: lines.join('\n'), total };
}

function describe(s: EncCalendarSetting): string[] {
  const out = [`出し方：${MODE_OPTIONS.find(o => o.value === s.mode)?.label}`];
  if (s.mode !== 'off') out.push(`出す休み：${s.types.join('・') || 'なし'}`);
  if (s.mode === 'summary') out.push(`名前：${s.names ? '出す' : '出さない（人数だけ）'}`);
  return out;
}

const GcalEncouragementSection: React.FC = () => {
  const { isDarkMode: isDark } = useAdminPanel();
  const [saved, setSaved] = useState<EncCalendarSetting | null>(null);
  const [draft, setDraft] = useState<EncCalendarSetting>(ENC_CAL_DEFAULT);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<SaveMsg | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [gcalMode, setGcalMode] = useState<GcalMode | null>(null);
  const [next, setNext] = useState<NextDay | null | undefined>(undefined);

  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#333';
  const sub = isDark ? '#adb5bd' : '#666';
  const border = isDark ? '#6c757d' : '#ddd';

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', ENC_CAL_KEY).maybeSingle();
    setSaved(error ? ENC_CAL_DEFAULT : normalizeEncCalendarSetting(data?.value));
    fetchGcalMode().then(setGcalMode);
    // 次の奨励日と、その日に休む人（受理済みの奨励日の休暇）
    const today = toJstDateStr(new Date());
    const { data: day } = await supabase.from('paid_leave_encouragement_days').select('target_date')
      .gte('target_date', today).order('target_date', { ascending: true }).limit(1).maybeSingle();
    if (!day?.target_date) { setNext(null); return; }
    const { data: lv } = await supabase.from('leave_requests').select('user_id, leave_type')
      .eq('reason', ENC_REASON_MARK).eq('status', 'approved').eq('start_date', day.target_date);
    const rows = (lv ?? []) as { user_id: string; leave_type: string }[];
    const ids = [...new Set(rows.map(r => r.user_id))];
    const nameOf = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
      for (const p of (profs ?? []) as { id: string; name: string }[]) nameOf.set(p.id, String(p.name ?? '').replace(/\u3000/g, ' ').trim());
    }
    setNext({ date: day.target_date, people: rows.map(r => ({ name: nameOf.get(r.user_id) ?? '', type: encTypeOf(r.leave_type) })) });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cur = editing ? draft : (saved ?? ENC_CAL_DEFAULT);
  const changes = useMemo(() => {
    if (!saved) return [];
    const a = describe(saved), b = describe(draft);
    return b.filter(x => !a.includes(x)).map(x => {
      const key = x.split('：')[0];
      const before = a.find(y => y.startsWith(key + '：'));
      return before ? `${before} → ${x.split('：')[1]}` : x;
    });
  }, [saved, draft]);

  const runSync = async () => {
    setSaving(true); setRetryable(false);
    const r = await syncEncouragementCalendar();
    setSaving(false);
    if (!r.ok) {
      setMsg({ fail: true, text: `設定は保存しましたが、Google カレンダーの予定を作り直せませんでした（${r.error ?? ''}）。今夜の作り直しでそろいます。今すぐそろえるときは［もう一度作り直す］を押してください。` });
      setRetryable(true);
      return;
    }
    setMsg({ fail: false, text: `保存しました。Google カレンダーの予定を作り直しました（${r.days}日分：作成 ${r.created}件・更新 ${r.updated}件・削除 ${r.deleted}件）。` });
  };

  const onSave = async () => {
    if (draft.mode !== 'off' && draft.types.length === 0) { setMsg({ fail: true, text: '出す休みを1つ以上選んでください。' }); return; }
    setSaving(true); setMsg(null);
    const { data, error } = await supabase.from('app_settings')
      .upsert({ key: ENC_CAL_KEY, value: draft, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select('key');
    if (error || !data || data.length === 0) {
      setSaving(false);
      setMsg({ fail: true, text: `保存できませんでした：${error?.message ?? '権限を確かめてください'}` });
      return;
    }
    setSaved(draft); setEditing(false);
    await runSync();
  };

  const nextCount = next ? summaryText(next, { ...cur, types: cur.types, names: true }).total : 0;
  const warn = next && saved
    ? `いまの連携先（${gcalMode === 'production' ? '本番' : 'テスト'}）で、${fmtMdDow(next.date)}（${nextCount}人）など、これからの奨励日の予定を作り直します。過去の日は変わりません。`
    : 'これからの奨励日の予定を作り直します。過去の日は変わりません。';

  const choiceBtn = (active: boolean, disabled: boolean): React.CSSProperties => ({
    textAlign: 'left', padding: '8px 12px', borderRadius: 10, fontSize: 13,
    border: `1.5px solid ${active ? TOGGLE_BLUE : border}`,
    background: active ? TOGGLE_BLUE : 'none', color: active ? '#fff' : text,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled && !active ? 0.45 : disabled ? 0.6 : 1,
  });
  const setD = (patch: Partial<EncCalendarSetting>) => setDraft(d => ({ ...d, ...patch }));
  const typesDisabled = !editing || cur.mode === 'off';
  const namesDisabled = !editing || cur.mode !== 'summary';

  // 見え方
  let preview: React.ReactNode;
  if (next === undefined) preview = <span style={{ color: sub }}>読み込み中…</span>;
  else if (next === null) preview = <span style={{ color: sub }}>これからの奨励日はありません。</span>;
  else if (cur.mode === 'off') preview = <span style={{ color: sub }}>{fmtMdDow(next.date)}：Google カレンダーには出しません。</span>;
  else if (cur.mode === 'summary') {
    const s = summaryText(next, cur);
    preview = s.total === 0
      ? <span style={{ color: sub }}>{fmtMdDow(next.date)}：出す休みの人がいないので、予定は作りません。</span>
      : (<>
        <div style={{ color: sub, marginBottom: 4 }}>{fmtMdDow(next.date)}（終日）</div>
        <div style={{ fontWeight: 700 }}>有休奨励日</div>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.text}</div>
      </>);
  } else {
    const list = next.people.filter(p => cur.types.includes(p.type)).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    preview = list.length === 0
      ? <span style={{ color: sub }}>{fmtMdDow(next.date)}：出す休みの人がいないので、予定は作りません。</span>
      : (<>
        <div style={{ color: sub, marginBottom: 4 }}>{fmtMdDow(next.date)}（終日）・{list.length}件</div>
        {list.slice(0, 5).map((p, i) => <div key={i}>{p.name}｜{eachLabel(p.type)}</div>)}
        {list.length > 5 && <div style={{ color: sub }}>ほか {list.length - 5}件</div>}
      </>);
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        background: '#E3F2FD', borderLeft: '3px solid #1565C0', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#0D47A1', marginBottom: 8,
      }}>
        有休奨励日の休みの出し方（Google カレンダー）
      </div>
      <div style={{ background: bg, border: `0.5px solid ${border}`, borderRadius: 12, padding: '14px 16px', color: text }}>
        <div style={{ fontSize: 12, color: sub, lineHeight: 1.7, marginBottom: 12 }}>
          有休奨励日に回答して休む方を、Google カレンダーにどう出すかを決めます。ふだんの休暇（奨励日の回答でない休暇）は今までどおり1人ずつ出ます。<br />
          回答・修正のたびにその日の予定を作り直し、毎晩もう一度そろえます。
        </div>

        {saved === null ? <div style={{ fontSize: 12, color: sub }}>読み込み中…</div> : (<>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>出し方</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {MODE_OPTIONS.map(o => {
              const active = cur.mode === o.value;
              return (
                <button key={o.value} type="button" disabled={!editing} onClick={() => setD({ mode: o.value })} style={choiceBtn(active, !editing)}>
                  <div style={{ fontWeight: 700 }}>{active ? '● ' : ''}{o.label}</div>
                  <div style={{ fontSize: 11.5, opacity: 0.9, marginTop: 2 }}>{o.sub}</div>
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, opacity: cur.mode === 'off' ? 0.45 : 1 }}>出す休み</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
            {ENC_CAL_TYPES.map(t => {
              const active = cur.types.includes(t);
              return (
                <button key={t} type="button" disabled={typesDisabled}
                  onClick={() => setD({ types: active ? draft.types.filter(x => x !== t) : ENC_CAL_TYPES.filter(x => x === t || draft.types.includes(x)) })}
                  style={{ ...choiceBtn(active, typesDisabled), minWidth: 120 }}>
                  <div style={{ fontWeight: 700 }}>{active ? '✓ ' : ''}{t}</div>
                  <div style={{ fontSize: 11, opacity: 0.9 }}>{TYPE_SUB[t]}</div>
                </button>
              );
            })}
          </div>
          {editing && cur.mode !== 'off' && cur.types.length === 0 && (
            <div style={{ fontSize: 12, color: '#dc3545', marginBottom: 4 }}>出す休みを1つ以上選んでください（このままでは保存できません）。</div>
          )}

          <div style={{ fontSize: 13, fontWeight: 700, margin: '10px 0 6px', opacity: cur.mode === 'summary' ? 1 : 0.45 }}>
            名前<span style={{ fontSize: 11, fontWeight: 400, color: sub }}>（まとめて1件のときだけ）</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {[{ v: true, l: '出す' }, { v: false, l: '出さない（人数だけ）' }].map(o => (
              <button key={String(o.v)} type="button" disabled={namesDisabled} onClick={() => setD({ names: o.v })}
                style={{ ...choiceBtn(cur.names === o.v, namesDisabled), flex: 1, textAlign: 'center', fontWeight: 700 }}>{o.l}</button>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>見え方{editing ? '（選んだ内容）' : ''}</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.7, padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#2b3035' : '#f8f9fa', marginBottom: 4 }}>
            {preview}
          </div>

          {editing ? (
            <SaveBar isDark={isDark} changes={changes} saving={saving} msg={msg} warn={warn}
              onCancel={() => { setEditing(false); setDraft(saved); setMsg(null); }} onSave={() => void onSave()} />
          ) : (<>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" style={{ ...backBtn(isDark), flex: 1 }} disabled={saving}
                onClick={() => { setDraft(saved); setEditing(true); setMsg(null); setRetryable(false); }}>変更する</button>
              {retryable && (
                <button type="button" style={{ ...primaryBtn({ disabled: saving }), flex: 1 }} disabled={saving} onClick={() => void runSync()}>
                  {saving ? '作り直しています…' : 'もう一度作り直す'}
                </button>
              )}
            </div>
            {saving && !retryable && <div style={{ fontSize: 12, color: sub, marginTop: 8 }}>Google カレンダーの予定を作り直しています…</div>}
            <SaveNotice msg={msg} />
          </>)}
        </>)}
      </div>
    </div>
  );
};

export default GcalEncouragementSection;
