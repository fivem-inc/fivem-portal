// 管理画面に入れるか・どのタブを出すか（2026-09-15）。判定そのものは lib/adminTabs.ts の decideAdminAccess。
//
// 🚨 NavBar（「⚙️ 管理」ボタン）・AdminPage（/admin の入口）・管理画面のタブが同じものを使う
// 🚨 設定（app_settings 'manager_admin_tabs'）を読むのは「管理者でないマネージャー以上」だけ。
//    それ以外の人（約40名）には問い合わせを1本も増やさない
// 🚨 読んだ設定はモジュールで1つを共有する（useRoles と同じ形）。
//    読めなかったときは前回の値を保つ（空で上書きすると、開いている画面が急に閉じる）

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { usePolling } from './usePolling';
import { isPointerDevice } from '../lib/idleLogout';
import {
  MANAGER_ADMIN_TABS_SETTING_KEY, decideAdminAccess, normalizeManagerTabs,
  type AdminAccess, type ManagerTabKey,
} from '../lib/adminTabs';

interface TabsState { tabs: ManagerTabKey[] | null; failed: boolean }

let state: TabsState = { tabs: null, failed: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: TabsState) => void>();

function publish(next: TabsState): void {
  state = next;
  listeners.forEach(l => l(next));
}

/** 設定を読み直す（管理者が権限管理で保存したあとにも呼ぶ） */
export async function refreshManagerAdminTabs(): Promise<void> {
  if (!inflight) {
    inflight = (async () => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', MANAGER_ADMIN_TABS_SETTING_KEY)
        .maybeSingle();
      if (error) {
        // 🚨 一度読めていれば前回の値のまま。まだ一度も読めていないときだけ「読めなかった」にする
        if (state.tabs === null) publish({ tabs: null, failed: true });
        return;
      }
      // 行が無い＝まだ一度も保存していない＝全部オフ
      publish({ tabs: normalizeManagerTabs(data?.value ?? []), failed: false });
    })().finally(() => { inflight = null; });
  }
  await inflight;
}

const pollTabs = () => { void refreshManagerAdminTabs(); };
const noop = () => {};

/**
 * @param poll 30秒ごとに読み直す（管理者がタブを閉じたら、開いている画面にも効かせるため）。
 *             管理画面（AdminPage）だけ true。NavBar は読み直さない（同じ値を共有するので、管理画面の読み直しで更新される）
 */
export function useAdminAccess({ isAdmin, isManagerPlus, poll = false }: { isAdmin: boolean; isManagerPlus: boolean; poll?: boolean }): AdminAccess {
  const needsSetting = !isAdmin && isManagerPlus;
  const [tabsState, setTabsState] = useState<TabsState>(state);

  useEffect(() => {
    if (!needsSetting) return;
    listeners.add(setTabsState);
    setTabsState(state);
    if (state.tabs === null) void refreshManagerAdminTabs();
    return () => { listeners.delete(setTabsState); };
  }, [needsSetting]);

  usePolling(needsSetting && poll ? pollTabs : noop);

  const isPc = isPointerDevice();
  // 中身が同じなら作り直さない（受け取った側が useEffect の依存に入れても毎回走らないように）
  const tabsKey = tabsState.tabs ? tabsState.tabs.join(',') : null;
  const failed = tabsState.failed;
  return useMemo(() => {
    const tabs = tabsKey === null ? null : (tabsKey === '' ? [] : tabsKey.split(',') as ManagerTabKey[]);
    return decideAdminAccess({ isAdmin, isManagerPlus, isPc, tabs, loadFailed: failed });
  }, [isAdmin, isManagerPlus, isPc, tabsKey, failed]);
}
