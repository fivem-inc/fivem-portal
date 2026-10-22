import React, { useMemo, useState } from 'react';
import { backBtn, primaryBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { bulkSplit, hm, parseHours } from '../../lib/shiftWeekSummary';
import type { KidsPlanPerson } from '../../lib/kidsShift';
import { ShiftDialogFrame } from './ShiftCellDialog';
import type { WeekRow } from './ShiftWeekView';

// まとめて変える（2026-10-22・docs/計画-シフト表の時間と週休.md）。作業中の案の中だけ。
// ・変えるもの（週休か週の目標時間）→ 値 → 対象の役職 →「すでに同じ値の人は変えない」
// ・「まとめて変えない」の印がある人は変えない（理由を出す）
// ・押す前に「変わる人／変えない人」を並べる＝この窓の中が「見るだけ」。閉じれば何も変わらない
// ・残し方は2つ：［この案に入れる］／［新しい案として残す］（名前をつける）
// 🚨 役職は role_id で選ぶ（役職名で判定しない）

const HOUR_CHOICES = [40 * 60, 37.5 * 60, 35 * 60, 30 * 60];

const ShiftBulkTermsDialog: React.FC<{
  isDarkMode: boolean;
  rows: WeekRow[];
  /** 役職（並び順つき）。この案に出てくる役職だけ選べる */
  roles: { id: string; name: string }[];
  planName: string;
  canNewPlan: boolean;
  onClose: () => void;
  onApply: (people: KidsPlanPerson[]) => Promise<string | null>;
  onApplyAsNew: (name: string, people: KidsPlanPerson[]) => Promise<string | null>;
}> = ({ isDarkMode, rows, roles, planName, canNewPlan, onClose, onApply, onApplyAsNew }) => {
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, border: on ? 'none' : `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 13,
    fontWeight: on ? 'bold' : 'normal', background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : text,
  });

  const [what, setWhat] = useState<'off' | 'hours'>('off');
  const [offValue, setOffValue] = useState(2);
  const [hoursValue, setHoursValue] = useState<number>(35 * 60);
  const [otherText, setOtherText] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [skipSame, setSkipSame] = useState(true);
  const [mode, setMode] = useState<'here' | 'new'>('here');
  const [newName, setNewName] = useState(`${planName}（まとめて変更）`.slice(0, 40));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 対象にできる人＝目標のある人（正社員・仮の人）。役職のない仮の人は「仮の人」として選べる
  const targets = rows.filter(r => r.defaultTarget != null || r.terms?.weekly_minutes != null);
  const presentRoles = roles.filter(ro => targets.some(r => r.roleId === ro.id));
  const hasTemps = targets.some(r => r.isTemp);
  const TEMP_ROLE = '__temp__';

  const otherMin = otherText.trim() ? parseHours(otherText) : null;
  const value = what === 'off' ? offValue : (otherText.trim() ? otherMin : hoursValue);

  const split = useMemo(() => {
    if (value == null) return { change: [], skip: [] };
    return bulkSplit(targets.map(r => ({
      id: r.key,
      roleId: r.isTemp ? TEMP_ROLE : r.roleId,
      current: what === 'off' ? (r.terms?.weekly_off ?? r.defaultOff) : (r.terms?.weekly_minutes ?? r.defaultTarget),
      keep: r.terms?.keep ?? false,
      keepReason: r.terms?.keep_reason ?? null,
    })), roleIds, value, skipSame);
  }, [targets, roleIds, value, skipSame, what]);

  const nameOf = (key: string) => rows.find(r => r.key === key)?.name ?? '（不明）';
  const fmt = (v: number | null) => (v == null ? '—' : what === 'off' ? `${v}` : hm(v));

  const build = (): KidsPlanPerson[] => split.change.map(p => {
    const r = rows.find(x => x.key === p.id)!;
    const base: KidsPlanPerson = r.terms ?? { key: r.key, weekly_off: null, weekly_minutes: null, daily_minutes: null, keep: false, keep_reason: null };
    return what === 'off' ? { ...base, weekly_off: value } : { ...base, weekly_minutes: value };
  });

  const go = async () => {
    setErr('');
    if (value == null || (what === 'hours' && (value < 60 || value > 4800))) { setErr('週の目標時間は「36」「36.5」「36:30」の形で、1〜80時間で入れてください'); return; }
    if (roleIds.size === 0) { setErr('対象の役職を選んでください'); return; }
    if (split.change.length === 0) { setErr('変わる人がいません。対象や値を見直してください'); return; }
    if (mode === 'new' && !newName.trim()) { setErr('新しい案の名前を入れてください'); return; }
    setBusy(true);
    const e = mode === 'new' ? await onApplyAsNew(newName.trim(), build()) : await onApply(build());
    setBusy(false);
    if (e) { setErr(e); return; }
    onClose();
  };

  const footer = (
    <div style={{ display: 'flex', gap: 8 }}>
      <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} onClick={onClose} disabled={busy}>やめる</button>
      <button type="button" style={{ ...primaryBtn({ disabled: busy }), flex: 2 }} onClick={() => void go()} disabled={busy}>
        {busy ? '保存しています…' : mode === 'new' ? `新しい案に ${split.change.length}人を変えて残す` : `この案の ${split.change.length}人を変える`}
      </button>
    </div>
  );

  return (
    <ShiftDialogFrame isDarkMode={isDarkMode} width={620} labelledBy="bulk-terms-title" footer={footer}>
      <div id="bulk-terms-title" style={{ fontWeight: 'bold', fontSize: 15, marginBottom: 2 }}>まとめて変える（この案だけ）</div>
      <div style={{ fontSize: 12, color: subText, marginBottom: 10 }}>下の一覧が、変えたときの結果です。［やめる］を押せば何も変わりません。</div>

      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>変えるもの</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button type="button" style={chip(what === 'off')} onClick={() => setWhat('off')}>週休</button>
        <button type="button" style={chip(what === 'hours')} onClick={() => setWhat('hours')}>週の目標時間</button>
      </div>

      {what === 'off' ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: subText }}>週休を</span>
          {[1, 2, 3].map(n => <button key={n} type="button" style={chip(offValue === n)} onClick={() => setOffValue(n)}>{n}日</button>)}
          <span style={{ fontSize: 12.5, color: subText }}>にする</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: subText }}>週の目標時間を</span>
          {HOUR_CHOICES.map(m => (
            <button key={m} type="button" style={chip(!otherText.trim() && hoursValue === m)} onClick={() => { setHoursValue(m); setOtherText(''); }}>
              {hm(m).replace(/:00$/, '').replace(':30', '.5')}
            </button>
          ))}
          <span style={{ fontSize: 12.5, color: subText }}>ほか</span>
          <input type="text" inputMode="decimal" value={otherText} placeholder="36.5" style={{ ...inputStyle, width: 70 }} onChange={e => setOtherText(e.target.value)} />
          <span style={{ fontSize: 12.5, color: subText }}>時間にする</span>
        </div>
      )}

      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>対象の役職（いくつでも）</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {presentRoles.map(ro => (
          <button key={ro.id} type="button" style={chip(roleIds.has(ro.id))}
            onClick={() => setRoleIds(prev => { const n = new Set(prev); if (n.has(ro.id)) n.delete(ro.id); else n.add(ro.id); return n; })}>{ro.name}</button>
        ))}
        {hasTemps && (
          <button type="button" style={chip(roleIds.has(TEMP_ROLE))}
            onClick={() => setRoleIds(prev => { const n = new Set(prev); if (n.has(TEMP_ROLE)) n.delete(TEMP_ROLE); else n.add(TEMP_ROLE); return n; })}>仮の人</button>
        )}
      </div>
      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>（目標のある方＝正社員と仮の人だけが対象です）</div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 2, cursor: 'pointer' }}>
        <input type="checkbox" checked={skipSame} onChange={e => setSkipSame(e.target.checked)} />
        すでに{what === 'off' ? `週休${offValue}日` : `週${value != null ? hm(value) : '—'}`}の人は変えない
      </label>
      <div style={{ fontSize: 12.5, color: subText, marginBottom: 10 }}>「まとめて変えない」の印がある方は変えません（人ごとの窓で付け外しできます）</div>

      <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.6, marginBottom: 10 }}>
        <div style={{ fontWeight: 'bold' }}>変わる人 {split.change.length}人</div>
        <div>{split.change.length === 0 ? <span style={{ color: subText }}>まだいません（役職を選んでください）</span>
          : split.change.map(p => `${nameOf(p.id)} ${fmt(p.current)}→${fmt(value)}`).join('／')}</div>
        {split.skip.length > 0 && (
          <div style={{ color: subText, marginTop: 4 }}>変えない：{split.skip.map(s => `${nameOf(s.p.id)}（${s.why}）`).join('・')}</div>
        )}
      </div>

      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>残し方</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', border: `${mode === 'here' ? 2 : 1}px solid ${mode === 'here' ? TOGGLE_BLUE : borderColor}`, borderRadius: 8, padding: '6px 10px' }}>
          <input type="radio" checked={mode === 'here'} onChange={() => setMode('here')} />
          <span>この案（{planName}）に入れる</span>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', cursor: canNewPlan ? 'pointer' : 'not-allowed', opacity: canNewPlan ? 1 : 0.7, border: `${mode === 'new' ? 2 : 1}px solid ${mode === 'new' ? TOGGLE_BLUE : borderColor}`, borderRadius: 8, padding: '6px 10px' }}>
          <input type="radio" checked={mode === 'new'} disabled={!canNewPlan} onChange={() => setMode('new')} />
          <span>新しい案として残す（この案を写して変える）</span>
          {mode === 'new' && (
            <input type="text" value={newName} maxLength={40} placeholder="名前（例：一般全員週休2）" style={{ ...inputStyle, flex: 1, minWidth: 180 }}
              onChange={e => setNewName(e.target.value)} />
          )}
          {!canNewPlan && <span style={{ fontSize: 12, color: subText, width: '100%' }}>作業中の案が上限に達しています。使わない案を過去の案に移すと作れます</span>}
        </label>
      </div>
      {err && <div style={{ color: red, marginTop: 8 }}>{err}</div>}
    </ShiftDialogFrame>
  );
};

export default ShiftBulkTermsDialog;
