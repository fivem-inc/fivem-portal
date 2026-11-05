// 管理者からのお知らせの宛先を選ぶ欄（2026-11-05 ユーザー確定・計画 docs/計画-管理者からのお知らせの宛先.md）
// ・ボタンは連絡板と同じ（lib/recipientPresets・判定はそこ1か所）。いくつでも押せる＋個別に人を足す
// ・「届く人◯人」［届く人を見る ▼］。🚨 0人のボタンは押せない（役職の一覧が読めていないと「マネージャー・リーダー」が0人になるため）
// ・保存するときの宛先＝押したボタンの人 ＋ 個別に足した人（呼ぶ側が recipientIdsOf で出す）
import React, { useMemo, useState } from 'react';
import { RECIPIENT_PRESET_KEYS, recipientPresetIds, type RecipientProfile } from '../../lib/recipientPresets';

export interface PickerProfile extends RecipientProfile { name: string | null }

/** 押したボタンと個別に足した人から、届く人の id を出す（並びは名簿の順） */
export const recipientIdsOf = (pressed: string[], extras: string[], profiles: PickerProfile[]): string[] => {
  const sel = new Set<string>(extras);
  for (const k of pressed) for (const id of recipientPresetIds(k, profiles)) sel.add(id);
  return profiles.filter(p => sel.has(p.id)).map(p => p.id);
};

interface Props {
  profiles: PickerProfile[];
  pressed: string[];
  extras: string[];
  onChange: (pressed: string[], extras: string[]) => void;
  isDarkMode: boolean;
  /** 外すと、すでに通知が届いている人の数（編集のとき・0なら出さない） */
  removedNotified?: number;
}

const AnnouncementRecipientPicker: React.FC<Props> = ({ profiles, pressed, extras, onChange, isDarkMode, removedNotified = 0 }) => {
  const [query, setQuery] = useState('');
  const [showList, setShowList] = useState(false);
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';

  const ids = useMemo(() => recipientIdsOf(pressed, extras, profiles), [pressed, extras, profiles]);
  const idSet = useMemo(() => new Set(ids), [ids]);
  const nameOf = (id: string) => profiles.find(p => p.id === id)?.name ?? '（名前なし）';

  const togglePreset = (k: string) => {
    onChange(pressed.includes(k) ? pressed.filter(x => x !== k) : [...pressed, k], extras);
  };
  const q = query.trim();
  const hits = q ? profiles.filter(p => (p.name ?? '').includes(q) && !idSet.has(p.id)).slice(0, 8) : [];

  const chip = (on: boolean, disabled: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 'bold', cursor: disabled ? 'default' : 'pointer',
    border: `2px solid ${on ? '#1565c0' : '#90caf9'}`, background: on ? '#1976d2' : '#e3f2fd', color: on ? '#fff' : '#1565c0',
    opacity: disabled ? 0.45 : 1,
  });

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>宛先 <span style={{ color: '#dc3545' }}>*</span>（いくつでも選べます）</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {RECIPIENT_PRESET_KEYS.map(k => {
          const n = recipientPresetIds(k, profiles).length;
          const disabled = n === 0 && !pressed.includes(k);
          return (
            <button key={k} type="button" disabled={disabled} onClick={() => togglePreset(k)} style={chip(pressed.includes(k), disabled)}>
              {k}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>個別に追加（任意）</div>
      <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="名前で探す"
        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: `0.5px solid ${borderColor}`, borderRadius: 8,
          background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 }} />
      {hits.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {hits.map(p => (
            <button key={p.id} type="button" onClick={() => { onChange(pressed, [...extras, p.id]); setQuery(''); }}
              style={{ padding: '4px 10px', borderRadius: 8, border: `0.5px solid ${borderColor}`, background: 'none', color: text, fontSize: 12.5, cursor: 'pointer' }}>
              ＋ {p.name}
            </button>
          ))}
        </div>
      )}
      {extras.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {extras.map(id => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, background: isDarkMode ? '#1e3a5f' : '#e3f2fd', color: isDarkMode ? '#90caf9' : '#1565c0', fontSize: 12 }}>
              {nameOf(id)}
              <button type="button" aria-label={`${nameOf(id)}を外す`} onClick={() => onChange(pressed, extras.filter(x => x !== id))}
                style={{ border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 12 }}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, background: isDarkMode ? '#1e3a5f' : '#e3f2fd', borderRadius: 8, padding: '8px 10px', color: isDarkMode ? '#bbdefb' : '#0d47a1', fontSize: 13 }}>
        届く人：<b>{ids.length}人</b>
        {pressed.length > 0 && <span>（{pressed.join('・')}{extras.length ? `＋個別 ${extras.length}人` : ''}）</span>}
        {ids.length > 0 && (
          <button type="button" onClick={() => setShowList(v => !v)}
            style={{ marginLeft: 8, border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
            {showList ? '閉じる ▲' : '届く人を見る ▼'}
          </button>
        )}
        {showList && (
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8, color: text }}>{ids.map(nameOf).join('、')}</div>
        )}
      </div>
      {ids.length === 0 && (
        <div style={{ fontSize: 12, color: '#dc3545', marginTop: 4 }}>宛先を選んでください</div>
      )}
      {removedNotified > 0 && (
        <div style={{ fontSize: 12, color: isDarkMode ? '#ffcc80' : '#8a5a00', background: isDarkMode ? '#3a2f00' : '#fff8e1', borderRadius: 8, padding: '6px 10px', marginTop: 6 }}>
          ⚠️ 宛先から外す {removedNotified}人には、すでにメール・スマホの通知が届いています（取り消せません）。画面とベルからは消えます。
        </div>
      )}
      <div style={{ fontSize: 11, color: subText, marginTop: 4 }}>ホームの表示・過去のお知らせ・ベル・メール・スマホの通知は、届く人にだけ出ます。</div>
    </div>
  );
};

export default AnnouncementRecipientPicker;
