// ログインの記録（管理者だけ・2026-10-16 ユーザー確定）。置き場所は管理画面「👤 ユーザー」のいちばん下。
// 決めたこと・表の作りは supabase/migrations/20261016181404_login_history.sql の冒頭。
//
// ・いまログインしている端末：人を選ぶと一覧。［この端末をログアウト］（パソコンもスマホも・確認つき）
//   → その端末の通知の登録も消える（端末が分かるときだけ）。効くのは最長1時間ほど後（いまの通行証が切れるまで）
// ・記録（90日分）：ログイン／ログアウト／自動ログアウト（共有）／強制ログアウト／使っていないため。新しい順・500件まで。期間のボタン（今日／7日／30日／90日・最初は7日）と、高さの決まった枠（見出しは上に残す）・行を押すと端末番号（2026-10-23）
// ・使っていないパソコンの自動ログアウト：最後に使ってから N 日（app_settings 'pc_idle_session_days'・既定30・0で止める）。
//   保存の前に「今夜ログアウトされる見込み」を出す（admin_pc_idle_preview）
// 🚨 表は管理者しか読めない（RLS）。書くのは DB の関数だけ
// 🚨 人をすばやく切り替えたとき、古い応答で一覧が入れ替わらないようにする（一覧は「誰の一覧か」と一緒に持つ）。
//    確認の名前も一覧の持ち主から引く。処理中は人を変えられない（2026-10-16 UI/UX レビュー）

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';
import { backBtn, primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { describeUserAgent, deviceShortCode } from '../../lib/deviceInfo';

interface LoginEvent {
  id: number; user_id: string; event: string; at: string; session_id: string | null;
  device_id: string | null; device_kind: string | null; device_label: string | null; shared_pc: boolean | null; actor_id: string | null;
}
interface SessionRow {
  session_id: string; logged_in_at: string; last_used_at: string; user_agent: string | null;
  device_id: string | null; device_kind: string | null; device_label: string | null; shared_pc: boolean | null; is_current: boolean;
}

const EVENT_LABEL: Record<string, string> = {
  login: 'ログイン',
  logout: 'ログアウト',
  idle_logout: '自動ログアウト（共有の端末）',
  forced_logout: '強制ログアウト（管理者）',
  expired_logout: 'ログアウト（使っていないため）',
};
const PC_DAYS_KEY = 'pc_idle_session_days';
const DEFAULT_PC_DAYS = 30;
/** この日より前からのログインは、どの端末か分からない（記録を始めた日） */
const START_LABEL = '10/16 より前からのログイン';

const fmt = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${'日月火水木金土'[d.getUTCDay()]}）${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// 失敗の知らせ（固定色の箱・ダークでも読める・IdleLogoutSettingsSection と同じ）
const errBox: React.CSSProperties = { marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13, lineHeight: 1.6 };
const okBox: React.CSSProperties = { marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724', fontSize: 13, lineHeight: 1.6 };
const smallBtn: React.CSSProperties = { padding: '7px 14px', fontSize: 13 };

type KindFilter = 'all' | 'pc' | 'mobile';
// 表の期間（2026-10-23 ユーザー確定：ページが下に長く続くので、最初は7日・表は高さの決まった枠の中で動かす）
type Period = 'today' | '7' | '30' | '90';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: '今日' }, { key: '7', label: '7日' }, { key: '30', label: '30日' }, { key: '90', label: '90日' },
];
/** 期間の始まり（今日＝日本時間の今日の0時から） */
const periodStart = (p: Period): number => {
  const now = Date.now();
  if (p === 'today') { const j = new Date(now + 9 * 3600_000); return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600_000; }
  return now - Number(p) * 86400_000;
};
/** 表の端末の欄は短く（「スマホ（iPhone）・Safari（ホーム画面のアプリ）」→「iPhone・アプリ」・「パソコン（Windows）・Chrome」→「パソコン・Chrome」）。
 *  元の書き方は lib/deviceInfo の describeUserAgent／currentDevice */
const shortDevice = (label: string): string => label
  .replace(/^(スマホ|タブレット)（(.+?)）/, '$2')
  .replace(/^パソコン（Mac）/, 'Mac')
  .replace(/^パソコン（.+?）/, 'パソコン')
  .replace(/・[^・]*（ホーム画面のアプリ）$/, '・アプリ');
type StaffOpt = { id: string; name: string; active: boolean };

const LoginHistorySection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<StaffOpt[]>([]);
  const [err, setErr] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState<Period>('7');
  // 行を押すと端末番号を出す（1行だけ）
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [personId, setPersonId] = useState('');
  // 一覧は「誰の一覧か」と一緒に持つ（古い応答で入れ替わらないように）
  const [sessions, setSessions] = useState<{ uid: string; rows: SessionRow[] } | null>(null);
  const [sessErr, setSessErr] = useState('');
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [daysText, setDaysText] = useState('');
  const [daysMsg, setDaysMsg] = useState('');
  const [daysErr, setDaysErr] = useState('');
  const [preview, setPreview] = useState<{ days: number; count: number } | null>(null);
  const [daysBusy, setDaysBusy] = useState(false);
  const personRef = useRef('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  const text = isDarkMode ? '#fff' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 14, fontSize: 12.5, fontWeight: 'bold', cursor: 'pointer',
    border: `1px solid ${on ? TOGGLE_BLUE : border}`, background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : sub,
  });
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 8, fontSize: 14, border: `1px solid ${border}`,
    background: isDarkMode ? '#2b3035' : '#fff', color: text,
  };

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('login_events')
      .select('id, user_id, event, at, session_id, device_id, device_kind, device_label, shared_pc, actor_id')
      .order('at', { ascending: false })
      .limit(500);
    if (error) { setErr(`記録を読み込めませんでした：${error.message}`); return; }
    setEvents((data as LoginEvent[] | null) ?? []);
    const { data: profs, error: pErr } = await supabase.from('profiles').select('id, name, is_active').order('name');
    if (pErr) { setErr(`名前を読み込めませんでした：${pErr.message}`); return; }
    const map: Record<string, string> = {};
    const opts: StaffOpt[] = [];
    for (const p of (profs as { id: string; name: string | null; is_active: boolean | null }[] | null) ?? []) {
      map[p.id] = p.name || '（名前なし）';
      opts.push({ id: p.id, name: p.name || '（名前なし）', active: p.is_active !== false });
    }
    // 在籍の方を先に。退職（猶予期間中も）・入社前の方も選べるように下に並べる（いちばんログアウトさせたい相手のため）
    opts.sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
    setNames(map);
    setStaff(opts);
    setErr('');
  }, []);

  const loadDays = useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', PC_DAYS_KEY).maybeSingle();
    if (error) { setDaysErr(`設定を読み込めませんでした：${error.message}`); return; }
    const v = typeof data?.value === 'number' ? data.value : DEFAULT_PC_DAYS;
    setDays(v); setDaysText(String(v));
  }, []);

  useEffect(() => { void load(); void loadDays(); }, [load, loadDays]);

  const fetchSessions = useCallback(async (uid: string) => {
    const { data, error } = await supabase.rpc('admin_user_sessions', { p_user_id: uid });
    // 🚨 返ってくる間に別の人を選んでいたら捨てる
    if (personRef.current !== uid) return;
    if (error) { setSessErr(`端末を読み込めませんでした：${error.message}`); return; }
    setSessions({ uid, rows: (data as SessionRow[] | null) ?? [] });
  }, []);

  const openPerson = (uid: string, scroll = false) => {
    if (busy) return;
    personRef.current = uid;
    setPersonId(uid);
    setSessions(null); setSessErr(''); setConfirmFor(null); setMsg('');
    if (uid) void fetchSessions(uid);
    if (scroll) setTimeout(() => boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const labelOf = (s: { device_label: string | null; user_agent?: string | null }) =>
    s.device_label ?? (s.user_agent ? `${describeUserAgent(s.user_agent).label}（${START_LABEL}）` : `不明な端末（${START_LABEL}）`);

  const forceLogout = async (uid: string, s: SessionRow) => {
    setBusy(true); setMsg(''); setSessErr('');
    const { data, error } = await supabase.rpc('admin_force_logout', { p_session_id: s.session_id });
    const r = (data ?? {}) as { ok?: boolean; reason?: string; push_removed?: number; device_known?: boolean };
    if (error || !r.ok) {
      setBusy(false);
      setSessErr(error ? `ログアウトできませんでした：${error.message}` : (r.reason ?? 'ログアウトできませんでした'));
      return;
    }
    setConfirmFor(null);
    setMsg(!r.device_known
      ? `手続きをしました。この端末は最長1時間ほどで使えなくなります。（${START_LABEL}のため、どの端末か分からず、通知の登録は消せませんでした）`
      : `手続きをしました。この端末は最長1時間ほどで使えなくなります。${r.push_removed ? 'この端末の通知の登録も消しました。' : 'この端末には通知の登録はありませんでした。'}`);
    await fetchSessions(uid);
    setBusy(false);
    void load();
  };

  const daysNumber = (() => {
    const n = Number(daysText);
    return daysText.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 365 ? n : null;
  })();

  // 保存の前に：日数を小さくするときは、今夜ログアウトされる見込みを出してから
  const askSave = async () => {
    setDaysMsg(''); setDaysErr(''); setPreview(null);
    if (daysNumber === null) { setDaysErr('0〜365 の数字で入れてください（0 で止めます）'); return; }
    if (daysNumber === 0 || (days !== null && daysNumber >= days)) { await saveDays(daysNumber); return; }
    setDaysBusy(true);
    const { data, error } = await supabase.rpc('admin_pc_idle_preview', { p_days: daysNumber });
    setDaysBusy(false);
    if (error) { setDaysErr(`見込みを数えられませんでした：${error.message}`); return; }
    setPreview({ days: daysNumber, count: Number(data ?? 0) });
  };

  const saveDays = async (n: number) => {
    setDaysBusy(true);
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ key: PC_DAYS_KEY, value: n, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('key');
    setDaysBusy(false);
    setPreview(null);
    if (error) { setDaysErr(`保存できませんでした：${error.message}`); return; }
    if (!data || data.length === 0) { setDaysErr('保存できませんでした（権限がない可能性があります）'); return; }
    setDays(n);
    setDaysMsg(n === 0 ? '保存しました。使っていないパソコンの自動ログアウトは止まります。' : `保存しました。今夜から${n}日で効きます。`);
  };

  const shown = useMemo(() => {
    const qq = q.trim();
    const from = periodStart(period);
    return (events ?? []).filter(e => {
      if (new Date(e.at).getTime() < from) return false;
      if (kind === 'pc' && e.device_kind !== 'pc') return false;
      if (kind === 'mobile' && e.device_kind !== 'phone' && e.device_kind !== 'tablet') return false;
      if (qq && !(names[e.user_id] ?? '').includes(qq)) return false;
      return true;
    });
  }, [events, kind, q, names, period]);

  // 確認の名前は「一覧の持ち主」から引く（選択欄の今の値ではない）
  const ownerName = sessions ? (names[sessions.uid] ?? '') : '';
  const deviceText = (label: string, code: string, shared: boolean | null) =>
    `${label}${code ? ` ${code}` : ''}${shared ? '・共有' : ''}`;

  return (
    <div style={{ maxWidth: 760, margin: '28px auto 0', textAlign: 'left' }}>
      <h4 style={{ color: text, fontSize: 15, margin: '0 0 6px' }}>ログインの記録（90日分）</h4>
      <p style={{ fontSize: 12, color: sub, margin: '0 0 10px', lineHeight: 1.7 }}>
        だれが・いつ・どの端末でログイン／ログアウトしたかの記録です。管理者だけが見られます。<br />
        ・端末番号（例 PC-3F2A9C）：端末ごとの番号です。同じパソコンでも、ブラウザ（Chrome・Edge など）が違うと別の番号になります。閲覧履歴を消すと番号が変わります。<br />
        ・共有：ログイン画面で「この端末は共有です」にチェックした端末です。
      </p>

      {/* いまログインしている端末（人を選ぶ） */}
      <div ref={boxRef} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 12, marginBottom: 14, scrollMarginTop: 80 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 }}>いまログインしている端末</div>
        <select value={personId} disabled={busy} onChange={e => openPerson(e.target.value)} style={{ ...inputStyle, width: '100%', maxWidth: 320 }}>
          <option value="">名前を選んでください</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : '（在籍していない方）'}</option>)}
        </select>
        {sessErr && <div style={errBox}>{sessErr}</div>}
        {msg && <div style={okBox}>{msg}</div>}
        {personId && sessions === null && !sessErr && <div style={{ fontSize: 13, color: sub, marginTop: 8 }}>読み込み中…</div>}
        {sessions && sessions.uid === personId && sessions.rows.length === 0 && (
          <div style={{ fontSize: 13, color: sub, marginTop: 8 }}>{ownerName}さんは、いまどの端末でもログインしていません。</div>
        )}
        {sessions && sessions.uid === personId && sessions.rows.map(s => {
          const code = deviceShortCode(s.device_id, s.device_kind ?? describeUserAgent(s.user_agent ?? '').kind);
          return (
            <div key={s.session_id} style={{ borderTop: `1px solid ${border}`, marginTop: 8, paddingTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: 13, color: text, lineHeight: 1.6 }}>
                  <b>{labelOf(s)}</b>{code && <span style={{ color: sub }}> {code}</span>}
                  {s.shared_pc && <span style={{ color: sub }}>・共有</span>}
                  {s.is_current && <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 8px', borderRadius: 999, background: '#e3f2fd', color: '#0d47a1', fontWeight: 'bold' }}>この画面</span>}
                  <div style={{ fontSize: 12, color: sub }}>最後に使った日時：{fmt(s.last_used_at)}／ログイン：{fmt(s.logged_in_at)}</div>
                </div>
                {!s.is_current && confirmFor !== s.session_id && (
                  <button type="button" style={{ ...backBtn(isDarkMode), ...smallBtn }} disabled={busy} onClick={() => { setConfirmFor(s.session_id); setMsg(''); setSessErr(''); }}>
                    この端末をログアウト
                  </button>
                )}
              </div>
              {confirmFor === s.session_id && (
                <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404', fontSize: 13, lineHeight: 1.7 }}>
                  <b>{ownerName}さん</b>の <b>{labelOf(s)}{code ? `（${code}）` : ''}</b> をログアウトさせます。よろしいですか？<br />
                  ・最長1時間ほどで使えなくなります（いま開いている画面は、それまで使えます）<br />
                  ・{s.device_id ? 'この端末の通知（スマホ・パソコン）の登録も消します' : `${START_LABEL}のため、どの端末か分からず、通知は止められません`}<br />
                  ・本人はパスワードを入れれば、またログインできます
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" style={{ ...backBtn(isDarkMode), ...smallBtn, flex: 1 }} disabled={busy} onClick={() => setConfirmFor(null)}>やめる</button>
                    <button type="button" style={{ ...primaryBtn({ danger: true, disabled: busy }), ...smallBtn, flex: 2 }} disabled={busy}
                      onClick={() => void forceLogout(sessions.uid, s)}>
                      {busy ? '処理中…' : 'ログアウトさせる'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 記録の一覧 */}
      <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>名前を押すと、上にその人のいまの端末が出ます。</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: sub, marginRight: 2 }}>期間</span>
        {PERIODS.map(p => <button key={p.key} type="button" style={chip(period === p.key)} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: sub, marginRight: 2 }}>端末</span>
        <button type="button" style={chip(kind === 'all')} onClick={() => setKind('all')}>すべて</button>
        <button type="button" style={chip(kind === 'pc')} onClick={() => setKind('pc')}>パソコン</button>
        <button type="button" style={chip(kind === 'mobile')} onClick={() => setKind('mobile')}>スマホ・タブレット</button>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="表を名前で絞る" style={{ ...inputStyle, width: 150 }} />
      </div>
      {err && <div style={errBox}>{err}</div>}
      {events === null && !err ? (
        <div style={{ fontSize: 13, color: sub }}>読み込み中…</div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 13, color: sub, padding: 12, background: cardBg, border: `1px solid ${border}`, borderRadius: 8 }}>この期間の記録はありません</div>
      ) : (
        <>
        <div style={{ fontSize: 12.5, color: text, marginBottom: 6 }}>
          {PERIODS.find(p => p.key === period)?.label}{period === 'today' ? 'は' : 'で'} <b>{shown.length}件</b>（新しい順・行を押すと端末番号が出ます）
        </div>
        {/* 表は高さの決まった枠の中だけで上下に動かす。見出しの行は枠の上に残す（2026-10-23） */}
        <div style={{ overflow: 'auto', maxHeight: '50vh', border: `1px solid ${border}`, borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: text }}>
            <thead>
              <tr>
                {['日時', '名前', 'できごと', '端末'].map(h => (
                  <th key={h} style={{ padding: '6px 6px', borderBottom: `1px solid ${border}`, textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, background: isDarkMode ? '#495057' : '#f8f9fa' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(e => (
                <tr key={e.id} onClick={() => setOpenRow(o => (o === e.id ? null : e.id))}
                  style={{ borderBottom: `1px solid ${border}`, cursor: 'pointer', background: openRow === e.id ? (isDarkMode ? '#2c3e50' : '#e8f4fd') : undefined }}>
                  <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>{fmt(e.at)}</td>
                  <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }} onClick={ev => ev.stopPropagation()}>
                    <button type="button" disabled={busy} onClick={() => openPerson(e.user_id, true)}
                      style={{ background: 'transparent', border: 'none', padding: 0, color: TOGGLE_BLUE, textDecoration: 'underline', cursor: busy ? 'default' : 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                      {names[e.user_id] ?? '…'}
                    </button>
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    {EVENT_LABEL[e.event] ?? e.event}
                    {e.event === 'forced_logout' && e.actor_id && <span style={{ color: sub }}>（{names[e.actor_id] ?? ''}）</span>}
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    {e.device_label ? `${shortDevice(e.device_label)}${e.shared_pc ? '・共有' : ''}` : '—'}
                    {openRow === e.id && e.device_label && (
                      <div style={{ fontSize: 11.5, color: sub }}>{deviceText(e.device_label, deviceShortCode(e.device_id, e.device_kind), null)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {events && events.length >= 500 && <div style={{ fontSize: 11.5, color: sub, marginTop: 6 }}>新しい500件まで読んでいます（それより前は出ません）</div>}
        </>
      )}

      {/* 使っていないパソコンの自動ログアウト */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 12, marginTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>使っていないパソコンの自動ログアウト</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: text }}>
          パソコンは、最後に使ってから
          <input value={daysText} onChange={e => { setDaysText(e.target.value); setDaysMsg(''); setDaysErr(''); setPreview(null); }}
            inputMode="numeric" style={{ ...inputStyle, width: 70 }} disabled={days === null || daysBusy} />
          日でログアウト
          <button type="button" style={{ ...tintBtn(isDarkMode), ...smallBtn }} disabled={days === null || daysBusy} onClick={() => void askSave()}>保存</button>
        </div>
        <div style={{ fontSize: 11.5, color: sub, marginTop: 6, lineHeight: 1.6 }}>
          全員のパソコンが対象です（共有のパソコンも含みます）。毎晩 3:40 に確かめます。毎日使っている方は切れません。
          スマホ・タブレットは対象外です。0 にすると止めます（既定は30日）。保存すると今夜から効きます。
        </div>
        {preview && (
          <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: '#fff3cd', border: '2px solid #ffc107', color: '#856404', fontSize: 13, lineHeight: 1.7 }}>
            {preview.days}日にすると、今夜 3:40 に <b>パソコン{preview.count}台</b> がログアウトされる見込みです。保存しますか？
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" style={{ ...backBtn(isDarkMode), ...smallBtn, flex: 1 }} disabled={daysBusy} onClick={() => setPreview(null)}>やめる</button>
              <button type="button" style={{ ...primaryBtn({ disabled: daysBusy }), ...smallBtn, flex: 2 }} disabled={daysBusy} onClick={() => void saveDays(preview.days)}>この日数で保存</button>
            </div>
          </div>
        )}
        {daysErr && <div style={errBox}>{daysErr}</div>}
        {daysMsg && <div style={okBox}>{daysMsg}</div>}
      </div>
    </div>
  );
};

export default LoginHistorySection;
