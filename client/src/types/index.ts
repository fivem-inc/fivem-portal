export interface Expense {
  type: 'regular' | 'business_trip' | 'one_time' | 'other';
  type_other?: string;
  trip_category?: string;
  from_station: string;
  to_station: string;
  amount: string;
  start_date?: string;
  end_date?: string;
  transportation?: string;
  transportation_other?: string;
  notes?: string;
  workplace?: string;
  workplace_other?: string;
}

export interface Profile {
  email: string;
  name?: string;
  employment_type?: string;
  role_title?: string;
  group_name?: string;
  leave_request_enabled?: boolean;
}

export interface Submission {
  id: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected';
  expenses_data: Expense[];
  profiles?: Profile | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  rejected_reason?: string | null;
  user_id?: string;
  printed_at?: string | null;
  printed_by?: string | null;
  last_edited_at?: string | null;
  last_edited_by?: string | null;
  edit_count?: number;
}

export interface PendingApproval extends Submission {
  profiles: Profile | null;
}

export interface GroupedSubmissions {
  [year: string]: {
    [month: string]: Submission[];
  };
}

export interface AuthUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
  };
  user_metadata?: {
    name?: string;
    display_name?: string;
    full_name?: string;
    [key: string]: unknown;
  };
}

export interface AuthContextType {
  user: AuthUser | null;
}

export interface LeaveRequest {
  id?: string;
  user_id?: string;
  leave_type: '有給' | '特別休暇' | 'その他';
  leave_type_other?: string;
  start_date: string;
  end_date: string;
  reason?: string;
  status: 'pending' | 'leader_approved' | 'manager_approved' | 'admin_approved' | 'approved' | 'rejected';
  current_approver?: string;
  rejected_reason?: string;
  created_at?: string;
  profiles?: Profile | null;
}

export interface LeaveApproval {
  id?: string;
  leave_request_id: string;
  approver_id: string;
  approver_role: string;
  action: 'approved' | 'rejected';
  comment?: string;
  created_at?: string;
}

export interface BusinessTripReport {
  id?: string;
  user_id?: string;
  report_type: '到着' | '終了';
  category: string;
  category_other?: string;
  location: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  address?: string;
  next_dates?: string;
  created_at?: string;
  profiles?: Profile | null;
}

// Admin-specific types

export interface AdminUserProfile {
  id: string;
  email?: string;
  name?: string | null;
  is_active?: boolean;
  sort_order?: number | null;
  registered_at?: string | null;
  employment_type?: string;
  role_title?: string;
  group_names?: string[];
  leave_request_enabled?: boolean;
  leave_enabled_by?: string | null;
  submission_count?: number;
}

export interface AdminLeaveRequest {
  id: string;
  user_id: string;
  leave_type: string;
  leave_type_other?: string;
  leave_dates?: string;
  purpose?: string;
  start_date?: string;
  end_date?: string;
  reason?: string;
  status: string;
  approver_id?: string | null;
  approver2_id?: string | null;
  rejected_reason?: string | null;
  created_at: string;
  profile?: { id: string; name: string; email: string } | null;
  requester?: { id: string; name: string; email: string } | null;
  approver?: { id: string; name: string; email: string } | null;
  approver2?: { id: string; name: string; email: string } | null;
}

export interface ReportStats {
  overview: {
    totalSubmissions: number;
    pendingSubmissions: number;
    approvedSubmissions: number;
    rejectedSubmissions: number;
    approvalRate: string;
  };
  userStats: {
    name: string;
    email: string;
    totalSubmissions: number;
    approvedSubmissions: number;
    totalAmount: number;
    approvalRate: string;
  }[];
  monthlyStats: {
    month: string;
    total: number;
    approved: number;
    rejected: number;
    pending: number;
    amount: number;
  }[];
}