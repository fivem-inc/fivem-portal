import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { formatMin, DAY_KIND_LABELS } from '../lib/breakCalc';
import type { DayKind } from '../lib/breakCalc';
import type { AuthUser } from '../types';

// 通常シフト（曜日パターン）1行
interface PatternRow {
  id: string;
  user_id: string;
  day_kind: DayKind;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  break_minutes: number;
  labor_minutes: number;
  valid_from: string;
  valid_to: string | null;
}

interface PersonRow {
  id: string;
  name: string;
  group_names: string[] | null;
  role_title: string | null;
  employment_type: string | null;
}

const DAY_ORDER: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday', 'work_on_closed'];

function fmtTime(t: string | null | undefined): string {
  if (!t) return '-';
  return t.slice(0, 5);
}
function todayStr(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60000);
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`;
}

// 役職序列（OvertimePage の ROLE_RANK と同じ。一覧の並び用）
const ROLE_RANK: Record<string, number> = { '社長': 1, '管理者': 1, 'マネージャー': 2, 'リーダー': 3, 'フロア責任者': 4, '一般': 5, 'パート': 6 };
const roleRank = (role: string) => ROLE_RANK[role] ?? 99;

interface Props {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
  // 画面の出し分けは useAuth 経由で受け取る（役職プレビューを効かせるため）。
  // 実データの保護はDB側のRLS（has_feature_permission）が担当する
  canDirectory: boolean;
}

const ShiftDirectoryPage: React.FC<Props> = ({ isAdmin, canDirectory }) => {
  const isDark = useDarkMode();
  const navigate = useNavigate();
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#495057' : '#fff';

  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [patByUser, setPatByUser] = useState<Map<string, PatternRow[]>>(new Map());
  const [teamWhitelist, setTeamWhitelist] = useState<string[]>([]);
  const [nameQuery, setNameQuery] = useState('');
  const [team, setTeam] = useState('__all__');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      // 🚨 権限はDBに直接聞かず props（useAuth 経由）で判定する。
      //    RPCで聞くと役職プレビュー中も実アカウント（管理者）で評価され、
      //    「一般として表示」でもこのページが開けてしまい実際の見え方を確認できない
      const ok = isAdmin || canDirectory;
      setAllowed(ok);
      if (!ok) { setLoading(false); return; }

      const today = todayStr();
      const [profRes, patRes, setRes] = await Promise.all([
        supabase.from('profiles').select('id, name, group_names, role_title, employment_type').eq('is_active', true).order('name'),
        // 今日有効なパターンのみ取得（一覧バッジと詳細の「未登録」判定を一致させ、転送量も抑える）
        supabase.from('weekly_shift_patterns').select('*').lte('valid_from', today).or(`valid_to.is.null,valid_to.gte.${today}`),
        supabase.from('overtime_settings').select('banner_group_names').eq('id', 1).maybeSingle(),
      ]);
      if (profRes.error || patRes.error) {
        setLoadError('データの読み込みに失敗しました：' + (profRes.error?.message ?? patRes.error?.message ?? ''));
        setLoading(false);
        return;
      }
      setLoadError('');
      setPeople((profRes.data as PersonRow[] | null) ?? []);
      setTeamWhitelist((setRes.data?.banner_group_names as string[] | null) ?? []);
      const map = new Map<string, PatternRow[]>();
      for (const p of ((patRes.data as PatternRow[] | null) ?? [])) {
        const arr = map.get(p.user_id) ?? [];
        arr.push(p);
        map.set(p.user_id, arr);
      }
      setPatByUser(map);
      setLoading(false);
    })();
  }, [isAdmin, canDirectory]);

  // 各人のチーム（部門ホワイトリストに一致する group のみ採用。無ければ未所属）
  const teamOf = (p: PersonRow) => teamWhitelist.find(g => (p.group_names ?? []).includes(g)) ?? '未所属';

  const teamOptions = useMemo(() => {
    const set = new Set(people.map(teamOf));
    const list = [...set].sort((a, b) => a.localeCompare(b, 'ja'));
    return list.filter(g => g !== '未所属').concat(list.includes('未所属') ? ['未所属'] : []);
  }, [people, teamWhitelist]);

  const visible = useMemo(() => {
    const q = nameQuery.trim();
    return people
      .filter(p => (!q || p.name.includes(q)) && (team === '__all__' || teamOf(p) === team))
      .sort((a, b) => roleRank(a.role_title ?? '') - roleRank(b.role_title ?? '') || a.name.localeCompare(b.name, 'ja'));
  }, [people, nameQuery, team, teamWhitelist]);

  const selected = selectedId ? people.find(p => p.id === selectedId) ?? null : null;

  const selectStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: inputBg, color: text, fontSize: 13 };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '12px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/overtime')} style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: subText, padding: '5px 10px' }}>← 残業・時間管理へ</button>
        <h2 style={{ margin: 0, fontSize: 18, color: text }}>🗓 全員のシフト予定</h2>
      </div>

      {loading ? (
        <p style={{ margin: '24px 0', fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
      ) : loadError ? (
        <p style={{ margin: '24px 0', fontSize: 13, color: isDark ? '#f5b5ba' : '#c62828', textAlign: 'center' }}>{loadError}</p>
      ) : !allowed ? (
        <p style={{ margin: '24px 0', fontSize: 13, color: subText, textAlign: 'center', lineHeight: 1.7 }}>
          このページを表示する権限がありません。<br />閲覧できる役職は管理者が設定します。
        </p>
      ) : selected ? (
        // ── 個人のシフト詳細 ──
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button onClick={() => setSelectedId(null)} style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: subText, padding: '5px 10px' }}>← 一覧へ戻る</button>
            <span style={{ fontSize: 13, color: subText }}>
              <span style={{ color: text, fontWeight: 'bold' }}>{selected.name}</span>
              {selected.role_title ? `　${selected.role_title}` : ''}
              {teamOf(selected) !== '未所属' ? `・${teamOf(selected)}` : ''}
            </span>
          </div>
          <WeeklyPatternTable
            patterns={patByUser.get(selected.id) ?? []}
            isDark={isDark} text={text} subText={subText} borderColor={borderColor} innerBg={innerBg}
          />
        </div>
      ) : (
        // ── 一覧（検索＋チームフィルタ） ──
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <select value={team} onChange={e => setTeam(e.target.value)} style={{ ...selectStyle, flex: '0 0 auto' }}>
              <option value="__all__">すべてのチーム</option>
              {teamOptions.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <input value={nameQuery} onChange={e => setNameQuery(e.target.value)} placeholder="名前で絞り込み"
              style={{ flex: 1, minWidth: 120, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: inputBg, color: text, fontSize: 13 }} />
          </div>
          <p style={{ margin: '0 0 10px', fontSize: 11.5, color: subText }}>名前をタップすると、その方の通常シフト（曜日ごとの勤務予定）を確認できます。</p>
          {visible.length === 0 ? (
            <p style={{ margin: '20px 0', fontSize: 13, color: subText, textAlign: 'center' }}>該当する方がいません</p>
          ) : (
            <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, overflow: 'hidden' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', color: text }}>
                <tbody>
                  {visible.map((p, i) => {
                    const hasPattern = (patByUser.get(p.id) ?? []).length > 0;
                    return (
                      <tr key={p.id} onClick={() => setSelectedId(p.id)} style={{ cursor: 'pointer', borderTop: i > 0 ? `1px solid ${borderColor}` : 'none' }}>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{p.name}</td>
                        <td style={{ padding: '10px 0', width: '100%', fontSize: 11, color: subText }}>
                          {[teamOf(p) !== '未所属' ? teamOf(p) : null, p.role_title || null].filter(Boolean).join('・')}
                          {!hasPattern && (
                            <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 6, background: innerBg, border: `1px solid ${borderColor}`, fontSize: 10.5 }}>シフト未登録</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px 10px 8px', textAlign: 'right', color: subText, width: 14 }}>›</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// その人の有効な曜日パターンを表示（MyPatternToggle と同じ描画）
const WeeklyPatternTable: React.FC<{
  patterns: PatternRow[]; isDark: boolean; text: string; subText: string; borderColor: string; innerBg: string;
}> = ({ patterns, text, subText, borderColor, innerBg }) => {
  const today = todayStr();
  const active = patterns.filter(p => p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
  if (active.length === 0) {
    return <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>通常シフトが未登録です。</p>;
  }
  return (
    <div style={{ background: innerBg, borderRadius: 10, border: `1px solid ${borderColor}`, padding: '10px 12px' }}>
      <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', color: text }}>
        <tbody>
          {DAY_ORDER.filter(k => active.some(p => p.day_kind === k)).map((k, i) => {
            const p = active.find(x => x.day_kind === k)!;
            const cell: React.CSSProperties = { padding: '6px 0', verticalAlign: 'top' };
            return (
              <tr key={k} style={{ borderTop: i > 0 ? `1px solid ${borderColor}` : 'none' }}>
                <td style={{ ...cell, color: subText, whiteSpace: 'nowrap', paddingRight: 10, fontWeight: 'bold', width: 44 }}>{DAY_KIND_LABELS[k]}</td>
                <td style={cell}>
                  {p.start_time ? (
                    <>
                      <span style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.start_time)}〜{fmtTime(p.end_time)}</span>
                      {p.start_time2 && <span style={{ whiteSpace: 'nowrap' }}>　＋　{fmtTime(p.start_time2)}〜{fmtTime(p.end_time2)}</span>}
                      <span style={{ display: 'block', fontSize: 11, color: subText, marginTop: 1 }}>休憩{formatMin(p.break_minutes)}・労働{formatMin(p.labor_minutes)}</span>
                    </>
                  ) : <span style={{ color: subText }}>休み</span>}
                </td>
                <td style={{ ...cell, color: subText, textAlign: 'right', whiteSpace: 'nowrap', paddingLeft: 8 }}>
                  {p.start_time ? (p.location ?? '') : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default ShiftDirectoryPage;
