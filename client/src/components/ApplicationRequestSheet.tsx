import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { DateField } from './common/DateField';
import { ERROR_BORDER, errorBg } from '../lib/formHighlight';

// 上長がスタッフに「この内容で申請してください」と依頼するシート（2026-09-09 ユーザー確定）。
//
// 🚨 既存の「残業調整の提案」（OvertimeProposalSheet）とは目的が違う。
//    提案 … 相手が受諾した瞬間に記録ができる
//    依頼 … 相手が自分で申請する。ここで書くのは相談で聞いた内容のメモ（本人が書き直す前提）
//    混ぜると「受諾で終わるのか、自分で申請するのか」が分からなくなるので分けてある。
//
// 🚨 日付の入力は共通部品 DateField を使う。ここに新しい日付ピッカーを作らないこと。

type Kind = 'overtime' | 'leave';

const KIND_LABEL: Record<Kind, string> = {
  overtime: '残業・勤務変更',
  leave: '休暇',
};

interface Staff { id: string; name: string; role_title: string | null }

interface Props {
  requesterId: string;
  requesterName: string;
  isDark: boolean;
  /** 既定の種類（休暇の受理ページから開いたときは 'leave'） */
  defaultKind?: Kind;
  onClose: () => void;
  onSubmitted: () => void;
}

