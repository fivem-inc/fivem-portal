// 管理画面の「使用量」の表（2026-09-27・ユーザー確定：右上の［使用量］ボタンから開く）
//
// 無料枠のあるものを1か所で見る。自動で読めるものは数字、読めないものは外の画面へのリンク。
//   ・通信量（今月の見込み・目安）… 毎晩の問い合わせ回数の記録から（関数 admin_usage_estimate）
//   ・データベース／ファイル置き場／メール … 今までの右上の表示と同じ値（AdminPanel が読んだものを受け取る）
//   ・Edge Function の呼び出し（定期処理の分の見込み）… 関数 admin_usage_overview
//   ・日ごとの問い合わせ回数（直近 14 日）… 自動更新の見直しの効きを見る
//   ・Supabase のログの量・Vercel の配信量 … 自動では読めないのでリンクだけ
// 🚨 8割の判定（赤くする）は AdminPanel と同じ式を使う。ここでは受け取った値をそのまま出すだけ

import React, { useEffect, useRef, useState } from 'react';
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
  /** 毎朝の点検のベル（?usage=1）から開いたとき */
  fromBell?: boolean;
}

const SUPABASE_USAGE_URL = 'https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi/settings/billing/usage';
const VERCEL_USAGE_URL = 'https://vercel.com/dashboard/usage';

/** 'YYYY-MM-DD' → 'M/D' */
const md = (ymd: string) => { const [, m, d] = ymd.split('-').map(Number); return `${m}/${d}`; };
const pct = (used: number | null | undefined, limit: number) =>
  used === null || used === undefined ? null : Math.round((used / limit) * 100);

// ── 点検（2026-11-03・ユーザー確定）：毎朝 9:05 に DB が同じ関数 admin_health_check で前の日を見て、確認が要ることがあれば管理者と社長のベルへ。
//    🚨 判定は DB の1か所。ここは返ってきた値を並べるだけ（黄色＝確認が要る・緑の ✓＝問題なし・赤は使わない）
interface HealthItem { at: string; message?: string; error?: string; name?: string; event_key?: string }
interface Health {
  day: string; issues: number;
  cron: { total: number; failed: number; list: HealthItem[] };
  inner: { count: number; list: HealthItem[] };
  net: { failed: number; list?: HealthItem[] };
  /** 返事待ちの時間切れ（2026-11-05）：limit 件を超えた日だけ確認が要る。古い DB の返事には無い */
  timeout?: { count: number; limit: number; list: HealthItem[] };
  push: { failed: number; users: number; stuck: number; list: HealthItem[] };
  mail: { failed: number; list: HealthItem[] };
  db: { mb: number; limit_mb: number };
}
const jstYmd = (offsetDays: number) => {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
};

