// この人に「並べ替え」が効いているか（管理画面の nav_rollout.reorder・2026-10-17）。
// 「設定」の行を出すかどうか（pages/AccountSettings.tsx）と、行の中身（components/NavOrderSettings.tsx）が同じものを見る
import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth } from './useAuth';
import { useFeaturePublished } from './useFeaturePublished';
import { navRolloutOn } from '../lib/navItems';

export function useNavReorderOn(): boolean {
  const { user, roleTitle } = useAuth();
  const { previewRole, retiree, previewRetiree } = useContext(AuthContext);
  const fp = useFeaturePublished();
  const myRoleId = fp.roles.find(r => r.name === roleTitle)?.id ?? null;
  return !retiree && !previewRetiree && !!user && navRolloutOn(fp.navRollout.reorder, user.id, myRoleId, !!previewRole);
}
