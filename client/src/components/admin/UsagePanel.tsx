// 管理画面の「使用量」の表（2026-09-27・ユーザー確定：右上の［使用量］ボタンから開く）
//
// 無料枠のあるものを1か所で見る。自動で読めるものは数字、読めないものは外の画面へのリンク。
//   ・通信量（今月の見込み・目安）… 毎晩の問い合わせ回数の記録から（関数 admin_usage_estimate）
//   ・データベース／ファイル置き場／メール … 今までの右上の表示と同じ値（AdminPanel が読んだものを受け取る）
//   ・Edge Function の呼び出し（定期処理の分の見込み）… 関数 admin_usage_overview
//   ・日ごとの問い合わせ回数（直近 14 日）… 自動更新の見直しの効きを見る
//   ・Supabase のログの量・Vercel の配信量 … 自動では読めないのでリンクだけ
// 🚨 8割の判定（赤くする）は AdminPanel と同じ式を使う。ここでは受け取った値をそのまま出すだけ

import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

export interface EgressEstimate {
  status: 'ok' | 'collecting';
  cycle_start: string;
  cycle_end: string;
  limit_gb: number;
  projected_gb?: number;
  so_far_gb?: number;
  elapsed_days?: number;
}
export interface MailUsageLite {
  daily: { used: number; limit: number };
  monthly: { used: number; limit: number };
}
interface Overview {
  ef_cron_runs_24h: number;
  ef_projected_cycle: number;
  ef_limit: number;
  daily: { day: string; requests: number | null }[];
}

interface Props {
  isDarkMode: boolean;
  onClose: () => void;
  egress: EgressEstimate | null;
  storageMb: number | null;
  storageLimitMb: number;
  dbMb: number | null;
  dbLimitMb: number;
  mail: MailUsageLite | null;
  /** 取れなかったとき（🚨 0 と嘘をつかず「取れませんでした」と出す） */
  mailErr?: string;
  egressErr?: string;
}

const SUPABASE_USAGE_URL = 'https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi/settings/billing/usage';
const VERCEL_USAGE_URL = 'https://vercel.com/dashboard/usage';

/** 'YYYY-MM-DD' → 'M/D' */
const md = (ymd: string) => { const [, m, d] = ymd.split('-').map(Number); return `${m}/${d}`; };
const pct = (used: number | null | undefined, limit: number) =>
  used === null || used === undefined ? null : Math.round((used / limit) * 100);

