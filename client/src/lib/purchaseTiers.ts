// 備品購入申請の金額帯（承認ルートを決める唯一の基準）。
//
// 金額は「誰が承認するか」「相見積もりが必須か」「自己判断できるか」を同時に決めるため、
// このしきい値は申請フォームと管理画面の修正モーダルで必ず同じ値を使わなければならない。
// 片方だけ変えると、申請できたのに保存できない・承認ルートがずれる、といった事故になるので
// 定義はこのファイル1か所に集約する（DB側の purchase_requests_type_status_check と対応）。

export const LEADER_LIMIT = 10000;
export const MANAGER_LIMIT = 30000;
export const QUOTES_REQUIRED_THRESHOLD = 10000;

/** 金額が未入力・不正なときは 'none' */
export type Tier = 'none' | 'leader' | 'manager' | 'board';

export const tierOf = (amount: number): Tier => {
  if (isNaN(amount)) return 'none';
  if (amount <= LEADER_LIMIT) return 'leader';
  if (amount <= MANAGER_LIMIT) return 'manager';
  return 'board';
};

export const TIER_LABEL: Record<Tier, string> = {
  none: '',
  leader: '1万円以下',
  manager: '1万円超〜3万円',
  board: '3万円超',
};

/** 承認ルートの説明（金額帯をまたぐ修正を止めるときの案内文などで使う） */
export const TIER_ROUTE_LABEL: Record<Tier, string> = {
  none: '',
  leader: 'リーダー承認',
  manager: 'マネージャー承認',
  board: '全員承認',
};