// fromBell：毎朝の点検のベルから開いたとき（2026-11-05 ユーザー確定）＝点検まで画面を動かし、「このお知らせの中身」の1行を出し、黄色い行を最初から開く
const HealthSection: React.FC<{ isDarkMode: boolean; fromBell?: boolean }> = ({ isDarkMode, fromBell }) => {
  const [which, setWhich] = useState<-1 | 0>(-1);   // -1＝きのう・0＝きょう（ここまで）
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const bellOpened = useRef(false);
  useEffect(() => {
    let alive = true;
    setH(null); setErr('');
    supabase.rpc('admin_health_check', { p_day: jstYmd(which) }).then(({ data, error }: { data: Health | null; error: { message: string } | null }) => {
      if (!alive) return;
      if (error || !data) { setErr('点検の結果を読み込めませんでした'); return; }
      setH(data);
      // ベルから開いたときは1回だけ：黄色い行のうち中身のある最初の行を開き、点検まで画面を動かす
      if (fromBell && !bellOpened.current && which === -1) {
        bellOpened.current = true;
        const firstBad = ([
          ['cron', data.cron.failed > 0 && data.cron.list.length > 0],
          ['inner', data.inner.count > 0 && data.inner.list.length > 0],
          ['net', data.net.failed > 0 && (data.net.list?.length ?? 0) > 0],
          ['timeout', !!data.timeout && data.timeout.count > data.timeout.limit && data.timeout.list.length > 0],
          ['push', (data.push.failed > 0 || data.push.stuck > 0) && data.push.list.length > 0],
          ['mail', data.mail.failed > 0 && data.mail.list.length > 0],
        ] as [string, boolean][]).find(([, b]) => b);
        if (firstBad) setOpen(firstBad[0]);
        setTimeout(() => boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      }
    }, () => { if (alive) setErr('点検の結果を読み込めませんでした'); });
    return () => { alive = false; };
  }, [which, fromBell]);

  const text = isDarkMode ? '#e9ecef' : '#212529';
  const sub = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const okC = isDarkMode ? '#81c784' : '#2e7d32';
  const warnBg = isDarkMode ? '#3a2f00' : '#fff8e1';
  const warnC = isDarkMode ? '#fcd34d' : '#b45309';
  const cell: React.CSSProperties = { padding: '6px 8px', borderTop: `1px solid ${border}`, verticalAlign: 'top', fontSize: 13 };

  const line = (key: string, label: string, bad: boolean, okText: string, badText: string, list?: HealthItem[]) => (
    <React.Fragment key={key}>
      <tr style={{ background: bad ? warnBg : 'transparent', cursor: bad && list && list.length ? 'pointer' : 'default' }}
        onClick={() => { if (bad && list && list.length) setOpen(o => (o === key ? null : key)); }}>
        <td style={{ ...cell, color: bad ? warnC : text, width: '45%' }}>{label}</td>
        <td style={{ ...cell, color: bad ? warnC : okC, fontWeight: bad ? 'bold' : 'normal' }}>
          {bad ? badText : `✓ ${okText}`}{bad && list && list.length ? <div style={{ fontWeight: 'normal', color: sub, fontSize: 12 }}>{open === key ? '閉じる ▲' : '中身を見る ▼'}</div> : null}
        </td>
      </tr>
      {open === key && list && list.length > 0 && (
        <tr><td colSpan={2} style={{ ...cell, background: warnBg }}>
          {list.map((x, i) => (
            <div key={i} style={{ fontSize: 12, color: text, padding: '2px 0', wordBreak: 'break-word' }}>
              {x.at}　{x.name ?? x.event_key ?? ''}　<span style={{ color: sub }}>{x.message ?? x.error ?? ''}</span>
            </div>
          ))}
        </td></tr>
      )}
    </React.Fragment>
  );

  const tab = (v: -1 | 0, label: string) => (
    <button type="button" onClick={() => { setWhich(v); setOpen(null); }}
      style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer',
        background: which === v ? '#1976d2' : 'transparent', color: which === v ? '#fff' : sub }}>{label}</button>
  );

  return (
    <div ref={boxRef} style={{ marginBottom: 14, scrollMarginTop: 'calc(var(--topbar-height, 60px) + 12px)' }}>
      {fromBell && h && which === -1 && h.issues > 0 && (
        <div style={{ background: warnBg, color: warnC, border: `1px solid ${isDarkMode ? '#5c4a00' : '#ffe08a'}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 8 }}>
          🔔 このお知らせの中身：{md(h.day)} の点検で黄色くなっている行です
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontWeight: 'bold', color: text, fontSize: 13 }}>
          点検{h ? `（${md(h.day)}${which === 0 ? '・ここまで' : ''}）` : ''}
        </span>
        <span style={{ display: 'inline-flex', border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden' }}>
          {tab(-1, 'きのう')}{tab(0, 'きょう')}
        </span>
      </div>
      <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>毎朝 9:05 に自動で点検し、確認が要ることがあれば管理者と社長のベルに届きます（何も無い日は届きません）</div>
      {err && <div style={{ fontSize: 12, color: sub }}>{err}</div>}
      {!h && !err && <div style={{ fontSize: 12, color: sub }}>読み込んでいます…</div>}
      {h && (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <tbody>
            {line('cron', '自動の処理（cron）', h.cron.failed > 0, `${h.cron.total.toLocaleString()}回とも成功`, `失敗 ${h.cron.failed}件（${h.cron.total.toLocaleString()}回のうち）`, h.cron.list)}
            {line('inner', '毎分の処理の中の失敗', h.inner.count > 0, '0件', `${h.inner.count}件`, h.inner.list)}
            {line('net', 'サーバー呼び出しの失敗（自動の処理から）', h.net.failed > 0, '0件', `${h.net.failed}件`, h.net.list)}
            {h.timeout && (h.timeout.count > h.timeout.limit
              ? line('timeout', '返事待ちの時間切れ（処理は続いています）', true, '', `${h.timeout.count}件（1日${h.timeout.limit}件を超えました）`, h.timeout.list)
              : h.timeout.count === 0
                ? line('timeout', '返事待ちの時間切れ（処理は続いています）', false, '0件', '')
                : (
                  // 目安までの日は灰色で数だけ（確認は要らない・押すと何の処理か）
                  <React.Fragment key="timeout">
                    <tr style={{ cursor: h.timeout.list.length ? 'pointer' : 'default' }}
                      onClick={() => { if (h.timeout?.list.length) setOpen(o => (o === 'timeout' ? null : 'timeout')); }}>
                      <td style={{ ...cell, color: text, width: '45%' }}>返事待ちの時間切れ（処理は続いています）</td>
                      <td style={{ ...cell, color: sub }}>
                        {h.timeout.count}件（1日{h.timeout.limit}件までは確認不要）
                        {h.timeout.list.length ? <div style={{ fontSize: 12 }}>{open === 'timeout' ? '閉じる ▲' : '中身を見る ▼'}</div> : null}
                      </td>
                    </tr>
                    {open === 'timeout' && (
                      <tr><td colSpan={2} style={cell}>
                        {h.timeout.list.map((x, i) => (
                          <div key={i} style={{ fontSize: 12, color: text, padding: '2px 0', wordBreak: 'break-word' }}>
                            {x.at}　<span style={{ color: sub }}>{x.message ?? ''}</span>
                          </div>
                        ))}
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
            {line('push', 'スマホ通知', h.push.failed > 0 || h.push.stuck > 0, '送信失敗 0件・残っているもの 0件',
              `送信失敗 ${h.push.failed}件${h.push.users ? `（${h.push.users}人）` : ''}・送れずに残っている ${h.push.stuck}件`, h.push.list)}
            {line('mail', '連絡板のメール', h.mail.failed > 0, '送信失敗 0件', `送信失敗 ${h.mail.failed}件`, h.mail.list)}
            {line('db', 'データベースの大きさ', h.db.mb >= 400, `${h.db.mb}MB／${h.db.limit_mb}MB（${Math.round((h.db.mb / h.db.limit_mb) * 100)}%）`,
              `${h.db.mb}MB／${h.db.limit_mb}MB（上限の8割を超えています）`)}
            <tr>
              <td style={{ ...cell, color: text }}>ログの量</td>
              <td style={{ ...cell, color: sub }}>ここでは見られません（Supabase の画面だけ・週に1回確認）</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
};

const UsagePanel: React.FC<Props> = ({ isDarkMode, onClose, egress, storageMb, storageLimitMb, dbMb, dbLimitMb, mail, mailErr, egressErr, fromBell }) => {
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

      <HealthSection isDarkMode={isDarkMode} fromBell={fromBell} />

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
