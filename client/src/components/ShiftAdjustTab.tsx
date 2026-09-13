import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { todayJstStr } from '../lib/breakCalc';
import type { DayKind } from '../lib/breakCalc';
import { normalShiftTimeText } from '../lib/overtimeShift';
import { actedAtLabel } from '../lib/actedAt';

// ───────────────────────────────────────────────────────────────
// シフト調整の作業場（勤怠カレンダーの中のタブ）
//
// 設計は docs/計画-シフト調整.md。ここは手順6-A ＝ **見る・候補・相談** まで。
// 決定（誰がいつ入るか・勤怠の登録・依頼）は手順6-B で足す。
//
// 🚨 CalendarPage.tsx は 2,400行を超えているので、中身はこの別ファイルに置く。
//    あちらに足すのは「タブ」と「この部品を呼ぶ1行」だけ。
// 🚨 休んだ本人には見えない。判定はDB（RLS）が持っていて、画面は何もしない
//    （画面で隠すと、DBを直接見られたときに素通りする）。
// ───────────────────────────────────────────────────────────────

interface Perms {
  view: boolean;
  review: boolean;
  plan: boolean;
  request: boolean;
  decide: boolean;
}

interface SlotRow {
  id: string;
  target_user_id: string;
  target_date: string;
  cause: string;
  cause_leave_request_id: string | null;
  cause_attendance_exception_id: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
}

interface CommentRow {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
}

interface ProfileRow {
  id: string;
  name: string | null;
  employment_type: string | null;
}

interface PatternRow {
  user_id: string;
  day_kind: string;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
}

/** その日に「もう働けない」人（休み・欠勤など）と、その理由 */
type BusyMap = Record<string, string>;

const DAY_KINDS: DayKind[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

/** "2026-09-19" → "9/19（土）"。🚨 new Date(文字列) に頼らず、日本時間で組み立てる */
const dateLabel = (d: string): string => {
  const [y, m, dd] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return `${m}/${dd}（${DOW[w]}）`;
};
const dayKindOf = (d: string): DayKind => {
  const [y, m, dd] = d.split('-').map(Number);
  return DAY_KINDS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
};
/** その日まで何日あるか（日本時間） */
const daysUntil = (d: string): number => {
  const [y, m, dd] = d.split('-').map(Number);
  const [ty, tm, td] = todayJstStr().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86400000);
};

const STATUS_LABEL: Record<string, string> = {
  pending: '未調整',
  working: '調整中',
  decided: '調整済み',
  no_change: '確認済み（変更なし）',
  closed_past: '過ぎた日',
  cause_cancelled: '休みが取り消されました',
};

