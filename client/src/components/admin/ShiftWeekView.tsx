import React, { useMemo, useState } from 'react';
import { primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { ROSTER_DAY_LABEL, type RosterDayKind } from '../../lib/shiftRoster';
import { CHANGE_LABEL, WEEK_DAYS, hm, remainText, type WeekSummary } from '../../lib/shiftWeekSummary';
import type { KidsPlanPerson, KidsPlanPersonDay } from '../../lib/kidsShift';
import ShiftPersonTermsDialog from './ShiftPersonTermsDialog';
import ShiftBulkTermsDialog from './ShiftBulkTermsDialog';

// 週のまとめ（2026-10-22・docs/計画-シフト表の時間と週休.md）。こども・大人シフト表の［週のまとめ］で出す。
// ・決定済みの表：勤務時間＝勤務表／レッスン＝シフト表。目標の時間（正社員は既定40時間）だけ人ごとに直せる
// ・作業中の案：勤務時間の元は今の勤務表（2026-10-22 ユーザー確定）。担当が変わった日・休みになった日・勤務表に無い日は赤で出し、
//   変わった日は人ごとの窓で「出勤・退勤をこうしますか」と聞く。勤務表に無い日は担当の前後から組み立てる。
//   人ごとの窓・まとめて変える・仮の人・足りない人数・あとどこに入れるとよいか
// 🚨 計算は lib/shiftWeekSummary（画面はここで並べるだけ）。材料は KidsShiftPanel が集める

export interface WeekRow {
  key: string;
  name: string;
  isTemp: boolean;
  roleId: string | null;
  roleLabel: string;
  summary: WeekSummary;
  /** 案の前提（無ければ null） */
  terms: KidsPlanPerson | null;
  days: KidsPlanPersonDay[];
  /** 案：いまの勤務表の週休（出勤曜日から数える）。決定済みの表：null */
  defaultOff: number | null;
  /** 目標の時間の既定（正社員＝決定済みの表の値か40時間・仮の人＝40時間・パート＝null） */
  defaultTarget: number | null;
  /** 決定済みの表で人ごとに決めた目標（無ければ null） */
  targetSet: number | null;
  /** 案：出勤・退勤を自動で出したときの時刻（分） */
  autoDay: Record<RosterDayKind, { start: number | null; end: number | null }>;
  /** その曜日に担当・事務で埋まっている時間（あとどこに入れるとよいかの判定に使う） */
  busy: Record<RosterDayKind, { s: number; e: number }[]>;
}

export interface WeekSuggestion {
  day: RosterDayKind;
  what: string;
  need: number;
  candidates: string[];
}

export interface WeekTemp { id: string; label: string; note: string | null; count: number }

const ShiftWeekView: React.FC<{
  isDarkMode: boolean;
  isPlan: boolean;
  boardName: string;
  rows: WeekRow[];
  settings: { pre: number; post: number; gap: number };
  shortByDay: Record<RosterDayKind, number>;
  suggestions: WeekSuggestion[];
  temps: WeekTemp[];
  staffOptions: { id: string; name: string }[];
  compare: { name: string; rows: WeekRow[] } | null;
  roles: { id: string; name: string }[];
  planName: string;
  canNewPlan: boolean;
  onSavePlanPerson: (t: KidsPlanPerson, days: KidsPlanPersonDay[]) => Promise<string | null>;
  onSaveTarget: (userId: string, minutes: number | null) => Promise<string | null>;
  onBulkApply: (people: KidsPlanPerson[]) => Promise<string | null>;
  onBulkApplyAsNew: (name: string, people: KidsPlanPerson[]) => Promise<string | null>;
  onCreateTemp: (note: string) => Promise<string | null>;
  onAssignTemp: (tempId: string, userId: string) => Promise<string | null>;
  onDeleteTemp: (tempId: string) => Promise<string | null>;
}> = props => {
  const { isDarkMode, isPlan, boardName, rows, settings, shortByDay, suggestions, temps, staffOptions, compare } = props;
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const warnBg = isDarkMode ? '#4d3d00' : '#fff3cd';
  const warnText = isDarkMode ? '#ffe08a' : '#856404';
  const blue = isDarkMode ? '#8ab4f8' : '#0d6efd';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const toggle = (on: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
    fontWeight: on ? 'bold' : 'normal', background: on ? TOGGLE_BLUE : (isDarkMode ? '#495057' : '#e9ecef'), color: on ? '#fff' : text,
  });

  const [sort, setSort] = useState<'list' | 'remain'>('list');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [tempNote, setTempNote] = useState('');
  const [assign, setAssign] = useState<{ tempId: string; userId: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => {
    if (sort === 'list') return rows;
    // 目標まで：余裕のある順（目標なしは最後）
    return [...rows].sort((a, b) => (b.summary.remain ?? -Infinity) - (a.summary.remain ?? -Infinity));
  }, [rows, sort]);
  const openRow = rows.find(r => r.key === openKey) ?? null;

  const run = async (f: () => Promise<string | null>, ok: string) => {
    setBusy(true); setErr(''); setMsg('');
    const e = await f();
    setBusy(false);
    if (e) setErr(e); else setMsg(ok);
  };

  const th: React.CSSProperties = { padding: '6px 6px', fontSize: 12, color: subText, fontWeight: 'bold', textAlign: 'left', whiteSpace: 'nowrap', background: innerBg, borderBottom: `1px solid ${borderColor}` };
  const td: React.CSSProperties = { padding: '6px 6px', fontSize: 12.5, color: text, verticalAlign: 'top', borderTop: `1px solid ${borderColor}` };

  const totalShort = WEEK_DAYS.reduce((a, d) => a + shortByDay[d], 0);
  const maxShort = Math.max(...WEEK_DAYS.map(d => shortByDay[d]));

  return (
    <div>
      <div style={{ fontSize: 12.5, color: subText, marginBottom: 8, lineHeight: 1.6 }}>
        {isPlan
          ? `勤務時間は今の勤務表の出勤・退勤を元にしています（担当が決定済みの表と同じ日は勤務表のまま）。担当が変わった日・休みになった日・勤務表に無い日は赤で出します。変わった日は、名前を押すと出勤・退勤を変えるか選べます（選ぶまでは勤務表のまま数えます）。勤務表に無い日は、最初の担当の${settings.pre}分前に出勤・最後の担当の${settings.post}分後に退勤で数えます。休憩は会社の決まりで引きます。`
          : '勤務時間は勤務表（いつものシフト）、レッスンの時間はシフト表の担当から出しています。休憩は会社の決まりで引きます。'}
        {' '}名前を押すと{isPlan ? 'その方の働き方' : '週の目標時間'}を直せます。
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: subText }}>並び：</span>
        <button type="button" style={toggle(sort === 'list')} onClick={() => setSort('list')}>表の並び</button>
        <button type="button" style={toggle(sort === 'remain')} onClick={() => setSort('remain')}>目標まで（余裕のある順）</button>
        {isPlan && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={primaryBtn()} onClick={() => { setBulk(true); setMsg(''); setErr(''); }}>まとめて変える</button>
          </span>
        )}
      </div>

      {msg && <div style={{ padding: '6px 10px', borderRadius: 8, background: '#d4edda', color: '#155724', fontSize: 13, marginBottom: 8 }}>{msg}</div>}
      {err && <div style={{ color: red, fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...th, position: 'sticky', left: 0, zIndex: 1 }}>名前</th>
              <th style={th}>目標まで</th>
              <th style={th}>合計／目標</th>
              <th style={th}>レッスン</th>
              <th style={th}>レッスン以外</th>
              <th style={th}>出勤（週休）</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const s = r.summary;
              const over = s.remain != null && s.remain < 0;
              const days = s.overDailyDays.map(d => ROSTER_DAY_LABEL[d]).join('・');
              return (
                <tr key={r.key} onClick={() => setOpenKey(r.key)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...td, fontWeight: 'bold', position: 'sticky', left: 0, background: isDarkMode ? '#343a40' : '#fff', minWidth: 90 }}>
                    <span style={r.isTemp ? { border: `1px dashed ${subText}`, borderRadius: 4, padding: '0 4px' } : undefined}>{r.name}</span>
                    {r.terms?.keep && <div style={{ fontSize: 11, color: subText, fontWeight: 'normal' }}>（まとめて変えない{r.terms.keep_reason ? `：${r.terms.keep_reason}` : ''}）</div>}
                    {r.roleLabel && <div style={{ fontSize: 11, color: subText, fontWeight: 'normal' }}>{r.roleLabel}</div>}
                  </td>
                  <td style={{ ...td, fontWeight: 'bold', color: over ? red : s.remain != null && s.remain > 0 ? blue : text, whiteSpace: 'nowrap' }}>
                    {remainText(s.remain)}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {hm(s.totalMin)}／{s.target != null ? hm(s.target) : '—'}
                    {s.over40 && <div style={{ fontSize: 11, color: red }}>週40時間を超えています</div>}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {hm(s.lessonMin)}
                    <div style={{ fontSize: 11, color: subText }}>こども {hm(s.lessonKids)}・大人 {hm(s.lessonAdult)}</div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{hm(s.otherMin)}</td>
                  <td style={{ ...td, ...(s.offMismatch || days ? { background: warnBg, color: warnText } : {}) }}>
                    {s.workDays}日（週休{s.offDays}）
                    {s.offMismatch && <div style={{ fontSize: 11 }}>前提は週休{s.offTarget}。{s.offDays > (s.offTarget ?? 0) ? `あと${s.offDays - (s.offTarget ?? 0)}日出勤` : `${(s.offTarget ?? 0) - s.offDays}日多く出勤`}</div>}
                    {days && <div style={{ fontSize: 11 }}>1日の目安（{s.dailyTarget != null ? hm(s.dailyTarget) : ''}）を超える日：{days}</div>}
                    {WEEK_DAYS.some(d => s.days[d].timeless) && <div style={{ fontSize: 11, color: subText }}>時刻の無い日：{WEEK_DAYS.filter(d => s.days[d].timeless).map(d => ROSTER_DAY_LABEL[d]).join('・')}（0時間で数えています）</div>}
                    {WEEK_DAYS.some(d => s.days[d].change) && (
                      <div style={{ fontSize: 11, color: red, fontWeight: 'bold' }}>
                        変わった日：{WEEK_DAYS.filter(d => s.days[d].change).map(d => `${ROSTER_DAY_LABEL[d]}（${CHANGE_LABEL[s.days[d].change!]}${s.days[d].suggest ? '・時刻を確認' : ''}）`).join('・')}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 足りない人数（曜日ごと）。シフト表の「追加必要」を曜日ごとに足したもの */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 4 }}>足りない人数（曜日ごと・シフト表の「追加必要」の合計）</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {WEEK_DAYS.map(d => (
            <div key={d} style={{ minWidth: 54, textAlign: 'center', padding: '4px 6px', borderRadius: 8, border: `1px solid ${borderColor}`,
              ...(shortByDay[d] > 0 ? { background: warnBg, color: warnText, fontWeight: 'bold' } : { color: subText }) }}>
              <div style={{ fontSize: 11.5 }}>{ROSTER_DAY_LABEL[d]}</div>
              <div style={{ fontSize: 14 }}>{shortByDay[d] > 0 ? `⚠️ ${shortByDay[d]}人` : '—'}</div>
            </div>
          ))}
        </div>
        {totalShort > 0 && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>いちばん多い日 {maxShort}人。{isPlan ? '「仮の人」をマスに入れると、何人採れば足りるかを試せます。' : ''}</div>}
      </div>

      {/* あとどこに入れるとよいか（足りないマスと、その曜日に「目標まで」が残っている人） */}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 4 }}>あとどこに入れるとよいか</div>
          <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>人が足りないマスと、その時間が空いていて「目標まで」が残っている方（多い順に3人まで）です。入れるときは、曜日で見るからマスを開いてください。</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {suggestions.map((g, i) => (
              <div key={i} style={{ fontSize: 12.5, color: text, padding: '4px 8px', borderRadius: 6, background: innerBg }}>
                <b>{ROSTER_DAY_LABEL[g.day]} {g.what}</b>（あと{g.need}人）
                {' ← '}{g.candidates.length > 0 ? g.candidates.join('・') : <span style={{ color: subText }}>空いている方がいません</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 仮の人（案だけ） */}
      {isPlan && (
        <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, border: `1px dashed ${borderColor}` }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>仮の人（採用予定など）</div>
          <div style={{ fontSize: 12, color: subText, margin: '2px 0 6px' }}>
            作った仮の人は、曜日で見るのマスの「人を選ぶ」に出ます（作業中の案の中だけ）。入社した方が決まったら［入社した人に置き換える］。仮の人が残っている案は決定できません。
          </div>
          {temps.length === 0 && <div style={{ fontSize: 12.5, color: subText }}>まだいません</div>}
          {temps.map(t => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4, fontSize: 12.5, color: text }}>
              <span style={{ border: `1px dashed ${subText}`, borderRadius: 4, padding: '0 6px', fontWeight: 'bold' }}>{t.label}</span>
              {t.note && <span style={{ color: subText }}>{t.note}</span>}
              <span style={{ color: subText }}>この案のマス {t.count}か所</span>
              {assign?.tempId === t.id ? (
                <>
                  <select value={assign.userId} style={inputStyle} onChange={e => setAssign({ tempId: t.id, userId: e.target.value })}>
                    <option value="">入社した方を選ぶ</option>
                    {staffOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button type="button" style={primaryBtn({ disabled: busy || !assign.userId })} disabled={busy || !assign.userId}
                    onClick={() => void run(() => props.onAssignTemp(t.id, assign.userId), `${t.label}を置き換えました（この案のマスと前提）`).then(() => setAssign(null))}>置き換える</button>
                  <button type="button" style={{ background: 'none', border: 'none', color: subText, textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }} onClick={() => setAssign(null)}>やめる</button>
                </>
              ) : (
                <>
                  <button type="button" style={{ ...tintBtn(isDarkMode), padding: '2px 10px', fontSize: 12 }} onClick={() => setAssign({ tempId: t.id, userId: '' })}>入社した人に置き換える</button>
                  {t.count === 0 && (
                    <button type="button" style={{ background: 'none', border: 'none', color: subText, textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}
                      onClick={() => void run(() => props.onDeleteTemp(t.id), `${t.label}を消しました`)}>消す</button>
                  )}
                </>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <input type="text" value={tempNote} maxLength={100} placeholder="メモ（任意）例：2027年4月 採用予定" style={{ ...inputStyle, width: 240 }} onChange={e => setTempNote(e.target.value)} />
            <button type="button" style={{ ...tintBtn(isDarkMode), padding: '4px 12px' }} disabled={busy}
              onClick={() => void run(() => props.onCreateTemp(tempNote), '仮の人を作りました').then(() => setTempNote(''))}>＋ 仮の人を作る</button>
          </div>
        </div>
      )}

      {/* 案を比べる（数字と人ごとの違い） */}
      {compare && <CompareBlock isDarkMode={isDarkMode} a={{ name: '今の画面', rows }} b={compare} boardName={boardName} />}

      {openRow && (
        <ShiftPersonTermsDialog isDarkMode={isDarkMode} row={openRow} isPlan={isPlan} onClose={() => setOpenKey(null)}
          onSavePlan={(t, d) => props.onSavePlanPerson(t, d)}
          onSaveTarget={m => props.onSaveTarget(openRow.key, m)} />
      )}
      {bulk && (
        <ShiftBulkTermsDialog isDarkMode={isDarkMode} rows={rows} roles={props.roles} planName={props.planName} canNewPlan={props.canNewPlan}
          onClose={() => setBulk(false)}
          onApply={async people => { const e = await props.onBulkApply(people); if (!e) setMsg(`${people.length}人を変えました`); return e; }}
          onApplyAsNew={async (name, people) => { const e = await props.onBulkApplyAsNew(name, people); if (!e) setMsg(`新しい案「${name}」を作り、${people.length}人を変えました`); return e; }} />
      )}
    </div>
  );
};

/** 2つの案の違い：数字と、違う人だけ */
const CompareBlock: React.FC<{ isDarkMode: boolean; a: { name: string; rows: WeekRow[] }; b: { name: string; rows: WeekRow[] }; boardName: string }> = ({ isDarkMode, a, b }) => {
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const warnBg = isDarkMode ? '#4d3d00' : '#fff3cd';
  const warnText = isDarkMode ? '#ffe08a' : '#856404';
  // 週休は前提があれば前提（案で変えた週休）、無ければ出勤から数えた休み
  const offOf = (r: WeekRow) => r.summary.offTarget ?? r.summary.offDays;
  const stat = (rows: WeekRow[]) => ({
    off2: rows.filter(r => offOf(r) >= 2).length,
    over: rows.filter(r => r.summary.remain != null && r.summary.remain < 0).length,
    over40: rows.filter(r => r.summary.over40).length,
    room: rows.reduce((x, r) => x + Math.max(0, r.summary.remain ?? 0), 0),
  });
  const sa = stat(a.rows);
  const sb = stat(b.rows);
  const line = (r: WeekRow | undefined) => (r ? `週休${offOf(r)}${r.summary.offMismatch ? `（いまの担当では${r.summary.offDays}）` : ''}・目標${r.summary.target != null ? hm(r.summary.target) : '—'}・合計${hm(r.summary.totalMin)}・${remainText(r.summary.remain)}` : '（いない）');
  const keys = [...new Set([...a.rows.map(r => r.key), ...b.rows.map(r => r.key)])];
  const diffs = keys.map(k => ({ k, ra: a.rows.find(r => r.key === k), rb: b.rows.find(r => r.key === k) }))
    .filter(x => line(x.ra) !== line(x.rb));
  const card = (label: string, va: string, vb: string) => (
    <div style={{ background: innerBg, borderRadius: 8, padding: '6px 10px', minWidth: 130 }}>
      <div style={{ fontSize: 11.5, color: subText }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 'bold', color: text }}>{va} → {vb}</div>
    </div>
  );
  return (
    <div style={{ marginTop: 14, padding: '8px 10px', borderRadius: 8, border: `1px solid ${borderColor}` }}>
      <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>比べる：今の画面 → {b.name}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {card('週休2日以上の人', `${sa.off2}人`, `${sb.off2}人`)}
        {card('目標を超える人', `${sa.over}人`, `${sb.over}人`)}
        {card('週40時間を超える人', `${sa.over40}人`, `${sb.over40}人`)}
        {card('目標までの合計（空き）', hm(sa.room), hm(sb.room))}
      </div>
      {diffs.length === 0 ? <div style={{ fontSize: 12.5, color: subText }}>人ごとの違いはありません</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {diffs.map(x => (
            <div key={x.k} style={{ fontSize: 12.5, color: text }}>
              <b>{x.ra?.name ?? x.rb?.name}</b>：{line(x.ra)} → <span style={{ background: warnBg, color: warnText, padding: '0 4px', borderRadius: 3 }}>{line(x.rb)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ShiftWeekView;
