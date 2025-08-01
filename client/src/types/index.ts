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