// 役職の一覧（属性つき）を1回だけ読んで、全画面で共有するフック。
//
// 【なぜ要るか（2026-09-09）】
// 役職名を直書きしていた判定を roles の属性に置き換えた。属性は各画面が
// 「役職名 → attrsFor(roles, 名前)」で引くので、roles の配列がどこでも要る。
// 画面ごとに fetch すると同じ7行を何十回も読むことになるため、
// モジュール内で1回だけ取得し、端末にも保存して次回起動時は即使う。
//
// 🚨 取得に失敗したときは前回の一覧を保持する（空で上書きすると全員の属性が false になり、
//    承認者のナビが消える。useAuth の権限キャッシュと同じ考え方）。
// 🚨 権限キャッシュ（fivem_auth_cache_）とは別キー。AUTH_CACHE_VERSION は上げない
//    （上げると46人全員の初回描画でナビが減る・2026-07-13 の症状）。

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { ROLE_COLUMNS } from '../lib/roleAttrs';
import type { RoleRow } from '../lib/roleAttrs';

const ROLES_CACHE_KEY = 'fivem_roles_cache';
const ROLES_CACHE_VERSION = 1;

function readRolesCache(): RoleRow[] {
  try {
    const raw = localStorage.getItem(ROLES_CACHE_KEY);
    if (!raw) return [];
    const c = JSON.parse(raw) as { v: number; roles: RoleRow[] };
    return c.v === ROLES_CACHE_VERSION && Array.isArray(c.roles) ? c.roles : [];
  } catch { return []; }
}
function writeRolesCache(roles: RoleRow[]): void {
  try { localStorage.setItem(ROLES_CACHE_KEY, JSON.stringify({ v: ROLES_CACHE_VERSION, roles })); } catch { /* 容量超過等は無視 */ }
}

let cached: RoleRow[] = readRolesCache();
let inflight: Promise<RoleRow[] | null> | null = null;
const listeners = new Set<(r: RoleRow[]) => void>();

async function fetchRoles(): Promise<RoleRow[] | null> {
  const { data, error } = await supabase.from('roles').select(ROLE_COLUMNS).order('sort_order');
  if (error || !data) return null;
  return data as unknown as RoleRow[];
}

/** 一覧を取り直す（管理画面で役職を追加・改名・属性を変えたあとに呼ぶ）。失敗時は前回を保持 */
export async function refreshRoles(): Promise<RoleRow[]> {
  if (!inflight) {
    inflight = fetchRoles().then(r => {
      if (r) { cached = r; writeRolesCache(r); listeners.forEach(l => l(r)); }
      return r;
    }).finally(() => { inflight = null; });
  }
  await inflight;
  return cached;
}

/** いま手元にある一覧（購読なし）。React の外（lib）から読むときだけ使う */
export function getCachedRoles(): RoleRow[] { return cached; }

/** 役職の一覧（sort_order 順）。初回はキャッシュを返し、裏で取り直して更新する */
export function useRoles(): RoleRow[] {
  const [roles, setRoles] = useState<RoleRow[]>(cached);
  useEffect(() => {
    listeners.add(setRoles);
    if (cached.length === 0 || !inflight) void refreshRoles();
    return () => { listeners.delete(setRoles); };
  }, []);
  return roles;
}
