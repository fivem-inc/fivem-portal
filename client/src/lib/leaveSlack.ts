import { supabase } from './supabaseClient'

type LeaveSlackEvent =
  | 'new_request'
  | 'leader_approved'
  | 'manager_approved'
  | 'accounting_approved'
  | 'rejected'
  | 'cancelled'

// Slack へ追加で渡すもの。用が2つあるので分けて書く。
export type LeaveSlackExtra = {
  // ① 本文に載せる情報。受理済み（manager_approved / accounting_approved）と取消のときだけ使う
  applicantName?: string
  leaveTypeName?: string
  dateSummary?: string
  // ② 宛先（チャンネル）を決めるための**立場のコード**（'leader' / 'manager' / 'accounting' / 'president'）。
  //    🚨 approverRole は**画面に出す役職名**なので、宛先の判定に使わせない。
  //       名前で渡すと Edge Function 側が roles を名前で引き当てることになり、
  //       引き当てに失敗したとき**黙ってリーダーのチャンネルへ落ちる**（＝誰も気づけない誤配）。
  //    🚨 いま宛先が変わるのは new_request だけ（マネージャー宛か、リーダー宛か）。
  //       他のイベントは飛び先が固定なので渡さなくてよい。
  approverActsAs?: string
}

export async function sendLeaveSlack(
  event: LeaveSlackEvent,
  approverName: string,
  approverRole: string,
  nextApproverName?: string,
  nextApproverRole?: string,
  targetChannel?: string,
  extra?: LeaveSlackExtra
) {
  try {
    await supabase.functions.invoke('send-leave-slack', {
      body: { event, approverName, approverRole, nextApproverName, nextApproverRole, targetChannel, ...(extra ?? {}) },
    })
  } catch (e) {
    console.error('Slack通知エラー:', e)
  }
}
