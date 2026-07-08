import React, { useState } from 'react';
import type { PurchaseRequestItem } from '../types';

interface PurchaseItemsSummaryProps {
  items: PurchaseRequestItem[];
  isDarkMode: boolean;
  onViewFile?: (path: string) => void;
}

const PurchaseItemsSummary: React.FC<PurchaseItemsSummaryProps> = ({ items, isDarkMode, onViewFile }) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const quoteBg = isDarkMode ? '#20304a' : '#eef6ff';
  const quoteBorder = isDarkMode ? '#2e4a70' : '#cfe4ff';

  const summaryLine = (item: PurchaseRequestItem) => (
    <>
      {item.item_name}
      {item.quantity != null && <span style={{ color: subText }}>　数量:{item.quantity}</span>}
      <span style={{ fontWeight: 'bold' }}>　¥{item.amount.toLocaleString()}</span>
    </>
  );

  if (items.length === 1) {
    const item = items[0];
    return (
      <div>
        <div style={{ fontSize: 13, color: text }}>
          {summaryLine(item)}
        </div>
        {item.quotes.length > 0 && (
          <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: quoteBg, border: `1px solid ${quoteBorder}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {item.quotes.map((q, qi) => (
              <div key={qi} style={{ fontSize: 12, color: text, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, border: `1px solid ${quoteBorder}`, borderRadius: 6, padding: '4px 8px' }}>
                <span>{q.vendor}</span>
                <span style={{ fontWeight: 'bold' }}>¥{q.unit_amount.toLocaleString()}</span>
                {q.is_selected && (
                  <span style={{ color: '#fff', background: '#28a745', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>購入予定</span>
                )}
                {q.note && <span style={{ color: subText }}>{q.note}</span>}
                {q.quote_file_path && (
                  onViewFile ? (
                    <button
                      type="button"
                      onClick={() => onViewFile(q.quote_file_path!)}
                      title="見積書を見る"
                      style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                    >
                      📎 見積書
                    </button>
                  ) : (
                    <span title="見積書あり">📎</span>
                  )
                )}
              </div>
            ))}
          </div>
        )}
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

            {hasQuotes && isOpen && (
              <div style={{ padding: '8px 10px', borderTop: `1px solid ${border}`, background: quoteBg, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.quotes.map((q, qi) => (
                  <div key={qi} style={{ fontSize: 12, color: text, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, border: `1px solid ${quoteBorder}`, borderRadius: 6, padding: '4px 8px' }}>
                    <span>{q.vendor}</span>
                    <span style={{ fontWeight: 'bold' }}>¥{q.unit_amount.toLocaleString()}</span>
                    {q.is_selected && (
                      <span style={{ color: '#fff', background: '#28a745', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>購入予定</span>
                    )}
                    {q.note && <span style={{ color: subText }}>{q.note}</span>}
                    {q.quote_file_path && (
                  onViewFile ? (
                    <button
                      type="button"
                      onClick={() => onViewFile(q.quote_file_path!)}
                      title="見積書を見る"
                      style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                    >
                      📎 見積書
                    </button>
                  ) : (
                    <span title="見積書あり">📎</span>
                  )
                )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PurchaseItemsSummary;
