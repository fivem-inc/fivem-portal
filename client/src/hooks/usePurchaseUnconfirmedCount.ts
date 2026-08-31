import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// 備品購入申請：自分が関わった申請のうち、まだ確認していないやりとりを持つ件数
//
// 🚨 usePurchasePendingCount（承認・意見待ちの件数）とは別のフックにしてある。
//    向こうは3か所で共用されていて、ホームの黄色バナー
//    「備品購入申請の確認依頼が N件 あります」もその数字を読んでいる。
//    そこに未確認を足すと、承認が0件でもバナーが出て、しかも飛び先の承認タブは空。
//    このバナーは閉じる手段が無い作りなので、消せないバナーが本番に残ることになる。
//    → 合算するのは App.tsx のナビの赤バッジを描くところ**だけ**。
//
// 🚨 判定に使うのは canPurchaseRequest（ページを開ける人）であって
//    canApprovePurchase（リーダー以上）ではない。
//    未確認はいちばん申請者本人（一般社員・パート）に見せたいもので、
//    承認の権限で絞ると、共有ファイルが届いた本人の数字だけ常に0になる。
//
// 数え方はサーバーの purchase_unconfirmed_count() に集約している
// （migration 20260901072938）。クライアントで組むと全コメントを取ってくることになり、
// Supabase の「件数指定が無いと1,000行で打ち切る」に将来ぶつかって
// エラーも出さずバッジだけ静かに減るため。
export const usePurchaseUnconfirmedCount = (
  userId: string | undefined,
  canPurchaseRequest: boolean | undefined,
) => {
  const [unconfirmedCount, setUnconfirmedCount] = useState(0);

  const fetchUnconfirmed = useCallback(async () => {
    if (!userId || !canPurchaseRequest) { setUnconfirmedCount(0); return; }
    const { data, error } = await supabase.rpc('purchase_unconfirmed_count');
    // 🚨 失敗したときに0へ落とさない。通信が一度切れただけでバッジが消え、
    //    「対応したつもり」になってしまう。前の値のまま次の30秒を待つ
    if (error) return;
    setUnconfirmedCount(typeof data === 'number' ? data : 0);
  }, [userId, canPurchaseRequest]);

  // 30秒ごとに数え直す（承認待ちのバッジと同じ間隔）
  useEffect(() => {
    fetchUnconfirmed();
    const t = setInterval(fetchUnconfirmed, 30000);
    return () => clearInterval(t);
  }, [fetchUnconfirmed]);

  // 「✓ 確認した」を押した直後・投稿した直後に数え直す。
  // これが無いと、押したのに最大30秒バッジが残り「押しても効かない」と受け取られる
  useEffect(() => {
    window.addEventListener('purchase-unconfirmed-changed', fetchUnconfirmed);
    return () => window.removeEventListener('purchase-unconfirmed-changed', fetchUnconfirmed);
  }, [fetchUnconfirmed]);

  return { unconfirmedCount, refetch: fetchUnconfirmed };
};
