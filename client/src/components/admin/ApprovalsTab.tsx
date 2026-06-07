import React from 'react';
import { formatAmount } from '../../utils';
import { useAdminPanel } from './AdminPanelContext';

const toJST = (utcStr: string | null | undefined): string => {
  if (!utcStr) return '';
  // タイムゾーン情報がない場合はUTCとして解釈（Supabaseが+00:00なしで返す場合の対策）
  const hasTimezone = utcStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(utcStr);
  const d = new Date(hasTimezone ? utcStr : utcStr + 'Z');
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}/${mo}/${day} ${h}:${mi}:${s}`;
};

const ApprovalsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode } = ctx;
  // spread all context values for use in JSX
  const {
    isLoading,
    csvStartDate, setCsvStartDate, csvEndDate, setCsvEndDate, csvDateType, setCsvDateType,
    typeFilter, setTypeFilter, statusFilter, setStatusFilter,
    filteredPending, groupedSubmissions, expandedAdminYears, expandedMonths,
    toggleYearExpansion, toggleMonthExpansion,
    selectedForPrint, selectedForApproval,
    handleApprovalSelect, handleSelectAllForApproval, handleApproveSelected,
    handleBulkApproval, handleIndividualReject, handleApproval,
    handlePrintSelect, handlePrintPreview, handleSelectAll, handleSelectPendingOnly, handleDeselectAll,
    handleStartEdit, handleCancelEdit, handleSaveEdit, handleUpdateEditingExpense,
    editingSubmissionId, editingExpenses,
    handleDeleteSubmission, handleExportCsv,
    fetchLocationEditor, setShowLocationEditor,
  } = ctx;

  return (          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
              <div style={{ flex: 1 }} />
              <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#000' }}>承認管理</h3>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { fetchLocationEditor(); setShowLocationEditor(true); }}
                  style={{ padding: '6px 14px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : '#f8f9fa', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 13 }}
                >
                  ⚙️ 区分・勤務先リストを管理
                </button>
              </div>
            </div>
            
            {/* CSV出力セクション */}
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              {/* 日付種別選択（ラジオボタン） */}
              <div style={{ marginBottom: 15 }}>
                <label style={{ color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold', marginRight: 20 }}>抽出基準:</label>
                <label style={{ marginRight: 20, color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="csvDateType"
                    value="approved"
                    checked={csvDateType === 'approved'}
                    onChange={(e) => setCsvDateType(e.target.value as 'created' | 'approved')}
                    style={{ marginRight: 5 }}
                  />
                  承認日
                </label>
                <label style={{ color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="csvDateType"
                    value="created"
                    checked={csvDateType === 'created'}
                    onChange={(e) => setCsvDateType(e.target.value as 'created' | 'approved')}
                    style={{ marginRight: 5 }}
                  />
                  申請日
                </label>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label htmlFor="csvStartDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>開始日:</label>
                <input
                  type="date"
                  id="csvStartDate"
                  value={csvStartDate}
                  onChange={(e) => setCsvStartDate(e.target.value)}
                  style={{
                    marginRight: 10,
                    padding: 5,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
                  }}
                />
                <label htmlFor="csvEndDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>終了日:</label>
                <input
                  type="date"
                  id="csvEndDate"
                  value={csvEndDate}
                  onChange={(e) => setCsvEndDate(e.target.value)}
                  style={{
                    padding: 5,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
                  }}
                />
              </div>
              <button onClick={handleExportCsv}>承認済みCSV出力</button>
            </div>
            
            {/* フィルターセクション */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '20px',
              marginBottom: '20px',
              alignItems: 'center'
            }}>
              <div>
                <label htmlFor="typeFilter" style={{ marginRight: '8px', color: isDarkMode ? '#fff' : '#000' }}>申請種別:</label>
                <select
                  id="typeFilter"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000'
                  }}
                >
                  <option value="all">すべて</option>
                  <option value="one_time">通勤（単発）</option>
                  <option value="regular">定期</option>
                  <option value="business_trip">出張（園指導等）</option>
                </select>
              </div>
              <div>
                <label htmlFor="statusFilter" style={{ marginRight: '8px', color: isDarkMode ? '#fff' : '#000' }}>ステータス:</label>
                <select
                  id="statusFilter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000'
                  }}
                >
                  <option value="all">すべて</option>
                  <option value="pending">申請中</option>
                  <option value="approved">承認済み</option>
                  <option value="rejected">却下</option>
                </select>
              </div>
            </div>

            {/* 承認待ち一覧 */}
            <h4 style={{ textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>承認待ち一覧</h4>
            {isLoading ? (
              <p style={{ textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : (
              <div>
                {filteredPending.length > 0 && (
                  <>
                    {/* 印刷操作ボタン */}
                    <div style={{ marginBottom: '10px', padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '4px' }}>
                      <strong>印刷操作:</strong>
                      <button 
                        onClick={handlePrintPreview}
                        style={{ 
                          padding: '8px 16px', 
                          marginLeft: '10px',
                          marginRight: '8px', 
                          backgroundColor: '#17a2b8', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        選択印刷 ({selectedForPrint.size})
                      </button>
                      <button 
                        onClick={handleSelectPendingOnly}
                        style={{ 
                          padding: '8px 16px', 
                          marginRight: '8px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        承認待ち全選択
                      </button>
                      <button 
                        onClick={handleSelectAll}
                        style={{ 
                          padding: '8px 16px', 
                          marginRight: '8px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全選択
                      </button>
                      <button 
                        onClick={handleDeselectAll}
                        style={{ 
                          padding: '8px 16px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全解除
                      </button>
                    </div>
                    
                    {/* 承認・却下操作ボタン */}
                    <div style={{ marginBottom: '20px' }}>
                      <strong>承認操作:</strong>
                      <button
                        onClick={() => handleBulkApproval('approved')}
                        style={{
                          padding: '10px 20px',
                          marginLeft: '10px',
                          marginRight: '10px',
                          backgroundColor: '#28a745',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全て承認
                      </button>
                      <button
                        onClick={() => handleBulkApproval('rejected')}
                        style={{
                          padding: '10px 20px',
                          backgroundColor: '#dc3545',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全て却下
                      </button>
                    </div>

                    {/* 選択承認エリア */}
                    <div style={{
                      marginBottom: '20px',
                      padding: '12px 16px',
                      border: `2px solid ${isDarkMode ? '#495057' : '#dee2e6'}`,
                      borderRadius: '8px',
                      backgroundColor: isDarkMode ? '#2c3034' : '#f8f9fa'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold' }}>
                          <input
                            type="checkbox"
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                            checked={filteredPending.length > 0 && selectedForApproval.size === filteredPending.length}
                            onChange={(e) => handleSelectAllForApproval(e.target.checked)}
                          />
                          全選択
                        </label>
                        <span style={{ color: isDarkMode ? '#adb5bd' : '#6c757d', fontSize: '14px' }}>
                          {selectedForApproval.size > 0 ? `${selectedForApproval.size}件選択中` : '選択なし'}
                        </span>
                        <button
                          onClick={handleApproveSelected}
                          disabled={selectedForApproval.size === 0}
                          style={{
                            padding: '8px 20px',
                            backgroundColor: selectedForApproval.size === 0 ? '#6c757d' : '#28a745',
                            color: 'white',
                            border: '2px solid',
                            borderColor: selectedForApproval.size === 0 ? '#5a6268' : '#1e7e34',
                            borderRadius: '4px',
                            cursor: selectedForApproval.size === 0 ? 'not-allowed' : 'pointer',
                            fontWeight: 'bold',
                            opacity: selectedForApproval.size === 0 ? 0.6 : 1
                          }}
                        >
                          選択したものを承認 {selectedForApproval.size > 0 ? `(${selectedForApproval.size}件)` : ''}
                        </button>
                      </div>
                    </div>
                  </>
                )}
                <ul style={{ listStyle: 'none', padding: 0, textAlign: 'left' }}>
                  {filteredPending.map(p => (
                    <li key={p.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '16px', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>
                          <input
                            type="checkbox"
                            checked={selectedForApproval.has(p.id)}
                            onChange={(e) => handleApprovalSelect(p.id, e.target.checked)}
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                          />
                          承認選択
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>
                          <input
                            type="checkbox"
                            checked={selectedForPrint.has(p.id)}
                            onChange={(e) => handlePrintSelect(p.id, e.target.checked)}
                            style={{ marginRight: '2px' }}
                          />
                          印刷選択
                        </label>
                        {p.printed_at && (
                          <span style={{ 
                            marginLeft: '10px', 
                            padding: '2px 6px', 
                            backgroundColor: '#28a745', 
                            color: 'white', 
                            borderRadius: '3px', 
                            fontSize: '12px',
                            fontWeight: 'bold',
                            cursor: 'pointer'
                          }}
                          title={`印刷日時: ${toJST(p.printed_at)}`}
                          >
                            ✓ 印刷済み ({toJST(p.printed_at)})
                          </span>
                        )}
                      </div>
                      <strong>申請者:</strong> {p.profiles?.name || p.profiles?.email || '不明'} <br />
                      <strong>申請日:</strong> {toJST(p.created_at)} <br />
                      <strong>ステータス:</strong> {
                        p.status === 'pending' ? '申請中' :
                        p.status === 'approved' ? <span style={{ color: '#007bff', fontWeight: 'bold' }}>承認</span> :
                        <span style={{ color: '#dc3545', fontWeight: 'bold' }}>却下</span>
                      } <br />
                      <strong>合計金額:</strong> {formatAmount(p.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
                      {p.printed_at && (
                        <><strong>印刷日時:</strong> {toJST(p.printed_at)} <br /></>
                      )}
                      {p.printed_by && (
                        <><strong>印刷者ID:</strong> {p.printed_by} <br /></>
                      )}
                      {((p.edit_count && p.edit_count > 0) || p.last_edited_at) && (
                        <>
                          <span style={{ 
                            backgroundColor: '#ffc107', 
                            color: '#000', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontSize: '12px',
                            fontWeight: 'bold'
                          }}>
                            編集済み ({p.edit_count || 0}回)
                          </span> <br />
                          <strong>最終編集:</strong> {toJST(p.last_edited_at)} ({p.last_edited_by || ''}) <br />
                        </>
                      )}
                      {p.approved_at && (
                        <><strong>承認日:</strong> {toJST(p.approved_at)} <br /></>
                      )}
                      {p.rejected_at && (
                        <><strong>却下日:</strong> {toJST(p.rejected_at)} <br /></>
                      )}
                      {p.rejected_reason && (
                        <><strong>却下理由:</strong> {p.rejected_reason} <br /></>
                      )}
                      <ul>
                        {p.expenses_data.map((e, i) => (
                          <li key={i}>
                            {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）'}: 
                            {e.type === 'regular' 
                              ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                              : `${e.start_date || '未設定'}`
                            } | 
                            {e.transportation && `[${e.transportation}] `}
                            {e.from_station} - {e.to_station}: {e.amount}円
                            {e.workplace && ` [勤務先: ${e.workplace}]`}
                            {e.notes && ` (備考: ${e.notes})`}
                          </li>
                        ))}
                      </ul>
                      <button 
                        onClick={() => handleApproval(p.id, 'approved')} 
                        style={{ 
                          marginRight: 10, 
                          padding: '8px 16px',
                          backgroundColor: '#28a745',
                          color: 'white',
                          border: '2px solid #1e7e34',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        承認
                      </button>
                      <button 
                        onClick={() => handleIndividualReject(p.id)}
                        style={{ 
                          marginRight: 10,
                          padding: '8px 16px',
                          backgroundColor: '#dc3545',
                          color: 'white',
                          border: '2px solid #bd2130',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        却下
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* すべての申請履歴 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 40 }}>
              <h4 style={{ textAlign: 'left', margin: 0, color: isDarkMode ? '#fff' : '#000' }}>すべての申請履歴</h4>
              <div>
                <button 
                  onClick={handlePrintPreview}
                  style={{ 
                    padding: '8px 16px', 
                    marginRight: '8px',
                    backgroundColor: '#17a2b8', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  選択印刷 ({selectedForPrint.size})
                </button>
                <button 
                  onClick={handleSelectAll}
                  style={{ 
                    padding: '8px 16px', 
                    marginRight: '8px',
                    backgroundColor: '#6c757d', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  全選択
                </button>
                <button 
                  onClick={handleDeselectAll}
                  style={{ 
                    padding: '8px 16px', 
                    backgroundColor: '#6c757d', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  全解除
                </button>
              </div>
            </div>
            {isLoading ? (
              <p style={{ textAlign: 'left' }}>読み込み中...</p>
            ) : (
              <div style={{ textAlign: 'left' }}>
              {Object.entries(groupedSubmissions)
                .sort(([yearA], [yearB]) => parseInt(yearB) - parseInt(yearA))
                .map(([year, months]) => (
                  <div key={year} style={{ marginBottom: 20, border: '1px solid #eee', borderRadius: 4, padding: 10 }}>
                    <h5 
                      onClick={() => toggleYearExpansion(year)} 
                      style={{ 
                        cursor: 'pointer', 
                        margin: 0, 
                        padding: 8, 
                        background: '#f0f0f0',
                        color: '#333',
                        fontWeight: 'bold',
                        borderRadius: 4,
                        border: '1px solid #ddd'
                      }}
                    >
                      {year}年度 ({expandedAdminYears.has(year) ? '閉じる' : '開く'})
                    </h5>
                    {expandedAdminYears.has(year) && (
                      Object.entries(months)
                        .sort(([monthA], [monthB]) => parseInt(monthB) - parseInt(monthA))
                        .map(([month, monthSubmissions]) => (
                          <div key={`${year}-${month}`} style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 4, padding: 5 }}>
                            <h6 
                              onClick={() => toggleMonthExpansion(`${year}-${month}`)} 
                              style={{ 
                                cursor: 'pointer', 
                                margin: 0, 
                                padding: 8, 
                                background: '#f9f9f9',
                                color: '#333',
                                fontWeight: 'bold',
                                borderRadius: 4,
                                border: '1px solid #ccc'
                              }}
                            >
                              {month}月 ({expandedMonths.has(`${year}-${month}`) ? '閉じる' : '開く'})
                            </h6>
                            {expandedMonths.has(`${year}-${month}`) && (
                              <ul style={{ listStyle: 'none', padding: 0 }}>
                                {monthSubmissions.map(s => (
                                  <li key={s.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                                      <input
                                        type="checkbox"
                                        checked={selectedForPrint.has(s.id)}
                                        onChange={(e) => handlePrintSelect(s.id, e.target.checked)}
                                        style={{ marginRight: '8px' }}
                                      />
                                      <label style={{ fontWeight: 'bold' }}>印刷選択</label>
                                      {s.printed_at && (
                                        <span style={{ 
                                          marginLeft: '10px', 
                                          padding: '2px 6px', 
                                          backgroundColor: '#28a745', 
                                          color: 'white', 
                                          borderRadius: '3px', 
                                          fontSize: '12px',
                                          fontWeight: 'bold',
                                          cursor: 'pointer'
                                        }}
                                        title={`印刷日時: ${toJST(s.printed_at)}`}
                                        >
                                          ✓ 印刷済み ({toJST(s.printed_at)})
                                        </span>
                                      )}
                                    </div>
                                    <strong>申請者:</strong> {s.profiles?.name || s.profiles?.email || '不明'} <br />
                                    <strong>申請日:</strong> {toJST(s.created_at)} <br />
                                    <strong>ステータス:</strong> {
                                      s.status === 'pending' ? '申請中' : 
                                      s.status === 'approved' ? <span style={{ color: '#007bff', fontWeight: 'bold' }}>承認</span> : 
                                      <span style={{ color: '#dc3545', fontWeight: 'bold' }}>却下</span>
                                    } <br />
                                    <strong>合計金額:</strong> {formatAmount(s.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
                                    {s.printed_at && (
                                      <><strong>印刷日時:</strong> {toJST(s.printed_at)} <br /></>
                                    )}
                                    {s.printed_by && (
                                      <><strong>印刷者ID:</strong> {s.printed_by} <br /></>
                                    )}
                                    {((s.edit_count && s.edit_count > 0) || s.last_edited_at) && (
                                      <>
                                        <span style={{ 
                                          backgroundColor: '#ffc107', 
                                          color: '#000', 
                                          padding: '2px 6px', 
                                          borderRadius: '4px', 
                                          fontSize: '12px',
                                          fontWeight: 'bold'
                                        }}>
                                          編集済み ({s.edit_count || 0}回)
                                        </span> <br />
                                        <strong>最終編集:</strong> {toJST(s.last_edited_at)} ({s.last_edited_by || ''}) <br />
                                      </>
                                    )}
                                    {s.approved_at && (
                                      <><strong>承認日:</strong> {toJST(s.approved_at)} <br /></>
                                    )}
                                    {s.rejected_at && (
                                      <><strong>却下日:</strong> {toJST(s.rejected_at)} <br /></>
                                    )}
                                    <ul>
                                      {(editingSubmissionId === s.id ? editingExpenses : s.expenses_data).map((e, i) => (
                                        <li key={i} style={{ marginBottom: '10px' }}>
                                          {editingSubmissionId === s.id ? (
                                            <div style={{ border: '1px solid #ddd', padding: '10px', borderRadius: '4px', backgroundColor: '#f8f9fa' }}>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>申請種別:</strong>
                                                <select
                                                  value={e.type || 'commute'}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'type', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px' }}
                                                >
                                                  <option value="commute">通勤（単発）</option>
                                                  <option value="regular">定期</option>
                                                  <option value="business_trip">出張（園指導等）</option>
                                                </select>
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>日付:</strong>
                                                <input
                                                  type="date"
                                                  value={e.start_date || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'start_date', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px' }}
                                                />
                                                {e.type === 'regular' && (
                                                  <>
                                                    <span style={{ margin: '0 10px' }}>〜</span>
                                                    <input
                                                      type="date"
                                                      value={e.end_date || ''}
                                                      onChange={(event) => handleUpdateEditingExpense(i, 'end_date', event.target.value)}
                                                      style={{ padding: '4px' }}
                                                    />
                                                  </>
                                                )}
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>交通手段:</strong>
                                                <input
                                                  type="text"
                                                  value={e.transportation || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'transportation', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '100px' }}
                                                />
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>出発地:</strong>
                                                <input
                                                  type="text"
                                                  value={e.from_station || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'from_station', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '120px' }}
                                                />
                                                <strong style={{ marginLeft: '10px' }}>到着地:</strong>
                                                <input
                                                  type="text"
                                                  value={e.to_station || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'to_station', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '120px' }}
                                                />
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>金額:</strong>
                                                <input
                                                  type="number"
                                                  value={e.amount || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'amount', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '80px' }}
                                                />円
                                                <strong style={{ marginLeft: '20px' }}>勤務先:</strong>
                                                <input
                                                  type="text"
                                                  value={e.workplace || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'workplace', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '100px' }}
                                                />
                                              </div>
                                              <div>
                                                <strong>備考:</strong>
                                                <input
                                                  type="text"
                                                  value={e.notes || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'notes', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '200px' }}
                                                />
                                              </div>
                                            </div>
                                          ) : (
                                            <>
                                              {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）'}: 
                                              {e.type === 'regular' 
                                                ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                                                : `${e.start_date || '未設定'}`
                                              } | 
                                              {e.transportation && `[${e.transportation}] `}
                                              {e.from_station} - {e.to_station}: {e.amount}円
                                              {e.workplace && ` [勤務先: ${e.workplace}]`}
                                              {e.notes && ` (備考: ${e.notes})`}
                                            </>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                    <div style={{ marginTop: 10 }}>
                                      {editingSubmissionId === s.id ? (
                                        <div>
                                          <button 
                                            onClick={() => handleSaveEdit(s.id)}
                                            style={{ 
                                              marginRight: 10, 
                                              padding: '8px 16px', 
                                              backgroundColor: '#28a745', 
                                              color: 'white', 
                                              border: 'none', 
                                              borderRadius: 4, 
                                              cursor: 'pointer',
                                              fontWeight: 'bold'
                                            }}
                                          >
                                            保存
                                          </button>
                                          <button 
                                            onClick={handleCancelEdit}
                                            style={{ 
                                              padding: '8px 16px', 
                                              backgroundColor: '#6c757d', 
                                              color: 'white', 
                                              border: 'none', 
                                              borderRadius: 4, 
                                              cursor: 'pointer' 
                                            }}
                                          >
                                            キャンセル
                                          </button>
                                        </div>
                                      ) : (
                                        <div>
                                          <select
                                            defaultValue={s.status}
                                            onChange={(e) => handleApproval(s.id, e.target.value as 'pending' | 'approved' | 'rejected')}
                                            style={{ marginRight: 10, padding: 8 }}
                                          >
                                            <option value="pending">申請中</option>
                                            <option value="approved">承認</option>
                                            <option value="rejected">却下</option>
                                          </select>
                                          <button onClick={() => handleApproval(s.id, s.status)} style={{ padding: '8px 12px' }}>更新</button>
                                          {(s.status === 'approved' || s.status === 'rejected') && (
                                            <button 
                                              onClick={() => handleStartEdit(s.id, s.expenses_data)}
                                              style={{ 
                                                marginLeft: 10, 
                                                padding: '8px 12px', 
                                                backgroundColor: '#007bff', 
                                                color: 'white', 
                                                border: 'none', 
                                                borderRadius: 4, 
                                                cursor: 'pointer' 
                                              }}
                                            >
                                              編集
                                            </button>
                                          )}
                                          <button 
                                            onClick={() => handleDeleteSubmission(s.id)} 
                                            style={{ 
                                              marginLeft: 10, 
                                              padding: '8px 12px', 
                                              background: '#dc3545', 
                                              color: 'white', 
                                              border: 'none', 
                                              borderRadius: 4, 
                                              cursor: 'pointer' 
                                            }}
                                          >
                                            削除
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
  );
};

export default ApprovalsTab;
