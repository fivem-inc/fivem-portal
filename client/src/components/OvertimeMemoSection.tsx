// 残業申請のメモ（申請の前に「日付・時刻・理由」を書いておく）。
// 設計は docs/計画-残業申請メモ.md がすべて。判定・文言の組み立ては lib/overtimeMemo.ts に置き、
// この部品は「見た目」と「読み書き」だけを持つ。
//
// 🚨 メモは申請ではない。［申請］は申請フォームに内容を入れるだけで、送信は本人が申請画面で行う。
// 🚨 失敗は握りつぶさない。insert / update / delete は error と件数（.select('id')）を必ず見る。
// 🚨 alert()・window.confirm() は使わない。確認はその場のインラインUI、成功は薄緑カード。

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import { todayJstStr } from '../lib/breakCalc';
import {
  MEMO_KINDS, memoTimeLabels, memoNeedsLocation, memoReasonExamples,
  memoDateRange, memoSection, memoDeadlineState, memoCloseCutoffLabel, memoSoonCount, sortMemos,
  memoHeadText, validateMemo, isClockMemoKind, addDaysStr,
} from '../lib/overtimeMemo';
import type { MemoKind, OvertimeMemo } from '../lib/overtimeMemo';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}

interface MemoDraft {
  id: string | null;             // 修正のときだけ入る
  kind: MemoKind | null;
  kind_other: string;
  target_date: string;
  time_start: string;
  time_end: string;
  location: string;
  reason: string;
}

const EMPTY_DRAFT: MemoDraft = {
  id: null, kind: null, kind_other: '', target_date: '', time_start: '', time_end: '', location: '', reason: '',
};

interface Props {
  userId: string;
  isDark: boolean;
  workplaces: string[];
  /** その日に申請がすでにある日付（「申請済み」と出して［申請］を出さない） */
  appliedDates: Set<string>;
  /** ［申請］を押したとき。申請フォームへ内容を入れるのは呼ぶ側の仕事 */
  onApply: (memo: OvertimeMemo) => void;
  /** 開いている間は申請の入力欄を隠すため、開閉を親に伝える */
  onOpenChange: (open: boolean) => void;
  /** 同じ行の右端に置くもの（「クリア」ボタン）。🚨 メモは左端・クリアは右端に離す */
  rightSlot?: React.ReactNode;
}

