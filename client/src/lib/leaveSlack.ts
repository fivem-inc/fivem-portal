import { supabase } from './supabaseClient'

type LeaveSlackEvent =
  | 'new_request'
  | 'leader_approved'
  | 'manager_approved'
  | 'accounting_approved'
  | 'rejected'
  | 'cancelled'

// 受理済み（manager_approved / accounting_approved）のとき、Slack本文に
// 「誰の・どの休暇・いつ」を載せるための情報。受理待ちの段階では使わない
export type LeaveSlackDetail = {
  applicantName?: string
  leaveTypeName?: string
  dateSummary?: string
}

export async function sendLeaveSlack(
  event: LeaveSlackEvent,
  approverName: string,
  approverRole: string,
  nextApproverName?: string,
  nextApproverRole?: string,
  targetChannel?: string,
  detail?: LeaveSlackDetail
) {
  try {
    await supabase.functions.invoke('send-leave-slack', {
      body: { event, approverName, approverRole, nextApproverName, nextApproverRole, targetChannel, ...(detail ?? {}) },
    })
  } catch (e) {
    console.error('Slack通知エラー:', e)
  }
}
