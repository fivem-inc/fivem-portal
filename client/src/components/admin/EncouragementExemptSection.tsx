import React, { useEffect, useMemo, useState } from 'react';
import { backBtn } from '../../lib/buttonStyles';
import SaveBar, { SaveNotice, type SaveMsg } from './SaveBar';
import { loadEncouragementExempt, saveEncouragementExempt } from '../../lib/encouragementExempt';

// 有休奨励日の「対象外の方（役員など）」（2026-10-19 ユーザー確定）
// ・年間カレンダーの奨励日でも、この方たちの有給休暇・時間外調整休は止めない
// ・回答の受付を作るとき、この方たちは最初からチェックを外す（LeaveRequestsTab）
// ・［変更する］→ チェック →［保存］（SaveBar・押した瞬間に保存しない）

interface UserLite { id: string; name?: string | null; email?: string | null; employment_type?: string | null; is_active?: boolean | null }

const EncouragementExemptSection: React.FC<{
  users: UserLite[];
  isDark: boolean;
  /** 保存したら呼ぶ（受付を作る画面の初期値に使う） */
  onChange?: (ids: string[]) => void;
}> = ({ users, isDark, onChange }) => {
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<SaveMsg | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    void loadEncouragementExempt().then(ids => {
      if (ids === null) { setLoadError(true); return; }
      setSaved(ids); onChange?.(ids);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = isDark ? '#fff' : '#333';
  const sub = isDark ? '#adb5bd' : '#666';
  const active = useMemo(() => users.filter(u => u.is_active !== false)
    .sort((a, b) => (a.employment_type === '正社員' ? 0 : 1) - (b.employment_type === '正社員' ? 0 : 1) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ja')), [users]);
  const nameOf = (id: string) => users.find(u => u.id === id)?.name || users.find(u => u.id === id)?.email || '（在籍していない方）';

  const changes = useMemo(() => {
    if (!saved) return [];
    const add = draft.filter(id => !saved.includes(id)).map(id => `対象外に追加：${nameOf(id)}`);
    const rm = saved.filter(id => !draft.includes(id)).map(id => `対象外から外す：${nameOf(id)}`);
    return [...add, ...rm];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, draft, users]);

  const onSave = async () => {
    setSaving(true); setMsg(null);
    const err = await saveEncouragementExempt(draft);
    setSaving(false);
    if (err) { setMsg({ fail: true, text: `保存できませんでした：${err}` }); return; }
    setSaved(draft); setEditing(false); onChange?.(draft);
    setMsg({ fail: false, text: '保存しました。' });
  };

  return (
    <div style={{ textAlign: 'left', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}` }}>
      <p style={{ fontSize: 12.5, fontWeight: 'bold', color: text, margin: '0 0 4px' }}>対象外の方（役員など）</p>
      <p style={{ fontSize: 11.5, color: sub, margin: '0 0 8px', lineHeight: 1.6 }}>
        奨励日でも、この方たちの有給休暇・時間外調整休は止めません。回答の受付を作るときも、最初から対象から外します。
      </p>
      {loadError ? (
        <p style={{ fontSize: 12, color: '#dc3545', margin: 0 }}>読み込めませんでした。開き直してください。</p>
      ) : saved === null ? (
        <p style={{ fontSize: 12, color: sub, margin: 0 }}>読み込み中…</p>
      ) : !editing ? (<>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {saved.length === 0 ? <span style={{ fontSize: 12, color: sub }}>なし</span>
            : saved.map(id => <span key={id} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 12, background: isDark ? '#495057' : '#e9ecef', color: text }}>{nameOf(id)}</span>)}
        </div>
        <button type="button" style={{ ...backBtn(isDark), padding: '5px 14px', fontSize: 12 }}
          onClick={() => { setDraft(saved); setEditing(true); setMsg(null); }}>変更する</button>
        <SaveNotice msg={msg} />
      </>) : (<>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, borderRadius: 8, padding: '6px 10px' }}>
          {active.map(u => (
            <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12.5, color: text, cursor: 'pointer' }}>
              <input type="checkbox" checked={draft.includes(u.id)}
                onChange={e => setDraft(prev => e.target.checked ? [...prev, u.id] : prev.filter(x => x !== u.id))} />
              <span>{u.name || u.email}</span>
              {u.employment_type && u.employment_type !== '正社員' && <span style={{ fontSize: 11, color: sub }}>（{u.employment_type}）</span>}
            </label>
          ))}
        </div>
        <SaveBar isDark={isDark} changes={changes} saving={saving} msg={msg}
          onCancel={() => { setEditing(false); setDraft(saved); setMsg(null); }} onSave={() => void onSave()} />
      </>)}
    </div>
  );
};

export default EncouragementExemptSection;
