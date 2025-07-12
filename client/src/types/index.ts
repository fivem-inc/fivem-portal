export interface Expense {
  type: 'regular' | 'business_trip' | 'one_time';
  from_station: string;
  to_station: string;
  amount: string;
  start_date?: string;
  end_date?: string;
  transportation?: string;
  notes?: string;
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
  user_id?: string;
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
}

export interface AuthContextType {
  user: AuthUser | null;
}