const OvertimeMemoSection: React.FC<Props> = ({ userId, isDark, workplaces, appliedDates, onApply, onOpenChange, rightSlot }) => {
  const [open, setOpen] = useState(false);
  const [memos, setMemos] = useState<OvertimeMemo[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState<MemoDraft | null>(null);   // null = 一覧を出す
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState('');
  const [okMsg, setOkMsg] = useState<{ title: string; note?: string } | null>(null);
  const [limitMsg, setLimitMsg] = useState('');
  const [unsent, setUnsent] = useState<MemoDraft | null>(() => loadDraft<MemoDraft>(DRAFT_KEYS.overtimeMemoUnsent));
  const [today, setToday] = useState(todayJstStr());
  const openRef = useRef(false);

  // 成功カードは数秒で消す（アプリ共通の成功フィードバック）
  useEffect(() => {
    if (!okMsg) return;
    const t = setTimeout(() => setOkMsg(null), 4000);
    return () => clearTimeout(t);
  }, [okMsg]);

  // 🚨 日付が変わった画面をそのまま開いていることがある。戻ってきたら「今日」を取り直す
  useEffect(() => {
    const onFocus = () => setToday(todayJstStr());
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('overtime_memos')
      .select('id, kind, kind_other, target_date, time_start, time_end, location, reason, applied_at, applied_report_id, created_at, updated_at')
      .eq('user_id', userId)
      .order('target_date', { ascending: true });
    // 🚨 読めなかったときに「0件」と言わない（黙って事実と違うことを言わない）
    if (error) { setLoadErr(`メモを読み込めませんでした：${error.message}`); return; }
    setLoadErr('');
    setMemos((data ?? []) as OvertimeMemo[]);
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (openRef.current !== open) { openRef.current = open; onOpenChange(open); }
  }, [open, onOpenChange]);

  // ---- styles（この画面のほかのボタンと同じ見た目にそろえる）----
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const panelBg = isDark ? '#2b3035' : '#fff';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const btn: React.CSSProperties = {
    background: isDark ? '#495057' : '#f1f3f5', border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`,
    borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', color: isDark ? '#e9ecef' : '#495057',
    padding: '5px 14px',
  };
  const smallBtn: React.CSSProperties = { ...btn, fontSize: 12, padding: 0, height: 28, minWidth: 40 };
  const inputStyle: React.CSSProperties = {
    padding: '9px 12px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: isDark ? '#495057' : '#fff', color: text, fontSize: 14,
    boxSizing: 'border-box', width: '100%', colorScheme: isDark ? 'dark' : 'light',
  };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const req = <span style={{ color: '#dc3545' }}> *</span>;
  // 🚨 択一トグルの青は固定色（🎨🔒）
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 'bold',
    border: `2px solid ${on ? '#1565c0' : '#90caf9'}`, background: on ? '#1976d2' : '#e3f2fd',
    color: on ? '#fff' : '#1565c0',
  });

  const soon = memoSoonCount(memos, today);
  const range = memoDateRange(today);

  // ---- 保存 ----
  const save = async (d: MemoDraft) => {
    const err = validateMemo(d, today);
    if (err) { setFormErr(err); return; }
    setSaving(true); setFormErr('');
    const row = {
      user_id: userId,
      kind: d.kind as MemoKind,
      kind_other: d.kind === 'other' ? d.kind_other.trim() : null,
      target_date: d.target_date,
      time_start: d.time_start || null,
      time_end: d.time_end || null,
      location: memoNeedsLocation(d.kind as MemoKind) ? (d.location || null) : null,
      reason: d.reason.trim(),
    };
    if (d.id) {
      // 🚨 update は0件でもエラーにならない。件数を見る
      const { data, error } = await supabase.from('overtime_memos').update(row).eq('id', d.id).select('id');
      setSaving(false);
      if (error) { setFormErr(`保存できませんでした：${error.message}`); return; }
      if (!data || data.length === 0) { setFormErr('保存できませんでした（このメモが見つかりません）'); return; }
      clearDraft(DRAFT_KEYS.overtimeMemoUnsent); setUnsent(null);
      setDraft(null); setOkMsg({ title: 'メモを直しました' });
      void load();
      return;
    }
    const { data, error } = await supabase.from('overtime_memos').insert(row).select('id');
    setSaving(false);
    if (error) {
      // 🚨 上限はDB側のトリガーが返すコードで見分ける（文字で判定しない）
      if (error.code === 'OTM20') { setFormErr('メモは20件までです。使い終わったメモを ✕ で削除してから保存してください'); return; }
      // 🚨 電波が弱いところで書くことが多い。入力は消さず、端末にも預けてから知らせる
      saveDraft(DRAFT_KEYS.overtimeMemoUnsent, d); setUnsent(d);
      setFormErr(`保存できませんでした：${error.message} 電波のよい場所でもう一度［メモを保存する］を押してください`);
      return;
    }
    if (!data || data.length === 0) {
      saveDraft(DRAFT_KEYS.overtimeMemoUnsent, d); setUnsent(d);
      setFormErr('保存できませんでした。電波のよい場所でもう一度［メモを保存する］を押してください');
      return;
    }
    clearDraft(DRAFT_KEYS.overtimeMemoUnsent); setUnsent(null);
    setDraft(null);
    setOkMsg({ title: 'メモを保存しました', note: 'まだ申請はしていません。申請するときは、メモの［申請］を押してください' });
    void load();
  };

  const remove = async (id: string) => {
    setRowErr('');
    const { data, error } = await supabase.from('overtime_memos').delete().eq('id', id).select('id');
    if (error) { setRowErr(`削除できませんでした：${error.message}`); return; }
    if (!data || data.length === 0) { setRowErr('削除できませんでした（このメモが見つかりません）'); return; }
    setDeleteId(null);
    setOkMsg({ title: 'メモを削除しました' });
    void load();
  };

  const startNew = () => {
    if (memos.length >= 20) {
      setLimitMsg('メモは20件までです。使い終わったメモを ✕ で削除してから書いてください');
      return;
    }
    setLimitMsg(''); setFormErr('');
    setDraft({ ...EMPTY_DRAFT, target_date: today });
  };

  const startEdit = (m: OvertimeMemo) => {
    setLimitMsg(''); setFormErr('');
    setDraft({
      id: m.id, kind: m.kind, kind_other: m.kind_other ?? '', target_date: m.target_date,
      time_start: (m.time_start ?? '').slice(0, 5), time_end: (m.time_end ?? '').slice(0, 5),
      location: m.location ?? '', reason: m.reason,
    });
  };

  // ---- 入力画面 ----
  const renderForm = (d: MemoDraft) => {
    const times = d.kind ? memoTimeLabels(d.kind) : { start: null, end: null };
    const examples = d.kind ? memoReasonExamples(d.kind) : [];
    const maxDate = d.kind && isClockMemoKind(d.kind) ? today : range.max;
    const set = (patch: Partial<MemoDraft>) => setDraft({ ...d, ...patch });
    return (
      <div>
        <span style={labelStyle}>何があった？{req}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {MEMO_KINDS.map(k => (
            <button key={k.key} type="button" style={chip(d.kind === k.key)}
              onClick={() => set({
                kind: k.key,
                // 種類を変えたら、その種類では使わない欄を空にする（使われない文字を残さない）
                kind_other: k.key === 'other' ? d.kind_other : '',
                location: k.key === 'location_change' ? d.location : '',
                time_start: memoTimeLabels(k.key).start ? d.time_start : '',
                time_end: memoTimeLabels(k.key).end ? d.time_end : '',
              })}>
              {k.label}
            </button>
          ))}
        </div>
        {d.kind === 'other' && (
          <input value={d.kind_other} onChange={e => set({ kind_other: e.target.value })}
            placeholder="その他の内容" maxLength={100} style={{ ...inputStyle, marginBottom: 10 }} />
        )}

        <span style={labelStyle}>いつ？{req}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {[['昨日', addDaysStr(today, -1)], ['今日', today], ['明日', addDaysStr(today, 1)]].map(([label, v]) => (
            <button key={label} type="button" style={chip(d.target_date === v)}
              onClick={() => set({ target_date: v })} disabled={v > maxDate}>
              {label}
            </button>
          ))}
        </div>
        <input type="date" value={d.target_date} min={range.min} max={maxDate}
          onChange={e => set({ target_date: e.target.value })} style={{ ...inputStyle, marginBottom: 10 }} />

        {(times.start || times.end) && (
          <>
            <span style={labelStyle}>時刻<span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（分からなければ空のままで保存できます）</span></span>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              {times.start && (
                <>
                  <span style={{ fontSize: 12, color: subText }}>{times.start}</span>
                  <input type="time" value={d.time_start} onChange={e => set({ time_start: e.target.value })}
                    style={{ ...inputStyle, width: 130 }} />
                </>
              )}
              {times.end && (
                <>
                  <span style={{ fontSize: 12, color: subText }}>{times.end}</span>
                  <input type="time" value={d.time_end} onChange={e => set({ time_end: e.target.value })}
                    style={{ ...inputStyle, width: 130 }} />
                </>
              )}
              {/* 🚨 「いま」は押した瞬間の時刻を入れる（画面を開いた時刻ではない） */}
              <button type="button" style={btn} onClick={() => {
                const n = new Date();
                const hhmm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
                set(times.end && !times.start ? { time_end: hhmm } : { time_start: hhmm });
              }}>いま</button>
            </div>
          </>
        )}

        {d.kind && memoNeedsLocation(d.kind) && (
          <>
            <span style={labelStyle}>勤務地</span>
            <select value={d.location} onChange={e => set({ location: e.target.value })} style={{ ...inputStyle, marginBottom: 10 }}>
              <option value="">選んでください</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </>
        )}

        <span style={labelStyle}>理由<span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（なくてもよい）</span></span>
        {examples.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {examples.map(ex => (
              <button key={ex} type="button" onClick={() => set({ reason: ex })}
                style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0', fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}>
                文例 ー「{ex}」
              </button>
            ))}
          </div>
        )}
        <textarea value={d.reason} onChange={e => set({ reason: e.target.value })} rows={2} maxLength={500}
          placeholder="理由" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', marginBottom: 10 }} />

        {formErr && (
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: '#842029', lineHeight: 1.6 }}>{formErr}</p>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={btn} onClick={() => { setDraft(null); setFormErr(''); }}>やめる</button>
          <button type="button" disabled={saving}
            style={{ ...btn, background: '#1976d2', border: '1px solid #1565c0', color: '#fff', opacity: saving ? 0.6 : 1 }}
            onClick={() => void save(d)}>
            {saving ? '保存しています…' : 'メモを保存する'}
          </button>
        </div>
      </div>
    );
  };

  // ---- 一覧 ----
  const renderRow = (m: OvertimeMemo) => {
    const state = memoDeadlineState(m, today);
    const applied = !!m.applied_at || appliedDates.has(m.target_date);
    const dateYellow = !applied && state === 'soon' && m.target_date >= today;
    return (
      <div key={m.id}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 0', borderBottom: `1px solid ${isDark ? '#3a4047' : '#f0f0f0'}` }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: applied ? subText : text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {!applied && state === 'soon' && m.target_date < today && (
              <span style={{ background: '#fff3cd', color: '#856404', borderRadius: 10, fontSize: 11, padding: '0 6px', marginRight: 4 }}>{memoCloseCutoffLabel(m)}</span>
            )}
            {!applied && state === 'closed' && (
              <span style={{ background: isDark ? '#495057' : '#e9ecef', color: subText, borderRadius: 10, fontSize: 11, padding: '0 6px', marginRight: 4 }}>締め切り済み</span>
            )}
            <span style={dateYellow ? { background: '#fff3cd', color: '#856404', borderRadius: 4, padding: '0 3px' } : undefined}>{dateLabel(m.target_date)}</span>
            {' '}{memoHeadText(m)}
            {m.reason && <span style={{ color: subText, fontSize: 11.5 }}>{' '}{m.reason}</span>}
          </span>
          {applied
            ? <span style={{ ...smallBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', background: isDark ? '#495057' : '#e9ecef', border: 'none', color: subText, padding: '0 7px' }}>申請済み</span>
            : <button type="button" style={{ ...smallBtn, padding: '0 7px' }} onClick={() => { onApply(m); setOpen(false); }}>申請</button>}
          <button type="button" style={{ ...smallBtn, padding: '0 7px' }} onClick={() => startEdit(m)}>修正</button>
          <button type="button" aria-label="削除" onClick={() => { setDeleteId(m.id); setRowErr(''); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', width: 26, height: 28, marginLeft: 6, fontSize: 14, color: subText }}>✕</button>
        </div>
        {deleteId === m.id && (
          <div style={{ background: isDark ? '#3a2b2d' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 6, padding: '5px 8px', margin: '2px 0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: '#842029' }}>このメモを削除しますか？</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={{ ...btn, background: '#dc3545', border: '1px solid #dc3545', color: '#fff', padding: '4px 12px' }} onClick={() => void remove(m.id)}>削除</button>
              <button type="button" style={{ ...btn, padding: '4px 12px' }} onClick={() => setDeleteId(null)}>やめる</button>
            </span>
          </div>
        )}
      </div>
    );
  };

  const sorted = sortMemos(memos, today);
  const sections: { key: 'today' | 'future' | 'past'; label: string }[] = [
    { key: 'today', label: '今日' }, { key: 'future', label: '先の予定' }, { key: 'past', label: '過去' },
  ];

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button type="button"
          onClick={() => { if (!open && memos.length === 0 && !loadErr) startNew(); setOpen(v => !v); }}
          style={soon > 0
            ? { ...btn, background: '#fff3cd', border: '1px solid #ffeeba', color: '#856404' }
            : btn}>
          メモ（{memos.length}）{soon > 0 ? ' 締め切り近い' : ''}
        </button>
        {/* 開いている間は右の［クリア］の代わりに［申請に戻る］（2026-09-19 ユーザー指示）。
            ▲▼ だけでは「閉じると申請の画面に戻る」ことが伝わらなかったため。クリアはメモを開いている間は要らない */}
        {open
          // 色は濃い灰の塗り（2026-09-19 ユーザー確定・案F）。🚨 メモの中は青いボタン（種類・保存）が多いので、青にすると選択肢の1つに見える。
          //    ダークでは明るい灰に反転（濃い灰だと［メモ］と見分けが付かない）
          ? <button type="button" onClick={() => setOpen(false)}
              style={{ ...btn, background: isDark ? '#e9ecef' : '#495057', border: `1px solid ${isDark ? '#e9ecef' : '#495057'}`, color: isDark ? '#212529' : '#fff' }}>申請に戻る</button>
          : rightSlot}
      </div>

      {open && (
        <div style={{ marginTop: 8, background: panelBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px' }}>
          {okMsg && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
              <span style={{ flex: 'none', width: 36, height: 36, borderRadius: '50%', background: '#22c55e', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>✓</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{okMsg.title}</p>
                {okMsg.note && <p style={{ margin: '3px 0 0', fontSize: 12.5, color: '#15803d', lineHeight: 1.55 }}>{okMsg.note}</p>}
              </div>
              <button type="button" onClick={() => setOkMsg(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', fontSize: 14 }}>✕</button>
            </div>
          )}

          {loadErr && (
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: '#842029' }}>{loadErr}</p>
            </div>
          )}

          {/* 保存できずに端末へ預けてあるメモ（電波が戻ってからもう一度保存できる） */}
          {unsent && !draft && (
            <div style={{ background: '#fff3cd', border: '1px solid #ffeeba', borderRadius: 8, padding: '8px 10px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#856404' }}>保存されていないメモが1件あります</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={btn} onClick={() => { setDraft(unsent); setFormErr(''); }}>開く</button>
                <button type="button" style={btn} onClick={() => { clearDraft(DRAFT_KEYS.overtimeMemoUnsent); setUnsent(null); }}>破棄</button>
              </span>
            </div>
          )}

          {draft ? renderForm(draft) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <p style={{ margin: 0, fontSize: 11, color: subText }}>※ メモは申請ではありません。</p>
                <button type="button" onClick={startNew}
                  style={{ background: '#e3f2fd', border: '1.5px solid #64b5f6', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', color: '#1565c0', padding: '3px 10px' }}>
                  ＋ 新しいメモ
                </button>
              </div>
              {limitMsg && (
                <div style={{ background: '#fff3cd', border: '1px solid #ffeeba', borderRadius: 8, padding: '8px 10px', margin: '6px 0' }}>
                  <p style={{ margin: 0, fontSize: 12, color: '#856404', lineHeight: 1.6 }}>{limitMsg}</p>
                </div>
              )}
              {rowErr && (
                <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 10px', margin: '6px 0' }}>
                  <p style={{ margin: 0, fontSize: 12, color: '#842029' }}>{rowErr}</p>
                </div>
              )}
              {memos.length === 0 && !loadErr && (
                <p style={{ margin: '8px 0 0', fontSize: 12.5, color: subText }}>メモはまだありません。［＋ 新しいメモ］から書けます。</p>
              )}
              {sections.map(sec => {
                const rows = sorted.filter(m => memoSection(m, today) === sec.key);
                if (rows.length === 0) return null;
                return (
                  <div key={sec.key}>
                    <p style={{ margin: '6px 0 0', fontSize: 11, fontWeight: 'bold', color: subText, borderBottom: `1px solid ${borderColor}`, paddingBottom: 1 }}>{sec.label}</p>
                    {rows.map(renderRow)}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default OvertimeMemoSection;
