// 連絡板のアンケートの読み書き（2026-10-29）。判定・文字は lib/boardSurvey.ts（supabase を読まない側）。
//
// 🚨 rpc は失敗しても throw しない（{ error } が返る）。必ず error を見る
// 🚨 回答を書くのは board_survey_answer だけ（board_confirmations への直接の書き込みは DB が断る）

import { supabase } from './supabaseClient';
import type { SurveyAnswers, SurveyDef } from './boardSurvey';

export interface MySurveyAnswer {
  answers: SurveyAnswers;
  answered_at: string;
  updated_at: string;
  edit_count: number;
  is_late: boolean;
}

export interface SurveyResultRow {
  user_id: string;
  name: string | null;
  answers: SurveyAnswers;
  answered_at?: string;
  updated_at?: string;
  edit_count?: number;
  is_late?: boolean;
}

export type SurveyResults =
  | { mode: 'full'; recipients: string[]; rows: SurveyResultRow[] }
  | { mode: 'named'; rows: SurveyResultRow[] }
  | { mode: 'count'; respondents: number; counts: Record<string, Record<string, number>> };

const msgOf = (e: { message?: string } | null | undefined) => e?.message || '不明なエラー';

/** 自分の回答（無ければ null）。読めなかったら error */
export async function loadMySurveyAnswer(messageId: string, userId: string): Promise<{ answer: MySurveyAnswer | null; error: string | null }> {
  const { data, error } = await supabase.from('board_survey_answers')
    .select('answers, answered_at, updated_at, edit_count, is_late')
    .eq('message_id', messageId).eq('user_id', userId).maybeSingle();
  if (error) return { answer: null, error: msgOf(error) };
  return { answer: (data as MySurveyAnswer | null) ?? null, error: null };
}

/** 回答を送る（初めて・直す の両方）。成功なら DB が整えた回答を返す */
export async function sendSurveyAnswer(messageId: string, answers: SurveyAnswers): Promise<{ ok: true; answer: MySurveyAnswer } | { ok: false; error: { message?: string; code?: string } }> {
  const { data, error } = await supabase.rpc('board_survey_answer', { p_message_id: messageId, p_answers: answers });
  if (error) return { ok: false, error };
  if (!data) return { ok: false, error: { message: '回答を読み戻せませんでした' } };
  return { ok: true, answer: data as MySurveyAnswer };
}

/** 回答の一覧（見られる人だけ・形は見る人と見せ方で変わる） */
export async function loadSurveyResults(messageId: string): Promise<{ results: SurveyResults | null; error: string | null }> {
  const { data, error } = await supabase.rpc('board_survey_results', { p_message_id: messageId });
  if (error) return { results: null, error: msgOf(error) };
  return { results: data as SurveyResults, error: null };
}

/** 「◯人/◯人」の分子（宛先の人にも出す数・中身は返らない） */
export async function loadConfirmCounts(ids: string[]): Promise<{ counts: Record<string, number>; error: string | null }> {
  if (ids.length === 0) return { counts: {}, error: null };
  const { data, error } = await supabase.rpc('board_confirm_counts', { p_ids: ids });
  if (error) return { counts: {}, error: msgOf(error) };
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as { message_id: string; done: number }[]) counts[r.message_id] = r.done;
  return { counts, error: null };
}

/** 送ったあとに質問を直す（回答が0件のうちだけ・DB が確かめる）。🚨 update は0件でもエラーにならないので件数を見る */
export async function updateSurveyQuestions(messageId: string, survey: SurveyDef): Promise<string | null> {
  const { data, error } = await supabase.from('board_messages').update({ survey }).eq('id', messageId).select('id');
  if (error) return msgOf(error);
  if (!data || data.length === 0) return '直せませんでした（権限がないか、お知らせが見つかりません）';
  return null;
}
