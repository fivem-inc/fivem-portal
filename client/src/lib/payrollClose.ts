// 給与の締め日のお知らせ（2026-10-14 ユーザー確定・計画は docs/計画-締め日のお知らせ.md）
// 🚨 どの行を誰に出すか・文の組み立ては DB の payroll_close_compose / payroll_close_lines の1本だけ。
//    画面は返ってきた行を並べるだけ（ここで判定を書き直さない）

export type PayrollCloseLineKey =
  | 'intro' | 'overtime' | 'ot_pending' | 'shift' | 'sr_pending' | 'expense' | 'commuter' | 'outro';

export interface PayrollCloseLine { key: PayrollCloseLineKey; text: string; count: number | null }

export interface PayrollCloseNotice {
  close_date: string;
  title: string;
  dismissed: boolean;
  lines: PayrollCloseLine[];
}

/** 設定（app_settings key='payroll_close_notice'） */
export interface PayrollCloseSettings {
  enabled: boolean;
  start_close_date: string;
  bell: boolean;
  push: boolean;
  banner: boolean;
  lines: Record<PayrollCloseLineKey, string>;
}

export const PAYROLL_CLOSE_SETTINGS_KEY = 'payroll_close_notice';

/** 管理画面の欄の並び・名前・届く相手（DB の並びと同じ） */
export const PAYROLL_CLOSE_LINE_DEFS: { key: PayrollCloseLineKey; label: string; who: string }[] = [
  { key: 'intro',      label: 'はじめ',   who: '届く全員' },
  { key: 'overtime',   label: '残業',     who: '残業がONの人' },
  { key: 'ot_pending', label: '受理まち', who: '受理がまだの残業申請がある人' },
  { key: 'shift',      label: '勤務変更', who: '勤務変更がONのパート' },
  { key: 'sr_pending', label: '確認まち', who: '確認がまだの勤務変更がある人' },
  { key: 'expense',    label: '交通費',   who: '交通費がONの人' },
  { key: 'commuter',   label: '定期券',   who: '交通費がONの正社員' },
  { key: 'outro',      label: 'おわり',   who: '届く全員' },
];

/** 太字にする行（上長がほかの人のために動く行） */
export const PAYROLL_CLOSE_BOLD: ReadonlySet<PayrollCloseLineKey> = new Set(['ot_pending', 'sr_pending']);

/** ホームの交通費の画面の先頭に付ける目印（バナーの［↓ 交通費の申請へ］がここへ動く） */
export const EXPENSE_FORM_ANCHOR_ID = 'expense-form';
