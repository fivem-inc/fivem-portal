// 履歴の［カード｜表］の共用部品（2026-11-05 に OvertimePage から移した・残業の動きは変えていない）
// ・残業（ご本人の［履歴・実績報告］・部門集計の人の画面）と勤務変更の［履歴］が使う
// ・URL の印（param）と行・日の目印（prefix）は呼ぶ側ごとに分ける（同じページの中でぶつからないように）。既定は残業の値（otday・ot-）
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { DayUnit } from './DayFrameList';

/** enabled=false のときは端末に「表」と覚えていてもカードで出す（切り替えも出さない） */
export function useHistoryTableMode(storageKey: string, enabled = true, opts: { param?: string; prefix?: string } = {}) {
  const param = opts.param ?? 'otday';
  const prefix = opts.prefix ?? 'ot';
  const jumpKey = `${prefix}Jump`;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setModeState] = useState<'card' | 'table'>(() => {
    try { return localStorage.getItem(storageKey) === 'table' ? 'table' : 'card'; } catch { return 'card'; }
  });
  const setMode = (m: 'card' | 'table') => {
    setModeState(m);
    try { localStorage.setItem(storageKey, m); } catch { /* 端末に覚えられなくても動く */ }
  };
  // 全日（表のときだけ・2026-10-31）。端末に覚える
  const [allDays, setAllDaysState] = useState<boolean>(() => {
    try { return localStorage.getItem(`${storageKey}_all`) === '1'; } catch { return false; }
  });
  const setAllDays = (v: boolean) => {
    setAllDaysState(v);
    try { localStorage.setItem(`${storageKey}_all`, v ? '1' : '0'); } catch { /* 端末に覚えられなくても動く */ }
  };
  const jumpDay = searchParams.get(param);
  const lastPicked = useRef<string | null>(null);
  /** 表の行を押した：カードへ（履歴に1つ積む＝スマホの戻る操作で表に戻れる） */
  const pickDay = (d: string) => {
    lastPicked.current = d;
    const p = new URLSearchParams(location.search);
    p.set(param, d);
    navigate({ search: p.toString() }, { state: { [jumpKey]: true } });
  };
  /** ［📋 表に戻る］：積んだ1つを戻す（積んでいなければ otday を外すだけ） */
  const backToTable = () => {
    if ((location.state as Record<string, boolean> | null)?.[jumpKey]) { navigate(-1); return; }
    const p = new URLSearchParams(location.search);
    p.delete(param);
    navigate({ search: p.toString() }, { replace: true });
  };
  const showTable = enabled && mode === 'table' && !jumpDay;
  // 表に戻ったら、押した行まで動かす／カードに移ったら、その日まで動かす
  useEffect(() => {
    if (showTable && lastPicked.current) {
      const d = lastPicked.current;
      setTimeout(() => document.getElementById(`${prefix}-row-${d}`)?.scrollIntoView({ block: 'center' }), 50);
    }
  }, [showTable]);
  // 🚨 scrollIntoView＋scrollMarginTop は iPhone で効かなかった（2026-11-03 実機）。
  //    ナビ（2段のときも）・圏外の帯・［表に戻る］の帯の高さを読んで、その下に少し空けて止める
  useEffect(() => {
    if (!jumpDay) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`${prefix}-day-${jumpDay}`);
      if (!el) return;
      const cs = getComputedStyle(document.documentElement);
      const top = (parseInt(cs.getPropertyValue('--topbar-height'), 10) || 60) + (parseInt(cs.getPropertyValue('--offline-band-h'), 10) || 0);
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - top - HISTORY_BACK_BAR_H - 12), behavior: 'smooth' });
    }, 80);
    return () => clearTimeout(t);
  }, [jumpDay, prefix]);
  const showAll = showTable && allDays;
  return { mode: enabled ? mode : 'card' as const, setMode, showTable, showAll, allDays, setAllDays, jumpDay, pickDay, backToTable, enabled };
}

/** 表示の切り替え（2026-10-31 ユーザー確定）：［カード｜表］・表のときだけ［申請｜全日］・［↕ 降順］を1行に。
 *  選んでいる側を青にする（同じボタンを押して戻る形は、戻り方が分かりにくいため） */
