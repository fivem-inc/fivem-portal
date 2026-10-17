// 管理画面「📊 レポート」（2026-10-17 作り直し・決めたことは docs/計画-レポートの作り直し.md）
// ・期間は給与期間（16日〜翌15日）。初めは今の期（途中なら「途中」）。‹ › で前の期へ
// ・前の期とは「同じ日数まで」で比べる（途中の期と、締めた期を比べないため）
// ・名前は初めは隠す（［名前を見る］を押したときだけ）。3人未満の集まりの平均は「—」。順位は付けない
// 🚨 計算は lib/reportCalc（画面・Excel が同じものを呼ぶ）。残業の数え方は本人のカードと同じ computeBalance
// 🚨 記録は DB の report_overtime_data／report_misc_data（管理者だけ・1回で返す＝1,000件の打ち切りなし）

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';
import { useRoles } from '../../hooks/useRoles';
import { todayJstStr, calcPayPeriodStartJst, payPeriodEnd, payPeriodLabel } from '../../lib/breakCalc';
import { TOGGLE_BLUE, tintBtn } from '../../lib/buttonStyles';
import {
  MIN_GROUP, OVERTIME_ROLLOUT_DATE, WEEKDAY_LABEL, SCHOOLS,
  addDays, daysBetween, prevPeriod, nextPeriod, fiscalYearStart, hm, hours1, durationText, median,
  overtimeByPerson, overtimeDistribution, overtimeByGroup, top20Share, overtimeBySchool, agreement36, overtimeFlow,
  partTimeDelta, holes, adjustStats, leaveSummary, paidLeaveRecord, leaveStateOf, leaveDates, expenseSummary, purchaseSummary,
  noticeSummary, safetySummary, overtimeTrend, jstDate,
  type OtData, type MiscData, type Person, type OtPerson, type HoleKind,
} from '../../lib/reportCalc';

type Tab = 'summary' | 'overtime' | 'field' | 'flow' | 'leave' | 'money' | 'board' | 'trend';
const TABS: [Tab, string][] = [
  ['summary', 'まとめ'], ['overtime', '⏱ 残業'], ['field', '🏫 現場'], ['flow', '🔁 申請の流れ'],
  ['leave', '🌿 休暇'], ['money', '💴 交通費・📦 備品'], ['board', '💬 連絡板・🆘 安否'], ['trend', '📈 推移'],
];
/** 読み込む期の数（推移と36協定の年度のため・今の期を含む） */
const PERIODS_BACK = 12;
const YELLOW = { bg: '#fff3cd', border: '#ffc107', text: '#856404' };
const GREEN = { bg: '#d4edda', border: '#c3e6cb', text: '#155724' };
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;
const pct = (x: number | null) => x === null ? '—' : `${Math.round(x * 100)}%`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

