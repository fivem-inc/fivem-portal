// 宛先の一括ボタン（連絡板のお知らせ・管理者からのお知らせで共用・2026-11-05 に BoardPage から移した）。
// 🚨 判定はこの1か所だけ（作成画面のボタン／送信時の記録／コピーして作成 が使う）。DB には同じ判定を書かない
//    （宛先は画面でここを使って人に展開し、DB は「在籍しているか」と権限だけ確かめる）
import { attrsFor } from './roleAttrs';
import { getCachedRoles } from '../hooks/useRoles';

export interface RecipientProfile {
  id: string;
  role_title: string | null;
  employment_type: string | null;
  group_names: string[] | null;
}

export const RECIPIENT_PRESET_KEYS = ['全員', '正社員', 'パート', 'マネージャー・リーダー', 'こども', '大人', '管理部'] as const;
export type RecipientPresetKey = typeof RECIPIENT_PRESET_KEYS[number];

export const recipientPresetIds = (key: string, profiles: RecipientProfile[]): string[] => {
  switch (key) {
    case '全員':   return profiles.map(p => p.id);
    case '正社員': return profiles.filter(p => p.employment_type === '正社員').map(p => p.id);
    case 'パート': return profiles.filter(p => p.employment_type === 'パート').map(p => p.id);
    // 🚨 役職（role_title）で判定する（2026-09-08 ユーザー確定・案③）。
    //    以前は名簿（group_names に「マネージャー・リーダー」があるか）で見ていたため、
    //    6/13 の一括登録のあとにリーダーになった人が名簿に足されず、選ばれない事故が起きた。
    //    休暇・備品の承認者判定と同じく役職を正とする。
    //    フロア責任者は**含めない**（2026-09-08 ユーザー確定）。含めるかは毎回判断が割れる件なので、
    //    変えるときは必ず聞くこと（CLAUDE.md「役職序列」）。
    //    🚨 役職名の配列では判定しない（2026-09-09 属性化）。リーダー以上（フロア責任者を含まない）のうち、
    //       経理（立場 accounting）を除く＝旧 ['リーダー','マネージャー','社長'] と同じ顔ぶれ
    //    🚨 役職の一覧（getCachedRoles）が読めていないと0人になる。呼ぶ側は0人のボタンを押せないようにする
    case 'マネージャー・リーダー': return profiles.filter(p => {
      const a = attrsFor(getCachedRoles(), p.role_title);
      return a.is_leader_plus && a.acts_as !== 'accounting';
    }).map(p => p.id);
    case 'こども': return profiles.filter(p => (p.group_names || []).includes('こども')).map(p => p.id);
    case '大人':   return profiles.filter(p => (p.group_names || []).includes('大人')).map(p => p.id);
    case '管理部': return profiles.filter(p => (p.group_names || []).includes('管理部')).map(p => p.id);
    default: return [];
  }
};

// 送信時に「押したボタン（いまも全員が宛先に残っているもの）」と「ボタン以外で足した人」に分ける。
// 🚨 押していないボタンを宛先の中身から逆算しない（人数の少ないボタンがたまたま含まれていただけで
//    「押した」扱いになり、コピー時に無関係な人が入る）。押したあとに1人でも外したボタンは無効にする
export const splitRecipientsIntoPresets = (recipientIds: string[], pressedKeys: string[], profiles: RecipientProfile[]) => {
  const sel = new Set(recipientIds);
  const presets = RECIPIENT_PRESET_KEYS.filter(k => {
    if (!pressedKeys.includes(k)) return false;
    const ids = recipientPresetIds(k, profiles);
    return ids.length > 0 && ids.every(id => sel.has(id));
  });
  const covered = new Set(presets.flatMap(k => recipientPresetIds(k, profiles)));
  const extras = recipientIds.filter(id => !covered.has(id));
  return { presets: presets as RecipientPresetKey[], extras };
};
