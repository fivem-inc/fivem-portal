export interface Expense {
  type: 'regular' | 'business_trip' | 'one_time';
  from_station: string;
  to_station: string;
  amount: string;
  start_date?: string;
  end_date?: string;
  transportation?: string;
  notes?: string;
  workplace?: string;
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
    [key: string]: any;
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
  category: '出張' | '園指導' | '試合' | '下見' | 'その他';
  category_other?: string;
  location: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  created_at?: string;
  profiles?: Profile | null;
}