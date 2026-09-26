// 連絡板「お知らせのテンプレート」の読み書き（2026-09-26）。判定・絞り込みは lib/boardTemplates.ts（supabase を読まない側）。
//
// 🚨 送信画面と管理画面の2か所がここを呼ぶ。画面に supabase.from('board_notice_templates') を直接書かないこと。
// 🚨 書き込みは error と件数を必ず見る（update / delete は0件でもエラーにならない）。
//    RLS で弾かれた insert は 0件ではなく error 42501 で返る。
// 🚨 upsert は使わない（upsert は「あれば更新」で UPDATE の権限が要る。2026-09-26 に送信トレイのアーカイブで権限事故）。
// 🚨 owner_id / updated_by / updated_at は送らない（DB のトリガーが入れる。送っても本人に直される）。

import { supabase } from './supabaseClient';
import { describeUpdate } from './statusUpdate';
import type { BoardTemplate, BoardTemplateCategory, BoardTemplateScope } from './boardTemplates';

/** 一度に読む上限。🚨 達したら truncated=true を返し、画面で断る（黙って切らない） */
export const TEMPLATE_LOAD_LIMIT = 1000;

const TPL_SEL = 'id, scope, owner_id, name, category_id, subject, body, created_at, updated_at, updated_by';

/** テンプレ（自分に見える全部）と分類（隠したものも・名前の解決に要る）をまとめて読む */
export async function loadTemplates(): Promise<{
  templates: BoardTemplate[];
  categories: BoardTemplateCategory[];
  truncated: boolean;
  error: string | null;
}> {
  const [t, c] = await Promise.all([
    supabase.from('board_notice_templates').select(TPL_SEL).order('updated_at', { ascending: false }).limit(TEMPLATE_LOAD_LIMIT),
    supabase.from('board_template_categories').select('id, name, sort_order, active').order('sort_order').order('name'),
  ]);
  const problems: string[] = [];
  if (t.error) problems.push('テンプレートを読み込めませんでした：' + t.error.message);
  if (c.error) problems.push('分類を読み込めませんでした：' + c.error.message);
  const templates = (t.data ?? []) as BoardTemplate[];
  return {
    templates,
    categories: (c.data ?? []) as BoardTemplateCategory[],
    truncated: templates.length >= TEMPLATE_LOAD_LIMIT,
    error: problems.length > 0 ? problems.join('／') : null,
  };
}

/** RLS の拒否を分かりやすく（42501＝権限がない） */
function friendly(msg: string, code?: string): string {
  if (code === '42501' || /row-level security/i.test(msg)) return '権限がありません（全体テンプレートの登録・変更は、権限管理で許された役職だけです）';
  return msg;
}

export interface TemplateInput {
  scope: BoardTemplateScope;
  name: string;
  category_id: string | null;
  subject: string;
  body: string;
}

/** 新しく登録。成功なら作った行を返す（トリガーが入れた owner_id・updated_* 込み） */
export async function insertTemplate(v: TemplateInput): Promise<{ ok: true; template: BoardTemplate } | { ok: false; message: string }> {
  const { data, error } = await supabase.from('board_notice_templates')
    .insert({ scope: v.scope, name: v.name.trim(), category_id: v.category_id, subject: v.subject.trim(), body: v.body.trim() })
    .select(TPL_SEL).single();
  if (error || !data) return { ok: false, message: '保存できませんでした：' + friendly(error?.message ?? '保存した行を読み戻せませんでした', error?.code) };
  return { ok: true, template: data as BoardTemplate };
}

/** 直す（名前・分類・件名・本文・保存先）。0件＝権限が無いか消されている */
export async function updateTemplate(id: string, v: TemplateInput): Promise<{ ok: true; template: BoardTemplate } | { ok: false; message: string }> {
  const r = await supabase.from('board_notice_templates')
    .update({ scope: v.scope, name: v.name.trim(), category_id: v.category_id, subject: v.subject.trim(), body: v.body.trim() })
    .eq('id', id).select(TPL_SEL);
  if (r.error) return { ok: false, message: '保存できませんでした：' + friendly(r.error.message, r.error.code) };
  const fail = describeUpdate({ data: (r.data ?? []) as { id: string }[], error: null, status: r.status }, '保存', 'missing');
  if (fail) return { ok: false, message: fail };
  return { ok: true, template: (r.data as BoardTemplate[])[0] };
}

/** 消す。0件＝権限が無いか、すでに消えている */
export async function deleteTemplate(id: string): Promise<string | null> {
  const r = await supabase.from('board_notice_templates').delete().eq('id', id).select('id');
  if (r.error) return '削除できませんでした：' + friendly(r.error.message, r.error.code);
  return describeUpdate({ data: (r.data ?? []) as { id: string }[], error: null, status: r.status }, '削除', 'missing');
}

// ───────── 分類（管理者だけ。RLS が締める）─────────

export async function insertCategory(name: string, sortOrder: number): Promise<{ ok: true; category: BoardTemplateCategory } | { ok: false; message: string }> {
  const { data, error } = await supabase.from('board_template_categories')
    .insert({ name: name.trim(), sort_order: sortOrder }).select('id, name, sort_order, active').single();
  if (error || !data) {
    if (error?.code === '23505') return { ok: false, message: '同じ名前の分類がすでにあります（「使わない」にしてある分類なら、戻して使ってください）' };
    return { ok: false, message: '追加できませんでした：' + friendly(error?.message ?? '', error?.code) };
  }
  return { ok: true, category: data as BoardTemplateCategory };
}

/** 分類を直す（名前・並び順・使う/使わない）。🚨 名前を変えてもテンプレ側は id で結んでいるので触らなくてよい */
export async function updateCategory(id: string, patch: Partial<Pick<BoardTemplateCategory, 'name' | 'sort_order' | 'active'>>): Promise<string | null> {
  const r = await supabase.from('board_template_categories').update(patch).eq('id', id).select('id');
  if (r.error) {
    if (r.error.code === '23505') return '同じ名前の分類がすでにあります';
    return '保存できませんでした：' + friendly(r.error.message, r.error.code);
  }
  return describeUpdate({ data: (r.data ?? []) as { id: string }[], error: null, status: r.status }, '保存', 'missing');
}

/** 分類ごとのテンプレの件数（自分に見える範囲。管理者は全体＋自分の個人だけ＝他人の個人は数えない） */
export function countByCategory(templates: BoardTemplate[]): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const t of templates) m.set(t.category_id, (m.get(t.category_id) ?? 0) + 1);
  return m;
}
