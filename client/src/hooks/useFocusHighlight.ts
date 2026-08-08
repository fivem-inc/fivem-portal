import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// 通知バナーから ?focus=<申請ID> で来たとき、その申請カードまでスクロールして一時的に強調するための共通フック。
// 使い方：
//   const { highlightId, focusRef } = useFocusHighlight(requests); // 第2引数にデータ配列を渡すと、読み込み完了後にスクロールする
//   <div ref={el => { if (el && highlightId === req.id) focusRef.current = el; }}
//        style={{ background: highlightId === req.id ? '#fff9c4' : 'transparent', transition: 'background 0.6s' }}>
// 6秒後に highlightId が null になり、ハイライトはフェードして消える。
export function useFocusHighlight(readySignal?: unknown) {
  // 🚨 URLは「画面を開いた瞬間に1回だけ」ではなく、変わるたびに読み直す。
  // 同じページを開いたまま通知をタップしても画面は作り直されないため、
  // 1回きりの読み取りだと ?focus= が変わったことに気づけず何も起きない
  // （「別のページからは飛べるのに、そのページにいると効かない」不具合の原因だった）
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus') || null;
  const [highlightId, setHighlightId] = useState<string | null>(focusId);
  const focusRef = useRef<HTMLElement | null>(null);

  // focus が変わったら強調し直す
  useEffect(() => {
    setHighlightId(focusId);
  }, [focusId]);

  useEffect(() => {
    if (!highlightId) return;
    const t1 = setTimeout(() => focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
    const t2 = setTimeout(() => setHighlightId(null), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [highlightId, readySignal]);

  return { highlightId, focusRef };
}
