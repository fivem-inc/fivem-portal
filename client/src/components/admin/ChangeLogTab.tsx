// 管理画面「📋 受理済みの変更」（2026-10-26 ユーザー確定・計画 docs/計画-経理向け変わった申請の一覧.md）。
// 経理が給与期間のデータを取ったあとに、受理済みの申請が変わったかを見る。記録は DB の application_change_log（トリガーが書く）。
// ・最初は「今の給与期間」「人ごと」「給与の数字にかかわるもの」「未確認だけ」。受理の前の動きは下にたたむ
// ・確認は1行ずつ（2026-10-26 作り直し・UI/UX の専門家のレビュー）：行のチェック → 青い［選んだ◯件を確認済みにする］。
//   「表示中の未確認をすべて選ぶ」「この人の◯件を選ぶ」でまとめて選べる。印は DB の change_log_checks（記録の行ごと・一度に付けた分は同じ batch）
//   🚨 前は時刻1つの印で「その時刻までは全部」だったため、絞り込みで押すと見えていない種類まで確認済みになっていた
// ・Excel・CSV を出した時刻（payroll_check_marks）は「データを出した時刻」としてだけ使う（確認済みにはしない）。それより後の変更に「データを出したあと」
// ・締めた期（支給月の17日を過ぎた期）への変更は赤い1行（上の絞り込みに合わせる）
// ・文字の段：主（日付・給与への響き 15px 太字）／従（中身 13px）／注記（した人・日時など 12px 灰色）
// ・いちばん下に「削除の記録」（修正依頼のタブから移した）
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import DeletionLogSection from './DeletionLogSection';
import LoadFailedNotice from '../LoadFailedNotice';
import { NOTICE_LOAD_FAILED_TEXT } from '../../lib/netFailure';
import { backBtn, primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { calcPayPeriodStartJst, payMonthPeriodLabel, payPeriodEnd, payPeriodLabel, todayJstStr } from '../../lib/breakCalc';
import { payrollPeriodOptions } from '../../lib/payrollSheet';
import { PAYROLL_CHECK_KIND_LABEL } from '../../lib/payrollCheckMark';
import { APPLICATION_KIND_LABEL, type ApplicationKind } from '../../lib/applicationStatus';
import {
  changeLines, changeParts, datesText, eventText, isAfterClose, isPayrollRelevant, itemHeadText, itemTypeText, jstAt, mergeRows, overtimeMinutesDelta,
  type ChangeItem, type ChangeLogData,
} from '../../lib/changeLog';
import { formatMin } from '../../lib/breakCalc';

// 🚨 交通費は出さない（2026-10-26 ユーザー指示「交通費は不要」）。記録（DB）は今までどおり残っている
const KINDS: ApplicationKind[] = ['overtime', 'leave', 'shift', 'attendance'];
const shownKind = (it: ChangeItem) => it.kind !== 'expense';
const signed = (min: number) => (min === 0 ? '±0:00' : `${min < 0 ? '−' : '+'}${formatMin(min)}`);
const WARN_LINE = '#ffc107';

type CheckInfo = { at: string; by: string | null; batch: string };

const ChangeLogTab: React.FC = () => {
  const { supabase, isDarkMode } = useAdminPanel() as { supabase: typeof import('../../lib/supabaseClient').supabase; isDarkMode: boolean };
  const isDark = isDarkMode;
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#2b3035' : '#fff';

  const current = calcPayPeriodStartJst(todayJstStr());
  const [period, setPeriod] = useState(current);
  const [view, setView] = useState<'person' | 'time'>('person');
  const [kind, setKind] = useState<ApplicationKind | 'all'>('all');
  const [onlyUnchecked, setOnlyUnchecked] = useState(true);
  const [data, setData] = useState<ChangeLogData | null>(null);
  const [checks, setChecks] = useState<Map<string, CheckInfo>>(new Map());
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ batch: string; count: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFolded, setShowFolded] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const loadChecks = useCallback(async (d: ChangeLogData) => {
    const ids = [...(d.rows ?? []), ...(d.closed ?? [])].map(r => r.id);
    if (ids.length === 0) { setChecks(new Map()); return true; }
    const { data: rows, error } = await supabase.rpc('admin_change_log_checks', { p_ids: ids });
    if (error) { console.error('[受理済みの変更] 確認の印を読めませんでした:', error.message); return false; }
    const m = new Map<string, CheckInfo>();
    for (const r of (rows ?? []) as { log_id: string; checked_at: string; checked_by_name: string | null; batch_id: string }[]) {
      m.set(r.log_id, { at: r.checked_at, by: r.checked_by_name, batch: r.batch_id });
    }
    setChecks(m);
    return true;
  }, [supabase]);

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('admin_change_log', { p_period: period });
    if (error) { console.error('[受理済みの変更] 読み込みに失敗:', error.message); setFailed(true); return; }
    // 🚨 確認の印が読めないときは一覧を出さない（全部が未確認に見えて、確認済みのものをもう一度確かめることになるため）
    if (!(await loadChecks(d as ChangeLogData))) { setFailed(true); return; }
    setData(d as ChangeLogData); setFailed(false);
  }, [supabase, period, loadChecks]);
  useEffect(() => { setData(null); setSelected(new Set()); setDone(null); void load(); }, [load]);

  const items = useMemo(() => mergeRows(data?.rows ?? []).filter(shownKind), [data]);
  const closedAll = useMemo(() => mergeRows(data?.closed ?? []).filter(it => shownKind(it) && isPayrollRelevant(it) && isAfterClose(it)), [data]);
  const isChecked = useCallback((it: ChangeItem) => it.rows.every(r => checks.has(r.id)), [checks]);
  const checkOf = (it: ChangeItem): CheckInfo | null => {
    let best: CheckInfo | null = null;
    for (const r of it.rows) { const c = checks.get(r.id); if (c && (!best || c.at > best.at)) best = c; }
    return best;
  };
  // データを出した時刻（いちばん新しいもの）。それより後の変更に「データを出したあと」
  const exportMark = (data?.marks ?? []).find(m => m.kind !== 'manual') ?? null;
  const exportAt = exportMark ? new Date(exportMark.upto).getTime() : null;
  const afterExport = (it: ChangeItem) => exportAt !== null && new Date(it.at).getTime() > exportAt;

  const relevant = items.filter(isPayrollRelevant);
  const folded = items.filter(it => !isPayrollRelevant(it));
  const byKind = (it: ChangeItem) => kind === 'all' || it.kind === kind;
  const inKind = relevant.filter(byKind);
  const shown = onlyUnchecked ? inKind.filter(it => !isChecked(it)) : inKind;
  const uncheckedInKind = inKind.filter(it => !isChecked(it)).length;
  const uncheckedOther = relevant.filter(it => !byKind(it) && !isChecked(it)).length;
  // 締めたあとの期への変更も、上の絞り込み（残業・休暇など）に合わせる（2026-10-26 ユーザー指摘）
  const closedItems = closedAll.filter(byKind);
  const closedUnchecked = closedItems.filter(it => !isChecked(it)).length;

  // 人ごと（従業員番号の順 → 名前）／時系列（新しい順）
  const groups = useMemo(() => {
    if (view === 'time') return [{ key: 'all', title: '', no: '', items: [...shown].sort((a, b) => (a.at < b.at ? 1 : -1)) }];
    const m = new Map<string, { key: string; title: string; no: string; items: ChangeItem[] }>();
    for (const it of shown) {
      const k = it.applicant_id ?? 'unknown';
      if (!m.has(k)) m.set(k, { key: k, title: it.applicant_name, no: it.employee_no ?? '', items: [] });
      m.get(k)!.items.push(it);
    }
    const arr = [...m.values()];
    arr.forEach(g => g.items.sort((a, b) => (a.target_dates[0] ?? '').localeCompare(b.target_dates[0] ?? '') || a.at.localeCompare(b.at)));
    arr.sort((a, b) => (a.no && b.no ? Number(a.no) - Number(b.no) : a.no ? -1 : b.no ? 1 : a.title.localeCompare(b.title, 'ja')));
    return arr;
  }, [shown, view]);

  // 選べるのは未確認の行だけ（画面に出ているもの）
  const selectable = [...shown, ...(showClosed ? closedItems : [])].filter(it => !isChecked(it));
  const selectedItems = selectable.filter(it => selected.has(it.key));
  const toggle = (keys: string[], on: boolean) => setSelected(prev => {
    const n = new Set(prev); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n;
  });
  const allShownKeys = shown.filter(it => !isChecked(it)).map(it => it.key);
  const allShownOn = allShownKeys.length > 0 && allShownKeys.every(k => selected.has(k));

  const doCheck = async () => {
    if (selectedItems.length === 0) return;
    setBusy(true); setMsg(null); setDone(null);
    const ids = selectedItems.flatMap(it => it.rows.map(r => r.id));
    const { data: r, error } = await supabase.rpc('admin_change_log_check', { p_ids: ids });
    if (error || !r) {
      console.error('[受理済みの変更] 確認済みにできませんでした:', error?.message);
      setBusy(false); setMsg('確認済みにできませんでした。もう一度押してください。'); return;
    }
    const res = r as { batch: string; count: number };
    const n = selectedItems.length;
    setSelected(new Set());
    if (data) await loadChecks(data);
    setBusy(false);
    setDone({ batch: res.batch, count: n });
  };
  const undoBatch = async () => {
    if (!done) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc('admin_change_log_uncheck', { p_ids: null, p_batch: done.batch });
    if (error) { console.error('[受理済みの変更] 元に戻せませんでした:', error.message); setBusy(false); setMsg('元に戻せませんでした。もう一度押してください。'); return; }
    if (data) await loadChecks(data);
    setBusy(false); setDone(null);
  };
  const uncheckOne = async (it: ChangeItem) => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc('admin_change_log_uncheck', { p_ids: it.rows.map(r => r.id), p_batch: null });
    if (error) { console.error('[受理済みの変更] 未確認に戻せませんでした:', error.message); setMsg('未確認に戻せませんでした。もう一度押してください。'); }
    if (data) await loadChecks(data);
    setBusy(false);
  };

  const exportXlsx = async () => {
    setBusy(true); setMsg(null);
    try {
      const XLSX = await import('xlsx');
      const head = ['日時', '名前', '従業員番号', '申請', '種類', '対象日', '何が起きたか', '変わった中身', '残業の時間数の差（分）', '給与にかかわる', '締め後', 'した人', '確認', '備考'];
      const all = [...items].sort((a, b) => a.at.localeCompare(b.at));
      const rows = all.map(it => {
        const c = isChecked(it) ? checkOf(it) : null;
        return [
          jstAt(it.at), it.applicant_name, it.employee_no ?? '', APPLICATION_KIND_LABEL[it.kind], itemTypeText(it), it.target_dates.join(' '),
          eventText(it), changeLines(it).join(' ／ '), overtimeMinutesDelta(it) ?? '', isPayrollRelevant(it) ? 'はい' : '', isAfterClose(it) ? '締め後' : '',
          it.actor, c ? `確認済み ${jstAt(c.at)}${c.by ? ` ${c.by}` : ''}` : '未確認',
          [it.rebuilt ? '復元した記録' : '', it.approxWindow ? `時刻は ${it.approxWindow} のどこか` : '', it.reason ?? ''].filter(Boolean).join('・'),
        ];
      });
      const per = new Map<string, { name: string; no: string; n: number; min: number }>();
      for (const it of all.filter(isPayrollRelevant)) {
        const k = it.applicant_id ?? 'unknown';
        const p = per.get(k) ?? { name: it.applicant_name, no: it.employee_no ?? '', n: 0, min: 0 };
        p.n++; p.min += overtimeMinutesDelta(it) ?? 0; per.set(k, p);
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), '変更の一覧');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['名前', '従業員番号', '給与にかかわる変更（件）', '残業の時間数の差の合計（分）'],
        ...[...per.values()].sort((a, b) => Number(a.no || 9999) - Number(b.no || 9999)).map(p => [p.name, p.no, p.n, p.min])]), '人ごとの差');
      XLSX.writeFile(wb, `受理済みの変更_${payPeriodLabel(period).replace(/\//g, '-')}.xlsx`);
    } catch (e) {
      setMsg('Excel を作れませんでした：' + (e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  };

  const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 12, borderRadius: 14, padding: '3px 10px', cursor: 'pointer',
    border: `1px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : sub,
  });
  const seg = (on: boolean): React.CSSProperties => ({
    fontSize: 13, padding: '4px 12px', cursor: 'pointer', border: 'none',
    background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : TOGGLE_BLUE,
  });
  const badge = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: 11, fontWeight: 600, borderRadius: 4, padding: '0 6px', background: bg, color: fg, whiteSpace: 'nowrap', marginLeft: 6 });
  const box: React.CSSProperties = { width: 16, height: 16, cursor: 'pointer', accentColor: TOGGLE_BLUE, margin: 0 };
  const link: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: TOGGLE_BLUE, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' };

  const row = (it: ChangeItem, showName: boolean) => {
    const checked = isChecked(it);
    const c = checked ? checkOf(it) : null;
    const delta = overtimeMinutesDelta(it);
    const main = checked ? sub : text;
    const notes = [it.actor, jstAt(it.at), it.rebuilt ? '復元した記録' : '', it.approxWindow ? `時刻は ${it.approxWindow} のどこか` : '', it.reason ? `理由：${it.reason}` : ''].filter(Boolean).join('・');
    return (
      <div key={it.key} style={{
        display: 'grid', gridTemplateColumns: '28px 150px minmax(0,1fr) 90px', gap: 8, padding: '10px 0 10px 6px', alignItems: 'start',
        borderBottom: `1px solid ${border}`, borderLeft: `3px solid ${checked ? 'transparent' : WARN_LINE}`, borderRadius: 0, lineHeight: 1.5,
      }}>
        <span style={{ paddingTop: 3 }}>
          {checked
            ? <span style={{ fontSize: 12, color: sub }}>✓</span>
            : <input type="checkbox" aria-label="この行を選ぶ" style={box} checked={selected.has(it.key)} onChange={e => toggle([it.key], e.target.checked)} />}
        </span>
        <span>
          <div style={{ fontSize: 15, fontWeight: checked ? 400 : 700, color: main }}>{datesText(it.target_dates)}</div>
          <div style={{ fontSize: 13, color: main }}>{itemHeadText(it)}</div>
        </span>
        <span style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: main }}>
            {showName && <span style={{ fontWeight: 700 }}>{it.applicant_name}　</span>}
            {eventText(it)}
            {isAfterClose(it) && <span style={badge('#ffe5d0', '#984c0c')}>締め後</span>}
            {!checked && afterExport(it) && <span style={badge('#fff3cd', '#856404')}>データを出したあと</span>}
          </div>
          {changeParts(it).map((p, i) => (
            <div key={i} style={{ fontSize: 13, color: main }}>
              {p.label && <span style={{ fontSize: 12, color: sub, marginRight: 8 }}>{p.label}</span>}{p.value}
            </div>
          ))}
          <div style={{ fontSize: 12, color: sub }}>{notes}</div>
          {checked && c && (
            <div style={{ fontSize: 12, color: sub }}>
              確認済み（{jstAt(c.at)}{c.by ? `・${c.by}` : ''}）
              <button type="button" disabled={busy} onClick={() => void uncheckOne(it)} style={{ ...link, marginLeft: 8 }}>未確認に戻す</button>
            </div>
          )}
        </span>
        <span style={{ textAlign: 'right', paddingRight: 4 }}>
          {delta !== null && (delta === 0
            ? <span style={{ fontSize: 12, color: sub }}>±0:00</span>
            : <span style={{ fontSize: 15, fontWeight: checked ? 400 : 700, color: main }}>{signed(delta)}</span>)}
        </span>
      </div>
    );
  };

  return (
    <div style={{ color: text, textAlign: 'left' }}>
      <h3 style={{ margin: '0 0 8px' }}>給与期間 {payPeriodLabel(period)} の変更</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13 }}>
          {payrollPeriodOptions(current).map(p => <option key={p} value={p}>{payPeriodEnd(p).slice(0, 4)}年{payMonthPeriodLabel(p)}{p === current ? '（今の期）' : ''}</option>)}
        </select>
        <span style={{ display: 'inline-flex', border: `1px solid ${TOGGLE_BLUE}`, borderRadius: 6, overflow: 'hidden' }}>
          <button type="button" style={seg(view === 'person')} onClick={() => setView('person')}>人ごと</button>
          <button type="button" style={seg(view === 'time')} onClick={() => setView('time')}>時系列</button>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" style={chip(kind === 'all')} onClick={() => setKind('all')}>すべて</button>
        {KINDS.map(k => <button key={k} type="button" style={chip(kind === k)} onClick={() => setKind(k)}>{APPLICATION_KIND_LABEL[k]}</button>)}
      </div>

      {failed && <LoadFailedNotice text={NOTICE_LOAD_FAILED_TEXT.replace('お知らせ', '受理済みの変更')} onRetry={() => { setFailed(false); void load(); }} />}
      {!failed && !data && <div style={{ padding: 16, color: sub, fontSize: 13 }}>読み込んでいます…</div>}

      {data && (
        <>
          {/* 状況の1行（色は付けない・赤は締め後だけに取っておく） */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: sub }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: uncheckedInKind > 0 ? text : sub }}>未確認 {uncheckedInKind}件</span>
              ／全{inKind.length}件
              {uncheckedOther > 0 && <>（ほかの種類に未確認 {uncheckedOther}件）</>}
            </span>
            <label style={{ fontSize: 13, color: text, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" style={box} checked={onlyUnchecked} onChange={e => { setOnlyUnchecked(e.target.checked); setSelected(new Set()); }} />
              未確認だけ表示
            </label>
          </div>
          {exportMark && (
            <div style={{ fontSize: 12, color: sub, marginBottom: 8 }}>
              最後にデータを出した：{jstAt(exportMark.upto)}（{PAYROLL_CHECK_KIND_LABEL[exportMark.kind] ?? exportMark.kind}{exportMark.marked_by_name ? `・${exportMark.marked_by_name}` : ''}）
            </div>
          )}

          {closedItems.length > 0 && (
            <div style={{ background: '#f8d7da', border: '1px solid #dc3545', color: '#842029', borderRadius: 8, padding: '6px 12px', marginBottom: 10, fontSize: 13.5 }}>
              ⚠️ 締めたあとの期の変更 {closedItems.length}件{closedUnchecked < closedItems.length ? `（未確認 ${closedUnchecked}件）` : ''}
              <button type="button" onClick={() => setShowClosed(v => !v)}
                style={{ background: 'none', border: 'none', color: '#842029', textDecoration: 'underline', fontSize: 13, cursor: 'pointer', marginLeft: 6 }}>{showClosed ? '閉じる ▲' : '見る ▼'}</button>
              {showClosed && <div style={{ background: cardBg, color: text, borderRadius: 6, padding: '0 8px', marginTop: 6 }}>{closedItems.map(it => row(it, true))}</div>}
            </div>
          )}

          {/* 選んで確認済みにする（押すボタンは1つ） */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${border}`, borderBottom: `1px solid ${border}`, padding: '8px 0', marginBottom: 4 }}>
            <label style={{ fontSize: 13, color: allShownKeys.length ? text : sub, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: allShownKeys.length ? 'pointer' : 'default' }}>
              <input type="checkbox" style={box} disabled={allShownKeys.length === 0} checked={allShownOn} onChange={e => toggle(allShownKeys, e.target.checked)} />
              表示中の未確認をすべて選ぶ
            </label>
            <button type="button" disabled={busy || selectedItems.length === 0} onClick={() => void doCheck()}
              style={{ ...primaryBtn({ disabled: busy || selectedItems.length === 0 }), padding: '8px 18px' }}>
              選んだ{selectedItems.length}件を確認済みにする
            </button>
          </div>
          {done && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', borderRadius: 8, padding: '9px 12px', margin: '6px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600 }}>✓ {done.count}件を確認済みにしました</span>
              <button type="button" disabled={busy} onClick={() => void undoBatch()} style={{ ...backBtn(false), background: '#fff', padding: '4px 14px', fontSize: 13 }}>元に戻す</button>
            </div>
          )}
          {msg && <div style={{ color: '#842029', fontSize: 13, margin: '6px 0' }}>{msg}</div>}

          {shown.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: sub, fontSize: 13 }}>
              {onlyUnchecked && inKind.length > 0 ? '未確認の変更はありません。' : 'この給与期間に、受理済みの申請の変更はありません。'}
            </div>
          )}
          {groups.map(g => {
            const keys = g.items.filter(it => !isChecked(it)).map(it => it.key);
            const allOn = keys.length > 0 && keys.every(k => selected.has(k));
            return (
              <div key={g.key} style={{ marginBottom: 6 }}>
                {g.title && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 0 6px', borderBottom: `1px solid ${border}` }}>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>
                      {g.title}{g.no ? `（${g.no}）` : ''}
                      <span style={{ fontSize: 13, color: sub, fontWeight: 400 }}>　未確認 {keys.length}件／{g.items.length}件</span>
                    </span>
                    {keys.length > 0 && (
                      <button type="button" style={link} onClick={() => toggle(keys, !allOn)}>{allOn ? 'この人の選択を外す' : `この人の${keys.length}件を選ぶ`}</button>
                    )}
                  </div>
                )}
                {g.items.map(it => row(it, view === 'time'))}
              </div>
            );
          })}

          {folded.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setShowFolded(v => !v)}
                style={{ background: 'none', border: 'none', padding: '6px 0', color: sub, fontSize: 13, cursor: 'pointer' }}>
                受理の前の動き（申請中の直し・受理の途中の段）{folded.length}件 {showFolded ? '▲' : '▼'}
              </button>
              {showFolded && folded.filter(byKind).map(it => row(it, true))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={() => void exportXlsx()} style={{ ...tintBtn(isDark), flex: 1 }}>📥 この一覧を Excel で出す</button>
          </div>
          <button type="button" onClick={() => setShowHelp(v => !v)} style={{ ...link, marginTop: 10, color: sub }}>このページの見方 {showHelp ? '▲' : '▼'}</button>
          {showHelp && (
            <p style={{ fontSize: 12, color: sub, margin: '6px 0 0', lineHeight: 1.7 }}>
              残業・休暇・勤務変更・勤怠カレンダーの予定が、あとから変わったときの記録です（管理者だけが見られます）。
              行の左のチェックで選び、［選んだ◯件を確認済みにする］を押すと、その行だけが確認済みになります。確認済みの行の［未確認に戻す］で1件ずつ戻せます。
              左に黄色い線がある行が未確認です。右の数字は給与（残業の時間数）への響きです。
              「データを出したあと」は、表で見るの Excel や一覧の Excel・CSV を最後に出した時刻より後の変更です。
              「復元した記録」は、記録を始める前（10/16〜10/26）の分を毎日のバックアップを見比べて作り直したもので、1日の間の細かい動きと、した人が分からないことがあります。
              {data.since && ` 記録は ${jstAt(data.since)} からです。`}
              {data.errors > 0 && ` 記録の失敗が ${data.errors}件 あります（この30日）。`}
            </p>
          )}
        </>
      )}

      <DeletionLogSection isDark={isDark} />
    </div>
  );
};

export default ChangeLogTab;
