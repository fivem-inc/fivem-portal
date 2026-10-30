// 連絡板のアンケートの「ご提案」が届いた側のカード（2026-10-30 段2-3・見本の③・ユーザー確定）。
// 残業ページ（履歴タブ）と休暇ページ（申請タブ）の2か所が同じこれを出す（AppRequestCard のすぐ上）。
//
// ・見た目は今の申請の依頼のカード（AppRequestCard）と同じ薄い青。見分けは見出し「📩 申請についてのご提案」
//   🚨 黄色にしない（ベルから来たときに光らせる色＝光ったか分からなくなる・UI/UX のレビュー）
// ・［承諾する］→ DB が今の申請の依頼を作る → 呼ぶ側がその依頼で申請の画面を開く（onAccepted）
// ・［内容を相談したい］→ ひとこと（必須・200字）→ 担当者にベル。担当者は直接相談して、決まった内容でもう一度ご提案する
// 🚨 押せない理由は文で出す（disabled で黙らせない）。押したときは components/TapButton（iPhone で確実に反応する）

import React, { useState } from 'react';
import TapButton from './TapButton';
import { acceptOffer, consultOffer, type MyOffer } from '../lib/boardOfferApi';
import { APP_REQUEST_OT_CONTENT_LABEL, mdDow } from '../lib/appRequests';
import { backBtn, primaryBtn } from '../lib/buttonStyles';
import { toJstDateStr } from '../lib/breakCalc';

interface Props {
  o: MyOffer;
  isDark: boolean;
  focused?: boolean;
  focusRef?: (el: HTMLDivElement | null) => void;
  /** 承諾したあと（作った申請の依頼の ID）。呼ぶ側が読み直して申請の画面を開く */
  onAccepted: (appRequestId: string | null) => void;
  /** 相談を送ったあと（一覧から外す） */
  onConsulted: (o: MyOffer) => void;
}

/** 申請の種類の言い方（カード・変わった所で共用） */
export const offerKindText = (kind: string, ot: string | null | undefined) =>
  kind === 'leave' ? '休暇' : (ot ? APP_REQUEST_OT_CONTENT_LABEL[ot as keyof typeof APP_REQUEST_OT_CONTENT_LABEL] ?? '残業申請' : '残業申請');

const OfferCard: React.FC<Props> = ({ o, isDark, focused = false, focusRef, onAccepted, onConsulted }) => {
  const [consulting, setConsulting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const textMain = isDark ? '#fff' : '#0d47a1';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const today = toJstDateStr(new Date());
  const overdue = !!o.due_date && o.due_date < today;
  const dates = (o.target_dates ?? []).map(mdDow).join('・');

  // 2回目以降：前回からの変わった所（日付・種類）
  const changes: string[] = [];
  if (o.round > 1 && o.prev) {
    const prevDates = (o.prev.target_dates ?? []).map(mdDow).join('・');
    if (prevDates && prevDates !== dates) changes.push(`日付 ${prevDates}→${dates}`);
    const prevKind = o.prev.kind ? offerKindText(o.prev.kind, o.prev.ot_content) : '';
    const nowKind = offerKindText(o.kind, o.ot_content);
    if (prevKind && prevKind !== nowKind) changes.push(`種類 ${prevKind}→${nowKind}`);
  }

  const doAccept = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    const r = await acceptOffer(o.offer_id, o.round);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onAccepted(r.appRequestId);
  };
  const doConsult = async () => {
    if (busy) return;
    if (!note.trim()) { setErr('相談したい内容を書いてください'); return; }
    setBusy(true); setErr('');
    const fail = await consultOffer(o.offer_id, o.round, note.trim());
    setBusy(false);
    if (fail) { setErr(fail); return; }
    onConsulted(o);
  };

  return (
    <div ref={el => focusRef?.(el)}
      style={{ background: focused ? (isDark ? '#4a4423' : '#fff9c4') : (isDark ? '#243447' : '#e8f4fd'), border: `1px solid ${focused ? '#f59e0b' : (isDark ? '#3d5166' : '#90caf9')}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, transition: 'background 0.6s', textAlign: 'left' }}>
      <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 'bold', color: textMain }}>
        📩 申請についてのご提案（{o.requester_name ?? ''}さんから）{o.round > 1 && `・${o.round}回目`}
      </p>
      <p style={{ margin: '0 0 6px', fontSize: 13.5, lineHeight: 1.8, color: textMain }}>
        {o.subject}について<br />
        {offerKindText(o.kind, o.ot_content)}・{dates}でお願いします。
      </p>
      {changes.length > 0 && (
        <p style={{ margin: '0 0 6px', fontSize: 13, color: textMain }}>変わった所：{changes.join('／')}</p>
      )}
      {o.memo && (
        <p style={{ margin: '0 0 8px', padding: '7px 10px', borderRadius: 6, fontSize: 13, lineHeight: 1.7, background: isDark ? '#1b2a3a' : '#fff', color: isDark ? '#dee2e6' : '#495057', whiteSpace: 'pre-wrap' }}>{o.memo}</p>
      )}
      {o.due_date && (
        <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: overdue ? 'bold' : 'normal', color: overdue ? '#dc3545' : sub }}>
          {overdue ? `返事の期限（${mdDow(o.due_date)}）を過ぎています` : `返事の期限：${mdDow(o.due_date)}`}
        </p>
      )}
      {err && <div role="alert" style={{ fontSize: 13, color: '#dc3545', marginBottom: 8 }}>{err}</div>}
      {consulting ? (
        <div>
          <div style={{ fontSize: 13, color: textMain, marginBottom: 6 }}>相談したい内容を書いてください（{o.requester_name ?? ''}さんに届きます）</div>
          <textarea value={note} onChange={e => { setNote(e.target.value); setErr(''); }} rows={3} maxLength={200}
            placeholder="例：12/3 は難しいので、12/5 にできますか"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#212529' : '#fff', color: isDark ? '#f8f9fa' : '#212529', fontSize: 16, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <TapButton onTap={() => { if (!busy) { setConsulting(false); setNote(''); setErr(''); } }} style={{ ...backBtn(isDark), flex: 1, minHeight: 44, padding: '0 8px' }}>やめる</TapButton>
            <TapButton netWrite onTap={() => void doConsult()} style={{ ...primaryBtn(), flex: 2, minHeight: 44, padding: '0 8px', opacity: busy ? 0.6 : 1 }}>
              {busy ? '送信しています…' : '相談を送る'}
            </TapButton>
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>承諾すると、この内容の申請画面が開きます</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <TapButton onTap={() => { setConsulting(true); setErr(''); }} style={{ ...backBtn(isDark), flex: 1, minHeight: 44, padding: '0 8px', background: isDark ? 'transparent' : '#fff' }}>内容を相談したい</TapButton>
            <TapButton netWrite onTap={() => void doAccept()} style={{ ...primaryBtn(), flex: 2, minHeight: 44, padding: '0 8px', opacity: busy ? 0.6 : 1 }}>
              {busy ? '送信しています…' : '承諾する'}
            </TapButton>
          </div>
        </>
      )}
    </div>
  );
};

export default OfferCard;
