import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';

// 安否・緊急連絡の管理
//   ・定型メッセージの追加・編集・削除・並び替え・有効/無効
//   ・過去の発信履歴（回答状況の要約）
//   通知は「災害時に設定ミスで届かない」事故を防ぐため、通知設定でOFFにできない仕様。
//   その旨をこの画面に明記する（設定が無いことを迷わせないため）。

type Pattern = 'safety3' | 'safety4' | 'attendance2' | 'support';

const PATTERN_LABEL: Record<Pattern, string> = {
  safety3: '安否確認（無事です／被害あり）',
  safety4: '安否＋出勤確認（台風・大雪）',
  attendance2: '出勤可否のみ',
  support: '応援要請（お願い・催促しない）',
};

interface Template {
  id: string;
  title: string;
  body: string;
  pattern: Pattern;
  sort_order: number;
  active: boolean;
}

interface SafetyCheckRow {
  id: string;
  title: string;
  pattern: Pattern;
  is_test: boolean;
  status: 'active' | 'closed';
  cancelled: boolean;
  created_at: string;
  created_by: string;
  closed_at: string | null;
  remind_count: number;
}

const fmt = (s: string | null): string => {
  if (!s) return '';
  const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SafetyChecksTab: React.FC = () => {
  const { isDarkMode, users, setSuccessMsg } = useAdminPanel();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [checks, setChecks] = useState<SafetyCheckRow[]>([]);
  const [counts, setCounts] = useState<Record<string, { recipients: number; responses: number }>>({});
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; body: string; pattern: Pattern }>({ title: '', body: '', pattern: 'safety3' });
  const [showNew, setShowNew] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const text = isDarkMode ? '#fff' : '#000';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const border = isDarkMode ? '#6c757d' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', fontSize: 13, borderRadius: 6,
    border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: text,
    boxSizing: 'border-box',
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [tplRes, checkRes] = await Promise.all([
      supabase.from('safety_check_templates').select('id, title, body, pattern, sort_order, active').order('sort_order'),
      supabase.from('safety_checks').select('id, title, pattern, is_test, status, cancelled, created_at, created_by, closed_at, remind_count').order('created_at', { ascending: false }).limit(30),
    ]);
    setTemplates((tplRes.data ?? []) as Template[]);
    const rows = (checkRes.data ?? []) as SafetyCheckRow[];
    setChecks(rows);

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const [recipRes, respRes] = await Promise.all([
        supabase.from('safety_check_recipients').select('check_id').in('check_id', ids),
        supabase.from('safety_check_responses').select('check_id').in('check_id', ids),
      ]);
      const c: Record<string, { recipients: number; responses: number }> = {};
      ids.forEach(id => { c[id] = { recipients: 0, responses: 0 }; });
      (recipRes.data ?? []).forEach((r: { check_id: string }) => { if (c[r.check_id]) c[r.check_id].recipients++; });
      (respRes.data ?? []).forEach((r: { check_id: string }) => { if (c[r.check_id]) c[r.check_id].responses++; });
      setCounts(c);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (t: Template) => {
    setEditingId(t.id);
    setShowNew(false);
    setForm({ title: t.title, body: t.body, pattern: t.pattern });
  };

  const startNew = () => {
    setShowNew(true);
    setEditingId(null);
    setForm({ title: '', body: '', pattern: 'safety3' });
  };

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) { setSuccessMsg('⚠ タイトルと本文を入力してください'); return; }
    setBusy(true);
    if (editingId) {
      const { error } = await supabase.from('safety_check_templates')
        .update({ title: form.title.trim(), body: form.body.trim(), pattern: form.pattern })
        .eq('id', editingId).select('id');
      setBusy(false);
      if (error) { setSuccessMsg('⚠ 保存できませんでした: ' + error.message); return; }
      setSuccessMsg('保存しました');
    } else {
      const maxOrder = templates.reduce((m, t) => Math.max(m, t.sort_order), 0);
      const { error } = await supabase.from('safety_check_templates')
        .insert({ title: form.title.trim(), body: form.body.trim(), pattern: form.pattern, sort_order: maxOrder + 1 })
        .select('id');
      setBusy(false);
      if (error) { setSuccessMsg('⚠ 追加できませんでした: ' + error.message); return; }
      setSuccessMsg('追加しました');
    }
    setEditingId(null); setShowNew(false);
    load();
  };

  const toggleActive = async (t: Template) => {
    const { error } = await supabase.from('safety_check_templates').update({ active: !t.active }).eq('id', t.id).select('id');
    if (error) { setSuccessMsg('⚠ 変更できませんでした'); return; }
    setSuccessMsg(t.active ? '発信画面に出さないようにしました' : '発信画面に出すようにしました');
    load();
  };

  const move = async (t: Template, dir: -1 | 1) => {
    const sorted = [...templates].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(x => x.id === t.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    await Promise.all([
      supabase.from('safety_check_templates').update({ sort_order: swap.sort_order }).eq('id', t.id),
      supabase.from('safety_check_templates').update({ sort_order: t.sort_order }).eq('id', swap.id),
    ]);
    load();
  };

  const doDelete = async (id: string) => {
    setBusy(true);
    const { error } = await supabase.from('safety_check_templates').delete().eq('id', id).select('id');
    setBusy(false);
    setDeleteConfirmId(null);
    if (error) { setSuccessMsg('⚠ 削除できませんでした: ' + error.message); return; }
    setSuccessMsg('削除しました');
    load();
  };

  const userName = (id: string) => users.find(u => u.id === id)?.name || '—';

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: sub }}>読み込み中...</div>;

  return (
    <div>
      <h3 style={{ color: text, fontSize: 18, margin: '0 0 4px' }}>🆘 安否・緊急連絡</h3>
      <p style={{ color: sub, fontSize: 13, margin: '0 0 16px' }}>
        災害時の安否確認・出勤確認・応援要請の定型メッセージを管理します。発信は連絡板の「🆘 安否・緊急連絡」から行います。
      </p>

      {/* 通知についての説明（設定が無いことを迷わせないため明記する） */}
      <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '12px 14px', marginBottom: 20 }}>
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', margin: '0 0 6px' }}>🔔 通知について（設定はありません）</p>
        <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>
          安否確認の通知は、災害時に設定ミスで届かない事故を防ぐため、<strong>通知設定に関係なく必ず送信されます</strong>（プッシュ・メール・サイト内通知）。
          そのため通知設定タブには表示されず、OFFにすることはできません。<br />
          プッシュの見出しは、安否確認＝「ファイブM 安否」、出勤確認・応援要請＝「ファイブM 緊急」です。<br />
          未回答者への自動リマインドはプッシュのみ送ります（メールは初回のみ。メール送信の上限を超えて他の通知が止まるのを防ぐため）。
        </p>
      </div>

      {/* 定型メッセージ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ color: text, fontSize: 15, margin: 0 }}>📝 定型メッセージ</h4>
        {!showNew && !editingId && (
          <button type="button" onClick={startNew}
            style={{ padding: '6px 14px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
            ＋ 追加
          </button>
        )}
      </div>

      {(showNew || editingId) && (
        <div style={{ background: cardBg, border: `2px solid #1976d2`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 'bold', color: text, margin: '0 0 10px' }}>{editingId ? '定型メッセージを編集' : '定型メッセージを追加'}</p>
          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 3 }}>タイトル（発信画面に一覧で出ます）</label>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="例：豪雨の安否確認" style={{ ...inputStyle, marginBottom: 10 }} />

          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 3 }}>種類（回答ボタンが決まります）</label>
          <select value={form.pattern} onChange={e => setForm({ ...form, pattern: e.target.value as Pattern })}
            style={{ ...inputStyle, marginBottom: 10 }}>
            {(Object.keys(PATTERN_LABEL) as Pattern[]).map(p => <option key={p} value={p}>{PATTERN_LABEL[p]}</option>)}
          </select>

          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 3 }}>本文（発信時に編集できます）</label>
          <textarea value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} rows={3}
            placeholder="例：豪雨により◯◯地域で被害が出ています。皆さんの安否を確認します。"
            style={{ ...inputStyle, marginBottom: 12, resize: 'vertical' }} />

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy} onClick={save}
              style={{ padding: '7px 18px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>
              {busy ? '保存中...' : '保存'}
            </button>
            <button type="button" onClick={() => { setEditingId(null); setShowNew(false); }}
              style={{ padding: '7px 18px', background: 'none', border: `1px solid ${border}`, color: sub, borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
              キャンセル
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 28 }}>
        {templates.length === 0 && <p style={{ fontSize: 13, color: sub }}>定型メッセージがありません</p>}
        {templates.map((t, i) => (
          <div key={t.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', opacity: t.active ? 1 : 0.55 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                <button type="button" onClick={() => move(t, -1)} disabled={i === 0} title="上へ"
                  style={{ padding: '0 5px', background: 'none', border: `1px solid ${border}`, color: i === 0 ? border : sub, borderRadius: 3, cursor: i === 0 ? 'default' : 'pointer', fontSize: 10, lineHeight: 1.6 }}>▲</button>
                <button type="button" onClick={() => move(t, 1)} disabled={i === templates.length - 1} title="下へ"
                  style={{ padding: '0 5px', background: 'none', border: `1px solid ${border}`, color: i === templates.length - 1 ? border : sub, borderRadius: 3, cursor: i === templates.length - 1 ? 'default' : 'pointer', fontSize: 10, lineHeight: 1.6 }}>▼</button>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>
                  {t.title}
                  {!t.active && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 8, background: isDarkMode ? '#495057' : '#e9ecef', color: sub }}>発信画面に出さない</span>}
                </div>
                <div style={{ fontSize: 11, color: sub, margin: '1px 0 3px' }}>{PATTERN_LABEL[t.pattern]}</div>
                <div style={{ fontSize: 12, color: sub }}>{t.body}</div>
              </div>
              <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                <button type="button" onClick={() => startEdit(t)}
                  style={{ padding: '4px 10px', background: 'none', border: '1px solid #1976d2', color: '#1976d2', borderRadius: 5, cursor: 'pointer', fontSize: 11 }}>編集</button>
                <button type="button" onClick={() => toggleActive(t)}
                  style={{ padding: '4px 10px', background: 'none', border: `1px solid ${border}`, color: sub, borderRadius: 5, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>
                  {t.active ? '隠す' : '出す'}
                </button>
                <button type="button" onClick={() => setDeleteConfirmId(t.id)}
                  style={{ padding: '4px 10px', background: 'none', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 5, cursor: 'pointer', fontSize: 11 }}>削除</button>
              </div>
            </div>
            {deleteConfirmId === t.id && (
              <div style={{ marginTop: 8, padding: '8px 10px', background: isDarkMode ? '#3a1f1f' : '#fff5f5', border: '1px solid #fca5a5', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#dc3545', flex: 1 }}>「{t.title}」を削除しますか？（元に戻せません）</span>
                <button type="button" disabled={busy} onClick={() => doDelete(t.id)}
                  style={{ padding: '4px 12px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>削除する</button>
                <button type="button" onClick={() => setDeleteConfirmId(null)}
                  style={{ padding: '4px 12px', background: 'none', border: `1px solid ${border}`, color: sub, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 発信履歴 */}
      <h4 style={{ color: text, fontSize: 15, margin: '0 0 8px' }}>📋 発信履歴（直近30件）</h4>
      {checks.length === 0 ? (
        <p style={{ fontSize: 13, color: sub }}>まだ発信されていません</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 640 }}>
            <thead>
              <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                {['発信日時', 'タイトル', '種類', '状態', '回答', '発信者', 'リマインド'].map(h => (
                  <th key={h} style={{ border: `1px solid ${border}`, padding: '5px 8px', color: text, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checks.map((c, i) => {
                const cnt = counts[c.id] || { recipients: 0, responses: 0 };
                const statusLabel = c.cancelled ? '取消済み' : c.status === 'active' ? '進行中' : '終了';
                const statusColor = c.cancelled ? '#dc3545' : c.status === 'active' ? '#28a745' : sub;
                return (
                  <tr key={c.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : '#fff') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: text, whiteSpace: 'nowrap' }}>{fmt(c.created_at)}</td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: text }}>
                      {c.is_test && <span style={{ marginRight: 4, fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#fff3cd', color: '#856404' }}>テスト</span>}
                      {c.title}
                    </td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: sub, whiteSpace: 'nowrap' }}>{PATTERN_LABEL[c.pattern]?.split('（')[0]}</td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: statusColor, fontWeight: 'bold', whiteSpace: 'nowrap' }}>{statusLabel}</td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: text, whiteSpace: 'nowrap', textAlign: 'center' }}>
                      {cnt.responses} / {cnt.recipients}人
                    </td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: sub, whiteSpace: 'nowrap' }}>{userName(c.created_by)}</td>
                    <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: sub, whiteSpace: 'nowrap', textAlign: 'center' }}>{c.remind_count}回</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SafetyChecksTab;