const ShiftAdjustTab: React.FC<{
  userId: string;
  isDark: boolean;
  isMobile: boolean;
  perms: Perms;
}> = ({ userId, isDark, isMobile, perms }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const cardBg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#e0e0e0';
  // 🚨 新しい色は足さない。「未＝あなたがやることがある」の橙と、済んだもののグレーだけ
  const warnFg = isDark ? '#ffcf8f' : '#b7770d';
  const warnBg = isDark ? '#4a3a1a' : '#fff8e1';
  const warnBd = isDark ? '#7a5a1a' : '#f0c36d';

  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const nameOf = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return '';
      return profiles.find(p => p.id === id)?.name || '';
    },
    [profiles],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    // 🚨 error を必ず見る。読めないまま「0件」と出すと、画面が嘘をつく
    const [{ data: sData, error: sErr }, { data: pData, error: pErr }] = await Promise.all([
      supabase.from('shift_adjust_slots')
        .select('id, target_user_id, target_date, cause, cause_leave_request_id, cause_attendance_exception_id, status, decided_by, decided_at')
        .gte('target_date', todayJstStr())
        .order('target_date', { ascending: true }),
      supabase.from('profiles')
        .select('id, name, employment_type')
        .eq('is_active', true),
    ]);
    if (sErr) { setErr('調整の場を読み込めませんでした：' + sErr.message); setLoading(false); return; }
    if (pErr) { setErr('スタッフの一覧を読み込めませんでした：' + pErr.message); setLoading(false); return; }
    setSlots((sData as SlotRow[] | null) ?? []);
    setProfiles((pData as ProfileRow[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 一覧に出すもの。🚨 過ぎた日・休みが取り消されたものは出さない（片付けようがない）
  const shown = useMemo(() => {
    const live = slots.filter(s => !['closed_past', 'cause_cancelled'].includes(s.status));
    return showDone ? live : live.filter(s => ['pending', 'working'].includes(s.status));
  }, [slots, showDone]);

  const pendingCount = useMemo(
    () => slots.filter(s => ['pending', 'working'].includes(s.status)).length,
    [slots],
  );

  const openSlot = slots.find(s => s.id === openId) ?? null;

  if (openSlot) {
    return (
      <SlotDetail
        slot={openSlot}
        userId={userId}
        isDark={isDark}
        isMobile={isMobile}
        perms={perms}
        profiles={profiles}
        nameOf={nameOf}
        onBack={() => { setOpenId(null); void load(); }}
      />
    );
  }

  return (
    <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, padding: isMobile ? 14 : 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>
          未調整の休み・欠勤（今日以降）
        </span>
        <span style={{ fontSize: 12, color: subText }}>{pendingCount}件</span>
        <button onClick={() => setShowDone(v => !v)}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 12, color: isDark ? '#64b5f6' : '#0d6efd', textDecoration: 'underline' }}>
          {showDone ? '未調整だけにする' : '片付いたものも見る'}
        </button>
      </div>

      {err && (
        <p style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f8d7da', color: '#842029' }}>{err}</p>
      )}

      {loading ? (
        <p style={{ margin: 0, fontSize: 12.5, color: subText }}>読み込んでいます…</p>
      ) : shown.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: subText, lineHeight: 1.8 }}>
          {showDone ? '今日以降の調整の場はありません。' : '未調整のものはありません。'}
          <br />
          <span style={{ fontSize: 11.5 }}>
            ※ 休みが受理された時点、または欠勤が登録された時点で、ここに自動で並びます。
          </span>
        </p>
      ) : (
        <div>
          {shown.map(s => {
            const until = daysUntil(s.target_date);
            const soon = s.status === 'pending' && until <= 7;
            return (
              <button key={s.id} type="button" onClick={() => setOpenId(s.id)}
                style={{
                  width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 8px', border: 'none', borderBottom: `1px solid ${border}`,
                  background: 'transparent', cursor: 'pointer', color: text, fontSize: isMobile ? 13 : 14,
                }}>
                <span style={{ color: soon ? warnFg : subText, fontSize: isMobile ? 12 : 13, whiteSpace: 'nowrap', fontWeight: soon ? 'bold' : 'normal' }}>
                  {dateLabel(s.target_date)}
                </span>
                <span style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nameOf(s.target_user_id) || '（名前を読み込めませんでした）'}
                </span>
                <span style={{ fontSize: 11, color: subText, whiteSpace: 'nowrap' }}>
                  {s.cause === 'absent' ? '欠勤' : '休暇'}
                </span>
                <span style={{
                  marginLeft: 'auto', fontSize: 10.5, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
                  whiteSpace: 'nowrap',
                  color: s.status === 'pending' ? warnFg : subText,
                  background: s.status === 'pending' ? warnBg : 'transparent',
                  border: `1px solid ${s.status === 'pending' ? warnBd : border}`,
                }}>
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
                <span style={{ color: subText, fontSize: 14 }}>›</span>
              </button>
            );
          })}
        </div>
      )}

      <p style={{ margin: '12px 0 0', fontSize: 11, color: subText, lineHeight: 1.7 }}>
        ※ 自分の休みの調整は、ここには出ません（他の人が調整します）。
      </p>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// 調整の場（1件）