export const HistoryViewSwitch: React.FC<{
  /** 表のときの左のボタンの名前（残業＝申請・勤務変更＝報告） */
  someLabel?: string;
  mode: 'card' | 'table'; onMode: (m: 'card' | 'table') => void;
  allDays: boolean; onAllDays: (v: boolean) => void;
  /** onSort を渡さなければ並び順のボタンは出さない（勤務変更） */
  sortAsc?: boolean; onSort?: () => void;
  /** false＝［カード｜表］を出さず、並び順だけ（権限 overtime_own_table が OFF の方・2026-11-03） */
  tableOn?: boolean;
  isDark: boolean; borderColor: string; subText: string;
}> = ({ someLabel = '申請', tableOn = true, mode, onMode, allDays, onAllDays, sortAsc, onSort, isDark, borderColor, subText }) => {
  const blue = isDark ? '#90caf9' : '#1976d2';
  const seg = (items: { key: string; label: string; on: boolean; onClick: () => void }[]) => (
    <span style={{ display: 'inline-flex', border: `1.5px solid ${blue}`, borderRadius: 8, overflow: 'hidden' }}>
      {items.map(it => (
        <button key={it.key} type="button" aria-pressed={it.on} onClick={it.onClick}
          style={{ width: 52, minHeight: 34, padding: 0, border: 'none', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
            background: it.on ? '#1976d2' : 'transparent', color: it.on ? '#fff' : blue, fontWeight: it.on ? 'bold' : 'normal' }}>{it.label}</button>
      ))}
    </span>
  );
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
      {/* 🚨 ［申請｜全日］は［カード｜表］の左に出す（右に寄せた並びなので、出ても［カード｜表］の位置が動かない・2026-11-02 ユーザー指示）。
          ボタンはどれも同じ幅（押しやすさ・同日ユーザー指示） */}
      {tableOn && mode === 'table' && seg([
        { key: 'some', label: someLabel, on: !allDays, onClick: () => onAllDays(false) },
        { key: 'all', label: '全日', on: allDays, onClick: () => onAllDays(true) },
      ])}
      {tableOn && seg([
        { key: 'card', label: 'カード', on: mode === 'card', onClick: () => onMode('card') },
        { key: 'table', label: '表', on: mode === 'table', onClick: () => onMode('table') },
      ])}
      {onSort && <button type="button" onClick={onSort}
        style={{ minHeight: 34, padding: '0 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: subText, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
        ↕ {sortAsc ? '昇順' : '降順'}
      </button>}
    </div>
  );
};


/** 全日：期間の日を全部並べる（申請・休暇の無い日は units が空の行） */
export function fillAllDays<T>(groups: { date: string; units: DayUnit<T>[] }[], from: string, to: string, asc: boolean): { date: string; units: DayUnit<T>[] }[] {
  const by = new Map<string, { date: string; units: DayUnit<T>[] }[]>();
  for (const g of groups) by.set(g.date, [...(by.get(g.date) ?? []), g]);
  const days: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  for (let d = from; d <= to; ) {
    days.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
    d = cur.toISOString().slice(0, 10);
  }
  if (!asc) days.reverse();
  return days.flatMap(d => by.get(d) ?? [{ date: d, units: [] }]);
}


/** 表から来たとき（カード・申請の画面）に出す［📋 表に戻る］。
 *  🚨 ボタンだけをナビのすぐ下の左に固定（帯は付けない・2026-11-03 ユーザー確定：動かしても同じ場所）。
 *     下には固定しない（連絡板の取り消しの帯・キーボードと重なる）。圏外の帯が出ていればその下（--offline-band-h） */
export const HISTORY_BACK_BAR_H = 44;
export const HistoryBackToTable: React.FC<{ onBack: () => void; isDark: boolean; spacer?: boolean }> = ({ onBack, isDark, spacer }) => (<>
  {/* 申請の画面：いちばん上まで戻したときに、帯が見出しにかぶらないように空けておく（カードの光った枠の中には空けない） */}
  {spacer && <div aria-hidden style={{ height: 46 }} />}
  {/* 見た目は高さ32の白い丸角＋影だけ（案A・Google マップなどの浮いたボタンの形）。押せる範囲は外側の透明な枠で44px */}
  <button type="button" onClick={onBack} aria-label="表に戻る"
    style={{ position: 'fixed', top: 'calc(var(--topbar-height, 60px) + var(--offline-band-h, 0px))', left: 6, zIndex: 250,
      padding: 6, border: 'none', background: 'transparent', cursor: 'pointer' }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 32, padding: '0 12px', borderRadius: 16,
      background: isDark ? '#2b3036' : '#ffffff', color: isDark ? '#90caf9' : '#1565c0', fontSize: 13, fontWeight: 'bold', whiteSpace: 'nowrap',
      boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.6)' : '0 1px 4px rgba(0,0,0,0.22)' }}>
      ‹ 表に戻る
    </span>
  </button>
</>);

/** カードの表示で、日のまとまりを包む（表から来た日を光らせ、上に［表に戻る］） */
export const HistoryDayWrap: React.FC<{ date: string; jumpDay: string | null; onBack: () => void; isDark: boolean; children: React.ReactNode; prefix?: string }> = ({ date, jumpDay, onBack, isDark, children, prefix = 'ot' }) => {
  const hit = jumpDay === date;
  return (
    <div id={`${prefix}-day-${date}`} style={hit ? { background: isDark ? '#4a4423' : '#fff9c4', borderRadius: 10, padding: 6, margin: '0 -6px 6px', scrollMarginTop: 120 } : { scrollMarginTop: 120 }}>
      {hit && <HistoryBackToTable onBack={onBack} isDark={isDark} />}
      {children}
    </div>
  );
};

