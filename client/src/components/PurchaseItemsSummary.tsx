import React, { useState } from 'react';
import type { PurchaseRequestItem } from '../types';
import FileViewerModal from './FileViewerModal';

interface PurchaseItemsSummaryProps {
  items: PurchaseRequestItem[];
  isDarkMode: boolean;
  // 見積書を開けるかどうか。表示はこの部品の中のFileViewerModalで行う
  // （以前は呼び出し側で window.open していたが、iPhoneがポップアップ扱いでブロックしていた）
  canViewFile?: boolean;
}

const PurchaseItemsSummary: React.FC<PurchaseItemsSummaryProps> = ({ items, isDarkMode, canViewFile }) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [viewPath, setViewPath] = useState<string | null>(null);

  const quoteFileButton = (path: string) =>
    canViewFile ? (
      <button
        type="button"
        onClick={() => setViewPath(path)}
        title="見積書を見る"
        style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
      >
        📎 見積書
      </button>
    ) : (
      <span title="見積書あり">📎</span>
    );

  const viewerModal = viewPath ? (
    <FileViewerModal path={viewPath} title="見積書" isDarkMode={isDarkMode} onClose={() => setViewPath(null)} />
  ) : null;

  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const quoteBg = isDarkMode ? '#20304a' : '#eef6ff';
  const quoteBorder = isDarkMode ? '#2e4a70' : '#cfe4ff';

  const summaryLine = (item: PurchaseRequestItem) => (
    <>
      {item.item_name}
      {item.quantity != null && <span style={{ color: subText }}>　数量:{item.quantity}</span>}
      <span style={{ fontWeight: 'bold' }}>　¥{item.amount.toLocaleString()}</span>
      {/* サイズ・色などの内訳メモ。承認の判断材料になるので品目名のすぐ下に出す */}
      {item.breakdown && <span style={{ display: 'block', fontSize: 12, color: subText }}>内訳・仕様：{item.breakdown}</span>}
      {/* 単価×数量と違う金額にした理由（送料込み・値引き後など）。金額の根拠なので必ず見せる */}
      {item.amount_override_note && <span style={{ display: 'block', fontSize: 12, color: subText }}>金額の内訳・調整：{item.amount_override_note}</span>}
    </>
  );

  // 備考（コメント＋リンクが混在しうる）を、文中のURL部分だけクリックできるリンクにして表示。
  // コメントはそのまま文字表示、URLは折り返す（はみ出さない）
  const renderNote = (note: string) => {
    // http/httpsで始まるURLを検出（末尾の句読点・閉じ括弧は含めない）
    const urlRegex = /(https?:\/\/[^\s　、。）」]+)/g;
    const parts = note.split(urlRegex);
    return (
      <span style={{ flexBasis: '100%', minWidth: 0, color: subText, wordBreak: 'break-all', fontSize: 12 }}>
        {parts.map((part, i) =>
          /^https?:\/\//i.test(part) ? (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#4a90d9', textDecoration: 'underline' }}
            >
              🔗 リンク
            </a>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          )
        )}
      </span>
    );
  };

  if (items.length === 1) {
    const item = items[0];
    return (
      <div>
        <div style={{ fontSize: 13, color: text }}>
          {summaryLine(item)}
        </div>
        {/* 1万円以上でも相見積もりを取らなかった場合の理由。承認の判断材料なので必ず見せる */}
        {item.single_vendor_reason && (
          <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: '#fff8e1', border: '1px solid #ffe082', color: '#8a6d00', fontSize: 12 }}>
            1社しか選べない理由：{item.single_vendor_reason}
          </div>
        )}
        {item.quotes.length > 0 && (
          <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: quoteBg, border: `1px solid ${quoteBorder}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {item.quotes.map((q, qi) => (
              <div key={qi} style={{ fontSize: 12, color: text, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, border: `1px solid ${quoteBorder}`, borderRadius: 6, padding: '4px 8px' }}>
                <span>{q.vendor}</span>
                <span style={{ fontWeight: 'bold' }}>¥{q.unit_amount.toLocaleString()}</span>
                {q.is_selected && (
                  <span style={{ color: '#fff', background: '#28a745', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>購入予定</span>
                )}
                {q.note && renderNote(q.note)}
                {q.quote_file_path && quoteFileButton(q.quote_file_path)}
              </div>
            ))}
          </div>
        )}
        {/* 🚨 商品1件の早期returnと下の通常returnの両方に描画する（片方だけだと押しても何も出ない） */}
        {viewerModal}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, i) => {
        const hasQuotes = item.quotes.length > 0;
        const isOpen = openIndex === i;
        return (
          <div key={i} style={{ border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden' }}>
            <div
              onClick={() => hasQuotes && setOpenIndex(isOpen ? null : i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                fontSize: 13, color: text, cursor: hasQuotes ? 'pointer' : 'default',
              }}
            >
              <span style={{ color: subText }}>[商品{i + 1}]</span>
              <span style={{ flex: 1 }}>{summaryLine(item)}</span>
              {hasQuotes && <span style={{ color: subText, fontSize: 11 }}>{isOpen ? '▲' : '▼'}</span>}
            </div>
            {/* 1社しか選べない理由は承認の判断材料なので、折りたたまずに常に見せる */}
            {item.single_vendor_reason && (
              <div style={{ padding: '6px 10px', borderTop: `1px solid ${border}`, background: '#fff8e1', color: '#8a6d00', fontSize: 12 }}>
                1社しか選べない理由：{item.single_vendor_reason}
              </div>
            )}

            {hasQuotes && isOpen && (
              <div style={{ padding: '8px 10px', borderTop: `1px solid ${border}`, background: quoteBg, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.quotes.map((q, qi) => (
                  <div key={qi} style={{ fontSize: 12, color: text, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, border: `1px solid ${quoteBorder}`, borderRadius: 6, padding: '4px 8px' }}>
                    <span>{q.vendor}</span>
                    <span style={{ fontWeight: 'bold' }}>¥{q.unit_amount.toLocaleString()}</span>
                    {q.is_selected && (
                      <span style={{ color: '#fff', background: '#28a745', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>購入予定</span>
                    )}
                    {q.note && renderNote(q.note)}
                    {q.quote_file_path && quoteFileButton(q.quote_file_path)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {viewerModal}
    </div>
  );
};

export default PurchaseItemsSummary;
