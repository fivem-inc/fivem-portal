// 管理部シフト表（2026-10-16・決めたことは docs/計画-管理部シフト表.md・モック 配布資料/管理部シフト表_モック.png）
// ・入力しない表：勤務表（いつものシフト）から作る。勤務表を直すとこの表も変わる
// ・［曜日で見る］校ごとに時間の帯（6時〜21時）／［人ごとに見る］縦＝人・横＝月〜日
// ・こども・大人のシフト表（決定済み）に入っている分をオレンジで重ねる
// ・締め：四条本校でいちばん遅く終わる管理部の人に印。同じ時刻が2人以上なら、マネージャー以上と管理者が選ぶ（選ぶまでは「未定」）
// 🚨 計算は lib/adminShift（画面・印刷・Excel が同じものを呼ぶ）。書くのは締めの選び直し（admin_shift_set_closer）だけ

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';
import { useAuth } from '../../hooks/useAuth';
import { useRoles } from '../../hooks/useRoles';
import { attrsFor, rankOf } from '../../lib/roleAttrs';
import { todayJstStr } from '../../lib/breakCalc';
import {
  AREA_COLORS, ROSTER_DAY_LABEL, ROSTER_WEEK, compareRosterStaff, minText, rowOnDate, rowToDay,
  type RosterDayKind,
} from '../../lib/shiftRoster';
import { loadRosterData, type RosterData } from '../../lib/shiftRosterApi';
import { loadKidsData, type KidsData } from '../../lib/kidsShiftApi';
import {
  ADMIN_AREA_NAME, CLOSE_SCHOOL, SCHOOL_COLOR_KEYS, TIMELINE_FROM, TIMELINE_TO,
  boardEntriesOn, closerCandidates, personCellLines, resolveCloser, schoolSpans,
  type BoardEntry, type SavedCloser, type SchoolSpan,
} from '../../lib/adminShift';
import { openRosterPrint } from '../../lib/shiftRosterPrint';
import LeaveHiddenLine from './LeaveHiddenLine';
import { type StaffLeave, leaveWeekOf, leaveWeekMark, leaveHiddenLabel } from '../../lib/staffLeave';
import { TOGGLE_BLUE, backBtn, tintBtn } from '../../lib/buttonStyles';

