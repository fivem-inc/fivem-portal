import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useRefreshOn } from '../hooks/useRefreshOn';
import { TOPICS_BELL, TOPICS_OVERTIME, TOPICS_SHIFT_REPORT } from '../lib/badgeTopics';
import {
  EXPENSE_FORM_ANCHOR_ID, PAYROLL_CLOSE_BOLD,
  type PayrollCloseLine, type PayrollCloseNotice,
} from '../lib/payrollClose';

// 給与の締め日のお知らせ（ホームのバナー・2026-10-14 ユーザー確定）
// ・送った相手だけに、送った時刻から15日の終わり（JST）まで出る（判定は DB の my_payroll_close_notice）
// ・［✕］で閉じるとその月は出ない（ベルも既読になる）。ベルから ?payroll=1 で来たら開き直す
// ・受理まち・確認まちの件数はその時点の数。受理が進んで0件になった行は消える
// 🚨 色は黄色の固定色（🎨🔒・#fff3cd／2px solid #ffc107／#856404）。ダークでも変えない

const YELLOW_TEXT = '#856404';
const REFRESH_TOPICS = [...TOPICS_BELL, ...TOPICS_OVERTIME, ...TOPICS_SHIFT_REPORT] as const;

const actionBtn: React.CSSProperties = {
  minHeight: 44, padding: '8px 14px', borderRadius: 8, border: `1px solid ${YELLOW_TEXT}`,
  background: 'transparent', color: YELLOW_TEXT, fontSize: 14, cursor: 'pointer',
};

/** 見た目だけ（管理画面のプレビューでも使う）。onAction が無ければボタンは押しても何もしない */
export const PayrollCloseCard: React.FC<{
  title: string;
  lines: PayrollCloseLine[];
  onClose?: () => void;
  closing?: boolean;
  onAction?: (kind: 'overtime' | 'shift' | 'expense') => void;
  glow?: boolean;
}> = ({ title, lines, onClose, closing, onAction, glow }) => {
  const body = lines.filter(l => l.key !== 'intro');
  const has = (k: PayrollCloseLine['key']) => lines.some(l => l.key === k);
  return (
    <div style={{
      background: '#fff3cd', border: '2px solid #ffc107', borderRadius: 10, padding: '12px 14px', marginBottom: 16,
      position: 'relative', color: YELLOW_TEXT,
      outline: glow ? '3px solid #ffc107' : 'none', outlineOffset: 2, transition: 'outline-color 0.6s',
    }}>
      {onClose && (
        <button type="button" aria-label="閉じる" onClick={onClose} disabled={closing}
          style={{ position: 'absolute', right: 2, top: 2, width: 44, height: 44, border: 'none', background: 'transparent',
            color: YELLOW_TEXT, fontSize: 18, cursor: closing ? 'default' : 'pointer', opacity: closing ? 0.5 : 1 }}>✕</button>
      )}
      <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 6, paddingRight: 36 }}>📅 {title}</div>
      {body.map(l => (
        <p key={l.key} style={{ margin: '0 0 6px', fontSize: 13.5, lineHeight: 1.7, fontWeight: PAYROLL_CLOSE_BOLD.has(l.key) ? 'bold' : 'normal' }}>
          {l.text}
        </p>
      ))}
      {(has('overtime') || has('shift') || has('expense')) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {has('overtime') && <button type="button" style={actionBtn} onClick={() => onAction?.('overtime')}>残業申請を開く</button>}
          {has('shift') && <button type="button" style={actionBtn} onClick={() => onAction?.('shift')}>勤務変更を開く</button>}
          {has('expense') && <button type="button" style={actionBtn} onClick={() => onAction?.('expense')}>↓ 交通費の申請へ</button>}
        </div>
      )}
    </div>
  );
};

/** ホームに置く本体 */
const PayrollCloseBanner: React.FC = () => {
  const navigate = useNavigate();
  const { search } = useLocation();
  const fromNotif = new URLSearchParams(search).get('payroll') === '1';
  const [notice, setNotice] = useState<PayrollCloseNotice | null>(null);
  const [closing, setClosing] = useState(false);
  const [closedNote, setClosedNote] = useState(false);
  const [err, setErr] = useState('');
  const [glow, setGlow] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const reopenedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_payroll_close_notice');
    // 🚨 読めなかったときは黙って出さない（前の表示も消さない）
    if (error) return;
    setNotice((data as PayrollCloseNotice | null) ?? null);
  }, []);
  useRefreshOn(load, REFRESH_TOPICS);
  useEffect(() => {
    const h = () => { void load(); };
    window.addEventListener('overtime-pending-changed', h);
    window.addEventListener('shift-pending-changed', h);
    return () => { window.removeEventListener('overtime-pending-changed', h); window.removeEventListener('shift-pending-changed', h); };
  }, [load]);

  // ベル・プッシュから来たら、閉じていても開き直して、バナーまで移動して少し光らせる
  useEffect(() => {
    if (!fromNotif || !notice) return;
    if (notice.dismissed && reopenedFor.current !== notice.close_date) {
      reopenedFor.current = notice.close_date;
      void (async () => {
        const { data, error } = await supabase.rpc('set_payroll_close_notice_dismissed', { p_close: notice.close_date, p_dismissed: false });
        if (!error && data === true) setNotice(n => (n ? { ...n, dismissed: false } : n));
      })();
      return;
    }
    if (notice.dismissed || !ref.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setGlow(true);
    const t = setTimeout(() => setGlow(false), 2500);
    return () => clearTimeout(t);
  }, [fromNotif, notice]);

  useEffect(() => {
    if (!closedNote) return;
    const t = setTimeout(() => setClosedNote(false), 6000);
    return () => clearTimeout(t);
  }, [closedNote]);

  const close = async () => {
    if (!notice) return;
    setClosing(true); setErr('');
    const { data, error } = await supabase.rpc('set_payroll_close_notice_dismissed', { p_close: notice.close_date, p_dismissed: true });
    setClosing(false);
    // 🚨 記録できてから消す（記録できないまま消すと、次に開いたときにまた出て「閉じたのに」となる）
    if (error || data !== true) { setErr('閉じられませんでした。通信を確かめて、もう一度お試しください'); return; }
    setNotice(n => (n ? { ...n, dismissed: true } : n));
    setClosedNote(true);
  };

  const onAction = (kind: 'overtime' | 'shift' | 'expense') => {
    if (kind === 'overtime') navigate('/overtime');
    else if (kind === 'shift') navigate('/shift-report');
    else document.getElementById(EXPENSE_FORM_ANCHOR_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (closedNote) {
    return (
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#6c757d' }}>
        締め日の案内を閉じました。15日までは、ベル（🔔）からもう一度見られます。
      </p>
    );
  }
  if (!notice || notice.dismissed) return null;
  return (
    <div ref={ref}>
      <PayrollCloseCard title={notice.title} lines={notice.lines} onClose={close} closing={closing} onAction={onAction} glow={glow} />
      {err && <p style={{ margin: '-10px 0 12px', fontSize: 12.5, color: '#842029' }}>{err}</p>}
    </div>
  );
};

export default PayrollCloseBanner;