const UsagePanel: React.FC<Props> = ({ isDarkMode, onClose, egress, storageMb, storageLimitMb, dbMb, dbLimitMb, mail, mailErr, egressErr }) => {
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState('');
  useEffect(() => {
    let alive = true;
    supabase.rpc('admin_usage_overview').then(({ data, error }: { data: Overview | null; error: { message: string } | null }) => {
      if (!alive) return;
      if (error || !data) { setOvErr('取れませんでした'); return; }
      setOv(data);
    }, () => { if (alive) setOvErr('取れませんでした'); });
    return () => { alive = false; };
  }, []);

  const text = isDarkMode ? '#e9ecef' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const headBg = isDarkMode ? '#343a40' : '#f3f4f6';
  const link = isDarkMode ? '#90b4e8' : '#1d4ed8';
  const cell: React.CSSProperties = { padding: '6px 8px', borderTop: `1px solid ${border}`, verticalAlign: 'top' };
  const num: React.CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };

  const row = (label: React.ReactNode, now: React.ReactNode, limit: React.ReactNode, ratio: number | null, how: React.ReactNode) => {
    const red = ratio !== null && ratio >= 80;
    return (
      <tr style={{ color: red ? '#dc3545' : text, fontWeight: red ? 'bold' : 'normal' }}>
        <td style={cell}>{red && '⚠️ '}{label}</td>
        <td style={num}>{now}</td>
        <td style={num}>{limit}</td>
        <td style={num}>{ratio === null ? '―' : `${ratio}%`}</td>
        <td style={{ ...cell, color: sub, fontWeight: 'normal', fontSize: 12 }}>{how}</td>
      </tr>
    );
  };
  const extLink = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: link }}>{label}</a>
  );

  const egressNow = egress?.status === 'ok' ? `約 ${egress.projected_gb} GB` : egress?.status === 'collecting' ? '計測中' : (egressErr || '―');
  const egressRatio = egress?.status === 'ok' ? pct(egress.projected_gb, egress.limit_gb) : null;

  return (
    <div style={{ margin: '0 0 20px', border: `1px solid ${border}`, borderRadius: 10, padding: 12, textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <span style={{ fontWeight: 'bold', color: text }}>使用量（無料枠）</span>
        <button type="button" onClick={onClose}
          style={{ padding: '3px 10px', borderRadius: 14, border: `1px solid ${border}`, background: 'transparent', color: sub, cursor: 'pointer', fontSize: 12 }}>
          ✕ 閉じる
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: headBg, color: text }}>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>項目</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>いま</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>無料枠</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>割合</th>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>見方</th>
            </tr>
          </thead>
          <tbody>
            {row('通信量（今月の見込み・目安）', egressNow, '5 GB/月', egressRatio,
              <>{egress?.status === 'ok'
                  ? `これまで 約 ${egress.so_far_gb} GB（${egress.elapsed_days}日分）。区切りは ${md(egress.cycle_start)}〜${md(egress.cycle_end)}。`
                  : egress?.status === 'collecting' ? `${md(egress.cycle_end)} から見込みを出します。` : ''}
                 毎晩の問い合わせ回数から出した目安。正確な値は {extLink(SUPABASE_USAGE_URL, 'Supabase の Usage')}</>)}
            {row('データベース', dbMb === null ? '―' : `${dbMb} MB`, `${dbLimitMb} MB`, pct(dbMb, dbLimitMb), '超えると読み取り専用になり、申請が保存できなくなる')}
            {row('ファイル置き場', storageMb === null ? '―' : `${storageMb} MB`, `${storageLimitMb} MB`, pct(storageMb, storageLimitMb), '領収書・見積もりの画像など')}
            {row('メール（今月）', mail ? `${mail.monthly.used} 通` : (mailErr || '―'), mail ? `${mail.monthly.limit} 通` : '―', mail ? pct(mail.monthly.used, mail.monthly.limit) : null, 'Resend。1日の上限もある')}
            {row('メール（今日）', mail ? `${mail.daily.used} 通` : '―', mail ? `${mail.daily.limit} 通` : '―', mail ? pct(mail.daily.used, mail.daily.limit) : null, '')}
            {row('Edge Function の呼び出し（今月の見込み・定期処理の分）',
              ov ? `約 ${ov.ef_projected_cycle.toLocaleString()} 回` : (ovErr || '―'), ov ? `${ov.ef_limit.toLocaleString()} 回/月` : '50万 回/月',
              ov ? pct(ov.ef_projected_cycle, ov.ef_limit) : null,
              ov ? `直近24時間の定期処理 ${ov.ef_cron_runs_24h.toLocaleString()} 回から。画面から呼ぶ分は含まない` : '')}
            {row('ログの量（Supabase）', '―', 'まだ枠なし', null, <>自動では読めない。{extLink(SUPABASE_USAGE_URL, 'Supabase の Usage')} の Log Ingestion</>)}
            {row('画面の配信量（Vercel）', '―', '100 GB/月', null, <>自動では読めない。{extLink(VERCEL_USAGE_URL, 'Vercel の Usage')}</>)}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, fontWeight: 'bold', color: text, fontSize: 13 }}>日ごとの問い合わせ回数（直近14日）</div>
      <div style={{ fontSize: 12, color: sub, margin: '2px 0 6px' }}>
        画面からデータベースへの問い合わせの回数。2026-09-27 に30秒ごとの数え直しをやめた（それまで1日約5.9万回）。毎晩 23:59 に記録
      </div>
      {ovErr && <div style={{ fontSize: 12, color: sub }}>{ovErr}</div>}
      {ov && ov.daily.length === 0 && <div style={{ fontSize: 12, color: sub }}>まだ記録がありません（毎晩たまっていきます）</div>}
      {ov && ov.daily.length > 0 && (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, color: text }}>
          <tbody>
            {ov.daily.map(d => (
              <tr key={d.day}>
                <td style={{ padding: '3px 12px 3px 0' }}>{md(d.day)}</td>
                <td style={{ padding: '3px 0', textAlign: 'right' }}>{d.requests === null ? '（前の日の記録なし）' : `${d.requests.toLocaleString()} 回`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default UsagePanel;
