// 連絡板のアンケート（2026-10-29・計画 docs/計画-連絡板のアンケート.md）。判定・文字の部品だけ（supabase を読まない側）。
//
// 🚨 質問の形・上限・回答の確かめは DB の board_survey_normalize／board_survey_answer と同じ決まり。片方だけ直さない
//    （画面は先に止めて分かりやすく出すため・最後の守りは DB）。
// 🚨 回答の値の形：single＝{choice:'<選択肢の id>'|'__other__', other?}／multi＝{choices:[...], other?}／text＝{text}／date＝{dates:['YYYY-MM-DD',...]}

export type SurveyKind = 'single' | 'multi' | 'text' | 'date';
export type SurveyVisibility = 'sender' | 'respondents_count' | 'respondents_named';

export interface SurveyOption { id: string; label: string }
export interface SurveyQuestion {
  id: string;
  kind: SurveyKind;
  label: string;
  help?: string;
  required?: boolean;
  options?: SurveyOption[];
  allow_other?: boolean;
  date_from?: string;
  date_to?: string;
}
export interface SurveyDef { v: 1; questions: SurveyQuestion[] }

export interface SurveyAnswerValue {
  choice?: string;
  choices?: string[];
  other?: string;
  text?: string;
  dates?: string[];
}
export type SurveyAnswers = Record<string, SurveyAnswerValue>;

export const OTHER_ID = '__other__';

// 上限（DB と同じ）
export const SURVEY_LIMITS = {
  questions: 30, label: 200, help: 500, options: 30, optionLabel: 100, other: 200, text: 1000, dates: 31,
} as const;

export const SURVEY_KIND_LABEL: Record<SurveyKind, string> = {
  single: '1つ選ぶ',
  multi: 'いくつでも選ぶ',
  text: '文字で書く',
  date: '日付を選ぶ',
};

export const SURVEY_VISIBILITY_LABEL: Record<SurveyVisibility, string> = {
  sender: '送った人と写しの人だけ',
  respondents_count: '回答した人どうし（数だけ）',
  respondents_named: '回答した人どうし（名前つき）',
};