const ApplicationRequestSheet: React.FC<Props> = ({
  requesterId, requesterName, isDark, defaultKind, onClose, onSubmitted,
}) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#2b3035' : '#fff';

  const [kind, setKind] = useState<Kind>(defaultKind ?? 'overtime');
  const [recipientId, setRecipientId] = useState('');
  const [dates, setDates] = useState<string[]>(['']);
  const [memo, setMemo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffQuery, setStaffQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  // 相手に通知が飛ぶので、送信前に必ず確認を出す（提案シートと同じ流儀）
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    supabase.from('profiles').select('id, name, role_title').eq('is_active', true).order('name')
      .then(({ data }) => { if (data) setStaff(data as Staff[]); });
  }, []);

  // 名前で絞り込む（人数が多いのでプルダウンから探せない）
  const shownStaff = useMemo(() => {
    const q = staffQuery.trim();
    const list = staff.filter(s => s.id !== requesterId);   // 自分には依頼しない
    if (!q) return list;
    return list.filter(s => (s.name ?? '').includes(q) || (s.role_title ?? '').includes(q));
  }, [staff, staffQuery, requesterId]);

  const recipient = staff.find(s => s.id === recipientId);
  const filledDates = dates.map(d => d.trim()).filter(Boolean);

  const validate = (): string => {
    const bad = new Set<string>();
    if (!recipientId) { bad.add('recipient'); }
    if (filledDates.length === 0) { bad.add('dates'); }
    setErrFields(bad);
    if (bad.has('recipient')) return '依頼する相手を選んでください';
    if (bad.has('dates')) return '対象の日付を1つ以上入れてください';
    return '';
  };

  const submit = async () => {
    const msg = validate();
    if (msg) { setError(msg); setShowConfirm(false); return; }
    setSubmitting(true);
    setError('');
    // 🚨 insert は error を見ないと RLS 拒否を握りつぶす
    const { data, error: err } = await supabase.from('application_requests').insert({
      requester_id: requesterId,
      recipient_id: recipientId,
      kind,
      target_dates: filledDates,
      memo: memo.trim() || null,
      due_date: dueDate || null,
    }).select('id').single();
    if (err) {
      setSubmitting(false);
      setShowConfirm(false);
      // 🚨 「通信を確認してください」で握りつぶさない。理由をそのまま出す
      setError('送信できませんでした：' + err.message);
      return;
    }

    // 相手へのお知らせ。文言は形式的に、何をすればよいかが分かる形にする（2026-09-09 ユーザー確定）
    const dateLabel = filledDates.map(d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join('・');
    const dueLabel = dueDate ? `（申請期限 ${Number(dueDate.slice(5, 7))}/${Number(dueDate.slice(8, 10))}）` : '';
    await insertNotification(
      recipientId,
      `${requesterName}さんより申請依頼：${dateLabel} ${KIND_LABEL[kind]}${dueLabel}`,
      memo.trim() || undefined,
      'application_request:received',
      data.id,
      'application_request:received',
    );

    setSubmitting(false);
    onSubmitted();
  };

  const label: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 'bold', color: text, marginBottom: 6 };
  const field = (bad: boolean): React.CSSProperties => ({
    width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 14,
    border: `1px solid ${bad ? ERROR_BORDER : border}`,
    background: bad ? errorBg(isDark) : inputBg, color: text, boxSizing: 'border-box',
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: cardBg, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
        borderRadius: '16px 16px 0 0', padding: '18px 16px 28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 16, fontWeight: 'bold', color: text }}>📩 申請の依頼</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: subText }}>✕</button>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
          相談で聞いた内容を伝えて、本人に申請してもらいます。<br />
          ここに書いたメモは案内として表示されます。<b style={{ color: text }}>申請の中身は本人が入力します</b>。
        </p>

        {/* 種類 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>依頼の種類</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['overtime', 'leave'] as Kind[]).map(k => (
              <button key={k} type="button" onClick={() => setKind(k)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
                  border: `2px solid ${kind === k ? '#4a90d9' : border}`,
                  background: kind === k ? '#e8f4fd' : 'transparent',
                  color: kind === k ? '#1565c0' : subText,
                }}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        {/* 相手 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>依頼する相手 <span style={{ color: '#dc3545' }}>*</span></span>
          {recipient ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
                {recipient.name}{recipient.role_title ? `（${recipient.role_title}）` : ''}
              </span>
              <button type="button" onClick={() => { setRecipientId(''); setStaffQuery(''); }}
                style={{ padding: '5px 12px', borderRadius: 12, fontSize: 11.5, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
                選び直す
              </button>
            </div>
          ) : (
            <>
              <input value={staffQuery} onChange={e => setStaffQuery(e.target.value)}
                placeholder="お名前で絞り込む" style={field(errFields.has('recipient'))} />
              <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6, border: `1px solid ${border}`, borderRadius: 8 }}>
                {shownStaff.slice(0, 30).map(s => (
                  <button key={s.id} type="button"
                    // 🚨 候補は先に blur が起きるとクリックが届かない。押せなくなるので mousedown を止める
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { setRecipientId(s.id); setErrFields(p => { const n = new Set(p); n.delete('recipient'); return n; }); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
                      border: 'none', borderBottom: `1px solid ${border}`, background: 'transparent',
                      color: text, fontSize: 13.5, cursor: 'pointer',
                    }}>
                    {s.name}<span style={{ color: subText, fontSize: 11.5, marginLeft: 8 }}>{s.role_title ?? ''}</span>
                  </button>
                ))}
                {shownStaff.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 12.5, color: subText }}>見つかりません</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 対象日 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>対象の日付 <span style={{ color: '#dc3545' }}>*</span></span>
          {dates.map((d, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <DateField value={d} isDark={isDark} placeholder="日付を選ぶ"
                  onChange={v => { setDates(p => p.map((x, j) => (j === i ? v : x))); setErrFields(p => { const n = new Set(p); n.delete('dates'); return n; }); }} />
              </div>
              {/* 🚨 増やせるなら必ず減らせるようにする */}
              {dates.length > 1 && (
                <button type="button" onClick={() => setDates(p => p.filter((_, j) => j !== i))}
                  style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: subText, cursor: 'pointer', fontSize: 13 }}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setDates(p => [...p, ''])}
            style={{ padding: '6px 14px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
            ＋ 日付を追加
          </button>
        </div>

        {/* メモ */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>メモ（相談で聞いた内容）</span>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={3}
            placeholder="例：雨でレッスンが無くなったぶん、18:00までの残業でお願いした分"
            style={{ ...field(false), resize: 'vertical', lineHeight: 1.6 }} />
        </div>

        {/* 期限 */}
        <div style={{ marginBottom: 16 }}>
          <span style={label}>いつまでに申請してほしいか（任意）</span>
          <DateField value={dueDate} onChange={setDueDate} isDark={isDark} placeholder="指定しない" />
        </div>

        {error && (
          <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{error}</div>
        )}

        {showConfirm ? (
          <div style={{ padding: '12px 14px', borderRadius: 10, background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`, marginBottom: 10 }}>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.8, color: isDark ? '#fff' : '#0d47a1' }}>
              {recipient?.name}さんに、{KIND_LABEL[kind]}の申請をお願いします。<br />
              対象日：{filledDates.map(d => d.slice(5).replace('-', '/')).join('・')}
              {dueDate && <><br />申請期限：{dueDate.slice(5).replace('-', '/')}</>}
              <br />相手にお知らせが届きます。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={submit} disabled={submitting}
                style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
                {submitting ? '送信中…' : 'この内容で依頼する'}
              </button>
              <button onClick={() => setShowConfirm(false)} disabled={submitting}
                style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: `1px solid ${border}`, cursor: 'pointer', fontSize: 14, background: 'transparent', color: subText }}>
                戻る
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => { const m = validate(); if (m) { setError(m); return; } setError(''); setShowConfirm(true); }}
            style={{ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
            内容を確認する
          </button>
        )}
      </div>
    </div>
  );
};

export default ApplicationRequestSheet;
