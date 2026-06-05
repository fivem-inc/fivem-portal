import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { PendingApproval, Submission } from '../../types';
import { groupSubmissionsByYearAndMonth, generateCSVData, downloadCSV, formatAmount } from '../../utils';
import { supabase } from '../../lib/supabaseClient';
import { sendLeaveSlack } from '../../lib/leaveSlack';
import { useDarkMode } from '../../hooks/useDarkMode';

export type AdminTab = 'approvals' | 'users' | 'groups' | 'reports' | 'trip_reports' | 'leave_requests';

interface PrintVoucher {
  submissionId: string;
  submitterName: string;
  submittedDate: string;
  expenses: any[];
  total: number;
  submissionTotal: number;
  isLastPage: boolean;
  voucherNumber: string;
  printDate: string;
  currentPage: number;
  totalPages: number;
  pageInfo: string;
  submissionIndex: number;
  totalSubmissions: number;
}

interface PrintPage {
  pageNumber: number;
  totalPages: number;
  vouchers: PrintVoucher[];
}

export interface AdminPanelContextType {
  // External props
  pendingApprovals: PendingApproval[];
  submissions: Submission[];
  isLoading: boolean;
  onRefresh: () => void;

  // Tab
  activeTab: AdminTab;
  setActiveTab: React.Dispatch<React.SetStateAction<AdminTab>>;

  // Dark mode & styles
  isDarkMode: boolean;
  tabStyle: (isActive: boolean) => React.CSSProperties;
  tabContentStyle: React.CSSProperties;

  // CSV & filters
  csvStartDate: string; setCsvStartDate: React.Dispatch<React.SetStateAction<string>>;
  csvEndDate: string; setCsvEndDate: React.Dispatch<React.SetStateAction<string>>;
  csvDateType: 'created' | 'approved'; setCsvDateType: React.Dispatch<React.SetStateAction<'created' | 'approved'>>;
  typeFilter: string; setTypeFilter: React.Dispatch<React.SetStateAction<string>>;
  statusFilter: string; setStatusFilter: React.Dispatch<React.SetStateAction<string>>;

  // Year/month expansion
  expandedAdminYears: Set<string>;
  expandedMonths: Set<string>;
  toggleYearExpansion: (year: string) => void;
  toggleMonthExpansion: (yearMonth: string) => void;

  // Computed
  filteredPending: Submission[];
  groupedSubmissions: ReturnType<typeof groupSubmissionsByYearAndMonth>;

  // Users
  users: any[]; setUsers: React.Dispatch<React.SetStateAction<any[]>>;
  loadingUsers: boolean;
  sortedUsers: any[];
  editingUser: string | null; setEditingUser: React.Dispatch<React.SetStateAction<string | null>>;
  editName: string; setEditName: React.Dispatch<React.SetStateAction<string>>;
  showRetired: 'active' | 'retired' | 'all'; setShowRetired: React.Dispatch<React.SetStateAction<'active' | 'retired' | 'all'>>;
  userSortKey: 'sort_order' | 'name' | 'registered_at' | 'submission_count';
  userSortAsc: boolean;
  editingSortOrder: string | null; setEditingSortOrder: React.Dispatch<React.SetStateAction<string | null>>;
  editSortOrderValue: string; setEditSortOrderValue: React.Dispatch<React.SetStateAction<string>>;
  masterOptions: { employment_type: string[]; role_title: string[]; group: string[] };
  isUserEditMode: boolean; setIsUserEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  confirmChange: { userId: string; field: string; label: string; oldVal: string; newVal: string } | null;
  setConfirmChange: React.Dispatch<React.SetStateAction<{ userId: string; field: string; label: string; oldVal: string; newVal: string } | null>>;
  fetchUsers: () => Promise<void>;
  fetchMasterOptions: () => Promise<void>;
  handleUserSort: (key: 'sort_order' | 'name' | 'registered_at' | 'submission_count') => void;
  handleSaveSortOrder: (userId: string) => Promise<void>;
  handleEditName: (userId: string, currentName: string) => void;
  handleSaveName: (userId: string) => Promise<void>;
  handleCancelUserEdit: () => void;
  handleToggleActive: (userId: string, currentIsActive: boolean) => Promise<void>;
  handleDeleteUser: (userId: string, userName: string) => Promise<void>;

  // Groups
  selectedGroup: string | null; setSelectedGroup: React.Dispatch<React.SetStateAction<string | null>>;
  editingGroupName: boolean; setEditingGroupName: React.Dispatch<React.SetStateAction<boolean>>;
  editGroupNameValue: string; setEditGroupNameValue: React.Dispatch<React.SetStateAction<string>>;
  newGroupName: string; setNewGroupName: React.Dispatch<React.SetStateAction<string>>;
  showAddGroup: boolean; setShowAddGroup: React.Dispatch<React.SetStateAction<boolean>>;

  // Reports
  reportStats: any;
  loadingReports: boolean;
  fetchReportStats: () => Promise<void>;

  // Reject modal
  rejectReason: string; setRejectReason: React.Dispatch<React.SetStateAction<string>>;
  showRejectModal: boolean; setShowRejectModal: React.Dispatch<React.SetStateAction<boolean>>;
  rejectingSubmissionId: string | null; setRejectingSubmissionId: React.Dispatch<React.SetStateAction<string | null>>;
  handleConfirmReject: () => Promise<void>;
  handleCancelReject: () => void;

  // Print
  selectedForPrint: Set<string>;
  showPrintPreview: boolean; setShowPrintPreview: React.Dispatch<React.SetStateAction<boolean>>;
  printData: PrintPage[];
  handlePrintSelect: (submissionId: string, checked: boolean) => void;
  handlePrintPreview: () => void;
  executePrint: () => Promise<void>;
  cancelPrint: () => void;
  handleSelectAll: () => void;
  handleSelectPendingOnly: () => void;
  handleDeselectAll: () => void;

  // Approval selection
  selectedForApproval: Set<string>;
  handleApprovalSelect: (id: string, checked: boolean) => void;
  handleSelectAllForApproval: (checked: boolean) => void;
  handleApproveSelected: () => Promise<void>;
  handleApproval: (id: string, newStatus: 'pending' | 'approved' | 'rejected', reason?: string) => Promise<void>;
  handleBulkApproval: (newStatus: 'approved' | 'rejected') => Promise<void>;
  handleIndividualReject: (id: string) => void;

  // Edit submission
  editingSubmissionId: string | null;
  editingExpenses: any[];
  handleStartEdit: (submissionId: string, expensesData: any[]) => void;
  handleCancelEdit: () => void;
  handleSaveEdit: (submissionId: string) => Promise<void>;
  handleUpdateEditingExpense: (index: number, field: string, value: string) => void;
  handleDeleteSubmission: (id: string) => Promise<void>;
  handleExportCsv: () => Promise<void>;

