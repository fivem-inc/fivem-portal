import { useEffect, useState } from 'react';
import { listPendingSubmits, SUBMIT_ONCE_EVENT } from '../lib/submitOnce';
import { describePendingSubmit, type PendingSubmitInfo } from '../lib/pendingSubmits';

/**
 * 送信できたか確認できていない申請（2026-10-21 電波 段4）。端末の番号を読むだけで、通信はしない。
 * 送信・取り消し（SUBMIT_ONCE_EVENT）・別のタブ（storage）・前面に戻ったときに読み直す。
 * match を渡すと、その申請の画面の分だけに絞る
 */
export function usePendingSubmits(userId: string | undefined, match?: (slot: string) => boolean): PendingSubmitInfo[] {
  const read = (): PendingSubmitInfo[] => {
    if (!userId) return [];
    return listPendingSubmits(userId)
      .filter(p => !match || match(p.slot))
      .map(p => describePendingSubmit(p.slot, p.at))
      .filter((x): x is PendingSubmitInfo => !!x);
  };
  const [list, setList] = useState<PendingSubmitInfo[]>(read);
  const key = JSON.stringify(list.map(x => x.slot + x.label));

  useEffect(() => {
    const reload = () => {
      const next = read();
      if (JSON.stringify(next.map(x => x.slot + x.label)) !== key) setList(next);
    };
    reload();
    const onVis = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener(SUBMIT_ONCE_EVENT, reload);
    window.addEventListener('storage', reload);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener(SUBMIT_ONCE_EVENT, reload);
      window.removeEventListener('storage', reload);
      document.removeEventListener('visibilitychange', onVis);
    };
    // match は呼ぶ側で毎回作られるので依存に入れない（userId と今の中身で十分）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, key]);

  return list;
}
