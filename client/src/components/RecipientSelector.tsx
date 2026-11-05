// 宛先を選ぶ欄（連絡板のお知らせ・管理者からのお知らせで共用・2026-11-05 に BoardPage から部品に出した）
// ・名前で検索／一括ボタン（全員→各グループ→全解除の固定順）／雇用形態・役職ごとのチェックの一覧／「◯人選択中」
// ・ボタンで一気に入れて、チェックを外せば1人ずつ外せる。🚨 一括ボタンの判定は lib/recipientPresets 1か所
// ・押したボタンの記録（presetKeys）：ボタンの人が全員入っているときだけ残す（コピーして作成で使う）。1人でも外したら、その人を含むボタンの記録は消す
import React, { useState } from 'react';
import { recipientPresetIds, type RecipientProfile } from '../lib/recipientPresets';
import { rolesByRank } from '../lib/roleAttrs';
import { useRoles } from '../hooks/useRoles';

export interface SelectorProfile extends RecipientProfile { name: string | null }

const EMP_ORDER = ['正社員', 'パート'];
const QUICK_KEYS = ['正社員', 'パート', 'マネージャー・リーダー', 'こども', '大人', '管理部'] as const;

interface Props {
  /** 候補（宛先の候補に出さない人は呼ぶ側で外しておく） */
  profiles: SelectorProfile[];
  selected: string[];
  presetKeys: string[];
  onChange: (ids: string[], presetKeys: string[]) => void;
  isDark: boolean;
  /** 自分の id（名前の横に「(自分)」） */
  selfId?: string;
  /** 見出しの上の余白（連絡板は 8） */
  labelMarginTop?: number;
  /** 検索の文字を呼ぶ側で持つとき（連絡板はクリア・コピーで消すため）。渡さなければ部品の中で持つ */
  query?: string;
  onQueryChange?: (q: string) => void;
}

const RecipientSelector: React.FC<Props> = ({ profiles, selected, presetKeys, onChange, isDark, selfId, labelMarginTop = 8, query: queryProp, onQueryChange }) => {
  const roles = useRoles();
  const [queryLocal, setQueryLocal] = useState('');
  const query = queryProp ?? queryLocal;
  const setQuery = onQueryChange ?? setQueryLocal;
  // 色は連絡板（BoardPage）と同じ
  const textColor = isDark ? '#eeeeee' : '#222222';
  const subColor  = isDark ? '#aaaaaa' : '#666666';
  const border    = isDark ? '#3a3a5c' : '#e0e0e0';
  const inputBg   = isDark ? '#3a3a5c' : '#f8f9fa';
  const ROLE_ORDER = [...rolesByRank(roles).map(r => r.name), 'その他'];

  const filtered = profiles.filter(p => !query || (p.name || '').includes(query));
  const empTypes = ([...new Set(profiles.map(p => p.employment_type || 'その他'))] as string[])
    .sort((a, b) => { const ai = EMP_ORDER.indexOf(a), bi = EMP_ORDER.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
  // グループタグ設定（こども/大人/管理部のみ表示）
  const GTAG = [
    { name: 'こども', bg: isDark ? '#1e3a5f' : '#dbeafe', color: isDark ? '#93c5fd' : '#1d4ed8' },
    { name: '大人',   bg: isDark ? '#14532d' : '#dcfce7', color: isDark ? '#86efac' : '#15803d' },
    { name: '管理部', bg: isDark ? '#451a03' : '#fef3c7', color: isDark ? '#fcd34d' : '#b45309' },
  ];
  // 宛先から人を外したら、その人を含むボタンの記録は無効にする（「ボタン全員」ではなくなったため）
  const dropPresets = (keys: string[], removedIds: string[]) =>
    keys.filter(k => !recipientPresetIds(k, profiles).some(id => removedIds.includes(id)));

  return (
    <>
      <div style={{ fontSize: 12, fontWeight: 700, color: subColor, marginBottom: 6, marginTop: labelMarginTop }}>宛先を選択 <span style={{ color: '#dc3545', fontSize: 11 }}>*必須</span></div>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="名前で検索..."
        style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, boxSizing: 'border-box', marginBottom: 6 }} />
      {/* 一括ボタン（全員→各グループ→全解除の固定順） */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
        <button type="button" onClick={() => onChange(filtered.map(p => p.id), query ? [] : ['全員'])}
          style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
        {QUICK_KEYS.map(label => {
          const ids = recipientPresetIds(label, filtered);
          const allInSel = ids.length > 0 && ids.every(id => selected.includes(id));
          const allSel = allInSel && selected.length === ids.length;
          return (
            <button key={label} type="button"
              onClick={() => {
                // 押したボタンを記録する（検索で絞っているときは「ボタン全員」ではないので記録しない）
                const remember = !query;
                if (allInSel && selected.length === ids.length) onChange([], []);
                else if (allInSel) onChange(ids, remember ? [label] : []);
                else onChange([...new Set([...selected, ...ids])], remember ? [...new Set([...presetKeys, label])] : presetKeys);
              }}
              style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: allInSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allInSel ? '#fff' : (isDark ? '#fff' : '#333'), opacity: allSel ? 1 : allInSel ? 0.75 : 1 }}>
              {label}
            </button>
          );
        })}
        <button type="button" onClick={() => onChange([], [])}
          style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
      </div>
      {/* メンバーグリッド */}
      <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
        {empTypes.map((et, gi) => {
          const etProfiles = filtered.filter(p => (p.employment_type || 'その他') === et);
          if (etProfiles.length === 0) return null;
          const roleNames = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort((a, b) => { const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
          return (
            <div key={et}>
              <div style={{ padding: '4px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined }}>
                <span style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {roleNames.map((role, ri) => {
                  const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                  const allRoleSel = roleProfiles.every(p => selected.includes(p.id));
                  return (
                    <div key={role} style={{ flex: '1 1 130px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '5px 8px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, cursor: 'pointer' }}>
                        <input type="checkbox" checked={allRoleSel && roleProfiles.length > 0}
                          onChange={() => {
                            const ids = roleProfiles.map(p => p.id);
                            if (allRoleSel) onChange(selected.filter(id => !ids.includes(id)), dropPresets(presetKeys, ids));
                            else onChange([...new Set([...selected, ...ids])], presetKeys);
                          }} />
                        <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                      </label>
                      {roleProfiles.map(p => {
                        const gTags = GTAG.filter(g => (p.group_names || []).includes(g.name));
                        return (
                          <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0', cursor: 'pointer', fontSize: 12, color: textColor, flexWrap: 'wrap' }}>
                            <input type="checkbox" checked={selected.includes(p.id)}
                              onChange={e => {
                                if (e.target.checked) onChange([...selected, p.id], presetKeys);
                                else onChange(selected.filter(id => id !== p.id), dropPresets(presetKeys, [p.id]));
                              }} />
                            <span style={{ flexShrink: 0 }}>
                              {p.name}
                              {p.id === selfId && <span style={{ fontSize: 10, color: subColor }}> (自分)</span>}
                            </span>
                            {gTags.map(g => (
                              <span key={g.name} style={{ fontSize: 11, padding: '1px 5px', borderRadius: 3, background: g.bg, color: g.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{g.name}</span>
                            ))}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {selected.length > 0 && (
        <div style={{ fontSize: 12, color: '#007bff', marginTop: 4 }}>{selected.length}人選択中</div>
      )}
    </>
  );
};

export default RecipientSelector;
