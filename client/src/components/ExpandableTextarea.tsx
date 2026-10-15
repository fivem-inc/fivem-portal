import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * 連絡板の本文の入力欄（2026-10-14 ユーザー確定）。お知らせ送信・グループ・DM の3か所が同じこれを使う。
 * ・打つと自動で広がる（短い一言は小さいまま）。🚨 伸びるだけで、ほかの文字を消しても縮めない（引っ張って広げた高さを打つたびに戻さないため）。
 *   空になったら（送信したあと）最初の高さに戻る
 * ・右下を引っ張って広げられる（パソコン・スマホとも。パソコンはボタンを付けない＝ユーザー確定）。
 *   🚨 スマホは機種によって引っ張る印が出ない（iPhone など）ので、［⤢］を残す
 * ・スマホ：文字なしの［⤢］で全画面で書ける。［閉じる］で元の欄に戻る（書いた文はそのまま・送信は元の欄から）
 */
interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  isMobile: boolean;
  isDark: boolean;
  /** 最初の高さ（行） */
  rows: number;
  /** 自動で広がる上限（px）。パソコンは画面の高さに対する割合で渡す */
  maxHeight: number;
  /** 全画面の見出し（例：グループの名前） */
  title: string;
  style?: React.CSSProperties;
  /** 欄と［⤢］を横に並べる箱の style（flex: 1 など） */
  wrapStyle?: React.CSSProperties;
  /** 開いたときに入力欄へ移る（見えるところまで動かす） */
  autoFocus?: boolean;
  /**
   * 入力欄を下に固定した画面（グループ・DM・スレッド）の、メッセージと入力欄が入っている箱。
   * 渡すと、広がる上限をこの箱の高さの fitRatio まで（引っ張っても同じ）にする。
   * 🚨 渡さないと、窓の高さが足りないときに欄が箱からはみ出し、右下の［送信］が画面の外に出る（2026-10-15 実機で発生）
   */
  fitRef?: React.RefObject<HTMLElement | null>;
  /** fitRef の高さに対する上限の割合（既定 0.45） */
  fitRatio?: number;
}

const ExpandableTextarea: React.FC<Props> = ({ value, onChange, placeholder, onKeyDown, isMobile, isDark, rows, maxHeight, title, style, wrapStyle, autoFocus, fitRef, fitRatio = 0.45 }) => {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const bigRef = useRef<HTMLTextAreaElement | null>(null);
  const [full, setFull] = useState(false);
  // 箱（fitRef）の高さ。窓の大きさを変えたときも追いかける
  const [fitH, setFitH] = useState<number | null>(null);
  useEffect(() => {
    const box = fitRef?.current;
    if (!box) return;
    const update = () => setFitH(box.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => ro.disconnect();
  }, [fitRef]);
  // 実際の上限：渡された上限と、箱の高さの割合の小さいほう（最低でも 3 行ぶんくらいは残す）
  const limit = fitH ? Math.max(72, Math.min(maxHeight, Math.round(fitH * fitRatio))) : maxHeight;
  // 表示が変わったら（「戻る」など）全画面を閉じる。書いた文は残る（2026-10-14）
  const location = useLocation();
  const locKey = useRef(location.key);
  useEffect(() => {
    if (locKey.current === location.key) return;
    locKey.current = location.key;
    setFull(false);
  }, [location.key]);

  // 打つたびに、中身に合わせて伸ばす（上限まで）。空になったら最初の高さに戻す
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) { el.style.height = ''; return; }
    const prev = el.offsetHeight;
    el.style.height = 'auto';
    const need = Math.min(el.scrollHeight + 2, limit);
    // 🚨 縮めないのは「打つたび」だけ。上限より大きくはしない（窓を小さくした・上限が下がったときも上限に収める）
    el.style.height = `${Math.min(Math.max(need, prev), limit)}px`;
  }, [value, limit]);

  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus();
    ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // 開いたときの1回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (full) setTimeout(() => bigRef.current?.focus(), 50);
  }, [full]);

  const border = isDark ? '#4a5568' : '#ced4da';
  const text = isDark ? '#e9ecef' : '#212529';
  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', ...wrapStyle }}>
        <textarea ref={ref} value={value} rows={rows} placeholder={placeholder}
          onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
          style={{ ...style, flex: 1, minWidth: 0, resize: 'vertical', overflowY: 'auto', maxHeight: limit }} />
        {isMobile && (
          <button type="button" onClick={() => setFull(true)} aria-label="大きく書く" title="大きく書く"
            style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: isDark ? '#90caf9' : '#1976d2', fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: 0 }}>⤢</button>
        )}
      </div>
      {full && (
        <div role="dialog" aria-label={title}
          style={{ position: 'fixed', inset: 0, zIndex: 10000, background: isDark ? '#1a1d21' : '#fff', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 'bold', color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
            <button type="button" onClick={() => setFull(false)}
              style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontSize: 13, cursor: 'pointer' }}>閉じる</button>
          </div>
          {/* 🚨 文字は16px（スマホの画面が勝手に拡大されないように） */}
          <textarea ref={bigRef} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
            style={{ flex: 1, width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: text, fontSize: 16, lineHeight: 1.6, fontFamily: 'inherit', resize: 'none' }} />
          <div style={{ fontSize: 11.5, color: isDark ? '#adb5bd' : '#6c757d', marginTop: 6 }}>［閉じる］で元の欄に戻ります。送信は元の欄から行ってください</div>
        </div>
      )}
    </>
  );
};

export default ExpandableTextarea;
