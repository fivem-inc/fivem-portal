import React, { useState } from 'react';
import { openReceiptImage } from '../lib/receiptView';

interface ReceiptViewButtonProps {
  path: string;
  isDarkMode: boolean;
}

const ReceiptViewButton: React.FC<ReceiptViewButtonProps> = ({ path, isDarkMode }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleClick = async () => {
    setLoading(true);
    setError('');
    const errorMessage = await openReceiptImage(path);
    if (errorMessage) setError(errorMessage);
    setLoading(false);
  };

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 'bold', cursor: loading ? 'default' : 'pointer',
          border: `1px solid ${isDarkMode ? '#3a3a5c' : '#e0e0e0'}`,
          background: 'transparent', color: '#4a90d9',
        }}
      >
        {loading ? 'レシート画像を取得中...' : '🧾 レシート画像を見る'}
      </button>
      {error && <div style={{ marginTop: 4, fontSize: 12, color: '#842029' }}>{error}</div>}
    </div>
  );
};

export default ReceiptViewButton;
