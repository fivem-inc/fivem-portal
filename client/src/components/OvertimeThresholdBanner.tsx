import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

// 残業がしきい値を超えたときのホームバナー。
//
// ・本人向け … 自分の残業が目安を超えたとき。「調整の予定を入れる」「後で再通知」「✕」
// ・上長向け … 自分より下の役職・同じ部門の超過者を部門ごとに1枚にまとめる
//               （1人ずつ出すと埋もれるため。誰が対応したかは部門集計の提案履歴で分かる）
//
// 出るタイミングは通知と同じ「超えたとき／毎月の指定日」の3回だけ。
// 出すかどうかの判定（役職・部門・閉じた状態）はすべて DB の
// overtime_threshold_banner に寄せている。クライアントで絞ると
// 判定が2か所に分かれて食い違うため。
//
// 色はライト・ダーク共通の固定色（CLAUDE.md のバナー配色ルール）。
// ホームで他に使っていないオレンジにして、連絡板の未読バナー（水色）と見分ける。
const BG = '#fff4e6';
const BORDER = '#fb923c';
const TEXT = '#9a3412';
const SUB = '#c2410c';
const LINE = '#fdba74';
const UP = '#b91c1c';

interface SelfInfo { total: number; confirmed: number; threshold: number }
interface MemberInfo {
  user_id: string; name: string | null; team: string | null;
  total: number; prev: number | null; is_new: boolean;
}
interface BannerData { self: SelfInfo | null; members: MemberInfo[]; last_sent: string | null }

/** 分 → ＋6:30 / −0:30 */
const fmtSigned = (min: number) => {
  const sign = min < 0 ? '−' : '＋';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};
