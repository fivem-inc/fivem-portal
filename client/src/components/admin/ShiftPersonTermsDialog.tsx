import React, { useCallback, useState } from 'react';
import { backBtn, primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { ROSTER_DAY_LABEL, minText, normTime, toMin } from '../../lib/shiftRoster';
import { WEEK_DAYS, hm, parseHours } from '../../lib/shiftWeekSummary';
import type { KidsPlanPerson, KidsPlanPersonDay } from '../../lib/kidsShift';
import { ShiftDialogFrame } from './ShiftCellDialog';
import type { WeekRow } from './ShiftWeekView';

// 人ごとの窓（2026-10-22・docs/計画-シフト表の時間と週休.md）。
// ・作業中の案：週休・週の目標時間・1日の目安・まとめて変えない（理由）・曜日ごとの出勤／退勤の時刻・事務の時間。保存は案の中だけ
// ・決定済みの表：週の目標時間だけ（勤務表・プロフィールには触らない）
// 🚨 押した瞬間には保存しない。［この内容にする］で保存する（ほかの窓とそろえる）

const HOUR_CHOICES = [40 * 60, 37.5 * 60, 35 * 60, 30 * 60];

const ShiftPersonTermsDialog: React.FC<{
  isDarkMode: boolean;
  row: WeekRow;
  isPlan: boolean;
  onClose: () => void;
  /** 案：前提と曜日ごとを保存。エラーの文を返す */
  onSavePlan: (t: KidsPlanPerson, days: KidsPlanPersonDay[]) => Promise<string | null>;
  /** 決定済みの表：週の目標時間（null＝既定に戻す） */
  onSaveTarget: (minutes: number | null) => Promise<string | null>;
}> = ({ isDarkMode, row, isPlan, onClose, onSavePlan, onSaveTarget }) => {
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, border: on ? 'none' : `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 13,
    fontWeight: on ? 'bold' : 'normal', background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : text,
  });

  const t0 = row.terms;
  const [off, setOff] = useState<number | null>(t0?.weekly_off ?? null);
  const [target, setTarget] = useState<number | null>(t0?.weekly_minutes ?? (isPlan ? null : row.targetSet));
  const [otherText, setOtherText] = useState(() => {
    const v = t0?.weekly_minutes ?? (isPlan ? null : row.targetSet);
    return v != null && !HOUR_CHOICES.includes(v) ? hm(v) : '';
  });
  const [dailyText, setDailyText] = useState(t0?.daily_minutes != null ? hm(t0.daily_minutes) : '');
  const [keep, setKeep] = useState(t0?.keep ?? false);
  const [keepReason, setKeepReason] = useState(t0?.keep_reason ?? '');
  const [days, setDays] = useState<Record<string, { start: string; end: string; office: { start: string; end: string }[] }>>(() => {
    const m: Record<string, { start: string; end: string; office: { start: string; end: string }[] }> = {};
    for (const d of WEEK_DAYS) {
      const r = row.days.find(x => x.day_kind === d);
      m[d] = { start: r?.start ?? '', end: r?.end ?? '', office: (r?.office ?? []).map(o => ({ ...o })) };
    }
    return m;
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const effTarget = target ?? row.defaultTarget;
  const effOff = off ?? row.defaultOff;
  const autoDaily = effTarget != null && effOff != null && 7 - effOff > 0 ? Math.round(effTarget / (7 - effOff)) : null;

  const setDay = (d: string, patch: Partial<{ start: string; end: string; office: { start: string; end: string }[] }>) =>
    setDays(prev => ({ ...prev, [d]: { ...prev[d], ...patch } }));

  const save = useCallback(async () => {
    setErr('');
    let minutes = target;
    if (otherText.trim()) {
      const v = parseHours(otherText);
      if (v == null || v < 60 || v > 4800) { setErr('週の目標時間は「36」「36.5」「36:30」の形で、1〜80時間で入れてください'); return; }
      minutes = v;
    }
    if (!isPlan) {
      setBusy(true);
      const e = await onSaveTarget(minutes);
      setBusy(false);
      if (e) { setErr(e); return; }
      onClose();
      return;
    }
    let daily: number | null = null;
    if (dailyText.trim()) {
      daily = parseHours(dailyText);
      if (daily == null || daily < 30 || daily > 960) { setErr('1日の目安は「8」「7.5」「7:30」の形で入れてください'); return; }
    }
    const outDays: KidsPlanPersonDay[] = [];
    for (const d of WEEK_DAYS) {
      const v = days[d];
      const s = normTime(v.start); const e = normTime(v.end);
      if (s && e && (toMin(e) ?? 0) <= (toMin(s) ?? 0)) { setErr(`${ROSTER_DAY_LABEL[d]}：退勤は出勤より後にしてください`); return; }
      for (const o of v.office) {
        const os = normTime(o.start); const oe = normTime(o.end);
        if (!os || !oe || (toMin(oe) ?? 0) <= (toMin(os) ?? 0)) { setErr(`${ROSTER_DAY_LABEL[d]}：事務の時間は、始まりと終わりを入れて、終わりを後にしてください`); return; }
      }
      if (s || e || v.office.length > 0) outDays.push({ key: row.key, day_kind: d, start: s, end: e, office: v.office.map(o => ({ start: normTime(o.start), end: normTime(o.end) })) });
    }
    setBusy(true);
    const e = await onSavePlan({ key: row.key, weekly_off: off, weekly_minutes: minutes, daily_minutes: daily, keep, keep_reason: keep ? (keepReason.trim() || null) : null }, outDays);
    setBusy(false);
    if (e) { setErr(e); return; }
    onClose();
  }, [target, otherText, isPlan, onSaveTarget, onClose, dailyText, days, onSavePlan, row.key, off, keep, keepReason]);

  const footer = (
    <div style={{ display: 'flex', gap: 8 }}>
      <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} onClick={onClose} disabled={busy}>直さずに閉じる</button>
      <button type="button" style={{ ...primaryBtn({ disabled: busy }), flex: 2 }} onClick={() => void save()} disabled={busy}>{busy ? '保存しています…' : 'この内容にする'}</button>
    </div>
  );

  return (
    <ShiftDialogFrame isDarkMode={isDarkMode} width={600} labelledBy="person-terms-title" footer={footer}>
      <div id="person-terms-title" style={{ fontWeight: 'bold', fontSize: 15 }}>
        {row.name}{isPlan ? 'の働き方（この案だけ）' : 'の週の目標時間'}
      </div>
      <div style={{ fontSize: 12, color: subText, margin: '2px 0 10px' }}>
        {isPlan
          ? `いまの勤務表：${row.defaultOff != null ? `週休${row.defaultOff}日` : '勤務表なし'}。この窓で変えた内容は、この案の中だけです（勤務表・本人の設定・給与は変わりません）`
          : '決定済みの表の「目標まで」に使います。正社員は、変えなければ週40時間です'}
      </div>

      {isPlan && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>週休</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {[1, 2, 3].map(n => <button key={n} type="button" style={chip(effOff === n)} onClick={() => setOff(n)}>{n}日</button>)}
            {off != null && <button type="button" style={{ background: 'none', border: 'none', color: subText, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setOff(null)}>↩ 勤務表どおりに戻す</button>}
          </div>
          {/* 前提を変えるだけで赤が消える件（2026-10-22 2体のレビュー） */}
          <div style={{ marginTop: 6, fontSize: 12, color: isDarkMode ? '#ffe08a' : '#856404', background: isDarkMode ? '#4d3d00' : '#fff3cd', borderRadius: 6, padding: '4px 8px' }}>
            シフトに合わせて前提を変えると赤は消えます。休みを増やすときは、曜日で見るのマスを直してください。
          </div>
        </div>
      )}

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>週の目標時間</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {HOUR_CHOICES.map(m => (
            <button key={m} type="button" style={chip(!otherText.trim() && effTarget === m)} onClick={() => { setTarget(m); setOtherText(''); }}>{hm(m).replace(/:00$/, '').replace(':30', '.5')}</button>
          ))}
          <span style={{ fontSize: 12.5, color: subText }}>ほか</span>
          <input type="text" inputMode="decimal" value={otherText} placeholder="36.5" style={{ ...inputStyle, width: 70 }} onChange={e => setOtherText(e.target.value)} />
          <span style={{ fontSize: 12.5, color: subText }}>時間</span>
          {(target != null || otherText) && (
            <button type="button" style={{ background: 'none', border: 'none', color: subText, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }}
              onClick={() => { setTarget(null); setOtherText(''); }}>↩ {isPlan ? 'いまの値に戻す' : '既定に戻す'}</button>
          )}
        </div>
        {effTarget == null && !otherText && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>目標なし（パートの方は目標を付けません）</div>}
        {effTarget != null && !otherText && target == null && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>いま：週{hm(effTarget)}（{isPlan ? '決定済みの表の値' : '既定'}）</div>}
      </div>

      {isPlan && (
        <>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>1日の目安</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" inputMode="decimal" value={dailyText} placeholder={autoDaily != null ? hm(autoDaily) : ''} style={{ ...inputStyle, width: 80 }} onChange={e => setDailyText(e.target.value)} />
              <span style={{ fontSize: 12, color: subText }}>
                {autoDaily != null ? `空なら 週の目標 ÷ 出勤${7 - (effOff ?? 0)}日＝${hm(autoDaily)}（自動）` : '空なら出しません'}。この長さを超えた日は黄色にします
              </span>
            </div>
          </div>

          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} />
            まとめて変えない（「まとめて変える」で、この方を対象から外します）
          </label>
          {keep && (
            <input type="text" value={keepReason} maxLength={100} placeholder="理由（任意）例：選手のため週休1"
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginBottom: 10 }} onChange={e => setKeepReason(e.target.value)} />
          )}

          <div style={{ fontSize: 12, color: subText, margin: '8px 0 4px' }}>
            曜日ごとの出勤・退勤と事務の時間（空なら今の勤務表のまま。勤務表に無い日は、最初の担当の前〜最後の担当の後）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {WEEK_DAYS.map(d => {
              const v = days[d];
              const auto = row.autoDay[d];
              const ds = row.summary.days[d];
              const rosterText = (ds.roster ?? []).filter(x => x.e > x.s).map(x => `${minText(x.s)}〜${minText(x.e)}`).join(' / ');
              const useRoster = !!rosterText && ds.change !== 'new' && ds.change !== 'off';
              const busy = row.busy[d] ?? [];
              const dutyText = busy.length ? `${minText(Math.min(...busy.map(b => b.s)))}〜${minText(Math.max(...busy.map(b => b.e)))}` : '';
              // 担当が変わった日：まだ時刻を入れていなければ「こうしますか」（押すと入力欄に入るだけ・保存は［この内容にする］）
              const sg = ds.suggest && !v.start && !v.end ? ds.suggest : null;
              return (
                <div key={d} style={{ border: `1px solid ${ds.change ? red : borderColor}`, borderRadius: 8, padding: '5px 8px' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ width: 22 }}>{ROSTER_DAY_LABEL[d]}</b>
                    <span style={{ fontSize: 12, color: subText }}>出勤</span>
                    <input type="time" step={300} value={v.start} style={{ ...inputStyle, width: 105 }} onChange={e => setDay(d, { start: e.target.value })} />
                    <span style={{ fontSize: 12, color: subText }}>退勤</span>
                    <input type="time" step={300} value={v.end} style={{ ...inputStyle, width: 105 }} onChange={e => setDay(d, { end: e.target.value })} />
                    <span style={{ fontSize: 11.5, color: subText }}>
                      {useRoster ? `勤務表 ${rosterText}`
                        : auto.start != null ? `自動 ${minText(auto.start)}〜${auto.end != null ? minText(auto.end) : ''}` : rosterText ? `勤務表 ${rosterText}` : '担当なし'}
                    </span>
                    {(v.start || v.end) && <button type="button" style={{ background: 'none', border: 'none', color: subText, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setDay(d, { start: '', end: '' })}>↩ {useRoster ? '勤務表に戻す' : '自動に戻す'}</button>}
                  </div>
                  {ds.change && (
                    <div style={{ fontSize: 12, color: red, marginTop: 3, paddingLeft: 28 }}>
                      {ds.change === 'changed' && `担当が変わりました${dutyText ? `（担当 ${dutyText}）` : ''}。選ぶまでは勤務表のまま数えます`}
                      {ds.change === 'off' && 'この案では休み（担当が無くなりました）'}
                      {ds.change === 'new' && `勤務表に無い日です（担当の前後で数えています${auto.start != null ? `：${minText(auto.start)}〜${auto.end != null ? minText(auto.end) : ''}` : ''}）`}
                    </div>
                  )}
                  {ds.studyOnly && (
                    <div style={{ fontSize: 12, color: isDarkMode ? '#ffe08a' : '#856404', marginTop: 3, paddingLeft: 28 }}>
                      勉強会あり（{ds.studyOnly.map(x => `${minText(x.s)}〜${minText(x.e)}`).join('・')}）。この案では休みとして数えています（勉強会は勤務が決まってから組み直します）
                    </div>
                  )}
                  {sg && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, paddingLeft: 28 }}>
                      <span style={{ fontSize: 12.5, color: red }}>
                        {sg.start !== sg.fromStart && `出勤を ${minText(sg.fromStart)} → ${minText(sg.start)}`}
                        {sg.start !== sg.fromStart && sg.end !== sg.fromEnd && '・'}
                        {sg.end !== sg.fromEnd && `退勤を ${minText(sg.fromEnd)} → ${minText(sg.end)}`}
                        にしますか？
                      </span>
                      <button type="button" style={{ ...primaryBtn(), padding: '3px 10px', fontSize: 12 }}
                        onClick={() => setDay(d, { start: normTime(minText(sg.start)), end: normTime(minText(sg.end)) })}>{minText(sg.start)}〜{minText(sg.end)} にする</button>
                      <button type="button" style={{ ...backBtn(isDarkMode), padding: '3px 10px', fontSize: 12 }}
                        onClick={() => setDay(d, { start: normTime(minText(sg.fromStart)), end: normTime(minText(sg.fromEnd)) })}>勤務表のまま（{minText(sg.fromStart)}〜{minText(sg.fromEnd)}）</button>
                    </div>
                  )}
                  {v.office.map((o, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap', paddingLeft: 28 }}>
                      <span style={{ fontSize: 12 }}>事務</span>
                      <input type="time" step={300} value={o.start} style={{ ...inputStyle, width: 105 }}
                        onChange={e => setDay(d, { office: v.office.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
                      <span style={{ fontSize: 12, color: subText }}>〜</span>
                      <input type="time" step={300} value={o.end} style={{ ...inputStyle, width: 105 }}
                        onChange={e => setDay(d, { office: v.office.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
                      <button type="button" aria-label="この事務の時間を消す" style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText }}
                        onClick={() => setDay(d, { office: v.office.filter((_, j) => j !== i) })}>✕</button>
                    </div>
                  ))}
                  {v.office.length < 6 && (
                    <button type="button" style={{ ...tintBtn(isDarkMode), marginTop: 4, marginLeft: 28, padding: '2px 10px', fontSize: 12 }}
                      onClick={() => setDay(d, { office: [...v.office, { start: '', end: '' }] })}>＋ 事務の時間</button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {err && <div style={{ color: red, marginTop: 8 }}>{err}</div>}
    </ShiftDialogFrame>
  );
};

export default ShiftPersonTermsDialog;
