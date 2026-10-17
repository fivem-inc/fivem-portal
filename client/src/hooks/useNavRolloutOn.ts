// この人に、上のナビの「試してから広げる」切り替えが効いているか（管理画面の nav_rollout・2026-10-17）。
// reorder＝並べ替え／two_row＝スマホの2段／split_home＝ホームと交通費を分ける。
// 🚨 役職プレビュー中は役職だけで判定・退職者には効かせない（lib/navItems の navRolloutOn と同じ）
import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth } from './useAuth';
import { useFeaturePublished } from './useFeaturePublished';
import { navRolloutOn, type NavRollout } from '../lib/navItems';

export function useNavRolloutOn(kind: keyof NavRollout): boolean {
  const { user, roleTitle } = useAuth();
  const { previewRole, retiree, previewRetiree } = useContext(AuthContext);
  const fp = useFeaturePublished();
  const myRoleId = fp.roles.find(r => r.name === roleTitle)?.id ?? null;
  return !retiree && !previewRetiree && !!user && navRolloutOn(fp.navRollout[kind], user.id, myRoleId, !!previewRole);
}
