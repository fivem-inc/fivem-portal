// ユーザー管理の「入社予定のスタッフ」の欄（2026-10-04）。設計は docs/計画-入社予定スタッフの登録と招待.md
//
// ・名前と入社日だけで先に登録できる（メールは任意）。勤務表には登録した日から出る（入社日からのシフトを先に入れられる）
// ・招待メールは「入社日の朝10時／今すぐ／まだ送らない」を選ぶ。あとからメールを入れたら、保存の前に送るかを確かめる
// ・入社したあともメールが仮のままの人はここに残る（メールを聞いて入れるため）
// 🚨 書き込みは Edge Function staff-onboard だけ（アカウントの作成・メールの差し替えに管理者の権限が要るため）
// 🚨 判定は lib/staffState.ts（isPrehire / isPlaceholderEmail）。ここで条件を書き直さない
// 🚨 supabase.functions.invoke は 4xx/5xx でも throw しない。error と success を見る

import React, { useMemo, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import { useRoles } from '../../hooks/useRoles';
import { todayJstStr } from '../../lib/breakCalc';
import { inviteStatusLabel, isPlaceholderEmail, isPrehire } from '../../lib/staffState';
import { primaryBtn, backBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import type { AdminUserProfile } from '../../types';

type SendMode = 'hire_date' | 'now' | 'none';
const SEND_LABEL: Record<SendMode, string> = {
  hire_date: '入社日の朝10時に送る',
  now: '今すぐ送る',
  none: 'まだ送らない',
};

const mdWeek = (ymd: string | null | undefined) => {
  if (!ymd) return '';
  const d = new Date(`${ymd}T12:00:00+09:00`);
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${'日月火水木金土'[d.getUTCDay()]}）`;
};

async function callOnboard(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const { data, error } = await supabase.functions.invoke('staff-onboard', { body });
  const d = (data ?? {}) as Record<string, unknown>;
  if (error || d.success !== true) return { ok: false, error: String(d.error ?? error?.message ?? '失敗しました') };
  return { ok: true, data: d };
}

const PrehireSection: React.FC = () => {
  const { isDarkMode, users, masterOptions, fetchUsers, setSuccessMsg, setErrorMsg } = useAdminPanel();
  const roleNames = useRoles().map(r => r.name);
  const employmentOptions = masterOptions.employment_type.length > 0 ? masterOptions.employment_type : ['正社員', 'パート'];
  const today = todayJstStr();
  const text = isDarkMode ? '#fff' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const cardBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 14, boxSizing: 'border-box',
    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#000',
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 'bold', color: sub, margin: '12px 0 4px' };

  // 入社予定の人と、入社したのにメールが仮のままの人（退職者は除く）
  const rows = useMemo(() => users
    .filter(u => isPrehire(u) || (u.is_active !== false && !!u.hire_date && isPlaceholderEmail(u.email)))
    .sort((a, b) => (a.hire_date ?? '').localeCompare(b.hire_date ?? '')), [users]);

  // ── 新しく登録 ──
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [employment, setEmployment] = useState('正社員');
  const [role, setRole] = useState('一般');
  const [email, setEmail] = useState('');
  const [send, setSend] = useState<SendMode>('hire_date');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const hasEmail = email.trim() !== '';
  const effectiveSend: SendMode = hasEmail ? send : 'none';
  const resetForm = () => { setName(''); setHireDate(''); setEmployment('正社員'); setRole('一般'); setEmail(''); setSend('hire_date'); setConfirming(false); setFormErr(''); };

  const toConfirm = () => {
    if (!name.trim()) { setFormErr('名前を入れてください'); return; }
    if (!hireDate) { setFormErr('入社日を入れてください'); return; }
    if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormErr('メールアドレスの形が正しくありません'); return; }
    setFormErr(''); setConfirming(true);
  };
  const submit = async () => {
    setBusy(true);
    const r = await callOnboard({ action: 'create', name: name.trim(), hire_date: hireDate, employment_type: employment, role_title: role, email: email.trim() || null, send: effectiveSend });
    setBusy(false);
    if (!r.ok) { setFormErr(r.error ?? ''); setConfirming(false); return; }
    const mailErr = r.data?.mail_error as string | null;
    if (mailErr) setErrorMsg(`登録しましたが、招待メールを送れませんでした：${mailErr}（下の［今すぐ送る］で送り直せます）`);
    else setSuccessMsg(effectiveSend === 'now' ? '登録して、招待メールを送りました' : effectiveSend === 'hire_date' ? '登録しました（招待メールは入社日の朝10時に送ります）' : '登録しました');
    resetForm(); setOpen(false); fetchUsers();
  };

  // ── 行ごとの操作 ──
  const [rowMode, setRowMode] = useState<{ id: string; kind: 'email' | 'date' | 'cancel' } | null>(null);
  const [rowEmail, setRowEmail] = useState('');
  const [rowSend, setRowSend] = useState<SendMode>('hire_date');
  const [rowDate, setRowDate] = useState('');
  const [rowConfirm, setRowConfirm] = useState(false);
  const [rowErr, setRowErr] = useState('');
  const [rowBusy, setRowBusy] = useState(false);
  const [shiftCount, setShiftCount] = useState<number | null>(null);
  const openRow = async (u: AdminUserProfile, kind: 'email' | 'date' | 'cancel') => {
    setRowMode({ id: u.id, kind }); setRowErr(''); setRowConfirm(false);
    setRowEmail(isPlaceholderEmail(u.email) ? '' : (u.email ?? ''));
    setRowSend(isPrehire(u) ? 'hire_date' : 'now');
    setRowDate(u.hire_date ?? '');
    setShiftCount(null);
    if (kind === 'cancel') {
      // 🚨 取り消すと勤務表なども一緒に消える（on delete cascade）。先に件数を見せる
      const { count, error } = await supabase.from('weekly_shift_patterns').select('id', { count: 'exact', head: true }).eq('user_id', u.id);
      setShiftCount(error ? -1 : (count ?? 0));
    }
  };
  const closeRow = () => { setRowMode(null); setRowConfirm(false); setRowErr(''); };
  const done = (msg: string) => { setSuccessMsg(msg); closeRow(); fetchUsers(); };

  const saveEmail = async (u: AdminUserProfile) => {
    if (!rowConfirm) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rowEmail.trim())) { setRowErr('メールアドレスの形が正しくありません'); return; }
      setRowErr(''); setRowConfirm(true); return;
    }
    setRowBusy(true);
    const r = await callOnboard({ action: 'update', id: u.id, email: rowEmail.trim(), send: rowSend });
    setRowBusy(false);
    if (!r.ok) { setRowErr(r.error ?? ''); setRowConfirm(false); return; }
    const mailErr = r.data?.mail_error as string | null;
    if (mailErr) { setErrorMsg(`メールアドレスは保存しましたが、招待メールを送れませんでした：${mailErr}`); closeRow(); fetchUsers(); return; }
    done(rowSend === 'now' ? 'メールアドレスを保存し、招待メールを送りました' : rowSend === 'hire_date' ? 'メールアドレスを保存しました（入社日の朝10時に送ります）' : 'メールアドレスを保存しました');
  };
  const saveDate = async (u: AdminUserProfile) => {
    if (!rowDate) { setRowErr('入社日を入れてください'); return; }
    setRowBusy(true);
    const r = await callOnboard({ action: 'update', id: u.id, hire_date: rowDate });
    setRowBusy(false);
    if (!r.ok) { setRowErr(r.error ?? ''); return; }
    done(rowDate <= today ? '入社日を変えました（今日から使えるようにしました）' : '入社日を変えました');
  };
  const sendNow = async (u: AdminUserProfile) => {
    setRowBusy(true);
    const r = await callOnboard({ action: 'send', id: u.id });
    setRowBusy(false);
    if (!r.ok) { setErrorMsg(`招待メールを送れませんでした：${r.error}`); return; }
    setSuccessMsg(`${u.name ?? ''}さんに招待メールを送りました`); fetchUsers();
  };
  const cancelHire = async (u: AdminUserProfile) => {
    setRowBusy(true);
    const { data, error } = await supabase.functions.invoke('delete-user', { body: { userId: u.id } });
    setRowBusy(false);
    const d = (data ?? {}) as { error?: string };
    if (error || d.error) { setRowErr(`取り消せませんでした：${d.error ?? error?.message}`); return; }
    done(`${u.name ?? ''}さんの登録を取り消しました`);
  };

  const sendChoices = (value: SendMode, onChange: (m: SendMode) => void, allowHireDate: boolean) => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(['hire_date', 'now', 'none'] as SendMode[]).filter(m => allowHireDate || m !== 'hire_date').map(m => (
        <button key={m} type="button" onClick={() => onChange(m)}
          style={{ padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${value === m ? TOGGLE_BLUE : border}`, background: value === m ? TOGGLE_BLUE : 'transparent', color: value === m ? '#fff' : text, fontWeight: value === m ? 'bold' : 'normal' }}>
          {SEND_LABEL[m]}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ marginBottom: 24, padding: 14, border: `1px solid ${border}`, borderRadius: 10, background: cardBg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 15, color: text }}>📅 入社予定のスタッフ（{rows.filter(isPrehire).length}人）</h4>
        {!open && <button onClick={() => { resetForm(); setOpen(true); }} style={{ ...tintBtn(isDarkMode), marginLeft: 'auto', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}>＋ 入社予定の人を登録</button>}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: sub, lineHeight: 1.6 }}>
        名前と入社日だけで先に登録できます。登録した日から勤務表に出るので、入社日からのシフトを先に入れられます。入社日までは本人はログインできず、通知・連絡板・安否確認の宛先にも入りません。
      </p>

      {open && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, border: `1px solid ${border}`, background: isDarkMode ? '#343a40' : '#fff' }}>
          {!confirming ? (
            <>
              <label style={{ ...label, marginTop: 0 }}>名前 <span style={{ color: '#dc3545' }}>*</span></label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="山田 花子" style={input} />
              <label style={label}>入社日 <span style={{ color: '#dc3545' }}>*</span></label>
              <input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} style={{ ...input, fontSize: 16 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>雇用形態</label>
                  <select value={employment} onChange={e => setEmployment(e.target.value)} style={input}>{employmentOptions.map(o => <option key={o} value={o}>{o}</option>)}</select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>役職</label>
                  <select value={role} onChange={e => setRole(e.target.value)} style={input}>{roleNames.map(o => <option key={o} value={o}>{o}</option>)}</select>
                </div>
              </div>
              <label style={label}>メールアドレス（分かっていれば）</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="あとから入れることもできます" style={input} />
              {hasEmail && (<><label style={label}>招待メール</label>{sendChoices(send, setSend, true)}</>)}
              {formErr && <p style={{ color: '#dc3545', fontSize: 13, margin: '10px 0 0' }}>{formErr}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button onClick={() => { resetForm(); setOpen(false); }} style={{ ...backBtn(isDarkMode), flex: 1, padding: '8px', borderRadius: 6, cursor: 'pointer' }}>やめる</button>
                <button onClick={toConfirm} style={{ ...primaryBtn(), flex: 2, padding: '8px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>確認へ</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, color: text, lineHeight: 1.9 }}>
                <div><strong>{name}</strong>（{employment}・{role}）</div>
                <div>入社日：{mdWeek(hireDate)}{hireDate <= today ? ' … 今日から使えるようになります' : ''}</div>
                {hasEmail ? (
                  <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 6, border: `2px solid ${TOGGLE_BLUE}` }}>
                    <div style={{ fontSize: 12, color: sub }}>招待メールの送り先（打ち間違いがないか確かめてください）</div>
                    <div style={{ fontSize: 18, fontWeight: 'bold', wordBreak: 'break-all' }}>{email.trim()}</div>
                    <div style={{ fontSize: 13 }}>{SEND_LABEL[send]}</div>
                  </div>
                ) : <div style={{ color: sub }}>メールアドレス：あとで入れる（招待メールはまだ送りません）</div>}
              </div>
              {formErr && <p style={{ color: '#dc3545', fontSize: 13, margin: '10px 0 0' }}>{formErr}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button onClick={() => setConfirming(false)} disabled={busy} style={{ ...backBtn(isDarkMode), flex: 1, padding: '8px', borderRadius: 6, cursor: 'pointer' }}>戻る</button>
                <button onClick={submit} disabled={busy} style={{ ...primaryBtn({ disabled: busy }), flex: 2, padding: '8px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontWeight: 'bold' }}>{busy ? '登録しています...' : '登録する'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {rows.length === 0 && !open && <p style={{ margin: '10px 0 0', fontSize: 13, color: sub }}>いまはいません。</p>}
      {rows.map(u => {
        const pre = isPrehire(u);
        const failed = pre && !!u.hire_date && u.hire_date <= today; // 入社日を過ぎたのに入社予定のまま（毎晩の切り替えの失敗）
        const noMail = isPlaceholderEmail(u.email);
        const mode = rowMode?.id === u.id ? rowMode.kind : null;
        return (
          <div key={u.id} style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${failed ? '#dc3545' : border}`, background: isDarkMode ? '#343a40' : '#fff' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline', fontSize: 14, color: text }}>
              <strong>{u.name}</strong>
              <span style={{ fontSize: 12, color: sub }}>{u.employment_type}・{u.role_title}</span>
              <span>入社日 {mdWeek(u.hire_date)}</span>
              <span style={{ fontSize: 12, color: failed ? '#dc3545' : pre ? (isDarkMode ? '#ffc107' : '#b35900') : '#28a745', fontWeight: 'bold' }}>
                {failed ? '在籍への切り替えに失敗（管理者に連絡）' : pre ? '入社予定' : '在籍中'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: sub, marginTop: 4, wordBreak: 'break-all' }}>
              メール：{noMail ? '未登録' : u.email} ／ 招待：{inviteStatusLabel(u)}
            </div>
            {!mode && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <button onClick={() => openRow(u, 'email')} style={{ ...tintBtn(isDarkMode), padding: '5px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer' }}>{noMail ? 'メールを入れる' : 'メールを直す'}</button>
                {!noMail && <button onClick={() => sendNow(u)} disabled={rowBusy} style={{ ...backBtn(isDarkMode), padding: '5px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer' }}>{u.invite_sent_at ? '再送' : '今すぐ送る'}</button>}
                {pre && <button onClick={() => openRow(u, 'date')} style={{ ...backBtn(isDarkMode), padding: '5px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer' }}>入社日を変える</button>}
                {pre && <button onClick={() => openRow(u, 'cancel')} style={{ ...backBtn(isDarkMode), padding: '5px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', color: '#dc3545' }}>登録を取り消す</button>}
              </div>
            )}
            {mode === 'email' && (
              <div style={{ marginTop: 10 }}>
                {!rowConfirm ? (
                  <>
                    <input type="email" value={rowEmail} onChange={e => setRowEmail(e.target.value)} placeholder="メールアドレス" style={input} />
                    <div style={{ fontSize: 12.5, color: sub, margin: '8px 0 4px' }}>招待メール</div>
                    {sendChoices(rowSend, setRowSend, pre)}
                  </>
                ) : (
                  <div style={{ padding: '8px 10px', borderRadius: 6, border: `2px solid ${TOGGLE_BLUE}`, color: text }}>
                    <div style={{ fontSize: 12, color: sub }}>{rowSend === 'none' ? 'このアドレスを保存します（招待メールはまだ送りません）' : 'このアドレスに招待メールを送りますか？（打ち間違いがないか確かめてください）'}</div>
                    <div style={{ fontSize: 18, fontWeight: 'bold', wordBreak: 'break-all' }}>{rowEmail.trim()}</div>
                    <div style={{ fontSize: 13 }}>{SEND_LABEL[rowSend]}</div>
                  </div>
                )}
                {rowErr && <p style={{ color: '#dc3545', fontSize: 13, margin: '8px 0 0' }}>{rowErr}</p>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={() => rowConfirm ? setRowConfirm(false) : closeRow()} disabled={rowBusy} style={{ ...backBtn(isDarkMode), flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer' }}>{rowConfirm ? '戻る' : 'やめる'}</button>
                  <button onClick={() => saveEmail(u)} disabled={rowBusy} style={{ ...primaryBtn({ disabled: rowBusy }), flex: 2, padding: '7px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
                    {rowBusy ? '保存しています...' : !rowConfirm ? '確認へ' : rowSend === 'now' ? '保存して送る' : '保存する'}
                  </button>
                </div>
              </div>
            )}
            {mode === 'date' && (
              <div style={{ marginTop: 10 }}>
                <input type="date" value={rowDate} onChange={e => setRowDate(e.target.value)} style={{ ...input, fontSize: 16 }} />
                <p style={{ fontSize: 12, color: sub, margin: '6px 0 0' }}>入社日の朝に送る予定の招待メールも、新しい入社日に合わせて動きます。今日以前の日にすると、今日から使えるようになります。</p>
                {rowErr && <p style={{ color: '#dc3545', fontSize: 13, margin: '8px 0 0' }}>{rowErr}</p>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={closeRow} disabled={rowBusy} style={{ ...backBtn(isDarkMode), flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer' }}>やめる</button>
                  <button onClick={() => saveDate(u)} disabled={rowBusy} style={{ ...primaryBtn({ disabled: rowBusy }), flex: 2, padding: '7px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>{rowBusy ? '保存しています...' : '保存する'}</button>
                </div>
              </div>
            )}
            {mode === 'cancel' && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 6, background: isDarkMode ? '#4a1f24' : '#f8d7da', color: isDarkMode ? '#f5c2c7' : '#842029', fontSize: 13, lineHeight: 1.6 }}>
                {u.name}さんの登録を取り消します。アカウントは削除され、元に戻せません。
                {shiftCount === null ? ' 勤務表を数えています...' : shiftCount < 0 ? ' 勤務表の件数を確かめられませんでした。' : shiftCount > 0 ? ` 入れてある勤務表（${shiftCount}件）も一緒に消えます。` : ''}
                {rowErr && <p style={{ margin: '8px 0 0', fontWeight: 'bold' }}>{rowErr}</p>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={closeRow} disabled={rowBusy} style={{ ...backBtn(isDarkMode), flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer' }}>やめる</button>
                  <button onClick={() => cancelHire(u)} disabled={rowBusy || shiftCount === null} style={{ ...primaryBtn({ danger: true, disabled: rowBusy || shiftCount === null }), flex: 2, padding: '7px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>{rowBusy ? '取り消しています...' : '取り消す'}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PrehireSection;
