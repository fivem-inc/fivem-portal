import { useEffect, useMemo, useRef, useState } from 'react';

// 通知バナーから ?focus=<申請ID> で来たとき、その申請カードまでスクロールして一時的に強調するための共通フック。
// 使い方：
//   const { highlightId, focusRef } = useFocusHighlight(requests); // 第2引数にデータ配列を渡すと、読み込み完了後にスクロールする
//   <div ref={el => { if (el && highlightId === req.id) focusRef.current = el; }}
//        style={{ background: highlightId === req.id ? '#fff9c4' : 'transparent', transition: 'background 0.6s' }}>
// 6秒後に highlightId が null になり、ハイライトはフェードして消える。
export function useFocusHighlight(readySignal?: unknown) {
  const focusId = useMemo(() => {
    const p = new URLSearchParams(window.location.search).get('focus');
    return p || null;
  }, []);
  const [highlightId, setHighlightId] = useState<string | null>(focusId);
  const focusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!highlightId) return;
    const t1 = setTimeout(() => focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
    const t2 = setTimeout(() => setHighlightId(null), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [highlightId, readySignal]);

  return { highlightId, focusRef };
}