  // Trip reports
  tripReports: any[];
  loadingTripReports: boolean;
  expandedTripYearMonths: Set<string>; setExpandedTripYearMonths: React.Dispatch<React.SetStateAction<Set<string>>>;
  tripReportFilter: 'all' | '到着' | '終了'; setTripReportFilter: React.Dispatch<React.SetStateAction<'all' | '到着' | '終了'>>;
  showLocationEditor: boolean; setShowLocationEditor: React.Dispatch<React.SetStateAction<boolean>>;
  tripCategories: { id: number; value: string; sort_order: number }[];
  locationOptions: { id: number; category: string; value: string; sort_order: number }[];
  newLocationByCategory: Record<string, string>; setNewLocationByCategory: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  newCategoryName: string; setNewCategoryName: React.Dispatch<React.SetStateAction<string>>;
  renamingCategoryId: number | null; setRenamingCategoryId: React.Dispatch<React.SetStateAction<number | null>>;
  renamingCategoryValue: string; setRenamingCategoryValue: React.Dispatch<React.SetStateAction<string>>;
  fetchTripReports: () => Promise<void>;
  fetchLocationEditor: () => Promise<void>;
  handleAddCategory: () => Promise<void>;
  handleDeleteCategory: (id: number, name: string) => Promise<void>;
  handleRenameCategory: (id: number, oldName: string) => Promise<void>;
  handleAddLocation: (categoryName: string) => Promise<void>;
  handleDeleteLocation: (id: number) => Promise<void>;
  workplaceOptions: { id: number; value: string; sort_order: number }[];
  newWorkplaceName: string; setNewWorkplaceName: React.Dispatch<React.SetStateAction<string>>;
  handleAddWorkplace: () => Promise<void>;
  handleDeleteWorkplace: (id: number) => Promise<void>;
  customExpenseTypes: { id: number; value: string; sort_order: number }[];
  newExpenseTypeName: string; setNewExpenseTypeName: React.Dispatch<React.SetStateAction<string>>;
  handleAddExpenseType: () => Promise<void>;
  handleDeleteExpenseType: (id: number) => Promise<void>;
  expenseTypeLabels: { id: number; value: string; sort_order: number }[];
  renamingExpenseTypeLabelId: number | null; setRenamingExpenseTypeLabelId: React.Dispatch<React.SetStateAction<number | null>>;
  renamingExpenseTypeLabelValue: string; setRenamingExpenseTypeLabelValue: React.Dispatch<React.SetStateAction<string>>;
  handleRenameExpenseTypeLabel: (id: number) => Promise<void>;

  // Leave requests
  leaveRequests: any[];
  loadingLeaveRequests: boolean;
  leaveStatusFilter: string; setLeaveStatusFilter: React.Dispatch<React.SetStateAction<string>>;
  adminSelectingManagerFor: any | null; setAdminSelectingManagerFor: React.Dispatch<React.SetStateAction<any | null>>;
  adminManagerList: any[]; setAdminManagerList: React.Dispatch<React.SetStateAction<any[]>>;
  adminSelectedManagerId: string; setAdminSelectedManagerId: React.Dispatch<React.SetStateAction<string>>;
  fetchLeaveRequests: () => Promise<void>;

  // Utilities
  formatAmount: typeof formatAmount;
  supabase: typeof supabase;
  sendLeaveSlack: typeof sendLeaveSlack;
}

const AdminPanelContext = createContext<AdminPanelContextType | null>(null);

export const useAdminPanel = (): AdminPanelContextType => {
  const ctx = useContext(AdminPanelContext);
  if (!ctx) throw new Error('useAdminPanel must be used within AdminPanelProvider');
  return ctx;
};

interface AdminPanelProviderProps {
  pendingApprovals: PendingApproval[];
  submissions: Submission[];
  isLoading: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}

