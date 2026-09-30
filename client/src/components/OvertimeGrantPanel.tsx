// 表入力の上に出す「締め切り後の許可の依頼」の枠（2026-09-29 ユーザー確定・計画 docs/計画-残業のまとめて申請.md の3回目）。
//
// 🚨 言葉・色・状態は1件フォーム（OvertimePage.tsx の「締め後申請の許可依頼」）と同じ。
//    依頼中（取り下げ）／見送り（理由・もう一度依頼）／給与データ確定済み／確認／送信済み／許可済み を1つの枠で出す。
// 🚨 依頼・取り下げ・文言は lib（overtimeSubmitApi の insertGrantRequest・withdrawGrantRequest、overtimeFormParts の grantRequestErrorMessage・formatGrantDates）。
//    ここに書き写さない。
// 🚨 依頼の対象は「締め切り後の期間で、時間を入れた日」だけ（残業の無い日まで経理に届かないように）。どの日を出すかは呼ぶ側が決める。

import React, { useRef, useState } from 'react';
import { insertGrantRequest, withdrawGrantRequest } from '../lib/overtimeSubmitApi';
import type { GrantRequestRow } from '../lib/overtimeSubmitApi';
import { grantRequestErrorMessage, formatGrantDates, PAYOUT_PASSED_MSG } from '../lib/overtimeFormParts';
import { notifyOvertimeGrantRequest } from '../lib/overtimeNotify';

interface Props {
  userId: string;
  profileName: string;
  isDark: boolean;
  /** 依頼できる日（締め切り後・時間を入れた・依頼中でも許可済みでもない） */
  requestable: string[];
  /** この期間にかかる依頼中の依頼 */
  openRequests: GrantRequestRow[];
  /** この期間にかかる見送られた依頼（依頼中の日と重なるものは除いて渡す） */
  declinedRequests: GrantRequestRow[];
  /** この期間の、締め切り後で許可済みの日 */
  grantedDates: string[];
  /** この期間の給与データが確定済み（依頼・もう一度依頼のボタンを出さない。文は依頼したい日があるときだけ） */
  payoutPassed: boolean;
  /** 依頼の一覧を読めなかったときの理由 */
  loadError: string | null;
  /** 依頼・取り下げのあとに読み直す */
  onReload: () => void;
}

