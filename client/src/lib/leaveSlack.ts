import { supabase } from './supabaseClient'

type LeaveSlackEvent =
  | 'new_request'
  | 'leader_approved'
  | 'manager_approved'
  | 'accounting_approved'
  | 'rejected'

export async function sendLeaveSlack(
  event: LeaveSlackEvent,
  approverName: string,
  approverRole: string,
  nextApproverName?: string,
  nextApproverRole?: string,
  targetChannel?: string
) {
  try {
    await supabase.functions.invoke('send-leave-slack', {
      body: { event, approverName, approverRole, nextApproverName, nextApproverRole, targetChannel },
    })
  } catch (e) {
    console.error('Slack通知エラー:', e)
  }
}
