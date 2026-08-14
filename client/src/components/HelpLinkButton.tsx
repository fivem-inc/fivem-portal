import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// 各ページの説明枠（黄色）の右上に置く「💡 FAQ」ボタン。
// 押すとFAQページが、そのページに関する質問だけに絞って開く。
//
// 🚨 表示するかどうかは管理画面「役職・機能権限管理」の FAQ の行で決まる。
//    ここに役職名を直書きしない（役職を増やすたびに開発が必要になる）。
// 🚨 権限は呼び出し側から props で受け取らず、この部品の中で useAuth から読む。
//    9ページに props を配ると必ずどこかで渡し忘れる（実際に休暇申請で発生した）。
//    置くだけで正しく動く形にしておく。
//
// 置き場所：説明枠の右上に重ねるため、枠側に position:'relative' が必要。
interface Props {
  /** FAQ側のカテゴリ名。FAQ管理画面のカテゴリと同じ文字列にすること */
  category: string;
  /** ボタンが多くて幅が足りない場所（連絡板のヘッダー等）はアイコンだけにする */
  compact?: boolean;
  /** 黄色の説明枠の外に置くときは、周りに合わせた色を渡す */
  borderColor?: string;
  color?: string;
}

const HelpLinkButton: React.FC<Props> = ({ category, compact, borderColor, color }) => {
  const navigate = useNavigate();
  const { canFaq } = useAuth();
  if (!canFaq) return null;

  return (
    <button
      type="button"
      onClick={() => navigate(`/faq?category=${encodeURIComponent(category)}`)}
      title="このページのよくある質問を見る"
      style={{
        // 既定は説明枠の右上角に重ねる
        ...(compact ? {} : { position: 'absolute', top: 7, right: 8 }),
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: compact ? '5px 7px' : '3px 9px', borderRadius: compact ? 6 : 14,
        cursor: 'pointer', lineHeight: 1, flexShrink: 0,
        // 黄色の説明枠の中に置くため、ライト・ダーク共通の固定色
        background: compact ? 'none' : '#fff',
        border: `1px solid ${borderColor ?? '#f0c000'}`,
        color: color ?? '#856404',
        fontSize: compact ? 14 : 11, fontWeight: 'bold', whiteSpace: 'nowrap',
      }}
    >
      {compact ? '💡' : '💡 FAQ'}
    </button>
  );
};

export default HelpLinkButton;
