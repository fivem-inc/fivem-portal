import React from 'react';
import type { PendingApproval, Submission } from '../types';
import { AdminPanelProvider, useAdminPanel } from './admin/AdminPanelContext';
import ApprovalsTab from './admin/ApprovalsTab';
import GroupsTab from './admin/GroupsTab';
import UsersTab from './admin/UsersTab';
import TripReportsTab from './admin/TripReportsTab';
import ReportsTab from './admin/ReportsTab';
import LeaveRequestsTab from './admin/LeaveRequestsTab';

interface AdminPanelProps {
  pendingApprovals: PendingApproval[];
  submissions: Submission[];
  isLoading: boolean;
  onRefresh: () => void;
}

const AdminPanelContent: React.FC = () => {
  const {
    activeTab, setActiveTab, isDarkMode, tabStyle, tabContentStyle,
    showRejectModal, rejectReason, setRejectReason, handleCancelReject, handleConfirmReject,
    setSelectedGroup,
    showPrintPreview, printData, executePrint, cancelPrint,
    adminSelectingManagerFor, setAdminSelectingManagerFor,
    adminManagerList, adminSelectedManagerId, setAdminSelectedManagerId,
    fetchLeaveRequests, supabase,
    showLocationEditor, setShowLocationEditor,
    tripCategories, locationOptions, newLocationByCategory, setNewLocationByCategory,
    newCategoryName, setNewCategoryName, renamingCategoryId, setRenamingCategoryId,
    renamingCategoryValue, setRenamingCategoryValue,
    handleAddCategory, handleDeleteCategory, handleRenameCategory, handleAddLocation, handleDeleteLocation,
    workplaceOptions, newWorkplaceName, setNewWorkplaceName, handleAddWorkplace, handleDeleteWorkplace,
    customExpenseTypes, newExpenseTypeName, setNewExpenseTypeName, handleAddExpenseType, handleDeleteExpenseType,
    expenseTypeLabels, renamingExpenseTypeLabelId, setRenamingExpenseTypeLabelId, renamingExpenseTypeLabelValue, setRenamingExpenseTypeLabelValue, handleRenameExpenseTypeLabel,
  } = useAdminPanel();

  return (    <div style={{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @media print {
          @page { 
            size: A4 portrait;
            margin: 15mm;
          }
          
          * {
            -webkit-print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          
          body * {
            visibility: hidden !important;
          }
          
          .print-area, .print-area * {
            visibility: visible !important;
          }
          
          .print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: auto !important;
            display: block !important;
          }
          
          .print-page {
            page-break-before: auto;
            page-break-inside: avoid;
            page-break-after: always;
            width: 100%;
            height: 297mm;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            align-items: center;
            padding: 0;
            margin: 0;
            overflow: hidden;
          }
          
          .print-page:last-child {
            page-break-after: avoid;
          }
          
          .print-voucher-grid {
            display: flex !important;
            justify-content: center;
            align-items: flex-start;
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 15mm 0;
          }
          
          .print-voucher {
            width: 150mm !important;
            height: 267mm !important;
            max-height: 267mm !important;
            margin: 0 !important;
            overflow: hidden !important;
            border: 1px solid #000 !important;
            padding: 2mm !important;
            page-break-inside: avoid !important;
            page-break-after: avoid !important;
            display: flex !important;
            flex-direction: column !important;
            font-family: "MS Gothic", "Yu Gothic", monospace !important;
            color: #000 !important;
            background: white !important;
            box-sizing: border-box !important;
          }
          
          .print-voucher-header {
            text-align: center;
            font-size: 14pt;
            font-weight: bold;
            margin-bottom: 2mm;
            border-bottom: 1px solid #000;
            padding-bottom: 1mm;
            color: #000 !important;
          }
          
          .print-voucher-content {
            display: flex;
            flex-direction: column;
          }
          
          .print-voucher-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2mm;
            font-size: 10pt;
            color: #000 !important;
          }
          
          .print-expense-list {
            margin: 1mm 0 0 0;
          }
          
          .print-expense-item {
            display: grid;
            grid-template-columns: 15mm 25mm 1fr 25mm;
            gap: 0.5mm;
            margin-bottom: 0.3mm;
            align-items: center;
            font-size: 7pt;
            min-height: 5mm;
            color: #000 !important;
          }
          
          .print-expense-number {
            text-align: center;
            font-weight: bold;
            border: 1px solid #000;
            padding: 0.1mm;
            color: #000 !important;
            background: white;
            font-size: 5pt;
          }
          
          .print-expense-type {
            text-align: center;
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
            font-weight: bold;
          }
          
          .print-expense-detail {
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
            line-height: 1.3;
            min-height: 5mm;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }
          
          .print-expense-amount {
            text-align: right;
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
          }
          
          .print-voucher-amount {
            text-align: center;
            font-size: 10pt;
            font-weight: bold;
            margin: 1mm 0 0 0;
            padding: 2mm;
            border: 1px solid #000;
            color: #000 !important;
            background: #f8f8f8;
          }
          
          .print-voucher-footer {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8mm;
            font-size: 8pt;
            margin: 1mm 0 0 0;
            padding: 1mm 0;
            color: #000 !important;
          }
          
          .print-voucher-footer-item {
            display: flex;
            align-items: center;
            gap: 5mm;
          }
          
          .print-voucher-footer-space {
            border-bottom: 1px solid #000;
            height: 5mm;
            flex: 1;
          }
        }
        
        @media screen {
          .print-area {
            display: none !important;
          }
        }
        
        @media print {
          html, body {
            width: 100% !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
          }
        }
        
        /* プレビュー用スタイル */
        .preview-modal {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          backgroundColor: rgba(0, 0, 0, 0.5);
          display: flex;
          alignItems: center;
          justifyContent: center;
          z-index: 1000;
        }
        
        .preview-content {
          width: 90vw;
          height: 95vh;
          backgroundColor: white;
          borderRadius: 8px;
          padding: 20px;
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
        }
        
        .preview-page {
          width: 210mm;
          height: 297mm;
          border: 1px solid #ddd;
          background: white;
          margin: 0 auto 20px auto;
          position: relative;
          transform: scale(0.5);
          transform-origin: top center;
        }
        
        .preview-voucher-grid {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding: 15mm;
          width: 100%;
          height: 100%;
        }
        
        .preview-voucher-grid .print-voucher {
          width: 150mm;
          height: 267mm;
          max-width: 150mm;
          max-height: 267mm;
          border: 1px solid #000;
          padding: 2mm;
          display: flex;
          flex-direction: column;
          font-family: "MS Gothic", "Yu Gothic", monospace;
          color: #000 !important;
          background: white;
          font-size: 8pt;
          overflow: hidden;
          box-sizing: border-box;
        }
        
        .preview-voucher-grid .print-voucher-header {
          text-align: center;
          font-size: 8pt;
          font-weight: bold;
          margin-bottom: 1mm;
          border-bottom: 1px solid #000;
          padding-bottom: 0.5mm;
          color: #000 !important;
        }
        
        .preview-voucher-grid .print-expense-item {
          display: grid;
          grid-template-columns: 15mm 25mm 1fr 25mm;
          gap: 0.5mm;
          margin-bottom: 0.3mm;
          align-items: center;
          font-size: 7pt;
          min-height: 5mm;
          color: #000 !important;
        }
        
        .preview-voucher-grid .print-expense-number,
        .preview-voucher-grid .print-expense-type,
        .preview-voucher-grid .print-expense-detail,
        .preview-voucher-grid .print-expense-amount {
          border: 1px solid #000;
          padding: 0.1mm;
          color: #000 !important;
          font-size: 7pt;
        }
        
        .preview-voucher-grid .print-expense-type {
          text-align: center;
          font-weight: bold;
        }
      `}</style>
      <h2 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>管理画面</h2>
      
      {/* 却下理由入力モーダル */}
      {showRejectModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: isDarkMode ? '#343a40' : 'white',
            color: isDarkMode ? '#fff' : '#000',
            padding: '30px',
            borderRadius: '8px',
            width: '90%',
            maxWidth: '500px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
          }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>却下理由を入力</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="却下理由を入力してください（省略可）"
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '10px',
                border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                borderRadius: '4px',
                marginBottom: '20px',
                resize: 'vertical',
                backgroundColor: isDarkMode ? '#495057' : 'white',
                color: isDarkMode ? '#fff' : '#000'
              }}
            />
            <div style={{ textAlign: 'right', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelReject}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                キャンセル
              </button>
              <button
                onClick={handleConfirmReject}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                却下する
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* タブナビゲーション */}
      <div style={{ display: 'flex', marginBottom: '0', justifyContent: 'center' }}>
        <button
          style={tabStyle(activeTab === 'approvals')}
          onClick={() => setActiveTab('approvals')}
        >
          承認管理
        </button>
        <button
          style={tabStyle(activeTab === 'users')}
          onClick={() => setActiveTab('users')}
        >
          ユーザー管理
        </button>
        <button
          style={tabStyle(activeTab === 'groups')}
          onClick={() => { setActiveTab('groups'); setSelectedGroup(null); }}
        >
          👥 グループ管理
        </button>
        <button
          style={tabStyle(activeTab === 'trip_reports')}
          onClick={() => setActiveTab('trip_reports')}
        >
          📍 出張報告
        </button>
        <button
          style={tabStyle(activeTab === 'leave_requests')}
          onClick={() => setActiveTab('leave_requests')}
        >
          🌿 休暇申請
        </button>
        <button
          style={tabStyle(activeTab === 'reports')}
          onClick={() => setActiveTab('reports')}
        >
          レポート・分析
        </button>
      </div>

      {/* タブコンテンツ */}
      <div style={tabContentStyle}>
        {activeTab === 'approvals' && <ApprovalsTab />}
        {activeTab === 'groups' && <GroupsTab />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'trip_reports' && <TripReportsTab />}
        {activeTab === 'reports' && <ReportsTab />}
        {activeTab === 'leave_requests' && <LeaveRequestsTab />}
      </div>

      {/* 区分・勤務先リスト管理モーダル（全タブから開ける） */}
      {showLocationEditor && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 12, padding: 28, width: '90%', maxWidth: 500, maxHeight: '85vh', overflowY: 'auto', color: isDarkMode ? '#fff' : '#333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>⚙️ 区分・勤務先リスト管理</h3>
              <button onClick={() => setShowLocationEditor(false)}
                style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: isDarkMode ? '#adb5bd' : '#6c757d', lineHeight: 1 }}>✕</button>
            </div>

            {/* ═══ 交通費申請 関連 ═══ */}
            <div style={{ fontSize: 13, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#6c757d', marginBottom: 12, letterSpacing: 1 }}>
              ── 交通費申請 ──────────────────
            </div>

            {/* ── 通勤区分 ── */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontWeight: 'bold', fontSize: 15, marginBottom: 10, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 6 }}>
                🚃 通勤区分の管理
              </div>
              {expenseTypeLabels.map(label => (
                <div key={label.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {renamingExpenseTypeLabelId === label.id ? (
                    <>
                      <input autoFocus value={renamingExpenseTypeLabelValue}
                        onChange={e => setRenamingExpenseTypeLabelValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleRenameExpenseTypeLabel(label.id); if (e.key === 'Escape') setRenamingExpenseTypeLabelId(null); }}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '2px solid #007bff', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }} />
                      <button onClick={() => handleRenameExpenseTypeLabel(label.id)} style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>保存</button>
                      <button onClick={() => setRenamingExpenseTypeLabelId(null)} style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>取消</button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontSize: 14, padding: '5px 8px', background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>{label.value}</span>
                      <button onClick={() => { setRenamingExpenseTypeLabelId(label.id); setRenamingExpenseTypeLabelValue(label.value); }} style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>名前変更</button>
                    </>
                  )}
                </div>
              ))}
              {customExpenseTypes.map(et => (
                <div key={et.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', marginBottom: 4, background: isDarkMode ? '#3a4a3a' : '#e8f5e9', borderRadius: 6 }}>
                  <span style={{ fontSize: 13 }}>＋ {et.value}</span>
                  <button onClick={() => handleDeleteExpenseType(et.id)} style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder="区分名を追加（例: 研修）" value={newExpenseTypeName}
                  onChange={e => setNewExpenseTypeName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddExpenseType(); }}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }} />
                <button onClick={handleAddExpenseType} disabled={!newExpenseTypeName.trim()}
                  style={{ padding: '7px 14px', borderRadius: 6, background: '#28a745', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>＋追加</button>
              </div>
            </div>

            {/* ── 勤務先リスト ── */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontWeight: 'bold', fontSize: 15, marginBottom: 10, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 6 }}>
                🏫 勤務先リスト
              </div>
              {workplaceOptions.length === 0 && <div style={{ color: isDarkMode ? '#888' : '#999', fontSize: 13, marginBottom: 6 }}>（未登録）</div>}
              {workplaceOptions.map(wp => (
                <div key={wp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', marginBottom: 4, background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>
                  <span style={{ fontSize: 13 }}>{wp.value}</span>
                  <button onClick={() => handleDeleteWorkplace(wp.id)} style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input type="text" placeholder="勤務先を追加（例: 四条本校）" value={newWorkplaceName}
                  onChange={e => setNewWorkplaceName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddWorkplace(); }}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }} />
                <button onClick={handleAddWorkplace} disabled={!newWorkplaceName.trim()}
                  style={{ padding: '7px 14px', borderRadius: 6, background: '#28a745', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>＋追加</button>
              </div>
            </div>

            {/* ═══ 出張報告 関連 ═══ */}
            <div style={{ fontSize: 13, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#6c757d', marginBottom: 12, letterSpacing: 1 }}>
              ── 出張報告 ──────────────────
            </div>

            {/* ── 出張区分の管理 ── */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontWeight: 'bold', fontSize: 15, marginBottom: 10, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 6 }}>
                📍 出張区分の管理
              </div>
              {tripCategories.map(cat => (
                <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {renamingCategoryId === cat.id ? (
                    <>
                      <input autoFocus value={renamingCategoryValue} onChange={e => setRenamingCategoryValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleRenameCategory(cat.id, cat.value); if (e.key === 'Escape') setRenamingCategoryId(null); }}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '2px solid #007bff', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }} />
                      <button onClick={() => handleRenameCategory(cat.id, cat.value)} style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>保存</button>
                      <button onClick={() => setRenamingCategoryId(null)} style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>取消</button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontSize: 14, padding: '5px 8px', background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>{cat.value}</span>
                      <button onClick={() => { setRenamingCategoryId(cat.id); setRenamingCategoryValue(cat.value); }} style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>名前変更</button>
                      <button onClick={() => handleDeleteCategory(cat.id, cat.value)} style={{ padding: '4px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                    </>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder="新しい区分名を入力" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddCategory(); }}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }} />
                <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
                  style={{ padding: '7px 14px', borderRadius: 6, background: '#28a745', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>＋追加</button>
              </div>
            </div>

            {/* ── 場所リスト（区分ごと） ── */}
            {tripCategories.map(cat => {
              const locKey = `trip_location_${cat.value}`;
              const items = locationOptions.filter(o => o.category === locKey);
              const newVal = newLocationByCategory[cat.value] || '';
              return (
                <div key={cat.id} style={{ marginBottom: 20 }}>
                  <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 8, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 5, color: isDarkMode ? '#adb5bd' : '#6c757d' }}>
                    【{cat.value}】の場所リスト
                  </div>
                  {items.length === 0 && <div style={{ color: isDarkMode ? '#888' : '#999', fontSize: 13, marginBottom: 6 }}>（未登録）</div>}
                  {items.map(item => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', marginBottom: 4, background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>
                      <span style={{ fontSize: 13 }}>{item.value}</span>
                      <button onClick={() => handleDeleteLocation(item.id)} style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <input type="text" placeholder={`${cat.value}の場所を追加`} value={newVal}
                      onChange={e => setNewLocationByCategory(prev => ({ ...prev, [cat.value]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddLocation(cat.value); }}
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 13 }} />
                    <button onClick={() => handleAddLocation(cat.value)} disabled={!newVal.trim()}
                      style={{ padding: '6px 12px', borderRadius: 6, background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>＋</button>
                  </div>
                </div>
              );
            })}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => setShowLocationEditor(false)}
                style={{ padding: '8px 20px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#444' : '#f8f9fa', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 14 }}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 管理者承認時マネージャー選択モーダル */}
      {adminSelectingManagerFor && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 12, padding: 24, width: 340, boxShadow: '0 4px 24px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#333', fontSize: 16 }}>マネージャーを選択して承認</h3>
            <p style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 12 }}>
              {adminSelectingManagerFor.requester?.name || '申請者'} の申請を承認し、マネージャーへ送ります
            </p>
            {adminManagerList.length === 0 ? (
              <p style={{ color: '#dc3545', fontSize: 13 }}>マネージャーが登録されていません</p>
            ) : (
              <select
                value={adminSelectedManagerId}
                onChange={e => setAdminSelectedManagerId(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', fontSize: 14, marginBottom: 16 }}
              >
                {adminManagerList.map(m => (
                  <option key={m.id} value={m.id}>{m.name}（{m.role_title}）</option>
                ))}
              </select>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setAdminSelectingManagerFor(null)}
                style={{ flex: 1, padding: '10px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold' }}
              >キャンセル</button>
              <button
                disabled={!adminSelectedManagerId}
                onClick={async () => {
                  await supabase.from('leave_requests').update({ status: 'step2_pending', approver2_id: adminSelectedManagerId }).eq('id', adminSelectingManagerFor.id);
                  // 管理者が代わりにpendingを進めた場合は通知なし
                  setAdminSelectingManagerFor(null);
                  fetchLeaveRequests();
                }}
                style={{ flex: 1, padding: '10px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold' }}
              >受理して送る</button>
            </div>
          </div>
        </div>
      )}

      {/* 印刷プレビューモーダル */}
      {showPrintPreview && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="preview-content">
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
              borderBottom: '1px solid #ddd',
              paddingBottom: '10px'
            }}>
              <h3>印刷プレビュー (A4)</h3>
              <div>
                <button 
                  onClick={executePrint}
                  style={{
                    padding: '8px 16px',
                    marginRight: '10px',
                    backgroundColor: '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  印刷実行
                </button>
                <button 
                  onClick={cancelPrint}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#6c757d',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  キャンセル
                </button>
              </div>
            </div>
            
            {printData.map((page, pageIndex) => (
              <div key={pageIndex} className="preview-page">
                <div style={{ 
                  position: 'absolute', 
                  top: '5mm', 
                  right: '5mm', 
                  fontSize: '12px', 
                  color: '#666',
                  zIndex: 10 
                }}>
                  ページ {pageIndex + 1} / {printData.length}
                </div>
                <div className="preview-voucher-grid">
                  {page.vouchers.map((voucher, index) => (
                <div key={index} className="print-voucher">
                  <div className="print-voucher-header">
                    交通費請求明細書 #{voucher.voucherNumber}
                    {voucher.pageInfo && <span style={{ marginLeft: '10px', fontSize: '6pt' }}>({voucher.pageInfo})</span>}
                  </div>
                  
                  <div className="print-voucher-content">
                    <div className="print-voucher-row">
                      <span>申請者: {voucher.submitterName}</span>
                      <span>申請日: {voucher.submittedDate}</span>
                    </div>
                    
                    <div className="print-expense-list">
                      {Array.from({ length: 20 }, (_, i) => {
                        const expense = voucher.expenses[i];
                        return (
                          <div key={i} className="print-expense-item">
                            <div className="print-expense-number">
                              {expense ? i + 1 : ''}
                            </div>
                            <div className="print-expense-type">
                              {expense ? (expense.type === 'regular' ? '定期' : 
                                         expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}
                            </div>
                            <div className="print-expense-detail">
                              {expense ? (
                                <>
                                  {expense.type === 'regular' && expense.start_date && expense.end_date ? 
                                    `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` :
                                    expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` : ''
                                  }<br/>
                                  {expense.from_station} → {expense.to_station}
                                  {expense.transportation && ` [${expense.transportation}]`}<br/>
                                  {expense.workplace && `勤務先:${expense.workplace} `}
                                  {expense.notes || ''}
                                </>
                              ) : ''}
                            </div>
                            <div className="print-expense-amount">
                              {expense ? `¥${expense.amount}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    
                    <div className="print-voucher-amount">
                      合計: ¥{voucher.total.toLocaleString()}
                    </div>
                    
                    <div className="print-voucher-footer">
                      <div className="print-voucher-footer-item">
                        <span>承認印:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                      <div className="print-voucher-footer-item">
                        <span>受付日:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                    </div>
                    </div>
                  </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 印刷用エリア（非表示） */}
      <div className="print-area">
        {/* 印刷デバッグ情報 */}
        <div style={{ display: 'none' }}>
          印刷ページ数: {printData.length}ページ
        </div>
        {printData.map((page, pageIndex) => (
          <div key={pageIndex} className="print-page">
            <div className="print-voucher-grid">
              {page.vouchers.map((voucher, index) => (
                <div key={index} className="print-voucher">
                  <div className="print-voucher-header">
                    交通費請求明細書 #{voucher.voucherNumber}
                    {voucher.pageInfo && <span style={{ marginLeft: '10px', fontSize: '6pt' }}>({voucher.pageInfo})</span>}
                  </div>
                  
                  <div className="print-voucher-content">
                    <div className="print-voucher-row">
                      <span>申請者: {voucher.submitterName}</span>
                      <span>申請日: {voucher.submittedDate}</span>
                    </div>
                    
                    <div className="print-expense-list">
                      {Array.from({ length: 20 }, (_, i) => {
                        const expense = voucher.expenses[i];
                        return (
                          <div key={i} className="print-expense-item">
                            <div className="print-expense-number">
                              {expense ? i + 1 : ''}
                            </div>
                            <div className="print-expense-type">
                              {expense ? (expense.type === 'regular' ? '定期' : 
                                         expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}
                            </div>
                            <div className="print-expense-detail">
                              {expense ? (
                                <>
                                  {expense.type === 'regular' && expense.start_date && expense.end_date ? 
                                    `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` :
                                    expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` : ''
                                  }<br/>
                                  {expense.from_station} → {expense.to_station}
                                  {expense.transportation && ` [${expense.transportation}]`}<br/>
                                  {expense.workplace && `勤務先:${expense.workplace} `}
                                  {expense.notes || ''}
                                </>
                              ) : ''}
                            </div>
                            <div className="print-expense-amount">
                              {expense ? `¥${expense.amount}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    
                    <div className="print-voucher-amount">
                      合計: ¥{voucher.total.toLocaleString()}
                    </div>
                    
                    <div className="print-voucher-footer">
                      <div className="print-voucher-footer-item">
                        <span>承認印:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                      <div className="print-voucher-footer-item">
                        <span>受付日:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

      </div>
    </div>
  );

};

const AdminPanel: React.FC<AdminPanelProps> = ({ pendingApprovals, submissions, isLoading, onRefresh }) => {
  return (
    <AdminPanelProvider pendingApprovals={pendingApprovals} submissions={submissions} isLoading={isLoading} onRefresh={onRefresh}>
      <AdminPanelContent />
    </AdminPanelProvider>
  );
};

export default AdminPanel;
