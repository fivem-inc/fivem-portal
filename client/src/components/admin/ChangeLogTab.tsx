// 管理画面「📋 受理済みの変更」（2026-10-26 ユーザー確定・文言はすべて案B・計画 docs/計画-経理向け変わった申請の一覧.md）。
// 経理が給与期間のデータを取ったあとに、受理済みの申請が変わったかを見る。記録は DB の application_change_log（トリガーが書く）。
// ・最初は「今の給与期間」「人ごと」「給与の数字にかかわるもの」（受理済みの前か後か・勤怠カレンダー）。受理の前の動きは下にたたむ
// ・「ここまで確認した」の印＝Excel・CSV を出したとき（自動）／［確認済みにする］。印の時刻より後の変更に「未確認」
//   🚨 印の時刻は押した時刻ではなく「画面に出ていた、いちばん新しい行の時刻」（押す直前に入った変更を見落とさないため）
// ・締めた期（支給月の17日を過ぎた期）への変更は上の赤い枠に別に出す
// ・いちばん下に「削除の記録」（修正依頼のタブから移した）
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import DeletionLogSection from './DeletionLogSection';
import LoadFailedNotice from '../LoadFailedNotice';
import { NOTICE_LOAD_FAILED_TEXT } from '../../lib/netFailure';
import { primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { calcPayPeriodStartJst, payMonthPeriodLabel, payPeriodEnd, payPeriodLabel, todayJstStr } from '../../lib/breakCalc';
import { payrollPeriodOptions } from '../../lib/payrollSheet';
import { recordPayrollCheck, PAYROLL_CHECK_KIND_LABEL } from '../../lib/payrollCheckMark';
import { APPLICATION_KIND_LABEL, type ApplicationKind } from '../../lib/applicationStatus';
import {
  changeLines, datesText, eventText, isAfterClose, isPayrollRelevant, itemHeadText, itemTypeText, jstAt, mergeRows, overtimeMinutesDelta,
  type ChangeItem, type ChangeLogData,
} from '../../lib/changeLog';
import { formatMin } from '../../lib/breakCalc';

const KINDS: ApplicationKind[] = ['overtime', 'leave', 'shift', 'expense', 'attendance'];
const signed = (min: number) => `${min < 0 ? '−' : '+'}${formatMin(min)}`;

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
  const [data, setData] = useState<ChangeLogData | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showFolded, setShowFolded] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('admin_change_log', { p_period: period });
    if (error) { console.error('[受理済みの変更] 読み込みに失敗:', error.message); setFailed(true); return; }
    setData(d as ChangeLogData); setFailed(false);
  }, [supabase, period]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const items = useMemo(() => mergeRows(data?.rows ?? []), [data]);
  const closedItems = useMemo(() => mergeRows(data?.closed ?? []).filter(it => isPayrollRelevant(it) && isAfterClose(it)), [data]);
  const mark = data?.marks?.[0] ?? null;
  const upto = mark ? new Date(mark.upto).getTime() : null;
  const isNew = (it: ChangeItem) => upto === null || new Date(it.at).getTime() > upto;

  const relevant = items.filter(isPayrollRelevant);
  const folded = items.filter(it => !isPayrollRelevant(it));
  const byKind = (it: ChangeItem) => kind === 'all' || it.kind === kind;
  const shown = relevant.filter(byKind);
  const newCount = relevant.filter(isNew).length;
  const hiddenNew = relevant.filter(it => isNew(it) && !byKind(it)).length;
  const maxShownAt = shown.reduce<string | null>((m, it) => (!m || it.at > m ? it.at : m), null);

  // 人ごと（従業員番号の順 → 名前）／時系列（新しい順）
  const groups = useMemo(() => {
    if (view === 'time') return [{ key: 'all', title: '', items: [...shown].sort((a, b) => (a.at < b.at ? 1 : -1)) }];
    const m = new Map<string, { key: string; title: string; no: string; items: ChangeItem[] }>();
    for (const it of shown) {
      const k = it.applicant_id ?? 'unknown';
      if (!m.has(k)) m.set(k, { key: k, title: it.applicant_name, no: it.employee_no ?? '', items: [] });
      m.get(k)!.items.push(it);
    }
    const arr = [...m.values()];
    arr.forEach(g => g.items.sort((a, b) => (a.target_dates[0] ?? '').localeCompare(b.target_dates[0] ?? '') || a.at.localeCompare(b.at)));
    arr.sort((a, b) => (a.no && b.no ? Number(a.no) - Number(b.no) : a.no ? -1 : b.no ? 1 : a.title.localeCompare(b.title, 'ja')));
    return arr.map(g => ({ key: g.key, title: `${g.title}${g.no ? `（${g.no}）` : ''}`, items: g.items }));
  }, [shown, view]);

  const markLine = (() => {
    if (!mark) return `この給与期間は、まだ確認済みにしていません（変更 ${relevant.length}件）`;
    const when = jstAt(mark.upto);
    const how = mark.kind === 'manual' ? '確認済みにした' : 'データを出した';
    return newCount > 0 ? `${when} に${how}あと、${newCount}件 変わりました` : `${when} に${how}あとの変更はありません`;
  })();

  const doMark = async () => {
    setBusy(true); setMsg(null);
    const r = await recordPayrollCheck(period, 'manual', { upto: maxShownAt ?? new Date().toISOString(), count: shown.length });
    setBusy(false);
    if (!r) { setMsg('確認済みにできませんでした。もう一度押してください。'); return; }
    await load();
  };
  const undoMark = async () => {
    if (!mark) return;
    setBusy(true); setMsg(null);
    const { data: ok, error } = await supabase.rpc('payroll_check_mark_undo', { p_id: mark.id });
    setBusy(false);
    if (error || !ok) { console.error('[受理済みの変更] 印を戻せませんでした:', error?.message); setMsg('1つ前に戻せませんでした。'); return; }
    await load();
  };

  const exportXlsx = async () => {
    setBusy(true); setMsg(null);
    try {
      const XLSX = await import('xlsx');
      const head = ['日時', '名前', '従業員番号', '申請', '種類', '対象日', '何が起きたか', '変わった中身', '残業の時間数の差（分）', '給与にかかわる', '締め後', 'した人', '備考'];
      const all = [...items].sort((a, b) => a.at.localeCompare(b.at));
      const rows = all.map(it => [
        jstAt(it.at), it.applicant_name, it.employee_no ?? '', APPLICATION_KIND_LABEL[it.kind], itemTypeText(it), it.target_dates.join(' '),
        eventText(it), changeLines(it).join(' ／ '), overtimeMinutesDelta(it) ?? '', isPayrollRelevant(it) ? 'はい' : '', isAfterClose(it) ? '締め後' : '',
        it.actor, [it.rebuilt ? 'バックアップから作り直し' : '', it.approxWindow ? `時刻は ${it.approxWindow} のどこか` : '', it.reason ?? ''].filter(Boolean).join('・'),
      ]);
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
      const newest = all.reduce<string | null>((m, it) => (!m || it.at > m ? it.at : m), null);
      await recordPayrollCheck(period, 'change_log_excel', { upto: newest ?? new Date().toISOString(), count: all.length });
      await load();
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
  const badge = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: 11, borderRadius: 4, padding: '0 6px', background: bg, color: fg, whiteSpace: 'nowrap' });

  const row = (it: ChangeItem, showName: boolean) => {
    const fresh = isNew(it);
    const delta = overtimeMinutesDelta(it);
    const lines = changeLines(it);
    return (
      <div key={it.key} style={{ display: 'grid', gridTemplateColumns: '58px 140px minmax(0,1fr) 120px', gap: 8, padding: '7px 0', borderBottom: `1px solid ${border}`, alignItems: 'start', color: fresh ? text : sub, fontSize: 13, lineHeight: 1.6 }}>
        <span style={{ textAlign: 'center' }}>{fresh ? <span style={badge('#fff3cd', '#856404')}>未確認</span> : '済'}</span>
        <span>{datesText(it.target_dates)}<br /><span style={{ color: sub, fontSize: 12 }}>{itemHeadText(it)}</span></span>
        <span>
          {showName && <b style={{ fontWeight: 600 }}>{it.applicant_name}　</b>}
          {eventText(it)}
          {delta !== null && delta !== 0 && <b style={{ fontWeight: 600 }}>（残業 {signed(delta)}）</b>}
          {isAfterClose(it) && <> <span style={badge('#ffe5d0', '#984c0c')}>締め後</span></>}
          {it.rebuilt && <> <span style={badge(isDark ? '#495057' : '#e9ecef', isDark ? '#f8f9fa' : '#495057')}>バックアップから</span></>}
          {lines.map((l, i) => <div key={i} style={{ fontSize: 12.5, color: fresh ? text : sub }}>{l}</div>)}
          {it.reason && <div style={{ fontSize: 12, color: sub }}>理由：{it.reason}</div>}
          {it.approxWindow && <div style={{ fontSize: 12, color: sub }}>時刻は {it.approxWindow} のどこか</div>}
        </span>
        <span style={{ color: sub, fontSize: 12 }}>{it.actor}<br />{jstAt(it.at)}</span>
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
          <div style={{ background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 13.5, lineHeight: 1.6 }}>
            {markLine}
            {mark && (
              <div style={{ fontSize: 12 }}>
                （{PAYROLL_CHECK_KIND_LABEL[mark.kind] ?? mark.kind}{mark.marked_by_name ? `・${mark.marked_by_name}` : ''}）
                <button type="button" disabled={busy} onClick={() => void undoMark()}
                  style={{ background: 'none', border: 'none', padding: '0 0 0 6px', color: '#856404', textDecoration: 'underline', fontSize: 12, cursor: 'pointer' }}>1つ前に戻す</button>
              </div>
            )}
            {hiddenNew > 0 && <div style={{ fontSize: 12 }}>絞り込みで隠れている未確認の変更が {hiddenNew}件 あります</div>}
          </div>

          {closedItems.length > 0 && (
            <div style={{ background: '#f8d7da', border: '1px solid #dc3545', color: '#842029', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13.5 }}>
              ⚠️ 締めたあとの期への変更が {closedItems.length}件 あります
              <button type="button" onClick={() => setShowClosed(v => !v)}
                style={{ background: 'none', border: 'none', color: '#842029', textDecoration: 'underline', fontSize: 13, cursor: 'pointer', marginLeft: 6 }}>{showClosed ? '閉じる ▲' : '見る ▼'}</button>
              {showClosed && <div style={{ background: cardBg, borderRadius: 6, padding: '0 8px', marginTop: 6 }}>{closedItems.map(it => row(it, true))}</div>}
            </div>
          )}

          {shown.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: sub, fontSize: 13 }}>この給与期間に、受理済みの申請の変更はありません。</div>
          )}
          {groups.map(g => (
            <div key={g.key} style={{ marginBottom: 6 }}>
              {g.title && <div style={{ fontWeight: 600, padding: '6px 0', borderBottom: `1px solid ${border}` }}>{g.title}<span style={{ color: sub, fontWeight: 400 }}>　{g.items.length}件</span></div>}
              {g.items.map(it => row(it, view === 'time'))}
            </div>
          ))}

          {folded.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setShowFolded(v => !v)}
                style={{ background: 'none', border: 'none', padding: '6px 0', color: sub, fontSize: 13, cursor: 'pointer' }}>
                受理の前の動き（申請中の直し・受理の途中の段）{folded.length}件 {showFolded ? '▲' : '▼'}
              </button>
              {showFolded && folded.filter(byKind).map(it => row(it, true))}
            </div>
          )}

          {msg && <div style={{ color: '#842029', fontSize: 13, marginTop: 8 }}>{msg}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={() => void exportXlsx()} style={{ ...tintBtn(isDark), flex: 1 }}>📥 この一覧を Excel で出す</button>
            <button type="button" disabled={busy} onClick={() => void doMark()} style={{ ...primaryBtn({ disabled: busy }), flex: 2 }}>確認済みにする</button>
          </div>
          <p style={{ fontSize: 12, color: sub, margin: '8px 0 0', lineHeight: 1.6 }}>
            ※ 残業・休暇・勤務変更・交通費・勤怠カレンダーの予定が変わったときの記録です（管理者だけが見られます）。
            {data.since && ` 記録は ${jstAt(data.since)} からです。`}
            「バックアップから」の札の行は、毎日のバックアップを見比べて作り直したもので、1日の間の細かい動きと、した人が分からないことがあります。
            {data.errors > 0 && ` 記録の失敗が ${data.errors}件 あります（この30日）。`}
          </p>
        </>
      )}

      <DeletionLogSection isDark={isDark} />
    </div>
  );
};

export default ChangeLogTab;
