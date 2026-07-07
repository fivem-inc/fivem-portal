import React, { useState } from 'react';
import { openReceiptImage } from '../lib/receiptView';

interface ReceiptViewButtonProps {
  path: string;
  isDarkMode: boolean;
  canDownload?: boolean;
  onDownloaded?: () => void;
}

const ReceiptViewButton: React.FC<ReceiptViewButtonProps> = ({ path, isDarkMode, canDownload = false, onDownloaded }) => {
  const [loadingMode, setLoadingMode] = useState<'view' | 'download' | null>(null);
  const [error, setError] = useState('');

  const handleClick = async (download: boolean) => {
    setLoadingMode(download ? 'download' : 'view');
    setError('');
    const errorMessage = await openReceiptImage(path, download);
    if (errorMessage) setError(errorMessage);
    else if (download) onDownloaded?.();
    setLoadingMode(null);
  };

  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const btnStyle: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 'bold',
    border: `1px solid ${border}`, background: 'transparent', color: '#4a90d9',
  };

  return (
    <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
      <button
        type="button"
        onClick={() => handleClick(false)}
        disabled={loadingMode !== null}
        style={{ ...btnStyle, cursor: loadingMode ? 'default' : 'pointer' }}
      >
        {loadingMode === 'view' ? '取得中...' : '🧾 レシート画像を見る'}
      </button>
      {canDownload && (
        <button
          type="button"
          onClick={() => handleClick(true)}
          disabled={loadingMode !== null}
          style={{ ...btnStyle, cursor: loadingMode ? 'default' : 'pointer' }}
        >
          {loadingMode === 'download' ? '取得中...' : '⬇ ダウンロード'}
        </button>
      )}
      {error && <div style={{ marginTop: 4, fontSize: 12, color: '#842029', flexBasis: '100%' }}>{error}</div>}
    </div>
  );
};

export default ReceiptViewButton;
