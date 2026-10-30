// 連絡板のアンケート：担当者の［この内容でご提案する］の窓（2026-10-30 段2-3・見本の②・ユーザー確定）。
// 回答の一覧（SurveyResultsPanel）から開く。回答の日付を最初から入れ、種類・日付・ひとこと・返事の期限を直せる。
// ・相談のあと（2回目以降）は「ご本人と直接相談して決まった内容を送ってください」（2026-10-30 ユーザー確定）
// 🚨 送るのは DB の application_request_offer_send だけ（回答が窓を開いたあとに変わっていたら DB が止める）

import React, { useState } from 'react';
import TapButton from '../TapButton';
import { sendOffer } from '../../lib/boardOfferApi';
import { APP_REQUEST_OT_CONTENT_LABEL, mdDow, type AppRequestKind, type AppRequestOtContent } from '../../lib/appRequests';
import { backBtn, primaryBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { toJstDateStr } from '../../lib/breakCalc';

/** 窓で選べる申請の種類（残業申請の中身5つ＋休暇） */
const CHOICES: { key: string; kind: AppRequestKind; ot: AppRequestOtContent | null; label: string }[] = [
  { key: 'overtime:chosei_off', kind: 'overtime', ot: 'chosei_off', label: `残業申請・${APP_REQUEST_OT_CONTENT_LABEL.chosei_off}（終日）` },
  { key: 'overtime:furikae_off', kind: 'overtime', ot: 'furikae_off', label: `残業申請・${APP_REQUEST_OT_CONTENT_LABEL.furikae_off}` },
  { key: 'overtime:time', kind: 'overtime', ot: 'time', label: `残業申請・${APP_REQUEST_OT_CONTENT_LABEL.time}` },
  { key: 'overtime:absence', kind: 'overtime', ot: 'absence', label: `残業申請・${APP_REQUEST_OT_CONTENT_LABEL.absence}` },
  { key: 'overtime:self', kind: 'overtime', ot: 'self', label: `残業申請・${APP_REQUEST_OT_CONTENT_LABEL.self}` },
  { key: 'leave', kind: 'leave', ot: null, label: '休暇申請' },
];

interface Props {
  messageId: string;
  recipientId: string;
  recipientName: string;
  isDark: boolean;
  /** 最初に入れる日付（回答の日付・前回のご提案の日付） */
  initialDates: string[];
  initialKind?: AppRequestKind | null;
  initialOt?: AppRequestOtContent | null;
  /** 窓を開いたときの回答の updated_at（違えば DB が止める） */
  answerSeen: string | null;
  /** 相談のあとか（ご本人のひとことを出す） */
  consultNote?: string | null;
  onClose: () => void;
  onSent: () => void;
}

const OfferDialog: React.FC<Props> = ({ messageId, recipientId, recipientName, isDark, initialDates, initialKind, initialOt, answerSeen, consultNote, onClose, onSent }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const initKey = initialKind === 'leave' ? 'leave' : `overtime:${initialOt ?? 'chosei_off'}`;
  const [choice, setChoice] = useState(CHOICES.some(c => c.key === initKey) ? initKey : 'overtime:chosei_off');
  const [dates, setDates] = useState<string[]>([...new Set(initialDates)].sort());
  const [addDate, setAddDate] = useState('');
  const [memo, setMemo] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const today = toJstDateStr(new Date());
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`,
    background: isDark ? '#212529' : '#fff', color: text, fontSize: 16, fontFamily: 'inherit',
  };
  const label = (t: string) => <div style={{ fontSize: 13, color: sub, margin: '10px 0 4px' }}>{t}</div>;

  const send = async () => {
    if (busy) return;
    const c = CHOICES.find(x => x.key === choice)!;
    if (dates.length === 0) { setErr('日付を選んでください'); return; }
    if (due && due < today) { setErr('返事の期限は今日以降にしてください'); return; }
    setBusy(true); setErr('');
    const fail = await sendOffer({ messageId, recipientId, kind: c.kind, otContent: c.ot, dates, memo: memo.trim(), due: due || null, answerSeen });
    setBusy(false);
    if (fail) { setErr(fail); return; }
    onSent();
  };

  return (
    <div onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5003, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
      <div role="dialog" aria-label={`${recipientName}さんへのご提案`}
        style={{ background: isDark ? '#2b3035' : '#fff', borderRadius: 14, width: '100%', maxWidth: 480, maxHeight: '94vh', overflowY: 'auto', padding: '14px 16px', boxSizing: 'border-box', color: text, textAlign: 'left' }}>
        <div style={{ fontSize: 15, fontWeight: 'bold' }}>{recipientName}さんへのご提案</div>
        {consultNote && (
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: isDark ? '#4a1f22' : '#fde2e1', color: isDark ? '#f1aeb5' : '#842029', fontSize: 13 }}>
            ご本人からの相談：{consultNote}
            <div style={{ marginTop: 4, fontWeight: 'bold' }}>ご本人と直接相談して決まった内容を送ってください。</div>
          </div>
        )}
        {label('申請の種類')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CHOICES.map(c => (
            <button key={c.key} type="button" onClick={() => { setChoice(c.key); setErr(''); }}
              style={{ textAlign: 'left', padding: '9px 12px', minHeight: 44, borderRadius: 10, cursor: 'pointer', fontSize: 14,
                border: `1.5px solid ${choice === c.key ? TOGGLE_BLUE : border}`, background: choice === c.key ? TOGGLE_BLUE : 'transparent', color: choice === c.key ? '#fff' : text }}>
              {c.label}
            </button>
          ))}
        </div>
        {label('日付（回答から入れています・直せます）')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {dates.length === 0 && <span style={{ fontSize: 13, color: sub }}>（まだ選んでいません）</span>}
          {dates.map(d => (
            <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 6px 6px 12px', borderRadius: 18, border: `1px solid ${border}`, fontSize: 14 }}>
              {mdDow(d)}
              <button type="button" aria-label={`${mdDow(d)}を外す`} onClick={() => setDates(prev => prev.filter(x => x !== d))}
                style={{ minWidth: 32, minHeight: 32, border: 'none', background: 'transparent', color: sub, cursor: 'pointer', fontSize: 14 }}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button type="button" onClick={() => { if (addDate && !dates.includes(addDate)) setDates(prev => [...prev, addDate].sort()); setAddDate(''); }}
            style={{ ...backBtn(isDark), padding: '0 14px', minHeight: 44 }}>日付を足す</button>
        </div>
        {label('ひとこと（任意・200字まで）')}
        <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={2} maxLength={200} placeholder="例：ご希望どおり 12/3 でお願いします" style={inputStyle} />
        {label('返事の期限（任意）')}
        <input type="date" value={due} min={today} onChange={e => setDue(e.target.value)} style={inputStyle} />
        <div style={{ fontSize: 12, color: sub, marginTop: 4 }}>期限を入れると、前日と翌日の朝にご本人へ、翌日に担当者へお知らせが届きます。</div>
        {err && <div role="alert" style={{ fontSize: 13, color: '#dc3545', marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <TapButton onTap={() => { if (!busy) onClose(); }} style={{ ...backBtn(isDark), flex: 1, minHeight: 44, padding: '0 8px' }}>やめる</TapButton>
          <TapButton netWrite onTap={() => void send()} style={{ ...primaryBtn(), flex: 2, minHeight: 44, padding: '0 8px', opacity: busy ? 0.6 : 1 }}>
            {busy ? '送信しています…' : 'ご提案を送る'}
          </TapButton>
        </div>
      </div>
    </div>
  );
};

export default OfferDialog;