/** 画面の中だけで使う仮の id（送ると DB が正式な id を振る・形が合えばそのまま使う） */
export const newLocalId = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`)
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 32);

export function emptyQuestion(kind: SurveyKind = 'single'): SurveyQuestion {
  const q: SurveyQuestion = { id: newLocalId(), kind, label: '', required: kind === 'single' };
  if (kind === 'single' || kind === 'multi') q.options = [{ id: newLocalId(), label: '' }, { id: newLocalId(), label: '' }];
  return q;
}

/** 答え方を変えたとき、要らないものを外し、要るものを足す */
export function changeKind(q: SurveyQuestion, kind: SurveyKind): SurveyQuestion {
  const next: SurveyQuestion = { id: q.id, kind, label: q.label, help: q.help, required: q.required };
  if (kind === 'single' || kind === 'multi') {
    next.options = q.options && q.options.length >= 2 ? q.options : [{ id: newLocalId(), label: '' }, { id: newLocalId(), label: '' }];
    next.allow_other = q.allow_other;
  }
  if (kind === 'date') { next.date_from = q.date_from; next.date_to = q.date_to; }
  return next;
}

/** 作る画面の確かめ。問題があれば「何問目の何か」を返す（DB の board_survey_normalize と同じ決まり） */
export function surveyDraftProblem(def: SurveyDef | null): { index: number; message: string } | null {
  if (!def || def.questions.length === 0) return { index: -1, message: '質問を1つ以上作ってください' };
  if (def.questions.length > SURVEY_LIMITS.questions) return { index: -1, message: `質問は${SURVEY_LIMITS.questions}個までです` };
  for (let i = 0; i < def.questions.length; i++) {
    const q = def.questions[i];
    const n = i + 1;
    const label = q.label.trim();
    if (!label) return { index: i, message: `${n}問目の質問の文を入れてください` };
    if (label.length > SURVEY_LIMITS.label) return { index: i, message: `${n}問目の質問の文は${SURVEY_LIMITS.label}字までです` };
    if ((q.help ?? '').trim().length > SURVEY_LIMITS.help) return { index: i, message: `${n}問目の説明は${SURVEY_LIMITS.help}字までです` };
    if (q.kind === 'single' || q.kind === 'multi') {
      const opts = q.options ?? [];
      if (opts.length < 2) return { index: i, message: `${n}問目の選択肢を2つ以上作ってください` };
      if (opts.length > SURVEY_LIMITS.options) return { index: i, message: `${n}問目の選択肢は${SURVEY_LIMITS.options}個までです` };
      if (opts.some(o => !o.label.trim())) return { index: i, message: `${n}問目に空の選択肢があります` };
      if (opts.some(o => o.label.trim().length > SURVEY_LIMITS.optionLabel)) return { index: i, message: `${n}問目の選択肢は${SURVEY_LIMITS.optionLabel}字までです` };
    }
    if (q.kind === 'date' && q.date_from && q.date_to && q.date_from > q.date_to) {
      return { index: i, message: `${n}問目の日付の範囲が逆です` };
    }
  }
  return null;
}

/** 送る形にそろえる（空白を落とす・要らない項目を外す） */
export function cleanSurvey(def: SurveyDef): SurveyDef {
  return {
    v: 1,
    questions: def.questions.map(q => {
      const out: SurveyQuestion = { id: q.id, kind: q.kind, label: q.label.trim(), required: !!q.required };
      const help = (q.help ?? '').trim();
      if (help) out.help = help;
      if (q.kind === 'single' || q.kind === 'multi') {
        out.options = (q.options ?? []).map(o => ({ id: o.id, label: o.label.trim() }));
        if (q.allow_other) out.allow_other = true;
      }
      if (q.kind === 'date') {
        if (q.date_from) out.date_from = q.date_from;
        if (q.date_to) out.date_to = q.date_to;
      }
      return out;
    }),
  };
}

/** DB から読んだ survey を型に合わせる（形が違えば null＝ふつうの「回答」として扱う） */
export function parseSurvey(raw: unknown): SurveyDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const qs = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  return { v: 1, questions: qs as SurveyQuestion[] };
}

/** 写し・テンプレートから使うとき：id を新しくする（同じ id を使い回さない） */
export function cloneSurveyFresh(def: SurveyDef): SurveyDef {
  return {
    v: 1,
    questions: def.questions.map(q => ({
      ...q,
      id: newLocalId(),
      options: q.options?.map(o => ({ id: newLocalId(), label: o.label })),
    })),
  };
}

const isEmptyAnswer = (q: SurveyQuestion, v: SurveyAnswerValue | undefined): boolean => {
  if (!v) return true;
  if (q.kind === 'single') return !v.choice;
  if (q.kind === 'multi') return !v.choices || v.choices.length === 0;
  if (q.kind === 'text') return !(v.text ?? '').trim();
  return !v.dates || v.dates.length === 0;
};

/** 回答の確かめ（DB の board_survey_answer と同じ決まり）。最初に見つけた問題の質問の番号と文 */
export function answerProblem(def: SurveyDef, answers: SurveyAnswers): { index: number; message: string } | null {
  for (let i = 0; i < def.questions.length; i++) {
    const q = def.questions[i];
    const n = i + 1;
    const v = answers[q.id];
    if (isEmptyAnswer(q, v)) {
      if (q.required) return { index: i, message: `${n}問目は必須です` };
      continue;
    }
    const usesOther = q.kind === 'single' ? v?.choice === OTHER_ID : q.kind === 'multi' ? !!v?.choices?.includes(OTHER_ID) : false;
    if (usesOther) {
      const o = (v?.other ?? '').trim();
      if (!o) return { index: i, message: `${n}問目の「その他」の内容を書いてください` };
      if (o.length > SURVEY_LIMITS.other) return { index: i, message: `${n}問目の「その他」は${SURVEY_LIMITS.other}字までです` };
    }
    if (q.kind === 'text' && (v?.text ?? '').trim().length > SURVEY_LIMITS.text) return { index: i, message: `${n}問目は${SURVEY_LIMITS.text}字までです` };
    if (q.kind === 'date') {
      const ds = v?.dates ?? [];
      if (ds.length > SURVEY_LIMITS.dates) return { index: i, message: `${n}問目の日付は${SURVEY_LIMITS.dates}日までです` };
      if (ds.some(d => (q.date_from && d < q.date_from) || (q.date_to && d > q.date_to))) return { index: i, message: `${n}問目の日付が選べる範囲の外です` };
    }
  }
  return null;
}

/** 送る形（空の回答は送らない・空白を落とす） */
export function cleanAnswers(def: SurveyDef, answers: SurveyAnswers): SurveyAnswers {
  const out: SurveyAnswers = {};
  for (const q of def.questions) {
    const v = answers[q.id];
    if (isEmptyAnswer(q, v) || !v) continue;
    if (q.kind === 'single') out[q.id] = v.choice === OTHER_ID ? { choice: OTHER_ID, other: (v.other ?? '').trim() } : { choice: v.choice };
    else if (q.kind === 'multi') {
      const cs = [...new Set(v.choices ?? [])];
      out[q.id] = cs.includes(OTHER_ID) ? { choices: cs, other: (v.other ?? '').trim() } : { choices: cs };
    } else if (q.kind === 'text') out[q.id] = { text: (v.text ?? '').trim() };
    else out[q.id] = { dates: [...new Set(v.dates ?? [])].sort() };
  }
  return out;
}

/** 答えた数（進み具合「3/8問」） */
export const answeredCount = (def: SurveyDef, answers: SurveyAnswers): number =>
  def.questions.filter(q => !isEmptyAnswer(q, answers[q.id])).length;

const mdDow = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${dow}）`;
};
export const surveyDateLabel = mdDow;