// ───────────────────────────────────────────────────────────────
const SlotDetail: React.FC<{
  slot: SlotRow;
  userId: string;
  isDark: boolean;
  isMobile: boolean;
  perms: Perms;
  profiles: ProfileRow[];
  nameOf: (id: string | null | undefined) => string;
  onBack: () => void;
}> = ({ slot, userId, isDark, isMobile, perms, profiles, nameOf, onBack }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const cardBg = isDark ? '#343a40' : '#fff';
  const border = isDark ? '#495057' : '#e0e0e0';
  const warnFg = isDark ? '#ffcf8f' : '#b7770d';

  const [comments, setComments] = useState<CommentRow[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [showCandidates, setShowCandidates] = useState(false);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [busy, setBusy] = useState<BusyMap>({});
  const [candLoaded, setCandLoaded] = useState(false);
  const [candErr, setCandErr] = useState('');
  const [where, setWhere] = useState<string>('');
  const [status, setStatus] = useState(slot.status);

  const loadComments = useCallback(async () => {
    const { data, error } = await supabase.from('shift_adjust_comments')
      .select('id, user_id, body, created_at')
      .eq('slot_id', slot.id)
      .order('created_at', { ascending: true });
    if (error) { setErr('相談を読み込めませんでした：' + error.message); return; }
    setComments((data as CommentRow[] | null) ?? []);
  }, [slot.id]);

  useEffect(() => { void loadComments(); }, [loadComments]);

  // 見出しに出す「校」。休暇なら日ごとの勤務校、欠勤なら記録の校
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (slot.cause_leave_request_id) {
        const { data } = await supabase.from('leave_requests')
          .select('leave_locations')
          .eq('id', slot.cause_leave_request_id)
          .maybeSingle();
        if (!alive || !data) return;
        // leave_locations は「日付→校」の JSON の文字列。読めないときは何も出さない
        try {
          const map = JSON.parse((data as { leave_locations: string | null }).leave_locations || '{}') as Record<string, string>;
          setWhere(map[slot.target_date] ?? '');
        } catch { setWhere(''); }
      } else if (slot.cause_attendance_exception_id) {
        const { data } = await supabase.from('attendance_exceptions')
          .select('location')
          .eq('id', slot.cause_attendance_exception_id)
          .maybeSingle();
        if (!alive || !data) return;
        setWhere((data as { location: string | null }).location ?? '');
      }
    })();
    return () => { alive = false; };
  }, [slot.cause_leave_request_id, slot.cause_attendance_exception_id, slot.target_date]);

  // 候補（押したときに初めて読む。見ない人のぶんまで通信しない）
  const loadCandidates = useCallback(async () => {
    setCandErr('');
    const d = slot.target_date;
    const [{ data: pat, error: patErr }, { data: att }, { data: lv }] = await Promise.all([
      supabase.from('weekly_shift_patterns')
        .select('user_id, day_kind, start_time, end_time, start_time2, end_time2, location, valid_from, valid_to')
        .eq('day_kind', dayKindOf(d))
        .lte('valid_from', d),
      supabase.from('attendance_exceptions')
        .select('user_id, type')
        .eq('date', d),
      supabase.from('leave_requests')
        .select('user_id, leave_dates, start_date, end_date, status')
        .in('status', ['manager_approved', 'admin_approved', 'approved'])
        .lte('start_date', d)
        .gte('end_date', d),
    ]);
    if (patErr) {
      // 🚨 「全員のシフト予定 閲覧」の権限が無いと読めない。黙って0件にしない
      setCandErr('週の基本シフトを読み込めませんでした（「全員のシフト予定 閲覧」の権限が要ります）');
    }
    const rows = ((pat as (PatternRow & { valid_from: string; valid_to: string | null })[] | null) ?? [])
      .filter(p => p.valid_to === null || p.valid_to >= d);
    setPatterns(rows);

    const b: BusyMap = {};
    for (const a of ((att as { user_id: string; type: string }[] | null) ?? [])) {
      if (a.type === 'absent') b[a.user_id] = 'この日は欠勤';
      else if (a.type === 'holiday_work') b[a.user_id] = 'この日は休日出勤';
    }
    for (const l of ((lv as { user_id: string; leave_dates: string | null }[] | null) ?? [])) {
      // leave_dates は日付の配列の文字列。読めないときは期間で判断（上のクエリで絞り込み済み）
      let hit = true;
      try {
        const arr = JSON.parse(l.leave_dates || '[]') as string[];
        if (Array.isArray(arr) && arr.length > 0) hit = arr.includes(d);
      } catch { hit = true; }
      if (hit) b[l.user_id] = 'この日は休み';
    }
    setBusy(b);
    setCandLoaded(true);
  }, [slot.target_date]);

  const toggleCandidates = () => {
    const next = !showCandidates;
    setShowCandidates(next);
    if (next && !candLoaded) void loadCandidates();
  };

  const send = async () => {
    const t = body.trim();
    if (!t || sending) return;
    setSending(true);
    setErr('');
    // 🚨 error を必ず見る。投げっぱなしにすると、書けていないのに消えたように見える
    const { error } = await supabase.from('shift_adjust_comments')
      .insert({ slot_id: slot.id, user_id: userId, body: t });
    setSending(false);
    if (error) { setErr('送れませんでした：' + error.message); return; }
    setBody('');
    void loadComments();
  };

  const setSlotStatus = async (next: 'pending' | 'no_change') => {
    setErr('');
    setOkMsg('');
    const { data, error } = await supabase.rpc('shift_adjust_set_status', { p_slot_id: slot.id, p_status: next });
    // 🚨 rpc は 4xx でも throw しない。error と、返ってきた ok の両方を見る
    if (error) { setErr('変えられませんでした：' + error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) { setErr(row?.reason || '変えられませんでした'); return; }
    setStatus(next);
    setOkMsg(next === 'no_change' ? '確認済み（変更なし）にしました' : '未調整に戻しました');
  };

  // 候補を「その日に勤務している人」と「休みのパート」に分ける
  const working = profiles
    .filter(p => p.id !== slot.target_user_id && patterns.some(x => x.user_id === p.id && x.start_time))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  const restingPart = profiles
    .filter(p => p.id !== slot.target_user_id && p.employment_type === 'パート'
      && !patterns.some(x => x.user_id === p.id && x.start_time))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));

  const shiftTextOf = (uid: string): string => {
    const p = patterns.find(x => x.user_id === uid);
    if (!p) return '';
    return normalShiftTimeText({
      start_time: p.start_time, end_time: p.end_time,
      start_time2: p.start_time2, end_time2: p.end_time2,
    });
  };
  const locOf = (uid: string): string => patterns.find(x => x.user_id === uid)?.location ?? '';

  const box: React.CSSProperties = {
    background: cardBg, borderRadius: 12, border: `1px solid ${border}`,
    padding: isMobile ? 14 : 18, marginBottom: 12,
  };

  return (
    <div>
      <button onClick={onBack}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
          color: isDark ? '#64b5f6' : '#0d6efd', padding: '4px 0', marginBottom: 8 }}>
        ‹ 一覧へ
      </button>

      {/* 見出し */}
      <div style={box}>
        <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 'bold', color: text }}>
          {dateLabel(slot.target_date)}
          {where && <span style={{ marginLeft: 10, fontSize: isMobile ? 13 : 14, color: subText }}>{where}</span>}
        </div>
        <div style={{ fontSize: 13.5, color: text, marginTop: 4 }}>
          {nameOf(slot.target_user_id) || '（名前を読み込めませんでした）'}さんの
          {slot.cause === 'absent' ? '欠勤' : '休み'}
        </div>
        <div style={{ fontSize: 12, color: status === 'pending' ? warnFg : subText, marginTop: 6 }}>
          状態：{STATUS_LABEL[status] ?? status}
          {slot.decided_at && status !== 'pending' && (
            <span style={{ color: subText, marginLeft: 10 }}>
              {nameOf(slot.decided_by) ? `${nameOf(slot.decided_by)}・` : ''}
              {actedAtLabel(slot.decided_at)}
            </span>
          )}
        </div>
      </div>

      {/* 誰が入るか（決める仕組みは手順6-B） */}
      <div style={box}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>誰が入るか</div>
        <p style={{ margin: 0, fontSize: 12.5, color: subText, lineHeight: 1.8 }}>
          まだ決まっていません。
          <br />
          <span style={{ fontSize: 11.5 }}>
            ※ ここで決めると勤怠に登録する仕組みは、次の更新で使えるようになります。
            それまでは相談してから、カレンダーの「シフト 未」を「調整済」にしてください。
          </span>
        </p>
      </div>

      {/* 候補 */}
      <div style={box}>
        <button onClick={toggleCandidates}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 13, fontWeight: 'bold', color: text }}>
          {showCandidates ? '▼' : '▶'} 候補を見る
        </button>
        {showCandidates && (
          <div style={{ marginTop: 10 }}>
            {candErr && (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#842029',
                background: '#f8d7da', padding: '6px 8px', borderRadius: 6 }}>{candErr}</p>
            )}
            {!candLoaded ? (
              <p style={{ margin: 0, fontSize: 12.5, color: subText }}>読み込んでいます…</p>
            ) : (
              <>
                <div style={{ fontSize: 12, color: subText, margin: '0 0 4px' }}>勤務している人</div>
                {working.length === 0 ? (
                  <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>この日に勤務の登録がある人はいません。</p>
                ) : working.map(p => (
                  <CandidateRow key={p.id} name={p.name || ''} part={p.employment_type === 'パート'}
                    shift={shiftTextOf(p.id)} loc={locOf(p.id)} note={busy[p.id] ?? ''}
                    isDark={isDark} />
                ))}

                <div style={{ fontSize: 12, color: subText, margin: '12px 0 4px' }}>休みのパート</div>
                {restingPart.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: subText }}>この日が休みのパートはいません。</p>
                ) : restingPart.map(p => (
                  <CandidateRow key={p.id} name={p.name || ''} part
                    shift="" loc="" note={busy[p.id] ?? 'この日は休み'} isDark={isDark} />
                ))}
                <p style={{ margin: '10px 0 0', fontSize: 11, color: subText, lineHeight: 1.7 }}>
                  ※ 週の基本シフトが登録されていない人は「勤務している人」に出ません。
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* 相談 */}
      <div style={box}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 }}>相談</div>
        {comments.length === 0 ? (
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>まだ書き込みはありません。</p>
        ) : comments.map(c => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: `1px solid ${border}` }}>
            <div style={{ fontSize: 11.5, color: subText }}>
              {nameOf(c.user_id) || '（名前なし）'}・{actedAtLabel(c.created_at)}
            </div>
            <div style={{ fontSize: 13.5, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{c.body}</div>
          </div>
        ))}
        {perms.view && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={2}
              placeholder="相談を書く"
              style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 13.5, resize: 'vertical',
                border: `1px solid ${border}`, background: isDark ? '#2b3035' : '#fff', color: text,
                boxSizing: 'border-box', fontFamily: 'inherit' }} />
            <button onClick={send} disabled={!body.trim() || sending}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', cursor: body.trim() ? 'pointer' : 'default',
                fontSize: 13, fontWeight: 'bold', whiteSpace: 'nowrap',
                background: body.trim() ? '#1976d2' : (isDark ? '#495057' : '#e9ecef'),
                color: body.trim() ? '#fff' : subText }}>
              {sending ? '送信中' : '送る'}
            </button>
          </div>
        )}
      </div>

      {err && (
        <p style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f8d7da', color: '#842029' }}>{err}</p>
      )}
      {okMsg && (
        <p style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: '#f0fdf4', border: '1px solid #86efac', color: '#166534' }}>✓ {okMsg}</p>
      )}

      {/* 閉じる／戻す */}
      {perms.decide && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
          {status !== 'no_change' ? (
            <button onClick={() => void setSlotStatus('no_change')}
              style={{ padding: '11px 18px', borderRadius: 10, border: `1px solid ${border}`,
                cursor: 'pointer', fontSize: 13.5, fontWeight: 'bold',
                background: isDark ? '#495057' : '#f8f9fa', color: text }}>
              確認済み（変更なし）で閉じる
            </button>
          ) : (
            <button onClick={() => void setSlotStatus('pending')}
              style={{ padding: '11px 18px', borderRadius: 10, border: `1px solid ${border}`,
                cursor: 'pointer', fontSize: 13.5, background: 'transparent', color: subText }}>
              未調整に戻す
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const CandidateRow: React.FC<{
  name: string; part: boolean; shift: string; loc: string; note: string; isDark: boolean;
}> = ({ name, part, shift, loc, note, isDark }) => {
  const text = isDark ? '#e9ecef' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  // 🚨 選べない人は opacity で薄くする（新しい色を足さない・配色の決まり）
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      padding: '5px 0', opacity: note ? 0.5 : 1 }}>
      <span style={{ fontSize: 13, color: text, fontWeight: 'bold' }}>{name || '（名前なし）'}</span>
      {part && <span style={{ fontSize: 10.5, color: subText }}>パート</span>}
      {shift && <span style={{ fontSize: 12, color: subText }}>{shift}</span>}
      {loc && <span style={{ fontSize: 11, color: subText }}>{loc}</span>}
      {note && <span style={{ fontSize: 11, color: subText }}>（{note}）</span>}
    </div>
  );
};

export default ShiftAdjustTab;