/** 給与期間（16日〜翌15日）の開始日。JSTの端末で動く前提は既存の実装と同じ */
const periodStartOf = (d: Date) => {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (day >= 16) return `${y}-${String(m).padStart(2, '0')}-16`;
  return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-16`;
};

const OvertimeThresholdBanner: React.FC<{
  userId: string; isAdmin: boolean; canOvertime: boolean;
}> = ({ userId, isAdmin, canOvertime }) => {
  const navigate = useNavigate();
  const [data, setData] = useState<BannerData | null>(null);
  const [periodStart, setPeriodStart] = useState('');

  const load = useCallback(async () => {
    const ps = periodStartOf(new Date());
    setPeriodStart(ps);
    const { data: res, error } = await supabase.rpc('overtime_threshold_banner', { p_period: ps });
    // 取得に失敗したら何も出さない（空で上書きして「無い」と断言しない方針だが、
    // ここは督促バナーなので出さない側に倒す。次回アクセスで再取得される）
    if (error) return;
    setData(res as BannerData);
  }, []);

  useEffect(() => {
    if (!canOvertime && !isAdmin) return;
    load();
  }, [userId, canOvertime, isAdmin, load]);

  /** 閉じる。remindAfter を渡すとその時刻まで、渡さないと次の配信まで出さない */
  const dismiss = async (targetIds: string[], remindAfter?: Date) => {
    setData(prev => prev ? {
      ...prev,
      self: targetIds.includes(userId) ? null : prev.self,
      members: prev.members.filter(m => !targetIds.includes(m.user_id)),
    } : prev);
    await supabase.from('overtime_banner_dismissals').upsert(
      targetIds.map(id => ({
        user_id: userId,
        target_user_id: id,
        pay_period_start: periodStart,
        dismissed_at: new Date().toISOString(),
        remind_after: remindAfter ? remindAfter.toISOString() : null,
      })),
      { onConflict: 'user_id,target_user_id,pay_period_start' }
    ).then(null, () => {});
  };

  /** 翌朝9時（定期リマインドの「後で」と同じ） */
  const tomorrowMorning = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  };

  if (!data) return null;

  const periodLabel = (() => {
    if (!periodStart) return '';
    const m = Number(periodStart.slice(5, 7));
    return `${m}/16〜${m === 12 ? 1 : m + 1}/15`;
  })();
  const todayLabel = (() => {
    const d = new Date();
    return `${d.getMonth() + 1}/${d.getDate()}`;
  })();

  const btnMain: React.CSSProperties = {
    fontSize: 12, padding: '6px 12px', borderRadius: 6,
    background: TEXT, color: '#fff', border: 'none', cursor: 'pointer',
  };
  const btnSub: React.CSSProperties = {
    fontSize: 12, padding: '6px 12px', borderRadius: 6,
    background: 'transparent', color: TEXT, border: `1px solid ${BORDER}`, cursor: 'pointer',
  };
  const closeBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: SUB, cursor: 'pointer',
    fontSize: 14, padding: '0 2px', flexShrink: 0, lineHeight: 1,
  };

  // 部門ごとにまとめる（マネージャー以上は複数部門を見ることがある）
  const byTeam = new Map<string, MemberInfo[]>();
  for (const m of data.members ?? []) {
    const key = m.team || 'その他';
    byTeam.set(key, [...(byTeam.get(key) ?? []), m]);
  }

  return (
    <>
      {/* 本人向け */}
      {data.self && (
        <div style={{
          margin: '0 0 10px 0', padding: '12px 14px',
          background: BG, border: `1px solid ${BORDER}`, borderRadius: 10,
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ textAlign: 'center', flexShrink: 0, width: 80, paddingTop: 2 }}>
                <div style={{ fontSize: 21, fontWeight: 500, color: TEXT, lineHeight: 1.15 }}>
                  {fmtSigned(data.self.total)}
                </div>
                <div style={{ fontSize: 9.5, color: SUB, marginTop: 1 }}>（見込み）</div>
                <div style={{
                  fontSize: 10.5, color: SUB, marginTop: 5,
                  border: `1px solid ${LINE}`, borderRadius: 3, padding: '1px 0',
                }}>
                  確定 {fmtSigned(data.self.confirmed)}
                </div>
                <div style={{ fontSize: 9.5, color: SUB, marginTop: 4 }}>{periodLabel}</div>
              </div>
              <div style={{ flex: 1, borderLeft: `1px solid ${LINE}`, paddingLeft: 11, minWidth: 0 }}>
                <p style={{ fontSize: 12.5, color: TEXT, lineHeight: 1.7, margin: 0 }}>
                  今月の残業時間です（{todayLabel} 時点）。時間調整をお願いします。
                </p>
                <p style={{ fontSize: 11.5, color: SUB, lineHeight: 1.65, margin: '6px 0 0' }}>
                  調整が難しい場合はリーダー・マネージャーへご相談ください。
                </p>
              </div>
            </div>
            <button type="button" onClick={() => dismiss([userId])} title="閉じる" style={closeBtn}>✕</button>
          </div>
          <div style={{
            borderTop: `1px solid ${LINE}`, marginTop: 10, paddingTop: 9,
            display: 'flex', gap: 7, flexWrap: 'wrap',
          }}>
            {/* 押しただけでは消さない。実際に時間外調整休を申請すれば見込みが下がって自然に消える。
                ⚠️ 申請タブを開くところまで。種別（時間外調整休）のプリセットは未実装
                   （書きかけの下書きが復元される仕組みと衝突するため見送っている） */}
            <button type="button" style={btnMain}
              onClick={() => navigate('/overtime?tab=form')}>
              調整の予定を入れる
            </button>
            <button type="button" style={btnSub}
              onClick={() => dismiss([userId], tomorrowMorning())}>
              後で再通知
            </button>
          </div>
        </div>
      )}

      {/* 上長向け（部門ごとに1枚） */}
      {[...byTeam.entries()].map(([team, members]) => {
        return (
          <div key={team} style={{
            margin: '0 0 10px 0', padding: '12px 14px',
            background: BG, border: `1px solid ${BORDER}`, borderRadius: 10,
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ textAlign: 'center', flexShrink: 0, width: 56, paddingTop: 2 }}>
                  <div style={{ fontSize: 21, fontWeight: 500, color: TEXT, lineHeight: 1.15 }}>
                    {members.length}人
                  </div>
                  <div style={{ fontSize: 9.5, color: SUB, marginTop: 3 }}>{periodLabel}</div>
                  <div style={{ fontSize: 9.5, color: SUB }}>{todayLabel} 時点</div>
                </div>
                <div style={{ flex: 1, borderLeft: `1px solid ${LINE}`, paddingLeft: 11, minWidth: 0 }}>
                  <p style={{ fontSize: 12.5, color: TEXT, lineHeight: 1.6, margin: '0 0 6px' }}>
                    {team}で残業が目安を超えています。
                  </p>
                  <table style={{ width: '100%', fontSize: 12.5, color: TEXT, borderCollapse: 'collapse' }}>
                    <tbody>
                      {members.map(m => (
                        <tr key={m.user_id}>
                          <td style={{ padding: '2.5px 0' }}>{m.name ?? ''}</td>
                          <td style={{ padding: '2.5px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {fmtSigned(m.total)}
                            {m.is_new || m.prev === null ? (
                              <span style={{ color: SUB, fontSize: 11 }}>（新規）</span>
                            ) : (
                              <span style={{ color: m.total - m.prev > 0 ? UP : SUB }}>
                                （{m.total - m.prev >= 0 ? '+' : ''}{fmtSigned(m.total - m.prev).replace(/^[＋−]/, '')}）
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 10, color: SUB, margin: '6px 0 0' }}>
                    見込みの時間です。（ ）は前回のお知らせからの増加
                  </p>
                </div>
              </div>
              <button type="button" title="閉じる" style={closeBtn}
                onClick={() => dismiss(members.map(m => m.user_id))}>✕</button>
            </div>
            <div style={{ marginTop: 10 }}>
              <button type="button" style={btnMain}
                onClick={() => navigate('/overtime?tab=history&mode=summary')}>
                部門集計を開く
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
};

export default OvertimeThresholdBanner;