/** 1つの質問の回答を文字に（一覧・Excel で使う1か所） */
export function answerText(q: SurveyQuestion, v: SurveyAnswerValue | undefined): string {
  if (!v) return '';
  const optLabel = (id: string) => (id === OTHER_ID ? `その他：${(v.other ?? '').trim()}` : q.options?.find(o => o.id === id)?.label ?? '（消えた選択肢）');
  if (q.kind === 'single') return v.choice ? optLabel(v.choice) : '';
  if (q.kind === 'multi') return (v.choices ?? []).map(optLabel).join('、');
  if (q.kind === 'text') return (v.text ?? '').trim();
  return (v.dates ?? []).map(mdDow).join('、');
}

/** 一覧の札「📋 アンケート（8問）」 */
export const surveyBadgeText = (def: SurveyDef): string => `📋 アンケート（${def.questions.length}問）`;

/** Excel・CSV で数式として読まれないように（= + - @ とタブ・改行で始まる値の頭に '） */
export const sheetSafe = (s: string): string => (/^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s);

/** 選択肢・日付の数（まとめ）。count の結果（board_survey_results の count）と同じ形を、全員の回答から作る */
export function tallyAnswers(def: SurveyDef, rows: { answers: SurveyAnswers }[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const q of def.questions) {
    const t: Record<string, number> = {};
    for (const r of rows) {
      const v = r.answers?.[q.id];
      if (!v) continue;
      const keys = q.kind === 'single' ? (v.choice ? [v.choice] : [])
        : q.kind === 'multi' ? (v.choices ?? [])
        : q.kind === 'date' ? (v.dates ?? []) : [];
      for (const k of keys) t[k] = (t[k] ?? 0) + 1;
    }
    out[q.id] = t;
  }
  return out;
}

/** 期限を過ぎているか（JST の今日と比べる・期限の日は当日いっぱい OK） */
export const isPastDeadline = (deadline: string | null | undefined, todayJst: string): boolean =>
  !!deadline && todayJst > deadline;