const OvertimeGrantPanel: React.FC<Props> = ({
  userId, profileName, isDark, requestable, openRequests, declinedRequests, grantedDates, payoutPassed, loadError, onReload,
}) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';

  // 確認中の対象日（null＝確認していない）
  const [confirmDates, setConfirmDates] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);   // 🚨 二度押しは ref で止める
  const [error, setError] = useState('');
  const [justSent, setJustSent] = useState(false);
  const [withdrawConfirmId, setWithdrawConfirmId] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const withdrawingRef = useRef(false);   // 🚨 取り下げの二度押しも ref で止める（2回目は0件で「成立しませんでした」が出る）
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const submit = async () => {
    if (!confirmDates || confirmDates.length === 0 || savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setError('');
    const res = await insertGrantRequest(userId, confirmDates);
    savingRef.current = false;
    setSaving(false);
    if (!res.ok) { setError(grantRequestErrorMessage(res.dbMessage)); return; }
    const label = formatGrantDates(confirmDates);
    setConfirmDates(null);
    setJustSent(true);
    setTimeout(() => setJustSent(false), 4000);
    onReload();
    notifyOvertimeGrantRequest({ requestId: res.id, applicantName: profileName, workDatesLabel: label }).then(null, () => {});
  };

  const withdraw = async () => {
    if (!withdrawConfirmId || withdrawingRef.current) return;
    withdrawingRef.current = true;
    setWithdrawing(true); setWithdrawError(null);
    const fail = await withdrawGrantRequest(withdrawConfirmId);
    withdrawingRef.current = false;
    setWithdrawing(false);
    if (fail) { setWithdrawError(fail); onReload(); return; }
    setWithdrawConfirmId(null);
    onReload();
  };

  const redBox: React.CSSProperties = { background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: '#842029', lineHeight: 1.6 };
  const sep = <div style={{ borderTop: `1px solid ${borderColor}`, margin: '8px 0' }} />;
  const btnBlue: React.CSSProperties = { padding: '6px 14px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 12.5, fontWeight: 'bold', cursor: 'pointer' };

  // 見送りの「もう一度依頼する」で送る日＝見送られた日のうち、いま依頼できる日だけ（時間を入れていない日・許可済み・依頼中は送らない）。
  // 🚨 その日は上の［📩 経理に許可を依頼する］から外す（同じ日のボタンが2つ並ばないように）
  const retryOf = (r: GrantRequestRow) => r.work_dates.filter(d => requestable.includes(d));
  const retrySet = new Set(declinedRequests.flatMap(retryOf));
  const fresh = requestable.filter(d => !retrySet.has(d));

  const parts: React.ReactNode[] = [];

  if (loadError) {
    parts.push(
      <div key="err" style={redBox}>
        依頼の状態を読み込めませんでした（{loadError}）
        <button type="button" onClick={onReload} style={{ ...btnBlue, marginLeft: 8, background: '#dc3545' }}>再読み込み</button>
      </div>,
    );
  }

  if (payoutPassed) {
    if (requestable.length > 0 || declinedRequests.length > 0) parts.push(<div key="payout" style={redBox}>{PAYOUT_PASSED_MSG}</div>);
  } else if (confirmDates) {
    parts.push(
      <div key="confirm">
        <div style={{ fontSize: 13.5, fontWeight: 'bold', color: text }}>この内容で依頼しますか？</div>
        <div style={{ fontSize: 12.5, color: subText, margin: '2px 0 8px' }}>対象日：{formatGrantDates(confirmDates)}（{confirmDates.length}日）</div>
        {error && <div style={{ ...redBox, marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={submit} disabled={saving}
            style={{ ...btnBlue, background: '#28a745', opacity: saving ? 0.6 : 1 }}>{saving ? '送信中…' : '依頼する'}</button>
          <button type="button" onClick={() => { setConfirmDates(null); setError(''); }} disabled={saving}
            style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: subText, fontSize: 12.5, cursor: 'pointer' }}>戻る</button>
        </div>
      </div>,
    );
  } else if (fresh.length > 0) {
    parts.push(
      <div key="ask" style={{ fontSize: 12.5, color: text, lineHeight: 1.7 }}>
        この給与期間は締め切りを過ぎています。時間を入れた日（<b>{formatGrantDates(fresh)}</b>）は、経理の許可があれば送れます。<br />
        <button type="button" onClick={() => { setConfirmDates([...fresh].sort()); setError(''); }} style={{ ...btnBlue, marginTop: 6 }}>
          📩 経理に許可を依頼する（{fresh.length}日）
        </button>
      </div>,
    );
  }

  openRequests.forEach(r => {
    parts.push(
      <div key={'open-' + r.id} style={{ fontSize: 12.5 }}>
        <b style={{ color: isDark ? '#fff' : '#1565c0' }}>📩 経理に依頼済み（対象日：{formatGrantDates(r.work_dates)}）</b>
        <span style={{ color: subText, marginLeft: 8 }}>
          {new Date(r.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}に依頼
        </span>
        {withdrawConfirmId === r.id ? (
          <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
            <button type="button" onClick={withdraw} disabled={withdrawing}
              style={{ ...btnBlue, background: '#dc3545', padding: '3px 10px' }}>{withdrawing ? '取り下げ中…' : '取り下げる'}</button>
            <button type="button" onClick={() => { setWithdrawConfirmId(null); setWithdrawError(null); }} disabled={withdrawing}
              style={{ padding: '3px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: subText, fontSize: 12, cursor: 'pointer' }}>やめる</button>
          </span>
        ) : (
          <button type="button" onClick={() => { setWithdrawConfirmId(r.id); setWithdrawError(null); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 8, fontSize: 12, color: subText, textDecoration: 'underline' }}>取り下げる</button>
        )}
        {withdrawConfirmId === r.id && withdrawError && <div style={{ ...redBox, marginTop: 6 }}>⚠️ {withdrawError}</div>}
      </div>,
    );
  });

  declinedRequests.forEach(r => {
    parts.push(
      // 🎨🔒 1件フォームと同じ薄赤の地（固定色）。暗い地に濃い赤の文字を置かない
      <div key={'dec-' + r.id} style={redBox}>
        <b>依頼は見送られました（対象日：{formatGrantDates(r.work_dates)}）</b>
        {r.resolve_note && <span style={{ marginLeft: 8 }}>理由：{r.resolve_note}</span>}
        {!payoutPassed && !confirmDates && retryOf(r).length > 0 && (
          <button type="button" onClick={() => { setConfirmDates([...retryOf(r)].sort()); setError(''); }} style={{ ...btnBlue, marginLeft: 8, padding: '3px 10px' }}>
            もう一度依頼する
          </button>
        )}
      </div>,
    );
  });

  if (parts.length === 0 && !justSent && grantedDates.length === 0) return null;
  // 🎨🔒 許可済み・送信済みは1件フォームと同じ薄緑（固定色・ライトとダークで変えない）
  const okCard: React.CSSProperties = { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '10px 12px', marginBottom: 10 };

  return (
    <>
      {parts.length > 0 && (
        <div style={{ background: innerBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
          {parts.map((p, i) => <React.Fragment key={i}>{i > 0 && sep}{p}</React.Fragment>)}
        </div>
      )}
      {grantedDates.length > 0 && (
        <div style={okCard}>
          <span style={{ fontSize: 12.5, color: '#166534' }}>✓ {formatGrantDates(grantedDates)} は経理から許可されています。送れます</span>
        </div>
      )}
      {justSent && (
        <div style={okCard}>
          <span style={{ fontSize: 12.5, color: '#166534' }}>✓ 依頼を送信しました。経理からの返答をお待ちください。</span>
        </div>
      )}
    </>
  );
};

export default OvertimeGrantPanel;
