import React, { useState } from 'react';
import { BTN_BLUE } from '../lib/buttonStyles';

/**
 * 「📩 正社員へ 申請を依頼」と「📋 パート・アルバイトへ 休暇申請を依頼」の枠の、共通の形（2026-10-15 ユーザー確定）。
 * 🚨 2つの枠の見た目（見出し・件数の場所・一覧の行・取り下げの確かめ方・エラーの出し方）はここだけで決める。
 *    中身（何を読み・何を書くか）は AppRequestBox／PartLeaveFormBox がそれぞれ持つ。
 * 決まり（UI/UX とシニアエンジニアのレビュー）：
 * ・件数「未申請 N件」は見出しの右（0件なら出さない）
 * ・一覧の行は「名前・内容・状態・［取り下げる］」。［取り下げる］は押せる高さ 32px 以上で、押したらその行の中で確かめる
 */

const sub = (isDark: boolean) => (isDark ? '#adb5bd' : '#6c757d');
// 「未申請」「申請済み」の文字の色。🚨 ダークでは暗い地で読める明るい色にする（どちらもほかの画面で使っている色）
const openColor = (isDark: boolean) => (isDark ? '#ffcf8f' : '#b7770d');
const appliedColor = (isDark: boolean) => (isDark ? '#86efac' : '#1e8449');

export const RequestBoxFrame: React.FC<{
  isDark: boolean;
  /** 見出し（絵文字つき） */
  title: string;
  /** まだ申請されていない件数（0 なら出さない） */
  openCount: number;
  /** 件数の補足（例：「うち自分 2件」）。マネージャー以上がほかの上長の分も見るとき */
  openCountNote?: string;
  description: React.ReactNode;
  /** ［依頼を作る］など、主の操作 */
  action: React.ReactNode;
  error?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ isDark, title, openCount, openCountNote, description, action, error, children, style }) => (
  <div style={{ background: isDark ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16, ...style }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
      <span style={{ fontWeight: 'bold', fontSize: 13.5, color: isDark ? '#fff' : '#333' }}>{title}</span>
      {openCount > 0 && (
        <span style={{ fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap', color: openColor(isDark) }}>未申請 {openCount}件{openCountNote ? `（${openCountNote}）` : ''}</span>
      )}
    </div>
    <div style={{ fontSize: 12, color: sub(isDark), margin: '0 0 10px', lineHeight: 1.7 }}>{description}</div>
    {action}
    {error && (
      <div style={{ marginTop: 8, fontSize: 12.5, color: isDark ? '#f5b5ba' : '#dc3545' }}>⚠️ {error}</div>
    )}
    {children}
  </div>
);

/** 一覧の区切り（上に線） */
export const RequestList: React.FC<{ isDark: boolean; children: React.ReactNode }> = ({ isDark, children }) => (
  <div style={{ marginTop: 10, borderTop: `1px solid ${isDark ? '#495057' : '#dee2e6'}`, paddingTop: 4 }}>{children}</div>
);

/**
 * 一覧の1行。［取り下げる］を押すと、その行の中で「◯◯さんへの依頼を取り下げますか？」と確かめる。
 * onWithdraw は失敗したら理由の文を返す（成功は null）。
 */
export const RequestRow: React.FC<{
  isDark: boolean;
  name: string;
  /** 日付・種類・送った人 など（灰色の小さめの文字で並べる） */
  details: React.ReactNode[];
  status: { text: string; tone: 'open' | 'applied' | 'muted' };
  /** 取り下げられるときだけ渡す */
  onWithdraw?: () => Promise<string | null>;
  /** 確かめのときの補足（例：本人の画面から申請フォームが消えます） */
  withdrawNote?: string;
  highlight?: boolean;
  rowRef?: (el: HTMLDivElement | null) => void;
}> = ({ isDark, name, details, status, onWithdraw, withdrawNote, highlight, rowRef }) => {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toneColor = status.tone === 'open' ? openColor(isDark) : status.tone === 'applied' ? appliedColor(isDark) : sub(isDark);
  const border = isDark ? '#6c757d' : '#ced4da';
  return (
    <div ref={rowRef}
      style={{ padding: '6px 0', borderBottom: `1px dashed ${isDark ? '#3a3f44' : '#e9ecef'}`, fontSize: 12.5, color: isDark ? '#dee2e6' : '#495057',
        // 🚨 色は既存のハイライトと同じ（新しい色は足さない）
        background: highlight ? (isDark ? '#4a4423' : '#fff9c4') : 'transparent', transition: 'background 0.6s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'bold' }}>{name}</span>
        {details.map((d, i) => <span key={i} style={{ color: sub(isDark) }}>{d}</span>)}
        <span style={{ color: toneColor, fontWeight: 'bold' }}>{status.text}</span>
        <span style={{ flex: 1 }} />
        {onWithdraw && !asking && (
          <button type="button" onClick={() => { setErr(''); setAsking(true); }}
            style={{ minHeight: 32, padding: '6px 12px', borderRadius: 16, fontSize: 12, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: isDark ? '#dee2e6' : '#495057', whiteSpace: 'nowrap' }}>
            取り下げる
          </button>
        )}
      </div>
      {asking && onWithdraw && (
        <div style={{ marginTop: 6, padding: '9px 11px', borderRadius: 8, background: isDark ? '#3a2e1a' : '#fff8e1', border: '1px solid #f0ad4e' }}>
          <div style={{ fontSize: 12.5, color: isDark ? '#fff' : '#333' }}>{name}さんへの依頼を取り下げますか？</div>
          {withdrawNote && <div style={{ fontSize: 11.5, color: sub(isDark), marginTop: 2 }}>{withdrawNote}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" disabled={busy} onClick={() => setAsking(false)}
              style={{ flex: 1, minHeight: 36, borderRadius: 8, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: isDark ? '#dee2e6' : '#495057' }}>やめる</button>
            <button type="button" disabled={busy}
              onClick={async () => {
                setBusy(true); setErr('');
                const e = await onWithdraw();
                setBusy(false);
                if (e) { setErr(e); return; }
                setAsking(false);
              }}
              style={{ flex: 2, minHeight: 36, borderRadius: 8, fontSize: 13, fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer', border: 'none', background: BTN_BLUE, color: '#fff', opacity: busy ? 0.6 : 1 }}>
              {busy ? '取り下げ中…' : '取り下げる'}
            </button>
          </div>
          {err && <div style={{ marginTop: 6, fontSize: 12.5, color: isDark ? '#f5b5ba' : '#dc3545' }}>⚠️ {err}</div>}
        </div>
      )}
    </div>
  );
};
