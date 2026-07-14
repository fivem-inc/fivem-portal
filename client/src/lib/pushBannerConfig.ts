import { supabase } from './supabaseClient';

// プッシュ通知ON促進バナー（PushEnableBanner）の管理画面設定。
// app_settings（key/value形式の設定保管庫）に1レコード（jsonb）で保存する。
export const PUSH_BANNER_CONFIG_KEY = 'push_banner_config';

// 案内文が空欄のときに使う初期文（Android等、「許可する」ボタンをその場で出せる端末向け。
// iPhoneのホーム画面追加手順はバナー側の固定文で、この設定の編集対象外）
export const DEFAULT_PUSH_BANNER_MESSAGE = '大切なお知らせを見逃さないよう、特別な理由がなければ通知はONでお願いします。';
export const DEFAULT_PUSH_BANNER_REDISPLAY_DAYS = 7;
// タイトル・ボタンの初期文（各欄が空欄のときに使う。バナー側もこの値をフォールバックに使う）
export const DEFAULT_PUSH_BANNER_TITLE = '通知設定のお願い';
export const DEFAULT_PUSH_BANNER_ENABLE_LABEL = '通知をONにする';
export const DEFAULT_PUSH_BANNER_LATER_LABEL = '後で';

export interface PushBannerConfig {
  enabled: boolean;
  // 空文字 = 初期文（DEFAULT_PUSH_BANNER_TITLE）を使う
  title: string;
  // 空文字 = 初期文（DEFAULT_PUSH_BANNER_MESSAGE）を使う
  message: string;
  // 空文字 = 初期文（DEFAULT_PUSH_BANNER_ENABLE_LABEL）を使う。「通知をONにする」ボタンの文言
  enableLabel: string;
  // 空文字 = 初期文（DEFAULT_PUSH_BANNER_LATER_LABEL）を使う。「後で」ボタンの文言
  laterLabel: string;
  // 「後で」を押した人に再表示するまでの日数
  redisplayDays: number;
}

export const DEFAULT_PUSH_BANNER_CONFIG: PushBannerConfig = {
  enabled: true,
  title: '',
  message: '',
  enableLabel: '',
  laterLabel: '',
  redisplayDays: DEFAULT_PUSH_BANNER_REDISPLAY_DAYS,
};

// jsonbの型崩れ（手動編集・旧形式）に耐える形で読み込む。未設定・取得失敗時は初期値
export const fetchPushBannerConfig = async (): Promise<PushBannerConfig> => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', PUSH_BANNER_CONFIG_KEY)
    .maybeSingle();
  if (error || !data?.value || typeof data.value !== 'object') return DEFAULT_PUSH_BANNER_CONFIG;
  const v = data.value as Partial<PushBannerConfig>;
  const days = Number(v.redisplayDays);
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
    title: typeof v.title === 'string' ? v.title : '',
    message: typeof v.message === 'string' ? v.message : '',
    enableLabel: typeof v.enableLabel === 'string' ? v.enableLabel : '',
    laterLabel: typeof v.laterLabel === 'string' ? v.laterLabel : '',
    redisplayDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_PUSH_BANNER_REDISPLAY_DAYS,
  };
};