export const AdminPanelProvider: React.FC<AdminPanelProviderProps> = ({
  pendingApprovals, submissions, isLoading, onRefresh, children
}) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('approvals');
  const [csvStartDate, setCsvStartDate] = useState<string>('');
  const [csvEndDate, setCsvEndDate] = useState<string>('');
  const [csvDateType, setCsvDateType] = useState<'created' | 'approved'>('approved');
  const [expandedAdminYears, setExpandedAdminYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [showRetired, setShowRetired] = useState<'active' | 'retired' | 'all'>('active');
  const [userSortKey, setUserSortKey] = useState<'sort_order' | 'name' | 'registered_at' | 'submission_count'>('sort_order');
  const [userSortAsc, setUserSortAsc] = useState(true);
  const [editingSortOrder, setEditingSortOrder] = useState<string | null>(null);
  const [editSortOrderValue, setEditSortOrderValue] = useState<string>('');
  const [masterOptions, setMasterOptions] = useState<{ employment_type: string[]; role_title: string[]; group: string[] }>({ employment_type: [], role_title: [], group: [] });
  const [isUserEditMode, setIsUserEditMode] = useState(false);
  const [confirmChange, setConfirmChange] = useState<{ userId: string; field: string; label: string; oldVal: string; newVal: string; } | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState(false);
  const [editGroupNameValue, setEditGroupNameValue] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [showAddGroup, setShowAddGroup] = useState(false);

  const [reportStats, setReportStats] = useState<any>(null);
  const [loadingReports, setLoadingReports] = useState(false);

  const [rejectReason, setRejectReason] = useState<string>('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectingSubmissionId, setRejectingSubmissionId] = useState<string | null>(null);

  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  const [showPrintPreview, setShowPrintPreview] = useState(false);

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [leaveRequests, setLeaveRequests] = useState<any[]>([]);
  const [loadingLeaveRequests, setLoadingLeaveRequests] = useState(false);
  const [leaveStatusFilter, setLeaveStatusFilter] = useState<string>('active');
  const [adminSelectingManagerFor, setAdminSelectingManagerFor] = useState<any | null>(null);
  const [adminManagerList, setAdminManagerList] = useState<any[]>([]);
  const [adminSelectedManagerId, setAdminSelectedManagerId] = useState('');

  const [tripReports, setTripReports] = useState<any[]>([]);
  const [loadingTripReports, setLoadingTripReports] = useState(false);
  const [expandedTripYearMonths, setExpandedTripYearMonths] = useState<Set<string>>(new Set());
  const [tripReportFilter, setTripReportFilter] = useState<'all' | '到着' | '終了'>('all');

  const [showLocationEditor, setShowLocationEditor] = useState(false);
  const [tripCategories, setTripCategories] = useState<{ id: number; value: string; sort_order: number }[]>([]);
  const [locationOptions, setLocationOptions] = useState<{ id: number; category: string; value: string; sort_order: number }[]>([]);
  const [newLocationByCategory, setNewLocationByCategory] = useState<Record<string, string>>({});
  const [newCategoryName, setNewCategoryName] = useState('');
  const [renamingCategoryId, setRenamingCategoryId] = useState<number | null>(null);
  const [renamingCategoryValue, setRenamingCategoryValue] = useState('');
  const [workplaceOptions, setWorkplaceOptions] = useState<{ id: number; value: string; sort_order: number }[]>([]);
  const [newWorkplaceName, setNewWorkplaceName] = useState('');
  const [customExpenseTypes, setCustomExpenseTypes] = useState<{ id: number; value: string; sort_order: number }[]>([]);
  const [newExpenseTypeName, setNewExpenseTypeName] = useState('');
  const [expenseTypeLabels, setExpenseTypeLabels] = useState<{ id: number; value: string; sort_order: number }[]>([]);
  const [renamingExpenseTypeLabelId, setRenamingExpenseTypeLabelId] = useState<number | null>(null);
  const [renamingExpenseTypeLabelValue, setRenamingExpenseTypeLabelValue] = useState('');

  const [editingSubmissionId, setEditingSubmissionId] = useState<string | null>(null);
  const [editingExpenses, setEditingExpenses] = useState<any[]>([]);
  const [printData, setPrintData] = useState<PrintPage[]>([]);
  const [selectedForApproval, setSelectedForApproval] = useState<Set<string>>(new Set());

  // ---- fetch functions ----

  const fetchLocationEditor = async () => {
    const [catRes, locRes, wpRes, etRes, elRes] = await Promise.all([
      supabase.from('master_options').select('id, value, sort_order').eq('category', 'trip_category').order('sort_order'),
      supabase.from('master_options').select('id, category, value, sort_order').like('category', 'trip_location_%').order('category').order('sort_order'),
      supabase.from('master_options').select('id, value, sort_order').eq('category', 'workplace').order('sort_order'),
      supabase.from('master_options').select('id, value, sort_order').eq('category', 'expense_type').order('sort_order'),
      supabase.from('master_options').select('id, value, sort_order').eq('category', 'expense_type_label').order('sort_order'),
    ]);
    if (catRes.data) setTripCategories(catRes.data);
    if (locRes.data) setLocationOptions(locRes.data);
    if (wpRes.data) setWorkplaceOptions(wpRes.data);
    if (etRes.data) setCustomExpenseTypes(etRes.data);
    if (elRes.data) setExpenseTypeLabels(elRes.data);
  };

  const handleAddWorkplace = async () => {
    const name = newWorkplaceName.trim();
    if (!name) return;
    if (workplaceOptions.some(w => w.value === name)) { alert('同じ名前の勤務先がすでに存在します'); return; }
    const maxOrder = workplaceOptions.reduce((m, w) => Math.max(m, w.sort_order), 0);
    const { error } = await supabase.from('master_options').insert({ category: 'workplace', value: name, sort_order: maxOrder + 1 });
    if (error) { alert('追加に失敗しました: ' + error.message); return; }
    setNewWorkplaceName('');
    await fetchLocationEditor();
  };

  const handleDeleteWorkplace = async (id: number) => {
    if (!window.confirm('この勤務先を削除しますか？')) return;
    const { error } = await supabase.from('master_options').delete().eq('id', id);
    if (error) { alert('削除に失敗しました: ' + error.message); return; }
    await fetchLocationEditor();
  };

  const handleAddExpenseType = async () => {
    const name = newExpenseTypeName.trim();
    if (!name) return;
    if (customExpenseTypes.some(t => t.value === name)) { alert('同じ名前の区分がすでに存在します'); return; }
    const maxOrder = customExpenseTypes.reduce((m, t) => Math.max(m, t.sort_order), 0);
    const { error } = await supabase.from('master_options').insert({ category: 'expense_type', value: name, sort_order: maxOrder + 1 });
    if (error) { alert('追加に失敗しました: ' + error.message); return; }
    setNewExpenseTypeName('');
    await fetchLocationEditor();
  };

  const handleRenameExpenseTypeLabel = async (id: number) => {
    const newLabel = renamingExpenseTypeLabelValue.trim();
    if (!newLabel) { setRenamingExpenseTypeLabelId(null); return; }
    const { error } = await supabase.from('master_options').update({ value: newLabel }).eq('id', id);
    if (error) { alert('更新に失敗しました: ' + error.message); return; }
    setRenamingExpenseTypeLabelId(null);
    setRenamingExpenseTypeLabelValue('');
    await fetchLocationEditor();
  };

  const handleDeleteExpenseType = async (id: number) => {
    if (!window.confirm('この区分を削除しますか？')) return;
    const { error } = await supabase.from('master_options').delete().eq('id', id);
    if (error) { alert('削除に失敗しました: ' + error.message); return; }
    await fetchLocationEditor();
  };

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    if (tripCategories.some(c => c.value === name)) { alert('同じ名前の区分がすでに存在します'); return; }
    const maxOrder = tripCategories.reduce((m, c) => Math.max(m, c.sort_order), 0);
    const { error } = await supabase.from('master_options').insert({ category: 'trip_category', value: name, sort_order: maxOrder + 1 });
    if (error) { alert('追加に失敗しました: ' + error.message); return; }
    setNewCategoryName('');
    await fetchLocationEditor();
  };

  const handleDeleteCategory = async (id: number, name: string) => {
    if (!window.confirm(`区分「${name}」と、その場所リストをすべて削除しますか？`)) return;
    await supabase.from('master_options').delete().eq('id', id);
    await supabase.from('master_options').delete().eq('category', `trip_location_${name}`);
    await fetchLocationEditor();
  };

  const handleRenameCategory = async (id: number, oldName: string) => {
    const newName = renamingCategoryValue.trim();
    if (!newName || newName === oldName) { setRenamingCategoryId(null); return; }
    if (tripCategories.some(c => c.value === newName && c.id !== id)) { alert('同じ名前の区分がすでに存在します'); return; }
    await supabase.from('master_options').update({ value: newName }).eq('id', id);
    await supabase.from('master_options').update({ category: `trip_location_${newName}` }).eq('category', `trip_location_${oldName}`);
    setRenamingCategoryId(null);
    setRenamingCategoryValue('');
    await fetchLocationEditor();
  };

  const handleAddLocation = async (categoryName: string) => {
    const value = (newLocationByCategory[categoryName] || '').trim();
    if (!value) return;
    const cat = `trip_location_${categoryName}`;
    const maxOrder = locationOptions.filter(o => o.category === cat).reduce((m, o) => Math.max(m, o.sort_order), 0);
    const { error } = await supabase.from('master_options').insert({ category: cat, value, sort_order: maxOrder + 1 });
    if (error) { alert('追加に失敗しました: ' + error.message); return; }
    setNewLocationByCategory(prev => ({ ...prev, [categoryName]: '' }));
    await fetchLocationEditor();
  };

  const handleDeleteLocation = async (id: number) => {
    if (!window.confirm('この場所を削除しますか？')) return;
    const { error } = await supabase.from('master_options').delete().eq('id', id);
    if (error) { alert('削除に失敗しました: ' + error.message); return; }
    await fetchLocationEditor();
  };

  // フィルタリング関数
  const getFilteredSubmissions = useCallback(() => {
    return submissions.filter(submission => {
      if (statusFilter !== 'all' && submission.status !== statusFilter) return false;
      if (typeFilter !== 'all') {
        const hasMatchingType = submission.expenses_data?.some(expense => expense.type === typeFilter);
        if (!hasMatchingType) return false;
      }
      return true;
    });
  }, [submissions, typeFilter, statusFilter]);

  const filteredPending = useMemo(() => {
    return getFilteredSubmissions().filter(s => s.status === 'pending');
  }, [getFilteredSubmissions]);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, name, is_active, sort_order, registered_at, employment_type, role_title, group_names, leave_request_enabled')
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (error) {
        console.error('ユーザー取得エラー:', error);
        alert('ユーザー情報の取得に失敗しました: ' + error.message);
      } else {
        setUsers(data || []);
      }
    } catch (error) {
      console.error('ユーザー取得エラー:', error);
      alert('ユーザー情報の取得中にエラーが発生しました');
    }
    setLoadingUsers(false);
  }, []);

  const sortedUsers = useMemo(() => {
    const filtered = showRetired === 'all' ? users : showRetired === 'retired' ? users.filter(u => u.is_active === false) : users.filter(u => u.is_active !== false);
    return [...filtered].sort((a, b) => {
      let aVal, bVal;
      if (userSortKey === 'sort_order') {
        aVal = a.sort_order ?? 9999; bVal = b.sort_order ?? 9999;
      } else if (userSortKey === 'name') {
        aVal = a.name || ''; bVal = b.name || '';
        return userSortAsc ? aVal.localeCompare(bVal, 'ja') : bVal.localeCompare(aVal, 'ja');
      } else if (userSortKey === 'registered_at') {
        aVal = a.registered_at ? new Date(a.registered_at).getTime() : 0;
        bVal = b.registered_at ? new Date(b.registered_at).getTime() : 0;
      } else {
        aVal = a.submission_count || 0; bVal = b.submission_count || 0;
      }
      return userSortAsc ? aVal - bVal : bVal - aVal;
    });
  }, [users, showRetired, userSortKey, userSortAsc]);

  const fetchMasterOptions = useCallback(async () => {
    const { data } = await supabase.from('master_options').select('category, value').order('sort_order');
    if (data) {
      const opts: { employment_type: string[]; role_title: string[]; group: string[] } = { employment_type: [], role_title: [], group: [] };
      data.forEach((row: any) => {
        if (row.category in opts) opts[row.category as keyof typeof opts].push(row.value);
      });
      setMasterOptions(opts);
    }
  }, []);

  const handleUserSort = (key: typeof userSortKey) => {
    if (userSortKey === key) { setUserSortAsc(!userSortAsc); } else { setUserSortKey(key); setUserSortAsc(true); }
  };

  const handleSaveSortOrder = async (userId: string) => {
    const newOrder = parseInt(editSortOrderValue);
    if (isNaN(newOrder)) return;
    const { error } = await supabase.from('profiles').update({ sort_order: newOrder }).eq('id', userId);
    if (!error) setUsers(prev => prev.map(u => u.id === userId ? { ...u, sort_order: newOrder } : u));
    setEditingSortOrder(null);
  };

  const handleEditName = useCallback((userId: string, currentName: string) => {
    setEditingUser(userId);
    setEditName(currentName || '');
  }, []);

  const handleSaveName = useCallback(async (userId: string) => {
    try {
      const { error: profileError } = await supabase.from('profiles').update({ name: editName.trim() || null }).eq('id', userId);
      if (profileError) {
        alert('名前の更新に失敗しました: ' + profileError.message);
      } else {
        try {
          await supabase.rpc('update_user_metadata', {
            user_id: userId,
            metadata: { name: editName.trim(), display_name: editName.trim(), full_name: editName.trim() }
          });
        } catch {}
        alert('名前を更新しました');
        setEditingUser(null);
        setEditName('');
        fetchUsers();
      }
    } catch (error) {
      alert('名前の更新中にエラーが発生しました: ' + error);
    }
  }, [editName, fetchUsers]);

  const handleCancelUserEdit = useCallback(() => { setEditingUser(null); setEditName(''); }, []);

  const handleToggleActive = useCallback(async (userId: string, currentIsActive: boolean) => {
    const action = currentIsActive ? '退職済みにします' : '現役に戻します';
    if (!window.confirm(`このユーザーを${action}。よろしいですか？`)) return;
    const { error } = await supabase.from('profiles').update({ is_active: !currentIsActive }).eq('id', userId);
    if (error) { alert('更新に失敗しました: ' + error.message); } else { fetchUsers(); }
  }, [fetchUsers]);

  const handleDeleteUser = useCallback(async (userId: string, userName: string) => {
    if (!window.confirm(`「${userName}」を完全に削除します。この操作は取り消せません。よろしいですか？`)) return;
    const { error } = await supabase.from('profiles').delete().eq('id', userId);
    if (error) { alert('削除に失敗しました: ' + error.message); } else { alert('削除しました'); fetchUsers(); }
  }, [fetchUsers]);

  const fetchReportStats = useCallback(async () => {
    if (users.length === 0 || submissions.length === 0) { setLoadingReports(false); return; }
    setLoadingReports(true);
    try {
      const totalSubmissions = submissions.length;
      const pendingSubmissions = submissions.filter(s => s.status === 'pending').length;
      const approvedSubmissions = submissions.filter(s => s.status === 'approved').length;
      const rejectedSubmissions = submissions.filter(s => s.status === 'rejected').length;
      const approvalRate = totalSubmissions > 0 ? (approvedSubmissions / totalSubmissions * 100).toFixed(1) : '0';
      const userStats = users.map(user => {
        const userSubmissions = submissions.filter(s => s.profiles?.email === user.email);
        const userApproved = userSubmissions.filter(s => s.status === 'approved');
        const totalAmount = userApproved.reduce((sum, s) => sum + s.expenses_data.reduce((expSum: number, exp: any) => expSum + (parseInt(exp.amount || '0') || 0), 0), 0);
        return {
          name: user.name || user.email, email: user.email,
          totalSubmissions: userSubmissions.length, approvedSubmissions: userApproved.length,
          totalAmount, approvalRate: userSubmissions.length > 0 ? (userApproved.length / userSubmissions.length * 100).toFixed(1) : '0'
        };
      }).sort((a, b) => b.totalAmount - a.totalAmount);
      const monthlyStats = submissions.reduce((acc, submission) => {
        const date = new Date(submission.created_at);
        const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
        if (!acc[monthKey]) acc[monthKey] = { month: monthKey, total: 0, approved: 0, rejected: 0, pending: 0, amount: 0 };
        acc[monthKey].total++;
        acc[monthKey][submission.status as 'approved' | 'rejected' | 'pending']++;
        if (submission.status === 'approved') {
          const amount = submission.expenses_data.reduce((sum: number, exp: any) => sum + (parseInt(exp.amount || '0') || 0), 0);
          acc[monthKey].amount += amount;
        }
        return acc;
      }, {} as Record<string, any>);
      setReportStats({
        overview: { totalSubmissions, pendingSubmissions, approvedSubmissions, rejectedSubmissions, approvalRate },
        userStats,
        monthlyStats: Object.values(monthlyStats).sort((a: any, b: any) => b.month.localeCompare(a.month))
      });
    } catch (error) {
      console.error('レポート統計取得エラー:', error);
    }
    setLoadingReports(false);
  }, [submissions, users]);

  const fetchTripReports = useCallback(async () => {
    setLoadingTripReports(true);
    try {
      const { data, error } = await supabase.from('business_trip_reports').select('*, profiles(name, email)').order('created_at', { ascending: false });
      if (error) throw error;
      setTripReports(data || []);
    } catch (err) {
      console.error('出張報告の取得に失敗:', err);
    } finally {
      setLoadingTripReports(false);
    }
  }, []);

  const fetchLeaveRequests = useCallback(async () => {
    setLoadingLeaveRequests(true);
    try {
      const { data, error } = await supabase.from('leave_requests').select('*').order('created_at', { ascending: false });
      if (error) { console.error('休暇申請取得エラー:', error); return; }
      if (!data) return;
      const ids = [...new Set([
        ...data.map((r: any) => r.user_id),
        ...data.map((r: any) => r.approver_id).filter(Boolean),
        ...data.map((r: any) => r.approver2_id).filter(Boolean),
      ])];
      const { data: profiles } = await supabase.from('profiles').select('id, name, email').in('id', ids);
      const profileMap: Record<string, any> = {};
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });
      setLeaveRequests(data.map((r: any) => ({
        ...r,
        profile: profileMap[r.user_id] || null,
        approver: profileMap[r.approver_id] || null,
        approver2: profileMap[r.approver2_id] || null,
      })));
    } catch (err) {
      console.error('休暇申請の取得に失敗:', err);
    } finally {
      setLoadingLeaveRequests(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'users') { fetchUsers(); fetchMasterOptions(); }
    if (activeTab === 'groups') { fetchUsers(); fetchMasterOptions(); }
    if (activeTab === 'trip_reports') { fetchTripReports(); }
    if (activeTab === 'leave_requests') { fetchLeaveRequests(); fetchUsers(); }
  }, [activeTab, fetchUsers, fetchTripReports, fetchMasterOptions, fetchLeaveRequests]);

  useEffect(() => {
    if (activeTab === 'reports' && users.length > 0 && submissions.length > 0) fetchReportStats();
  }, [activeTab, users, submissions, fetchReportStats]);

  const handleApproval = useCallback(async (id: string, newStatus: 'pending' | 'approved' | 'rejected', reason?: string) => {
    const updateData: { status: 'pending' | 'approved' | 'rejected'; approved_at?: string | null; rejected_at?: string | null; rejected_reason?: string | null } = { status: newStatus };
    if (newStatus === 'approved') { updateData.approved_at = new Date().toISOString(); updateData.rejected_at = null; updateData.rejected_reason = null; }
    else if (newStatus === 'rejected') { updateData.rejected_at = new Date().toISOString(); updateData.approved_at = null; updateData.rejected_reason = reason || null; }
    else { updateData.approved_at = null; updateData.rejected_at = null; updateData.rejected_reason = null; }
    const { error } = await supabase.from('expenses').update(updateData).eq('id', id);
    if (error) { alert('更新に失敗しました: ' + error.message); }
    else { alert(`ステータスを「${newStatus === 'pending' ? '申請中' : newStatus === 'approved' ? '承認' : '却下'}」に更新しました。`); onRefresh(); }
  }, [onRefresh]);

  const handleBulkApproval = useCallback(async (newStatus: 'approved' | 'rejected') => {
    if (filteredPending.length === 0) { alert('承認待ちの申請がありません。'); return; }
    const confirmMessage = newStatus === 'approved' ? `${filteredPending.length}件の申請をすべて承認しますか？` : `${filteredPending.length}件の申請をすべて却下しますか？`;
    if (!window.confirm(confirmMessage)) return;
    let reason = '';
    if (newStatus === 'rejected') reason = prompt('却下理由を入力してください:') || '';
    let successCount = 0, errorCount = 0;
    for (const approval of filteredPending) {
      try {
        const updateData: any = { status: newStatus };
        if (newStatus === 'approved') { updateData.approved_at = new Date().toISOString(); updateData.rejected_at = null; updateData.rejected_reason = null; }
        else { updateData.rejected_at = new Date().toISOString(); updateData.approved_at = null; updateData.rejected_reason = reason || null; }
        const { error } = await supabase.from('expenses').update(updateData).eq('id', approval.id);
        if (error) errorCount++; else successCount++;
      } catch { errorCount++; }
    }
    const statusText = newStatus === 'approved' ? '承認' : '却下';
    alert(errorCount > 0 ? `${successCount}件の申請を${statusText}しました。${errorCount}件でエラーが発生しました。` : `${successCount}件の申請をすべて${statusText}しました。`);
    onRefresh();
  }, [filteredPending, onRefresh]);

  const handleApprovalSelect = useCallback((id: string, checked: boolean) => {
    setSelectedForApproval(prev => { const next = new Set(prev); if (checked) next.add(id); else next.delete(id); return next; });
  }, []);

  const handleSelectAllForApproval = useCallback((checked: boolean) => {
    if (checked) setSelectedForApproval(new Set(filteredPending.map(p => p.id)));
    else setSelectedForApproval(new Set());
  }, [filteredPending]);

  const handleApproveSelected = useCallback(async () => {
    if (selectedForApproval.size === 0) { alert('承認する申請を選択してください。'); return; }
    if (!window.confirm(`選択した${selectedForApproval.size}件を承認しますか？`)) return;
    let successCount = 0, errorCount = 0;
    for (const id of selectedForApproval) {
      const { error } = await supabase.from('expenses').update({ status: 'approved', approved_at: new Date().toISOString(), rejected_at: null, rejected_reason: null }).eq('id', id);
      if (error) errorCount++; else successCount++;
    }
    alert(errorCount > 0 ? `${successCount}件を承認しました。${errorCount}件でエラーが発生しました。` : `${successCount}件を承認しました。`);
    setSelectedForApproval(new Set());
    onRefresh();
  }, [selectedForApproval, onRefresh]);

  const handleIndividualReject = useCallback((id: string) => {
    setRejectingSubmissionId(id); setShowRejectModal(true); setRejectReason('');
  }, []);

  const handlePrintSelect = useCallback((submissionId: string, checked: boolean) => {
    setSelectedForPrint(prev => { const newSet = new Set(prev); if (checked) newSet.add(submissionId); else newSet.delete(submissionId); return newSet; });
  }, []);

  const getVouchersForPrint = useCallback(() => {
    const allSubmissions = [...pendingApprovals, ...submissions];
    const uniqueSubmissions = allSubmissions.filter((submission, index, self) =>
      selectedForPrint.has(submission.id) && self.findIndex(s => s.id === submission.id) === index
    );
    const today = new Date();
    const dateStr = today.getFullYear().toString() + (today.getMonth() + 1).toString().padStart(2, '0') + today.getDate().toString().padStart(2, '0');
    const timeStr = today.getHours().toString().padStart(2, '0') + today.getMinutes().toString().padStart(2, '0');
    const printDate = today.toLocaleDateString('ja-JP') + ' ' + today.getHours().toString().padStart(2, '0') + ':' + today.getMinutes().toString().padStart(2, '0');
    const vouchers = [];
    let voucherCounter = 1;
    for (const submission of uniqueSubmissions) {
      const expenses = submission.expenses_data;
      const expensesPerVoucher = 12;
      const totalVouchersForSubmission = Math.ceil(expenses.length / expensesPerVoucher);
      const submissionTotal = expenses.reduce((sum: number, exp: any) => sum + (parseInt(exp.amount || '0') || 0), 0);
      for (let i = 0; i < expenses.length; i += expensesPerVoucher) {
        const voucherExpenses = expenses.slice(i, i + expensesPerVoucher);
        const voucherTotal = voucherExpenses.reduce((sum: number, exp: any) => sum + (parseInt(exp.amount || '0') || 0), 0);
        const voucherPageNum = Math.floor(i / expensesPerVoucher) + 1;
        const isLastPage = voucherPageNum === totalVouchersForSubmission;
        const voucherNumber = `#${dateStr}-${timeStr}-${voucherCounter.toString().padStart(2, '0')}`;
        voucherCounter++;
        vouchers.push({
          submissionId: submission.id,
          submitterName: submission.profiles?.name || submission.profiles?.email || '不明',
          submittedDate: new Date(submission.created_at).toLocaleDateString('ja-JP'),
          expenses: voucherExpenses, total: voucherTotal, submissionTotal, isLastPage,
          voucherNumber, printDate, currentPage: voucherPageNum, totalPages: totalVouchersForSubmission,
          pageInfo: totalVouchersForSubmission > 1 ? `【${voucherPageNum}/${totalVouchersForSubmission}】` : '',
          submissionIndex: uniqueSubmissions.indexOf(submission) + 1, totalSubmissions: uniqueSubmissions.length
        });
      }
    }
    return vouchers;
  }, [pendingApprovals, submissions, selectedForPrint]);

  const getPaginatedVouchers = useCallback(() => {
    const vouchers = getVouchersForPrint();
    const pages = [];
    for (let i = 0; i < vouchers.length; i += 1) {
      pages.push({ pageNumber: i + 1, totalPages: vouchers.length, vouchers: vouchers.slice(i, i + 1) });
    }
    return pages;
  }, [getVouchersForPrint]);

  const handlePrintPreview = useCallback(() => {
    if (selectedForPrint.size === 0) { alert('印刷する申請を選択してください'); return; }
    setPrintData(getPaginatedVouchers());
    setShowPrintPreview(true);
  }, [selectedForPrint, getPaginatedVouchers]);

  const executePrint = useCallback(async () => {
    const currentUser = await supabase.auth.getUser();
    if (currentUser.data.user) {
      await Promise.all(Array.from(selectedForPrint).map(submissionId =>
        supabase.from('expenses').update({ printed_at: new Date().toISOString(), printed_by: currentUser.data.user?.id }).eq('id', submissionId)
      ));
    }
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) { alert('ポップアップがブロックされました。ポップアップを許可してから再試行してください。'); return; }
    const printHTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>交通費請求明細書</title><style>@page{size:A4 portrait;margin:5mm}*{-webkit-print-color-adjust:exact!important;color-adjust:exact!important}body{font-family:"MS Gothic","Yu Gothic",monospace;margin:0;padding:0}.print-page{page-break-before:auto;page-break-inside:avoid;page-break-after:always;width:100%;height:287mm;display:flex;flex-direction:column;justify-content:flex-start;align-items:center;padding:0;margin:0;overflow:hidden}.print-page:last-child{page-break-after:avoid}.print-voucher-grid{display:flex!important;justify-content:center;align-items:flex-start;width:100%;height:100%;margin:0;padding:2mm 0}.print-voucher{width:180mm!important;height:280mm!important;max-height:280mm!important;margin:0!important;overflow:hidden!important;border:1px solid #000!important;padding:2mm!important;page-break-inside:avoid!important;page-break-after:avoid!important;display:flex!important;flex-direction:column!important;font-family:"MS Gothic","Yu Gothic",monospace!important;color:#000!important;background:white!important;box-sizing:border-box!important}.print-voucher-header{text-align:center;font-weight:bold;margin-bottom:2mm;border-bottom:2px solid #000;padding-bottom:1mm;color:#000!important;white-space:nowrap;font-size:18pt}.print-voucher-content{display:flex;flex-direction:column}.print-voucher-row{display:flex;justify-content:space-between;margin-bottom:2mm;font-size:16pt;font-weight:bold;color:#000!important}.print-expense-list{margin:1mm 0 0 0}.print-expense-item{display:grid;grid-template-columns:12mm 30mm 1fr 30mm;gap:1mm;margin-bottom:.3mm;align-items:flex-start;font-size:12pt;min-height:8mm;color:#000!important}.print-expense-number{text-align:center;font-weight:bold;border:2px solid #000;padding:.5mm;color:#000!important;background:white;font-size:12pt}.print-expense-type{text-align:center;padding:.5mm;border:2px solid #000;color:#000!important;font-size:11pt;font-weight:bold}.print-expense-detail{padding:1mm;border:2px solid #000;color:#000!important;font-size:10pt;line-height:1.3;min-height:8mm;display:flex;flex-direction:column;justify-content:flex-start;font-weight:500}.print-expense-amount{text-align:right;padding:.5mm;border:2px solid #000;color:#000!important;font-size:14pt;font-weight:bold}.print-voucher-amount{text-align:center;font-size:20pt;font-weight:bold;margin:2mm 0 0 0;padding:3mm;border:3px solid #000;color:#000!important;background:#f0f0f0}.print-voucher-footer{display:grid;grid-template-columns:1fr 1fr;gap:8mm;font-size:14pt;font-weight:bold;margin:2mm 0 0 0;padding:2mm 0;color:#000!important}.print-voucher-footer-item{display:flex;align-items:center;gap:5mm}.print-voucher-footer-space{border-bottom:2px solid #000;height:8mm;flex:1}</style></head><body>${printData.map((page) => `<div class="print-page"><div class="print-voucher-grid">${page.vouchers.map((voucher) => `<div class="print-voucher"><div class="print-voucher-header">[交通費請求明細書] ${voucher.voucherNumber} ${voucher.pageInfo || ''}</div><div class="print-voucher-content"><div class="print-voucher-row"><span>申請者: ${voucher.submitterName}</span><span>申請日: ${voucher.submittedDate}</span></div><div class="print-expense-list">${Array.from({ length: 12 }, (_, i) => { const expense = voucher.expenses[i]; return `<div class="print-expense-item"><div class="print-expense-number">${expense ? i + 1 : ''}</div><div class="print-expense-type">${expense ? (expense.type === 'regular' ? '定期' : expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}</div><div class="print-expense-detail">${expense ? `<div>${expense.type === 'regular' && expense.start_date && expense.end_date ? `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit'})}` : expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit'})}` : ''}${expense.workplace ? ` 勤務先:${expense.workplace}` : ''}</div><div>${expense.transportation || ''} ${expense.from_station}→${expense.to_station}</div><div>${expense.notes || ''}</div>` : ''}</div><div class="print-expense-amount">${expense ? `¥${parseInt(expense.amount || '0').toLocaleString()}` : ''}</div></div>`; }).join('')}</div><div class="print-voucher-amount">${voucher.isLastPage ? `申請合計: ¥${voucher.submissionTotal.toLocaleString()}` : `ページ小計: ¥${voucher.total.toLocaleString()}`}</div>${voucher.isLastPage && voucher.totalPages > 1 ? `<div style="font-size:12pt;text-align:center;margin-top:2mm;padding:1mm;border:1px solid #000;background:#e0e0e0;">(このページ: ¥${voucher.total.toLocaleString()})</div>` : ''}<div class="print-voucher-footer"><div class="print-voucher-footer-item"><span>承認印:</span><div class="print-voucher-footer-space"></div></div><div class="print-voucher-footer-item"><span>受付日:</span><div class="print-voucher-footer-space"></div></div></div></div></div>`).join('')}</div></div>`).join('')}</body></html>`;
    printWindow.document.write(printHTML);
    printWindow.document.close();
    printWindow.onload = () => {
      setTimeout(() => {
        printWindow.print();
        printWindow.onafterprint = () => { setShowPrintPreview(false); setSelectedForPrint(new Set()); onRefresh(); printWindow.close(); };
        setTimeout(() => {
          if (!printWindow.closed) {
            try { printWindow.focus(); setTimeout(() => { if (!printWindow.closed) { setShowPrintPreview(false); printWindow.close(); } }, 1000); }
            catch { setShowPrintPreview(false); if (!printWindow.closed) printWindow.close(); }
          }
        }, 3000);
        printWindow.onbeforeunload = () => { setShowPrintPreview(false); };
      }, 500);
    };
  }, [selectedForPrint, onRefresh, printData]);

  const cancelPrint = useCallback(() => { setShowPrintPreview(false); }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedForPrint(new Set(getFilteredSubmissions().map(s => s.id)));
  }, [getFilteredSubmissions]);

  const handleSelectPendingOnly = useCallback(() => {
    setSelectedForPrint(new Set(filteredPending.map(p => p.id)));
  }, [filteredPending]);

  const handleDeselectAll = useCallback(() => { setSelectedForPrint(new Set()); }, []);

  const handleConfirmReject = useCallback(async () => {
    if (!rejectingSubmissionId) return;
    await handleApproval(rejectingSubmissionId, 'rejected', rejectReason);
    setShowRejectModal(false); setRejectingSubmissionId(null); setRejectReason('');
  }, [rejectingSubmissionId, rejectReason, handleApproval]);

  const handleCancelReject = useCallback(() => {
    setShowRejectModal(false); setRejectingSubmissionId(null); setRejectReason('');
  }, []);

  const handleStartEdit = useCallback((submissionId: string, expensesData: any[]) => {
    setEditingSubmissionId(submissionId); setEditingExpenses([...expensesData]);
  }, []);

  const handleCancelEdit = useCallback(() => { setEditingSubmissionId(null); setEditingExpenses([]); }, []);

  const handleSaveEdit = useCallback(async (submissionId: string) => {
    if (!window.confirm('申請内容を更新しますか？')) return;
    const { data: currentData } = await supabase.from('expenses').select('edit_count').eq('id', submissionId).single();
    const currentEditCount = currentData?.edit_count || 0;
    const updateData = { expenses_data: editingExpenses, last_edited_at: new Date().toISOString(), last_edited_by: '管理者', edit_count: currentEditCount + 1 };
    const { error } = await supabase.from('expenses').update(updateData).eq('id', submissionId);
    if (error) { alert('更新に失敗しました: ' + error.message); }
    else { alert('申請内容を更新しました。'); setEditingSubmissionId(null); setEditingExpenses([]); onRefresh(); }
  }, [editingExpenses, onRefresh]);

  const handleUpdateEditingExpense = useCallback((index: number, field: string, value: string) => {
    setEditingExpenses(prev => { const updated = [...prev]; updated[index] = { ...updated[index], [field]: value }; return updated; });
  }, []);

  const handleDeleteSubmission = useCallback(async (id: string) => {
    if (!window.confirm('本当にこの申請を削除しますか？')) return;
    const confirmationText = prompt('削除を確定するには「削除」と入力してください。');
    if (confirmationText !== '削除') { alert('削除がキャンセルされました。'); return; }
    const { error } = await supabase.from('expenses').delete().eq('id', id);
    if (error) { alert('削除に失敗しました: ' + error.message); } else { alert('申請を削除しました。'); onRefresh(); }
  }, [onRefresh]);

  const handleExportCsv = useCallback(async () => {
    const dateField = csvDateType === 'approved' ? 'approved_at' : 'created_at';
    let query = supabase.from('expenses').select('*, profiles(name, email)').eq('status', 'approved');
    if (csvStartDate) query = query.gte(dateField, `${csvStartDate}T00:00:00Z`);
    if (csvEndDate) query = query.lte(dateField, `${csvEndDate}T23:59:59Z`);
    const { data, error } = await query.order(dateField, { ascending: true });
    if (error) { alert('CSV出力に失敗しました。'); return; }
    if (!data || data.length === 0) { alert('承認済みの交通費がありません。'); return; }
    downloadCSV(generateCSVData(data));
    alert('CSVを出力しました。');
  }, [csvStartDate, csvEndDate, csvDateType]);

  const toggleYearExpansion = useCallback((year: string) => {
    setExpandedAdminYears(prev => { const newSet = new Set(prev); if (newSet.has(year)) newSet.delete(year); else newSet.add(year); return newSet; });
  }, []);

  const toggleMonthExpansion = useCallback((yearMonth: string) => {
    setExpandedMonths(prev => { const newSet = new Set(prev); if (newSet.has(yearMonth)) newSet.delete(yearMonth); else newSet.add(yearMonth); return newSet; });
  }, []);

  const groupedSubmissions = groupSubmissionsByYearAndMonth(getFilteredSubmissions());
  const isDarkMode = useDarkMode();

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: '12px 24px', marginRight: '4px',
    background: isActive ? '#007bff' : (isDarkMode ? '#495057' : '#f8f9fa'),
    color: isActive ? 'white' : (isDarkMode ? '#fff' : '#333'),
    border: `1px solid ${isActive ? '#007bff' : (isDarkMode ? '#6c757d' : '#dee2e6')}`,
    borderBottom: isActive ? 'none' : `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
    borderRadius: '8px 8px 0 0', cursor: 'pointer', fontSize: '16px',
    fontWeight: isActive ? 'bold' : 'normal', transition: 'all 0.2s ease'
  });

  const tabContentStyle: React.CSSProperties = {
    border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
    borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: '20px',
    background: isDarkMode ? '#343a40' : 'white', color: isDarkMode ? '#fff' : '#000', minHeight: '400px'
  };

  return (
    <AdminPanelContext.Provider value={{
      pendingApprovals, submissions, isLoading, onRefresh,
      activeTab, setActiveTab,
      isDarkMode, tabStyle, tabContentStyle,
      csvStartDate, setCsvStartDate, csvEndDate, setCsvEndDate, csvDateType, setCsvDateType,
      typeFilter, setTypeFilter, statusFilter, setStatusFilter,
      expandedAdminYears, expandedMonths, toggleYearExpansion, toggleMonthExpansion,
      filteredPending, groupedSubmissions,
      users, setUsers, loadingUsers, sortedUsers,
      editingUser, setEditingUser, editName, setEditName,
      showRetired, setShowRetired, userSortKey, userSortAsc,
      editingSortOrder, setEditingSortOrder, editSortOrderValue, setEditSortOrderValue,
      masterOptions, isUserEditMode, setIsUserEditMode,
      confirmChange, setConfirmChange,
      fetchUsers, fetchMasterOptions, handleUserSort, handleSaveSortOrder,
      handleEditName, handleSaveName, handleCancelUserEdit, handleToggleActive, handleDeleteUser,
      selectedGroup, setSelectedGroup, editingGroupName, setEditingGroupName,
      editGroupNameValue, setEditGroupNameValue, newGroupName, setNewGroupName,
      showAddGroup, setShowAddGroup,
      reportStats, loadingReports, fetchReportStats,
      rejectReason, setRejectReason, showRejectModal, setShowRejectModal,
      rejectingSubmissionId, setRejectingSubmissionId,
      handleConfirmReject, handleCancelReject,
      selectedForPrint, showPrintPreview, setShowPrintPreview, printData,
      handlePrintSelect, handlePrintPreview, executePrint, cancelPrint,
      handleSelectAll, handleSelectPendingOnly, handleDeselectAll,
      selectedForApproval, handleApprovalSelect, handleSelectAllForApproval, handleApproveSelected,
      handleApproval, handleBulkApproval, handleIndividualReject,
      editingSubmissionId, editingExpenses,
      handleStartEdit, handleCancelEdit, handleSaveEdit, handleUpdateEditingExpense,
      handleDeleteSubmission, handleExportCsv,
      tripReports, loadingTripReports, expandedTripYearMonths, setExpandedTripYearMonths,
      tripReportFilter, setTripReportFilter, showLocationEditor, setShowLocationEditor,
      tripCategories, locationOptions, newLocationByCategory, setNewLocationByCategory,
      newCategoryName, setNewCategoryName, renamingCategoryId, setRenamingCategoryId,
      renamingCategoryValue, setRenamingCategoryValue,
      fetchTripReports, fetchLocationEditor,
      handleAddCategory, handleDeleteCategory, handleRenameCategory, handleAddLocation, handleDeleteLocation,
      workplaceOptions, newWorkplaceName, setNewWorkplaceName, handleAddWorkplace, handleDeleteWorkplace,
      customExpenseTypes, newExpenseTypeName, setNewExpenseTypeName, handleAddExpenseType, handleDeleteExpenseType,
      expenseTypeLabels, renamingExpenseTypeLabelId, setRenamingExpenseTypeLabelId, renamingExpenseTypeLabelValue, setRenamingExpenseTypeLabelValue, handleRenameExpenseTypeLabel,
      leaveRequests, loadingLeaveRequests, leaveStatusFilter, setLeaveStatusFilter,
      adminSelectingManagerFor, setAdminSelectingManagerFor,
      adminManagerList, setAdminManagerList, adminSelectedManagerId, setAdminSelectedManagerId,
      fetchLeaveRequests,
      formatAmount, supabase, sendLeaveSlack,
    }}>
      {children}
    </AdminPanelContext.Provider>
  );
};
