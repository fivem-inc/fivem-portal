// お知らせへの返信（2026-09-21）
//
// 🚨 「いま書けるか」の判定は**このファイル1か所**に置く。
//    同じ条件がデータベース側の board_reply_open() にもあり、両方が同じ3つを見ている。
//    片方だけ直すと「画面には書けると出るのに、送ると弾かれる」になる。
//    ※2か所あるのは、画面（見た目を決める）とサーバー（最終判定）の分担上どうしても避けられない。
//      条件を変えるときは必ず両方を直すこと。
//
// 🚨 日数（30日）は**このファイルが持たない**。データベースの board_reply_days() だけが持ち、
//    期限は送信したときにトリガーが入れる。画面は入った期限を読むだけ。

import { toJstDateStr } from './breakCalc';

/** お知らせの返信まわりの列。読み込みの select に必ず入れる */
export const REPLY_SELECT = 'allow_reply, reply_until, reply_closed_at';

export interface ReplyFields {
  allow_reply?: boolean | null;
  reply_until?: string | null;      // 'YYYY-MM-DD'（JST の日付）
  reply_closed_at?: string | null;  // 手で終了した日時
}

export type ReplyState =
  | 'off'      // 返信を受け付けていないお知らせ
  | 'open'     // いま書ける
  | 'ended'    // 送信者が手で終了した
  | 'expired'; // 期限が過ぎた

/** いまの状態。now は省略すると現在時刻（テストのために渡せるようにしている） */
export function replyState(m: ReplyFields, now: Date = new Date()): ReplyState {
  if (!m.allow_reply) return 'off';
  if (m.reply_closed_at) return 'ended';
  if (!m.reply_until) return 'expired';
  // 🚨 日付の比較は JST で行う。toISOString().slice(0,10) は UTC なので前日になる
  return m.reply_until >= toJstDateStr(now) ? 'open' : 'expired';
}

/** いま返信を書けるか */
export function canReplyNow(m: ReplyFields, now: Date = new Date()): boolean {
  return replyState(m, now) === 'open';
}

/** 期限まであと何日か（当日は 0）。返信を受け付けていない・終わっているときは null */
export function replyDaysLeft(m: ReplyFields, now: Date = new Date()): number | null {
  if (replyState(m, now) !== 'open' || !m.reply_until) return null;
  const [y, mo, d] = m.reply_until.split('-').map(Number);
  const [ty, tmo, td] = toJstDateStr(now).split('-').map(Number);
  const until = Date.UTC(y, mo - 1, d);
  const today = Date.UTC(ty, tmo - 1, td);
  return Math.round((until - today) / 86400000);
}

/** 「9月30日」の形。空なら '' */
export function replyDateLabel(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const [, m, d] = ymd.split('-');
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

/**
 * 画面に出す一言。🚨 受け取った人にも送信者にも**同じ文**を出す
 * （言い方が2通りあると、終わっているのかどうかが人によって違って見える）
 */
export function replyStatusText(m: ReplyFields, now: Date = new Date()): string {
  switch (replyState(m, now)) {
    case 'off':
      return '';
    case 'open': {
      const left = replyDaysLeft(m, now);
      if (left === 0) return '本日まで返信できます';
      return `あと${left}日 返信できます（${replyDateLabel(m.reply_until)}まで）`;
    }
    case 'ended':
      return 'このやり取りは終了しました';
    case 'expired':
      return `このやり取りは終了しました（${replyDateLabel(m.reply_until)}）`;
  }
}