const ORANGE = '#e8590c';
const DAY_OF_WEEK: RosterDayKind[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayKindOf = (date: string): RosterDayKind => DAY_OF_WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()];
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const AdminShiftPanel: React.FC<{ leavesByUser?: Map<string, StaffLeave[]> }> = ({ leavesByUser }) => {
  const { isDarkMode } = useAdminPanel();
  const { isAdmin, roleTitle } = useAuth();
  const roles = useRoles();
  const canChoose = isAdmin || attrsFor(roles, roleTitle).is_manager_plus;

  const [date, setDate] = useState(todayJstStr());
  const [view, setView] = useState<'day' | 'person'>('day');
  const [day, setDay] = useState<RosterDayKind>(() => {
    const k = dayKindOf(todayJstStr());
    return ROSTER_WEEK.includes(k) ? k : 'mon';
  });
  const [data, setData] = useState<RosterData | null>(null);
  const [kids, setKids] = useState<KidsData | null>(null);
  const [adult, setAdult] = useState<KidsData | null>(null);
  const [closers, setClosers] = useState<SavedCloser[]>([]);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#2b3035' : '#fff';
  const laneBg = isDarkMode ? '#343a40' : '#f8f9fa';
  const toggle = (on: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
    border: `1px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : text,
  });
  const smallBtn: React.CSSProperties = { padding: '6px 12px', fontSize: 13 };

  const load = useCallback(async () => {
    setErr(''); setWarn('');
    const [r, k, a, c] = await Promise.all([
      loadRosterData(date), loadKidsData(date), loadKidsData(date, 'adult'),
      supabase.from('admin_shift_closers').select('day_kind, user_id, candidates'),
    ]);
    if (r.error || !r.data) { setErr(r.error ?? '勤務表を読み込めませんでした'); return; }
    setData(r.data);
    // 🚨 こども・大人の表が読めなくても管理部の表は出す。ただし黙って消さず、重ねて出せない旨を出す
    const w: string[] = [];
    if (k.error) w.push('こどもシフト表'); else setKids(k.data);
    if (a.error) w.push('大人シフト表'); else setAdult(a.data);
    if (w.length > 0) setWarn(`${w.join('・')}を読み込めませんでした（重ねて出していません）`);
    if (c.error) setErr(`締めの記録を読み込めませんでした：${c.error.message}`);
    else setClosers((c.data as SavedCloser[] | null) ?? []);
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const adminAreaId = useMemo(() => data?.areas.find(a => a.name === ADMIN_AREA_NAME)?.id ?? null, [data]);
  const members = useMemo(() => {
    if (!data || !adminAreaId) return [];
    return data.staff
      // 🚨 基準の日から7日間ずっと休職中の方は出さない（締めの候補からも外れる・2026-10-21）
      .filter(s => data.mainAreas[s.id] === adminAreaId && !s.prehire_from && leaveWeekOf(leavesByUser?.get(s.id), date).state !== 'all')
      .sort((x, y) => compareRosterStaff(x, y, () => 0, t => rankOf(roles, t) ?? 99));
  }, [data, adminAreaId, roles, leavesByUser, date]);
  const leaveHidden = useMemo(() => (data && adminAreaId ? data.staff.filter(s => data.mainAreas[s.id] === adminAreaId && !s.prehire_from) : [])
    .map(s => ({ s, w: leaveWeekOf(leavesByUser?.get(s.id), date) })).filter(x => x.w.state === 'all' && x.w.leave)
    .map(x => leaveHiddenLabel(x.s.name ?? '', x.w.leave!)), [data, adminAreaId, leavesByUser, date]);
  const memberIds = useMemo(() => members.map(m => m.id), [members]);
  const nameOf = useCallback((id: string) => data?.staff.find(s => s.id === id)?.name ?? '（不明）', [data]);

  const rowsByUser = useMemo(() => {
    const m = new Map<string, RosterData['patterns']>();
    for (const r of data?.patterns ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return m;
  }, [data]);
  const spansOf = useCallback((uid: string, k: RosterDayKind): SchoolSpan[] => {
    if (!data) return [];
    const row = rowOnDate((rowsByUser.get(uid) ?? []).filter(r => r.day_kind === k), date);
    return schoolSpans(rowToDay(row), data.areas, data.mainAreas[uid] ?? null);
  }, [data, rowsByUser, date]);

  // こども・大人の分（決定済み）
  const overlaysOf = useCallback((k: RosterDayKind): BoardEntry[] =>
    [...boardEntriesOn(kids, 'kids', k, date), ...boardEntriesOn(adult, 'adult', k, date)].filter(e => memberIds.includes(e.userId)),
  [kids, adult, date, memberIds]);

  // 締め（曜日ごと）
  const closerOf = useCallback((k: RosterDayKind) => {
    const { candidates, endMin } = closerCandidates(memberIds, uid => spansOf(uid, k));
    return { candidates, endMin, ...resolveCloser(candidates, closers.find(c => c.day_kind === k)) };
  }, [memberIds, spansOf, closers]);

  const choose = async (k: RosterDayKind, uid: string | null, candidates: string[]) => {
    setBusy(true); setMsg(''); setErr('');
    const { error } = await supabase.rpc('admin_shift_set_closer', { p_day: k, p_user: uid, p_candidates: candidates });
    setBusy(false);
    if (error) { setErr(`締めを保存できませんでした：${error.message}`); return; }
    setMsg(uid ? `${ROSTER_DAY_LABEL[k]}曜の締めを ${nameOf(uid)} にしました` : `${ROSTER_DAY_LABEL[k]}曜の締めを未定に戻しました`);
    const { data: c, error: e2 } = await supabase.from('admin_shift_closers').select('day_kind, user_id, candidates');
    if (e2) setErr(`締めの記録を読み直せませんでした：${e2.message}`); else setClosers((c as SavedCloser[] | null) ?? []);
  };

  const schools = data?.workplaces ?? [];
  const colorOf = (school: string) => {
    const i = Math.max(0, schools.indexOf(school));
    return AREA_COLORS[SCHOOL_COLOR_KEYS[i % SCHOOL_COLOR_KEYS.length]] ?? AREA_COLORS.gray;
  };
  const pct = (m: number) => `${((Math.min(Math.max(m, TIMELINE_FROM), TIMELINE_TO) - TIMELINE_FROM) / (TIMELINE_TO - TIMELINE_FROM)) * 100}%`;
  const closerBadge = <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#fff3cd', color: '#856404', border: '1px solid #ffc107', fontWeight: 'bold', whiteSpace: 'nowrap' }}>締め</span>;

  // 締めが未定・選んだ曜日の案内（曜日で見る＝その曜日だけ／人ごと＝全曜日）
  const closerChoice = (k: RosterDayKind) => {
    const c = closerOf(k);
    if (c.candidates.length < 2) return null;
    return (
      <div key={k} style={{ fontSize: 13, color: text, padding: '8px 10px', borderRadius: 8, marginBottom: 8, lineHeight: 1.7,
        background: c.undecided ? '#fff3cd' : laneBg, border: c.undecided ? '2px solid #ffc107' : `1px solid ${border}`, ...(c.undecided ? { color: '#856404' } : {}) }}>
        <b>{ROSTER_DAY_LABEL[k]}曜の締め：{c.userId ? nameOf(c.userId) : '未定'}</b>
        <span style={{ marginLeft: 6 }}>（{CLOSE_SCHOOL}で {c.endMin != null ? minText(c.endMin) : ''} に終わる人が{c.candidates.length}人）</span>
        {canChoose ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {c.candidates.map(uid => (
              <button key={uid} type="button" disabled={busy || c.userId === uid} onClick={() => void choose(k, uid, c.candidates)}
                style={{ ...toggle(c.userId === uid), ...smallBtn }}>{nameOf(uid)}</button>
            ))}
            {c.chosen && <button type="button" disabled={busy} onClick={() => void choose(k, null, c.candidates)} style={{ ...backBtn(isDarkMode), ...smallBtn }}>未定に戻す</button>}
          </div>
        ) : c.undecided && <div style={{ fontSize: 12 }}>マネージャー以上の方が選びます</div>}
      </div>
    );
  };

  // ─── 曜日で見る ───
  const dayView = () => {
    const c = closerOf(day);
    const ov = overlaysOf(day);
    const offIds = memberIds.filter(id => spansOf(id, day).length === 0);
    const hours = Array.from({ length: (TIMELINE_TO - TIMELINE_FROM) / 60 + 1 }, (_, i) => TIMELINE_FROM / 60 + i);
    const used = schools.filter(sc => memberIds.some(id => spansOf(id, day).some(sp => sp.school === sc)));
    return (
      <div>
        {closerChoice(day)}
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', fontSize: 11, color: sub, marginBottom: 4 }}>
              <div />
              <div style={{ position: 'relative', height: 14 }}>
                {hours.map(h => <span key={h} style={{ position: 'absolute', left: pct(h * 60), transform: 'translateX(-50%)' }}>{h}</span>)}
              </div>
            </div>
            {used.length === 0 && <div style={{ fontSize: 13, color: sub, padding: 12 }}>{ROSTER_DAY_LABEL[day]}曜に勤務の入っている管理部の方はいません</div>}
            {used.map(sc => {
              const col = colorOf(sc);
              const ids = memberIds.filter(id => spansOf(id, day).some(sp => sp.school === sc));
              return (
                <div key={sc} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', color: TOGGLE_BLUE, margin: '6px 0 4px' }}>{sc}（{ids.length}人）</div>
                  {ids.map(id => {
                    const mine = spansOf(id, day).filter(sp => sp.school === sc);
                    // 重ねる分：同じ校の分。校の無い分（出張など）はその人のいちばん上の校に出す
                    const firstSchool = spansOf(id, day)[0]?.school;
                    const ovs = ov.filter(e => e.userId === id && (e.school === sc || (e.school == null && firstSchool === sc) || (e.school != null && !used.includes(e.school) && firstSchool === sc)));
                    return (
                      <div key={id} style={{ marginBottom: 4 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center' }}>
                          <div style={{ fontSize: 13, color: text, paddingRight: 6 }}>
                            {nameOf(id)}{members.find(m => m.id === id)?.employment_type === 'パート' && <span style={{ color: sub, fontSize: 11 }}>（パート）</span>}
                            {sc === CLOSE_SCHOOL && c.userId === id && closerBadge}
                          </div>
                          <div style={{ position: 'relative', height: 24, background: laneBg, borderRadius: 4 }}>
                            {hours.map(h => <span key={h} style={{ position: 'absolute', left: pct(h * 60), top: 0, bottom: 0, borderLeft: `1px solid ${border}` }} />)}
                            {mine.map((sp, i) => (
                              <div key={i} style={{ position: 'absolute', left: pct(sp.s), width: `calc(${pct(sp.e)} - ${pct(sp.s)})`, top: 2, bottom: 2,
                                background: col.bg, color: col.fg, borderRadius: 4, fontSize: 11, padding: '0 4px', overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: '20px' }}>
                                {minText(sp.s)}〜{minText(sp.e)}
                              </div>
                            ))}
                            {ovs.filter(e => e.s != null && e.e != null).map((e, i) => (
                              <div key={`o${i}`} title={e.text} style={{ position: 'absolute', left: pct(e.s!), width: `calc(${pct(e.e!)} - ${pct(e.s!)})`, top: 0, bottom: 0,
                                border: `2px dashed ${ORANGE}`, borderRadius: 4, pointerEvents: 'none' }} />
                            ))}
                          </div>
                        </div>
                        {ovs.length > 0 && (
                          <div style={{ marginLeft: 130, fontSize: 11.5, color: ORANGE, lineHeight: 1.5 }}>{ovs.map(e => e.text).join('／')}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {offIds.length > 0 && <div style={{ fontSize: 12.5, color: sub, marginTop: 6 }}>休み：{offIds.map(id => nameOf(id)).join('・')}</div>}
      </div>
    );
  };

  // ─── 人ごとに見る ───
  const personView = () => (
    <div>
      {ROSTER_WEEK.map(k => closerChoice(k))}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760, fontSize: 12.5, color: text }}>
          <thead>
            <tr style={{ background: laneBg }}>
              <th style={{ border: `1px solid ${border}`, padding: 6, width: 110 }}>人</th>
              {ROSTER_WEEK.map(k => <th key={k} style={{ border: `1px solid ${border}`, padding: 6 }}>{ROSTER_DAY_LABEL[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td style={{ border: `1px solid ${border}`, padding: 6, fontWeight: 'bold', verticalAlign: 'top' }}>
                  {m.name}{(() => { const w = leaveWeekOf(leavesByUser?.get(m.id), date); return w.state === 'partial' && w.leave ? <div style={{ fontSize: 11, color: sub, fontWeight: 'normal' }}>{leaveWeekMark(w.leave, date)}</div> : null; })()}{m.employment_type === 'パート' && <div style={{ fontSize: 11, color: sub, fontWeight: 'normal' }}>パート</div>}
                </td>
                {ROSTER_WEEK.map(k => {
                  const lines = personCellLines(spansOf(m.id, k));
                  const ovs = overlaysOf(k).filter(e => e.userId === m.id);
                  const isCloser = closerOf(k).userId === m.id;
                  return (
                    <td key={k} style={{ border: `1px solid ${border}`, padding: 6, verticalAlign: 'top', lineHeight: 1.5 }}>
                      {lines.length === 0 ? <span style={{ color: sub }}>休み</span> : lines.map((l, i) => (
                        <div key={i}>
                          <div>{l.school}{l.school === CLOSE_SCHOOL && isCloser && closerBadge}</div>
                          {l.times.map((t, j) => <div key={j}>{t}</div>)}
                        </div>
                      ))}
                      {ovs.map((e, i) => <div key={`o${i}`} style={{ fontSize: 11, color: ORANGE }}>{e.text}</div>)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  // ─── 印刷・Excel（人ごとの表の形・締めと重ねる分も入れる） ───
  const cellText = (uid: string, k: RosterDayKind): string[] => {
    const lines = personCellLines(spansOf(uid, k));
    const isCloser = closerOf(k).userId === uid;
    const out = lines.length === 0 ? ['休み'] : lines.flatMap(l => [`${l.school}${l.school === CLOSE_SCHOOL && isCloser ? '（締め）' : ''}`, ...l.times]);
    return [...out, ...overlaysOf(k).filter(e => e.userId === uid).map(e => e.text)];
  };
  const undecidedDays = ROSTER_WEEK.filter(k => closerOf(k).undecided);
  const print = () => {
    const head = ROSTER_WEEK.map(k => `<th>${ROSTER_DAY_LABEL[k]}</th>`).join('');
    const body = members.map(m => `<tr><th>${esc(m.name)}${m.employment_type === 'パート' ? '<br><small>パート</small>' : ''}</th>${
      ROSTER_WEEK.map(k => `<td>${cellText(m.id, k).map(t => (/^(こども|大人)：/.test(t) ? `<div class="ov">${esc(t)}</div>` : `<div>${esc(t)}</div>`)).join('')}</td>`).join('')}</tr>`).join('');
    const note = undecidedDays.length > 0 ? `<p class="warn">締めが未定の曜日：${undecidedDays.map(k => ROSTER_DAY_LABEL[k]).join('・')}</p>` : '';
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>管理部シフト表</title><style>
      body{font-family:sans-serif;font-size:11px;margin:12px}h1{font-size:15px;margin:0 0 4px}p{margin:0 0 6px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px;vertical-align:top}thead th{background:#eee}
      .ov{color:#c2410c;font-size:10px}.warn{color:#856404}@page{size:A4 landscape;margin:8mm}</style></head><body>
      <h1>管理部シフト表</h1><p>${esc(date)} 時点の勤務表から作成（締め＝${CLOSE_SCHOOL}でいちばん遅く終わる人）</p>${note}
      <table><thead><tr><th>人</th>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
    const e = openRosterPrint(html);
    if (e) setErr(e);
  };
  const excel = async () => {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const grid = [['人', ...ROSTER_WEEK.map(k => ROSTER_DAY_LABEL[k])], ...members.map(m => [m.name, ...ROSTER_WEEK.map(k => cellText(m.id, k).join('\n'))])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), '人ごと');
      const list: (string)[][] = [['曜日', '校', '名前', '時間', '締め', 'こども・大人']];
      for (const k of ROSTER_WEEK) {
        const c = closerOf(k);
        for (const m of members) {
          const ovs = overlaysOf(k).filter(e => e.userId === m.id).map(e => e.text).join(' / ');
          for (const sp of spansOf(m.id, k)) {
            list.push([ROSTER_DAY_LABEL[k], sp.school, m.name, `${minText(sp.s)}〜${minText(sp.e)}`,
              sp.school === CLOSE_SCHOOL && c.userId === m.id ? '締め' : (sp.school === CLOSE_SCHOOL && c.undecided && c.candidates.includes(m.id) ? '未定' : ''), ovs]);
          }
        }
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(list), '曜日ごと');
      XLSX.writeFile(wb, `管理部シフト表_${date}.xlsx`);
    } catch (e) {
      setErr(`Excel を作れませんでした：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!data && !err) return <p style={{ color: sub }}>読み込み中…</p>;

  return (
    <div style={{ textAlign: 'left', color: text }}>
      <h3 style={{ margin: '4px 0 4px', color: text }}>管理部シフト表</h3>
      <p style={{ fontSize: 12.5, color: sub, margin: '0 0 10px', lineHeight: 1.7 }}>
        入力はしません。勤務表（いつものシフト）から自動で作る表です。勤務表を直すと、この表も変わります。<br />
        こども・大人のシフト表（決定済み）に入っている分は、<span style={{ color: ORANGE }}>オレンジ</span>で重ねて出します。
        「締め」は、その曜日に{CLOSE_SCHOOL}でいちばん遅く終わる方です。
      </p>
      {err && <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13 }}>{err}</div>}
      <LeaveHiddenLine isDark={isDarkMode} labels={leaveHidden} />
      {warn && <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404', fontSize: 13 }}>{warn}</div>}
      {msg && <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724', fontSize: 13 }}>{msg}</div>}
      {data && !adminAreaId && <div style={{ fontSize: 13, color: sub }}>部門「{ADMIN_AREA_NAME}」が見つかりません（勤務表の部門の名前を確かめてください）</div>}

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 12 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <button type="button" style={toggle(view === 'day')} onClick={() => setView('day')}>曜日で見る</button>
          <button type="button" style={toggle(view === 'person')} onClick={() => setView('person')}>人ごとに見る</button>
          {view === 'day' && (
            <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6, flexWrap: 'wrap' }}>
              {ROSTER_WEEK.map(k => (
                <button key={k} type="button" style={{ ...toggle(day === k), padding: '6px 10px' }} onClick={() => setDay(k)}>
                  {ROSTER_DAY_LABEL[k]}{closerOf(k).undecided ? '⚠️' : ''}
                </button>
              ))}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: sub }}>
            <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${border}`, background: cardBg, color: text }} />
            時点
            <button type="button" style={{ ...tintBtn(isDarkMode), ...smallBtn }} onClick={print} disabled={!data}>印刷</button>
            <button type="button" style={{ ...tintBtn(isDarkMode), ...smallBtn }} onClick={() => void excel()} disabled={!data}>Excel</button>
          </span>
        </div>
        {data && adminAreaId && (view === 'day' ? dayView() : personView())}
      </div>
    </div>
  );
};

export default AdminShiftPanel;
