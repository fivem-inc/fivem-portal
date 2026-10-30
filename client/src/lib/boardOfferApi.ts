// 連絡板のアンケートの「ご提案」（2026-10-30 段2-3・計画 docs/計画-連絡板のアンケート.md の「段2で決めたこと」）。
// 担当者：回答を見て［この内容でご提案する］→ ご本人：［承諾する］［内容を相談したい］→ 承諾で今の「申請の依頼」になる。
//
// 🚨 書くのは DB の関数だけ（application_request_offer_* ／ board_survey_offer_release）。表へは直接書けない
// 🚨 札の判定は DB の board_survey_offer_states の1か所。ここは label を言葉と色に変えるだけ
// 🚨 rpc は失敗しても throw しない（{ error } が返る）。必ず error を見る

import { supabase } from './supabaseClient';
import { isNetworkFailure } from './netFailure';
import type { AppRequestKind, AppRequestOtContent } from './appRequests';

export type OfferLabel =
  | 'awaiting' | 'overdue' | 'consult' | 'accepted_unapplied'
  | 'applied_pending' | 'pre_approved' | 'approved' | 'returned' | 'withdrawn';

export interface OfferState {
  recipient_id: string;
  offer_id: string;
  round: number;
  status: 'awaiting' | 'consult' | 'accepted' | 'withdrawn';
  kind: AppRequestKind;
  ot_content: AppRequestOtContent | null;
  target_dates: string[];
  memo: string | null;
  due_date: string | null;
  consult_note: string | null;
  prev: { kind?: string; ot_content?: string | null; target_dates?: string[]; consult_note?: string | null } | null;
  updated_at: string;
  label: OfferLabel;
}

/** ご本人に届いている、返事がまだのご提案（my_open_app_requests の offers） */
export interface MyOffer {
  offer_id: string;
  message_id: string;
  subject: string;
  requester_id: string;
  requester_name: string | null;
  round: number;
  kind: AppRequestKind;
  ot_content: AppRequestOtContent | null;
  target_dates: string[];
  memo: string | null;
  due_date: string | null;
  prev: OfferState['prev'];
  created_at: string;
  updated_at: string;
}

/** 札の言葉と色（「だれの番か」で5色・2026-10-30 ユーザー確定）。色は必ず文字と一緒に出す */
type Tone = 'gray' | 'yellow' | 'red' | 'blue' | 'green';
export const OFFER_LABEL: Record<OfferLabel | 'answered', { text: string; tone: Tone }> = {
  answered:           { text: '回答済み', tone: 'gray' },
  awaiting:           { text: '返事待ち', tone: 'yellow' },
  accepted_unapplied: { text: '承諾済み・申請待ち', tone: 'yellow' },
  overdue:            { text: '期限切れ', tone: 'red' },
  consult:            { text: '内容を相談したい', tone: 'red' },
  applied_pending:    { text: '受理待ち', tone: 'blue' },
  returned:           { text: '差し戻し中', tone: 'blue' },
  pre_approved:       { text: '事前申請 受理済み', tone: 'green' },
  approved:           { text: '受理済み', tone: 'green' },
  withdrawn:          { text: '取り下げ', tone: 'gray' },
};
export const toneStyle = (tone: Tone, isDark: boolean): { background: string; color: string; border: string } => {
  const light: Record<Tone, [string, string, string]> = {
    gray: ['#f1f3f5', '#495057', '#dee2e6'], yellow: ['#fff3cd', '#664d03', '#ffe08a'], red: ['#fde2e1', '#842029', '#f5c2c7'],
    blue: ['#e7f1ff', '#0b5ed7', '#b6d4fe'], green: ['#d1e7dd', '#0f5132', '#a3cfbb'],
  };
  const dark: Record<Tone, [string, string, string]> = {
    gray: ['#343a40', '#dee2e6', '#495057'], yellow: ['#4a3a1a', '#ffcf8f', '#7a5c1f'], red: ['#4a1f22', '#f1aeb5', '#842029'],
    blue: ['#1b2a3a', '#9ec5fe', '#3d5166'], green: ['#16301f', '#a3cfbb', '#2d5a3c'],
  };
  const [background, color, border] = (isDark ? dark : light)[tone];
  return { background, color, border };
};

const errText = (e: { message?: string } | null | undefined, what: string) =>
  isNetworkFailure(e) ? `${what}できませんでした。通信環境の良い場所で、もう一度お試しください。` : `${what}できませんでした：${e?.message || '不明なエラー'}`;

/** 担当者の一覧の札（送った人・写しの代表者・管理者だけ） */
export async function loadOfferStates(messageId: string): Promise<{ states: OfferState[]; error: string | null }> {
  const { data, error } = await supabase.rpc('board_survey_offer_states', { p_message_id: messageId });
  if (error) return { states: [], error: errText(error, '読み込み') };
  return { states: (data ?? []) as OfferState[], error: null };
}

/** ご提案を送る（1回目・2回目以降）。answerSeen は窓を開いたときの回答の updated_at（違えば DB が止める） */
export async function sendOffer(args: {
  messageId: string; recipientId: string; kind: AppRequestKind; otContent: AppRequestOtContent | null;
  dates: string[]; memo: string; due: string | null; answerSeen: string | null;
}): Promise<string | null> {
  const { error } = await supabase.rpc('application_request_offer_send', {
    p_message_id: args.messageId, p_recipient_id: args.recipientId, p_kind: args.kind, p_ot_content: args.kind === 'overtime' ? args.otContent : null,
    p_dates: args.dates, p_memo: args.memo || null, p_due: args.due || null, p_answer_seen: args.answerSeen,
  });
  return error ? errText(error, 'ご提案を送信') : null;
}

/** 承諾する。成功なら作った申請の依頼の ID */
export async function acceptOffer(offerId: string, round: number): Promise<{ appRequestId: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('application_request_offer_accept', { p_offer_id: offerId, p_round: round });
  if (error) return { appRequestId: null, error: errText(error, '承諾') };
  return { appRequestId: (data as { app_request_id?: string } | null)?.app_request_id ?? null, error: null };
}

/** 内容を相談したい（承諾の前）／やはり相談したい（承諾のあと・申請の前） */
export async function consultOffer(offerId: string, round: number, note: string): Promise<string | null> {
  const { error } = await supabase.rpc('application_request_offer_consult', { p_offer_id: offerId, p_round: round, p_note: note });
  return error ? errText(error, '送信') : null;
}

/** お知らせを消す前の片付け（承諾済み・申請待ちの依頼を keep=true で残す／false で取り下げる）。ご提案の無いお知らせでも呼んでよい */
export async function releaseOffers(messageId: string, keep: boolean): Promise<string | null> {
  const { error } = await supabase.rpc('board_survey_offer_release', { p_message_id: messageId, p_keep: keep });
  return error ? errText(error, '削除の準備') : null;
}
