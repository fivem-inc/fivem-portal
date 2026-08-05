import React, { useState } from 'react';
import { openReceiptImage } from '../lib/receiptView';
import FileViewerModal from './FileViewerModal';

interface ReceiptViewButtonProps {
  path: string;
  isDarkMode: boolean;
  canDownload?: boolean;
  onDownloaded?: () => void;
  extraActions?: React.ReactNode;
}

const ReceiptViewButton: React.FC<ReceiptViewButtonProps> = ({ path, isDarkMode, canDownload = false, onDownloaded, extraActions }) => {
  const [loadingMode, setLoadingMode] = useState<'download' | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(false);

  // ダウンロード（管理者のみ）は保存動作なのでSafariにブロックされない。従来どおり別タブに渡す
  const handleDownload = async () => {
    setLoadingMode('download');
    setError('');
    const errorMessage = await openReceiptImage(path, true);
    if (errorMessage) setError(errorMessage);
    else onDownloaded?.();
    setLoadingMode(null);
  };

  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const btnStyle: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 'bold',
    border: `1px solid ${border}`, background: 'transparent', color: '#4a90d9',
  };

  return (
    <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setViewing(true)}
        style={{ ...btnStyle, cursor: 'pointer' }}
      >
        🧾 レシート画像を見る
      </button>
      {canDownload && (
        <button
          type="button"
          onClick={handleDownload}
          disabled={loadingMode !== null}
          style={{ ...btnStyle, cursor: loadingMode ? 'default' : 'pointer' }}
        >
          {loadingMode === 'download' ? '取得中...' : '⬇ ダウンロード'}
        </button>
      )}
      {extraActions}
      {error && <div style={{ marginTop: 4, fontSize: 12, color: '#842029', flexBasis: '100%' }}>{error}</div>}
      {viewing && (
        <FileViewerModal path={path} title="レシート" isDarkMode={isDarkMode} onClose={() => setViewing(false)} />
      )}
    </div>
  );
};

export default ReceiptViewButton;
