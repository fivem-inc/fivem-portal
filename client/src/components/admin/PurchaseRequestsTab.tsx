import React from 'react';
import { useAdminPanel } from './AdminPanelContext';

const PurchaseRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode } = ctx;
  const {
    purchaseCsvStartDate, setPurchaseCsvStartDate,
    purchaseCsvEndDate, setPurchaseCsvEndDate,
    purchaseCsvDateType, setPurchaseCsvDateType,
    handleExportPurchaseCsv, purchaseCsvError,
  } = ctx;

  return (
    <div>
      <h3 style={{ textAlign: 'center', margin: '0 0 20px', color: isDarkMode ? '#fff' : '#000' }}>🧾 購入申請</h3>

      {purchaseCsvError && (
        <div style={{ maxWidth: 500, margin: '0 auto 16px', padding: '10px 12px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{purchaseCsvError}</span>
        </div>
      )}

      {/* CSV出力セクション */}
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ marginBottom: 10, color: isDarkMode ? '#adb5bd' : '#6c757d', fontSize: 13 }}>
          全ステータス（申請中・差し戻しも含む）の申請・精算記録をCSV出力します。
        </div>
        {/* 日付種別選択（ラジオボタン） */}
        <div style={{ marginBottom: 15 }}>
          <label style={{ color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold', marginRight: 20 }}>抽出基準:</label>
          <label style={{ marginRight: 20, color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input
              type="radio"
              name="purchaseCsvDateType"
              value="created"
              checked={purchaseCsvDateType === 'created'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')}
              style={{ marginRight: 5 }}
            />
            申請日
          </label>
          <label style={{ color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input
              type="radio"
              name="purchaseCsvDateType"
              value="decided"
              checked={purchaseCsvDateType === 'decided'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')}
              style={{ marginRight: 5 }}
            />
            承認確定日
          </label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="purchaseCsvStartDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>開始日:</label>
          <input
            type="date"
            id="purchaseCsvStartDate"
            value={purchaseCsvStartDate}
            onChange={(e) => setPurchaseCsvStartDate(e.target.value)}
            style={{
              marginRight: 10,
              padding: 5,
              backgroundColor: isDarkMode ? '#495057' : 'white',
              color: isDarkMode ? '#fff' : '#000',
              border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
            }}
          />
          <label htmlFor="purchaseCsvEndDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>終了日:</label>
          <input
            type="date"
            id="purchaseCsvEndDate"
            value={purchaseCsvEndDate}
            onChange={(e) => setPurchaseCsvEndDate(e.target.value)}
            style={{
              padding: 5,
              backgroundColor: isDarkMode ? '#495057' : 'white',
              color: isDarkMode ? '#fff' : '#000',
              border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
            }}
          />
        </div>
        <button onClick={handleExportPurchaseCsv}>CSV出力（全ステータス）</button>
      </div>
    </div>
  );
};

export default PurchaseRequestsTab;