const ReportsTab: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const roles = useRoles();
  const today = todayJstStr();
  const current = calcPayPeriodStartJst(today);
  const periods = useMemo(() => {
    const out = [current];
    for (let i = 1; i < PERIODS_BACK; i++) out.unshift(prevPeriod(out[0]));
    return out;
  }, [current]);

  const [period, setPeriod] = useState(current);
  const [tab, setTab] = useState<Tab>('summary');
  const [ot, setOt] = useState<OtData | null>(null);
  const [misc, setMisc] = useState<MiscData | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [err, setErr] = useState('');
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#2b3035' : '#fff';
  const headBg = isDarkMode ? '#343a40' : '#f8f9fa';

  const load = useCallback(async () => {
    setErr('');
    const miscFrom = [periods[0], fiscalYearStart(today)].sort()[0];
    const [a, b, c] = await Promise.all([
      supabase.rpc('report_overtime_data', { p_from: periods[0], p_to: current }),
      supabase.rpc('report_misc_data', { p_from: miscFrom, p_to: payPeriodEnd(current) }),
      supabase.from('profiles').select('id, name, group_names, employment_type, role_title, is_active'),
    ]);
    const e = a.error ?? b.error ?? c.error;
    if (e) { setErr(`読み込めませんでした：${e.message}`); return; }
    setOt(a.data as OtData); setMisc(b.data as MiscData); setPeople((c.data ?? []) as Person[]);
  }, [periods, current, today]);
  useEffect(() => { load(); }, [load]);

  const nameOf = useCallback((id: string) => people.find(p => p.id === id)?.name ?? '（不明）', [people]);
  const banner = useMemo(() => ot?.settings?.banner_group_names ?? [], [ot]);

  // ── 期の数字（画面・Excel が同じものを使う） ──
  const inProgress = period === current;
  const periodTo = payPeriodEnd(period);
  const cutDay = inProgress ? daysBetween(period, today) + 1 : undefined;
  const prev = prevPeriod(period);
  const prevTo = cutDay !== undefined ? addDays(prev, cutDay - 1) : payPeriodEnd(prev);

  const R = useMemo(() => {
    if (!ot || !misc) return null;
    const ps = overtimeByPerson(ot, period, people);
    const psPrev = overtimeByPerson(ot, prev, people, cutDay);
    const sumPlus = (xs: OtPerson[]) => xs.reduce((s, p) => s + p.plannedPlus, 0);
    const active = (xs: OtPerson[]) => xs.filter(p => p.plannedPlus > 0);
    const holesNow = holes(misc, ot, period, inProgress ? today : periodTo);
    const holesPrev = holes(misc, ot, prev, prevTo);
    const a36 = agreement36(ot, today);
    const pendingOt = ot.rows.filter(r => r.st === 'requested' || r.st === 'reported').length;
    const pendingLeave = misc.leave.filter(l => leaveStateOf(l.st) === 'pending').length;
    const pendingExp = misc.expense.filter(x => x.st === 'pending').length;
    const pendingShift = misc.shift.filter(s => s.st === 'pending').length;
    const pendingPur = misc.purchase.filter(p => p.st.startsWith('pending')).length;
    return {
      ps, psPrev, total: sumPlus(ps), totalPrev: sumPlus(psPrev), n: active(ps).length, nPrev: active(psPrev).length,
      over: ps.filter(p => p.overThreshold), overPrev: psPrev.filter(p => p.overThreshold).length,
      dist: overtimeDistribution(ps), groups: overtimeByGroup(ps, banner), top20: top20Share(ps), schools: overtimeBySchool(ot, period),
      a36, near45: a36.filter(x => x.flags.length > 0),
      holesNow, holesPrev,
      part: partTimeDelta(misc, period),
      adjust: adjustStats(misc, period, periodTo),
      flow: overtimeFlow(ot, period),
      leave: leaveSummary(misc, ot, period, periodTo),
      // 🚨 共用の「管理者」アカウント（固定の役職）は人ではないので外す
      paid: paidLeaveRecord(misc, today, people.filter(pp => !roles.find(r => r.name === pp.role_title)?.is_fixed)),
      expense: expenseSummary(misc, period, periodTo),
      purchase: purchaseSummary(misc, period, periodTo),
      notice: noticeSummary(misc, period, periodTo),
      safety: safetySummary(misc, period, periodTo),
      pending: { ot: pendingOt, leave: pendingLeave, exp: pendingExp, shift: pendingShift, pur: pendingPur },
      // 推移：記録が始まる前の空の期は出さない（いちばん古い記録のある期から）
      trend: (() => { const t = overtimeTrend(ot, people, periods); const i = t.findIndex(x => x.total > 0 || x.people > 0); return i < 0 ? t : t.slice(i); })(),
    };
  }, [ot, misc, people, period, prev, prevTo, cutDay, inProgress, today, periodTo, banner, periods, roles]);

  // ── 前の期の「1枚」（締めた期の要点を3行・今の期を見ているときだけ） ──
  const lastClosed = useMemo(() => {
    if (!ot || !misc || !inProgress) return null;
    const p = prev;
    const ps = overtimeByPerson(ot, p, people).filter(x => x.plannedPlus > 0);
    const pp = prevPeriod(p);
    const psPP = overtimeByPerson(ot, pp, people).filter(x => x.plannedPlus > 0);
    const per = ps.length ? ps.reduce((s, x) => s + x.plannedPlus, 0) / ps.length : null;
    const perPP = psPP.length ? psPP.reduce((s, x) => s + x.plannedPlus, 0) / psPP.length : null;
    const h = holes(misc, ot, p, payPeriodEnd(p));
    const hPP = holes(misc, ot, pp, payPeriodEnd(pp));
    const adj = adjustStats(misc, p, payPeriodEnd(p));
    return { p, n: ps.length, per, perPP, h: h.length, hPP: hPP.length, over: ps.filter(x => x.overThreshold).length, adjPending: adj.pending };
  }, [ot, misc, inProgress, prev, people]);

  // ── 見た目の部品 ──
  const box: React.CSSProperties = { background: cardBg, border: `1px solid ${border}`, borderRadius: 8, padding: 14, marginBottom: 12, color: text };
  const h4: React.CSSProperties = { margin: '0 0 8px', fontSize: 15, color: text };
  const note: React.CSSProperties = { fontSize: 12, color: sub, margin: '6px 0 0', lineHeight: 1.6 };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 10px', borderRadius: 16, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : (isDarkMode ? '#343a40' : '#fff'), color: on ? '#fff' : text,
  });
  const Table: React.FC<{ head: string[]; rows: React.ReactNode[][]; right?: number[] }> = ({ head, rows, right = [] }) => rows.length === 0
    ? <div style={{ fontSize: 13, color: sub, padding: '4px 0' }}>この期はありません。</div>
    : (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ border: `1px solid ${border}`, background: headBg, padding: '6px 8px', textAlign: right.includes(i) ? 'right' : 'left', whiteSpace: 'nowrap', color: text }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ border: `1px solid ${border}`, padding: '6px 8px', textAlign: right.includes(j) ? 'right' : 'left', whiteSpace: 'nowrap', color: text }}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
  const Stat: React.FC<{ label: string; value: string; sub?: string; warn?: boolean }> = ({ label, value, sub: s, warn }) => (
    <div style={{ flex: '1 1 140px', border: `1px solid ${warn ? YELLOW.border : border}`, background: warn ? YELLOW.bg : cardBg, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 12, color: warn ? YELLOW.text : sub }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? YELLOW.text : text }}>{value}</div>
      {s && <div style={{ fontSize: 12, color: warn ? YELLOW.text : sub }}>{s}</div>}
    </div>
  );
  const Bar: React.FC<{ label: string; n: number; max: number; unit?: string }> = ({ label, n, max, unit = '人' }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '3px 0' }}>
      <span style={{ width: 90, flexShrink: 0, color: text }}>{label}</span>
      <span style={{ flex: 1, background: isDarkMode ? '#343a40' : '#eef1f4', borderRadius: 4, height: 14 }}>
        <span style={{ display: 'block', width: `${max ? (n / max) * 100 : 0}%`, height: 14, background: TOGGLE_BLUE, borderRadius: 4 }} />
      </span>
      <span style={{ width: 52, textAlign: 'right', color: text }}>{n}{unit}</span>
    </div>
  );
  const nameBtn = (key: string) => (
    <button type="button" onClick={() => setShown(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
      style={{ ...tintBtn(isDarkMode), padding: '4px 10px', fontSize: 12 }}>{shown.has(key) ? '名前を隠す' : '名前を見る'}</button>
  );
  const who = (key: string, id: string, i: number) => shown.has(key) ? nameOf(id) : `（${i + 1}）`;
  const cmp = (now: number, before: number, fmt: (x: number) => string) => {
    if (before === 0 && now === 0) return '前の期と同じ';
    const d = now - before;
    return `前の期 ${fmt(before)}（${d > 0 ? '↑' : d < 0 ? '↓' : '→'}）`;
  };

  // ── Excel（押したときだけ xlsx を読む） ──
  const saveExcel = async () => {
    if (!R) return;
    setSaving(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const add = (name: string, aoa: (string | number | null)[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
      add('まとめ', [
        ['給与期間', `${payPeriodLabel(period)}${inProgress ? '（途中）' : ''}`],
        ['残業の見込み（時間）', Number(hours1(R.total))], ['残業した人', R.n],
        ['目安を超えた人', R.over.length], ['36協定の目安に近い人', R.near45.length],
        ['欠勤・遅刻・早退（件）', R.holesNow.length],
        ['受理待ち 残業・時間', R.pending.ot], ['受理待ち 休暇', R.pending.leave], ['受理待ち 勤務変更', R.pending.shift],
        ['受理待ち 交通費', R.pending.exp], ['途中 備品', R.pending.pur],
      ]);
      add('残業_人ごと', [['名前', '部門', '確定（時間）', '見込み（時間）', '差し引き後の見込み', '目安（時間）', '目安超え', 'シフトの外（参考・時間）'],
        ...R.ps.map(p => [nameOf(p.id), p.group, Number(hours1(p.plus)), Number(hours1(p.plannedPlus)), hm(p.plannedTotal),
          p.threshold === null ? '対象外' : Number(hours1(p.threshold)), p.overThreshold ? '超え' : '', Number(hours1(p.outside))])]);
      add('36協定の目安', [['名前', '今月の確定', '今月の見込み', 'ペースだと', '年度の合計', '2〜6か月平均の最大', '45時間超えの月', 'メモ'],
        ...R.a36.filter(x => x.months.length > 0).map(x => [nameOf(x.id), Number(hours1(x.thisMonth.a)), Number(hours1(x.thisMonth.planned)),
          x.thisMonth.projected === null ? null : Number(hours1(x.thisMonth.projected)), Number(hours1(x.fyTotal)), Number(hours1(x.maxAvg2to6)), x.over45Count, x.flags.join('／')])]);
      add('現場_校舎×曜日', [['校舎', ...WEEKDAY_LABEL, '合計'], ...holeGrid(R.holesNow).map(r => [r.school, ...r.cells, r.total])]);
      add('休暇_種類', [['種類', '日数'], ...R.leave.byType.map(x => [x.type, x.days])]);
      add('有休の記録', [['名前', '今年度の日数', 'いちばん最近'], ...R.paid.map(x => [nameOf(x.id), x.days, x.last ?? ''])]);
      add('交通費', [['種類', '金額'], ...R.expense.byType.map(x => [x.type, x.amount])]);
      add('推移', [['給与期間', '残業の見込み（時間）', '人数', '1人あたり（時間）'],
        ...R.trend.map(t => [payPeriodLabel(t.period), Number(hours1(t.total)), t.people, t.perPerson === null ? null : Number(hours1(t.perPerson))])]);
      XLSX.writeFile(wb, `レポート_${period}.xlsx`);
    } catch (e) {
      setErr(`Excel を作れませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally { setSaving(false); }
  };

  if (err) return <div style={{ ...box, color: '#dc3545' }}>{err} <button type="button" onClick={load} style={tintBtn(isDarkMode)}>もう一度</button></div>;
  if (!R) return <div style={box}>読み込み中…</div>;

  const idx = periods.indexOf(period);
  const holeCount = (k: HoleKind, xs: typeof R.holesNow) => xs.filter(h => h.kind === k).length;
  const perPerson = R.n >= MIN_GROUP ? R.total / R.n : null;
  const perPersonPrev = R.nPrev >= MIN_GROUP ? R.totalPrev / R.nPrev : null;

  // ── まとめの一言（気になること・次にすること） ──
  const callouts: { text: string; to: Tab }[] = [];
  if (R.near45.length) callouts.push({ text: `36協定の目安（月45時間など）に近い人が${R.near45.length}人います。⏱ 残業で確かめてください。`, to: 'overtime' });
  if (R.over.length) callouts.push({ text: `残業の目安（${hours1(ot?.settings?.threshold_minutes ?? 0)}時間）を超えた人が${R.over.length}人います。`, to: 'overtime' });
  if (R.adjust.pending) callouts.push({ text: `シフト調整の相談で、決まっていないものが${R.adjust.pending}件あります。`, to: 'field' });
  const pendingAll = R.pending.ot + R.pending.leave + R.pending.shift + R.pending.exp;
  if (pendingAll >= 10) callouts.push({ text: `受理待ちが${pendingAll}件たまっています。🔁 申請の流れで確かめてください。`, to: 'flow' });

  return (
    <div style={{ color: text }}>
      {/* 期の切り替え */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" disabled={idx <= 0} onClick={() => setPeriod(periods[idx - 1])} style={{ ...tintBtn(isDarkMode), opacity: idx <= 0 ? 0.4 : 1 }}>‹</button>
        <strong style={{ fontSize: 16 }}>{payPeriodLabel(period)}{inProgress && <span style={{ fontSize: 12, color: sub, marginLeft: 6 }}>途中（{md(today)}まで）</span>}</strong>
        <button type="button" disabled={period === current} onClick={() => setPeriod(nextPeriod(period))} style={{ ...tintBtn(isDarkMode), opacity: period === current ? 0.4 : 1 }}>›</button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={saveExcel} disabled={saving} style={tintBtn(isDarkMode)}>{saving ? '作っています…' : 'Excel で保存'}</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" style={chip(tab === k)} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'summary' && <>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Stat label="残業の見込み（全体）" value={`${hours1(R.total)}時間`} sub={cmp(R.total, R.totalPrev, x => `${hours1(x)}時間`)} />
          <Stat label="残業した人・1人あたり" value={`${R.n}人・${perPerson === null ? '—' : `${hours1(perPerson)}時間`}`} sub={`前の期 ${R.nPrev}人・${perPersonPrev === null ? '—' : `${hours1(perPersonPrev)}時間`}`} />
          <Stat label="目安を超えた人" value={`${R.over.length}人`} sub={cmp(R.over.length, R.overPrev, x => `${x}人`)} warn={R.over.length > 0} />
          <Stat label="欠勤・遅刻・早退" value={`${R.holesNow.length}件`} sub={cmp(R.holesNow.length, R.holesPrev.length, x => `${x}件`)} />
        </div>
        {callouts.length === 0
          ? <div style={{ ...box, background: GREEN.bg, borderColor: GREEN.border, color: GREEN.text }}>いま気になることはありません。</div>
          : callouts.map((c, i) => (
            <div key={i} onClick={() => setTab(c.to)} style={{ ...box, background: YELLOW.bg, borderColor: YELLOW.border, color: YELLOW.text, cursor: 'pointer' }}>⚠️ {c.text} ›</div>
          ))}
        {lastClosed && (
          <div style={box}>
            <h4 style={h4}>締めた期（{payPeriodLabel(lastClosed.p)}）の要点</h4>
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              <div>・残業：{lastClosed.n}人・1人あたり {lastClosed.n >= MIN_GROUP && lastClosed.per !== null ? `${hours1(lastClosed.per)}時間` : '—'}
                {lastClosed.perPP !== null && lastClosed.per !== null && lastClosed.n >= MIN_GROUP && `（その前の期 ${hours1(lastClosed.perPP)}時間）`}／目安を超えた人 {lastClosed.over}人</div>
              <div>・欠勤・遅刻・早退：{lastClosed.h}件（その前の期 {lastClosed.hPP}件）</div>
              <div>・シフト調整の相談で決まっていないもの：{lastClosed.adjPending}件{lastClosed.adjPending > 0 ? ' → 🏫 現場で確かめる' : ''}</div>
            </div>
          </div>
        )}
        <div style={box}>
          <h4 style={h4}>受理待ち（いま）</h4>
          <div style={{ fontSize: 14, lineHeight: 1.9 }}>
            残業・時間 {R.pending.ot}件／休暇 {R.pending.leave}件／勤務変更 {R.pending.shift}件／交通費 {R.pending.exp}件／備品（途中）{R.pending.pur}件
          </div>
        </div>
        <p style={note}>
          ※ 前の期とは{inProgress ? `同じ日数（${cutDay}日目まで・その日までに出ていた申請）で` : ''}比べています。
          残業申請は {OVERTIME_ROLLOUT_DATE.slice(5).replace('-', '/')} に全員へ広げたので、それより前の期とは人数が違います（1人あたりで見てください）。
        </p>
      </>}

      {tab === 'overtime' && <>
        <div style={box}>
          <h4 style={h4}>1人あたりの残業（見込み）の分かれ方</h4>
          {R.dist.map(d => <Bar key={d.label} label={d.label} n={d.n} max={Math.max(1, ...R.dist.map(x => x.n))} />)}
          <p style={note}>※ 残業は「1件ずつの差し引きがプラスの分」の合計（本人の画面の「残業」と同じ数え方）。調整休で差し引く前の時間です。見込み＝確定＋受理待ち・実績報告待ち。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>部門ごと</h4>
          <Table head={['部門', '人数', '合計', '1人あたり']} right={[1, 2, 3]}
            rows={R.groups.map(g => [g.group, `${g.n}人`, `${hours1(g.total)}時間`, g.perPerson === null ? '—' : `${hours1(g.perPerson)}時間`])} />
          <p style={note}>※ 部門は残業の「部門のまとめ」と同じ分け方です。{MIN_GROUP}人未満の部門は1人あたりを出しません。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>目安を超えた人（{R.over.length}人）{R.over.length > 0 && nameBtn('over')}</h4>
          {R.over.length === 0 ? <div style={{ fontSize: 14 }}>いません。</div>
            : <Table head={['', '差し引き後の見込み', '目安', '残業（見込み）']} right={[1, 2, 3]}
              rows={R.over.map((p, i) => [who('over', p.id, i), hm(p.plannedTotal), p.threshold === null ? '—' : hm(p.threshold), `${hours1(p.plannedPlus)}時間`])} />}
          <p style={note}>※ 目安は管理画面 残業→設定 の値（人ごとの例外を含む・目安の対象外の人は数えません）。こちらは調整休などで差し引いたあとの時間で比べます。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>36協定の目安（暦の月・年度）{R.near45.length > 0 && nameBtn('a36')}</h4>
          {R.near45.length === 0 ? <div style={{ fontSize: 14 }}>目安に近い人はいません。</div>
            : <Table head={['', '今月 確定', '今月 見込み', 'ペースだと', '年度の合計', '2〜6か月平均', '今月 シフトの外（参考）', '']} right={[1, 2, 3, 4, 5, 6]}
              rows={R.near45.map((x, i) => [who('a36', x.id, i), hm(x.thisMonth.a), hm(x.thisMonth.planned),
                x.thisMonth.projected === null ? '—' : hm(x.thisMonth.projected), hm(x.fyTotal), hm(x.maxAvg2to6),
                hm(x.months.find(m => m.ym === today.slice(0, 7))?.b ?? 0), x.flags.join('／')])} />}
          <p style={note}>
            ※ 目安です（法令の判定ではありません）。月45時間・年360時間・2〜6か月の平均80時間・月100時間・45時間を超える月は年6回まで、の線で見ています。
            数えているのは「いつものシフトを超えた分」で、法定の8時間・40時間とは土台が違います。「シフトの外（参考）」は、働いた時間帯のうちいつものシフトに重ならない時間です。
            ペースの見込みは、月の10日目から出します。
          </p>
        </div>
        <div style={box}>
          <h4 style={h4}>負荷の偏り</h4>
          <div style={{ fontSize: 14 }}>残業の多い上位2割の人が、全体の {pct(R.top20)} を占めています。{R.top20 === null && '（残業した人が5人未満のため出していません）'}</div>
          <Table head={['校舎（申請の勤務地）', '残業', '人数']} right={[1, 2]}
            rows={R.schools.map(s => [s.school, `${hours1(s.minutes)}時間`, `${s.people}人`])} />
        </div>
      </>}

      {tab === 'field' && <>
        <div style={box}>
          <h4 style={h4}>パート・アルバイトの方の時間（勤務変更）</h4>
          <div style={{ fontSize: 14, lineHeight: 1.9 }}>
            予定より長く働いた分 {hm(R.part.plus)}／短かった分 {hm(R.part.minus)}（{R.part.n}件・{R.part.people}人）
          </div>
          {R.part.bySchool.length > 0 && <Table head={['校舎', '長く', '短く']} right={[1, 2]}
            rows={R.part.bySchool.map(s => [s.school, hm(s.plus), hm(s.minus)])} />}
          <p style={note}>※ 勤務変更の「予定」と「実際」の時間帯の長さの差です（休憩は引いていません）。欠勤は予定の時間がまるごと「短く」に入ります。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>欠勤・遅刻・早退（校舎×曜日）</h4>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            欠勤 {holeCount('欠勤', R.holesNow)}件・遅刻 {holeCount('遅刻', R.holesNow)}件・早退 {holeCount('早退', R.holesNow)}件
          </div>
          <Table head={['校舎', ...WEEKDAY_LABEL, '合計']} right={[1, 2, 3, 4, 5, 6, 7, 8]}
            rows={holeGrid(R.holesNow).map(r => [r.school, ...r.cells.map(c => c || ''), r.total])} />
          <p style={note}>※ 勤怠カレンダーの予定・残業申請・勤務変更から集め、同じ人・同じ日・同じ種類は1件にしています。時間調整（遅出・早上がり）は入れていません。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>シフト調整の相談</h4>
          <div style={{ fontSize: 14, lineHeight: 1.9 }}>
            この期の休み {R.adjust.n}件／決まった {R.adjust.decided}件／決まっていない {R.adjust.pending}件
            ／決まるまで（真ん中）{R.adjust.medianDays === null ? '—' : `${Math.round(R.adjust.medianDays * 10) / 10}日`}
          </div>
        </div>
      </>}

      {tab === 'flow' && <>
        <div style={box}>
          <h4 style={h4}>受理までの時間（真ん中・遅いほう1割）</h4>
          <Table head={['申請', '件数', '真ん中', '遅いほう1割', 'メモ']} right={[1, 2, 3]}
            rows={[
              ['残業・時間', `${R.flow.n}件`, durationText(R.flow.medianH), durationText(R.flow.p90H), `自分で受理 ${R.flow.selfN}件は除く・差し戻し ${R.flow.returned}件・事前申請 ${pct(R.flow.preRate)}`],
              flowRow('勤務変更', misc!.shift.filter(s => s.wd >= period && s.wd <= periodTo && s.st !== 'cancelled'), s => s.self ? null : s.cf ? hrs(s.c, s.cf) : null, s => s.self),
              flowRow('休暇', misc!.leave.filter(l => leaveStateOf(l.st) === 'approved' && leaveDates(l).some(d => d >= period && d <= periodTo)), l => (l.ap2 ?? l.ap) ? hrs(l.c, (l.ap2 ?? l.ap)!) : null),
              ['交通費', '', durationText(R.expense.medianH), '', ''],
              ['備品', `${R.purchase.n}件`, durationText(R.purchase.medianH), '', ''],
            ]} />
          <p style={note}>※ 自分で受理したもの・予定どおりで受理のいらないものは、時間から除いています。休暇は最後の受理まで（2人目まで）です。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>修正依頼（この期に届いたもの）</h4>
          {(() => {
            const cs = misc!.corr.filter(c => jstDate(c.c) >= period && jstDate(c.c) <= periodTo);
            const label: Record<string, string> = { leave: '休暇', overtime: '残業・時間', shift: '勤務変更', expense: '交通費' };
            const m = new Map<string, number>(); for (const c of cs) m.set(label[c.type] ?? c.type, (m.get(label[c.type] ?? c.type) ?? 0) + 1);
            return cs.length === 0 ? <div style={{ fontSize: 14 }}>ありません。</div>
              : <div style={{ fontSize: 14 }}>{[...m.entries()].map(([k, v]) => `${k} ${v}件`).join('／')}（対応待ち {cs.filter(c => c.st === 'pending').length}件）</div>;
          })()}
        </div>
      </>}

      {tab === 'leave' && <>
        <div style={box}>
          <h4 style={h4}>休んだ日数（受理済み・休んだ日で数える）</h4>
          {R.leave.byType.length === 0 ? <div style={{ fontSize: 14 }}>ありません。</div>
            : <Table head={['種類', '日数']} right={[1]} rows={R.leave.byType.map(x => [x.type, `${x.days}日`])} />}
          <p style={note}>
            ※ 申請中 {R.leave.pending}件。何日前に申請されたか（真ん中）{R.leave.advanceMedian === null ? '—' : `${R.leave.advanceMedian}日前`}・3日前より遅いもの {R.leave.lateCount}件／{R.leave.total}件。
            調整休・振替休日は 10/16 から残業申請で出すので、残業申請の分も足しています。
          </p>
        </div>
        <div style={box}>
          <h4 style={h4}>有休の取得の記録（今年度・{fiscalYearStart(today).slice(0, 4)}年4月〜）{nameBtn('paid')}</h4>
          <Table head={['', '日数', 'いちばん最近']} right={[1]}
            rows={R.paid.map((x, i) => [who('paid', x.id, i), `${x.days}日`, x.last ? md(x.last) : '—'])} />
          <p style={note}>
            ※ 年5日の取得義務は、本来は有休が付いた日から1年で数えます。この表は年度（4月〜3月）で数えた記録です。受理済みの日数で、今日までの分です（休暇に半日の項目は無いので1日単位）。
          </p>
        </div>
      </>}

      {tab === 'money' && <>
        <div style={box}>
          <h4 style={h4}>💴 交通費（使った日で数える・受理済み）</h4>
          <div style={{ fontSize: 14, marginBottom: 6 }}>合計 {yen(R.expense.approved)}／受理待ち {R.expense.pendingN}件（{yen(R.expense.pendingAmt)}）／差し戻し {R.expense.rejected}件</div>
          <Table head={['種類', '金額']} right={[1]} rows={R.expense.byType.map(x => [x.type, yen(x.amount)])} />
        </div>
        <div style={box}>
          <h4 style={h4}>📦 備品購入（この期に出たもの）</h4>
          <div style={{ fontSize: 14, marginBottom: 6 }}>{R.purchase.n}件・{yen(R.purchase.amount)}／途中 {R.purchase.pending}件／精算の記録 {R.purchase.reimburse}件</div>
          <Table head={['種類', '金額']} right={[1]} rows={R.purchase.byType.map(x => [x.type, yen(x.amount)])} />
        </div>
      </>}

      {tab === 'board' && <>
        <div style={box}>
          <h4 style={h4}>💬 連絡板のお知らせ（グループ・DM は除く）</h4>
          <div style={{ fontSize: 14, lineHeight: 1.9 }}>
            お知らせ {R.notice.posts}件／読まれた割合 {pct(R.notice.readRate)}／読まれるまで（真ん中）{R.notice.medianMin === null ? '—' : durationText(R.notice.medianMin / 60)}
            {R.notice.reqPosts > 0 && `／確認が必要なもの ${R.notice.reqPosts}件・確認した割合 ${pct(R.notice.confirmRate)}`}
          </div>
          <p style={note}>※ 1人ずつの未読の一覧は作りません（全体の数字だけ）。</p>
        </div>
        <div style={box}>
          <h4 style={h4}>🆘 安否確認（試しは除く）</h4>
          {R.safety.length === 0 ? <div style={{ fontSize: 14 }}>この期はありません。</div>
            : <Table head={['日付', '答えた割合', '全員が答えるまで']} right={[1, 2]}
              rows={R.safety.map(s => [md(s.date), pct(s.rate), s.allHours === null ? 'まだ' : durationText(s.allHours)])} />}
        </div>
      </>}

      {tab === 'trend' && <div style={box}>
        <h4 style={h4}>残業（見込み）の推移</h4>
        <TrendChart data={R.trend} isDarkMode={isDarkMode} />
        <Table head={['給与期間', '合計', '人数', '1人あたり']} right={[1, 2, 3]}
          rows={[...R.trend].reverse().map(t => [payPeriodLabel(t.period), `${hours1(t.total)}時間`, `${t.people}人`, t.people >= MIN_GROUP && t.perPerson !== null ? `${hours1(t.perPerson)}時間` : '—'])} />
        <p style={note}>※ 縦の点線は、残業申請を全員へ広げた期（{OVERTIME_ROLLOUT_DATE.slice(5).replace('-', '/')}）。それより前は使っていた人が少ないので、1人あたりで比べてください。</p>
      </div>}
    </div>
  );

  function hrs(a: string, b: string) { return (new Date(b).getTime() - new Date(a).getTime()) / 3600_000; }
  function flowRow<X>(label: string, xs: X[], wait: (x: X) => number | null, isSelf?: (x: X) => boolean): React.ReactNode[] {
    const ws = xs.map(wait).filter((w): w is number => w !== null);
    const sorted = [...ws].sort((p, q) => p - q);
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)] : null;
    const selfN = isSelf ? xs.filter(isSelf).length : 0;
    return [label, `${xs.length}件`, durationText(median(ws)), durationText(p90), selfN ? `自分で受理 ${selfN}件は除く` : ''];
  }
};

/** 校舎×曜日の表（月〜日の順・日曜は最後） */
function holeGrid(hs: { school: string; wd: number }[]): { school: string; cells: number[]; total: number }[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const schools = [...SCHOOLS, '在宅', 'その他（出張先など）', '不明'].filter(s => hs.some(h => h.school === s));
  return schools.map(s => {
    const mine = hs.filter(h => h.school === s);
    return { school: s, cells: order.map(w => mine.filter(h => h.wd === w).length), total: mine.length };
  });
}

/** 推移の折れ線（合計＝青・1人あたり＝オレンジ）。全員へ広げた期に点線 */
const TrendChart: React.FC<{ data: { period: string; total: number; perPerson: number | null; people: number }[]; isDarkMode: boolean }> = ({ data, isDarkMode }) => {
  const W = 640, H = 200, P = 34;
  const maxT = Math.max(60, ...data.map(d => d.total));
  const maxP = Math.max(60, ...data.map(d => d.perPerson ?? 0));
  const x = (i: number) => P + (data.length <= 1 ? 0 : i * (W - P * 2) / (data.length - 1));
  const yT = (v: number) => H - P - (v / maxT) * (H - P * 2);
  const yP = (v: number) => H - P - (v / maxP) * (H - P * 2);
  const line = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const rollIdx = data.findIndex(d => d.period === calcPayPeriodStartJst(OVERTIME_ROLLOUT_DATE));
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const ORANGE = '#e8590c';
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 320, maxWidth: W }}>
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke={sub} strokeWidth={1} />
        {rollIdx >= 0 && <line x1={x(rollIdx)} y1={P / 2} x2={x(rollIdx)} y2={H - P} stroke={sub} strokeDasharray="4 4" />}
        <path d={line(data.map((d, i) => [x(i), yT(d.total)]))} fill="none" stroke={TOGGLE_BLUE} strokeWidth={2} />
        <path d={line(data.filter(d => d.people >= MIN_GROUP && d.perPerson !== null).map(d => [x(data.indexOf(d)), yP(d.perPerson!)]))} fill="none" stroke={ORANGE} strokeWidth={2} />
        {data.map((d, i) => <text key={d.period} x={x(i)} y={H - P + 16} fontSize={10} textAnchor="middle" fill={sub}>{Number(d.period.slice(5, 7))}/16</text>)}
        <text x={P} y={14} fontSize={11} fill={TOGGLE_BLUE}>━ 合計（最大 {hours1(maxT)}時間）</text>
        <text x={W / 2} y={14} fontSize={11} fill={ORANGE}>━ 1人あたり（最大 {hours1(maxP)}時間）</text>
      </svg>
    </div>
  );
};

export default ReportsTab;
