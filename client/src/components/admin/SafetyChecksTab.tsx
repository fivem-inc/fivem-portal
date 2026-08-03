import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';

// 安否・緊急連絡の管理
//   ・定型メッセージの追加・編集・削除・並び替え・有効/無効
//   ・発信履歴（回答状況）＋ 終了 / 取消 / 未回答者へ再送 / 代行入力
//
//   災害時は「発信者自身が被災して動けない」「発信者は現場、管理者が後方で集計を回す」
//   といったことが普通に起きるため、管理者はここから全ての操作ができるようにしてある。
//   ⚠️ 呼び出す先は /safety の集計画面と同じRPC・同じEdge Function。
//      画面が2つあるだけで処理は1つなので、片方だけ直して食い違うことはない。
//
//   通知は「災害時に設定ミスで届かない」事故を防ぐため、通知設定でOFFにできない仕様。
//   その旨をこの画面に明記する（設定が無いことを迷わせないため）。

type Pattern = 'safety3' | 'safety4' | 'attendance2' | 'support';

const PATTERN_LABEL: Record<Pattern, string> = {
  safety3: '安否確認（無事です／被害あり）',
  safety4: '安否＋出勤確認（台風・大雪）',
  attendance2: '出勤可否のみ',
  support: '応援要請（お願い・催促しない）',
};

// 回答内容の色（/safety の COLOR_STYLE と対応。ダークで沈まないよう暗い時用の色も持つ）
const TONE: Record<string, { bg: string; border: string; text: string; darkBg: string; darkText: string }> = {
  green: { bg: '#dcfce7', border: '#22c55e', text: '#166534', darkBg: '#1e3a2a', darkText: '#7bdca0' },
  blue:  { bg: '#e3f2fd', border: '#1976d2', text: '#0c447c', darkBg: '#1e3a5f', darkText: '#90caf9' },
  amber: { bg: '#fff3cd', border: '#ffc107', text: '#856404', darkBg: '#3a2f0d', darkText: '#ffd970' },
  red:   { bg: '#f8d7da', border: '#dc3545', text: '#721c24', darkBg: '#4a2328', darkText: '#ff9aa2' },
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

// 所属チーム（こども・大人・管理部）だけを取り出す。
// ⚠️ group_names には配信用グループ（マネージャー・リーダー／三役／正社員・契約社員 等）も
//    混ざっているため、先頭を機械的に取ると「マネージャー・リーダー」等を拾ってしまう。
//    チームの一覧は master_options の shift_report_group が正。
const teamOf = (groups: string[] | null | undefined, teams: string[]): string =>
  (groups ?? []).find(g => teams.includes(g)) ?? '';

const fmt = (s: string | null): string => {
  if (!s) return '';
  const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SafetyChecksTab: React.FC = () => {
  const { isDarkMode, users, setSuccessMsg } = useAdminPanel();
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [checks, setChecks] = useState<SafetyCheckRow[]>([]);
  const [teams, setTeams] = useState<string[]>([]);   // こども・大人・管理部（所属チームの判定に使う）
  const [counts, setCounts] = useState<Record<string, { recipients: number; responses: number }>>({});
  const [loading, setLoading] = useState(true);

  // 定型メッセージは既定で閉じる（普段見たいのは発信履歴なので場所を占有させない）
  const [showTemplates, setShowTemplates] = useState(false);
  // 各定型メッセージは1行に省略表示し、クリックで本文を開く
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);

  // 発信履歴の展開（誰が回答したか・未回答は誰かを見る）
  const [expandedCheckId, setExpandedCheckId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    recipients: { id: string; name: string; role_title: string | null; group_names: string[] | null }[];
    responses: { user_id: string; choice: string; comment: string | null; is_proxy: boolean; proxy_by: string | null; answered_at: string }[];
    options: { key: string; label: string; color: string }[];
    phones: Record<string, string>;   // 代行入力のために電話番号も出す（管理者は元々閲覧できる）
  } | null>(null);
  // 代行入力（電話で聞いた内容を管理者が記録する）
  const [proxyTarget, setProxyTarget] = useState<{ checkId: string; userId: string; name: string } | null>(null);
  const [proxyChoice, setProxyChoice] = useState('');
  const [proxyComment, setProxyComment] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  // 終了・取消の確認（インライン確認パネル。window.confirmは使わない）
  const [actionConfirm, setActionConfirm] = useState<{ id: string; kind: 'close' | 'cancel' } | null>(null);

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
    const [tplRes, checkRes, teamRes] = await Promise.all([
      supabase.from('safety_check_templates').select('id, title, body, pattern, sort_order, active').order('sort_order'),
      supabase.from('safety_checks').select('id, title, pattern, is_test, status, cancelled, created_at, created_by, closed_at, remind_count').order('created_at', { ascending: false }).limit(30),
      supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order'),
    ]);
    setTemplates((tplRes.data ?? []) as Template[]);
    setTeams(((teamRes.data ?? []) as { value: string }[]).map(r => r.value));
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

  // 展開中のcheckの詳細を読み込む（開いたとき・代行入力の後に呼ぶ）
  const loadDetail = async (checkId: string) => {
    setDetailLoading(true);
    const [checkRes, recipRes, respRes] = await Promise.all([
      supabase.from('safety_checks').select('options').eq('id', checkId).single(),
      supabase.from('safety_check_recipients').select('user_id').eq('check_id', checkId),
      supabase.from('safety_check_responses').select('user_id, choice, comment, is_proxy, proxy_by, answered_at').eq('check_id', checkId),
    ]);
    const ids = (recipRes.data ?? []).map((r: { user_id: string }) => r.user_id);
    const [profRes, phoneRes] = ids.length > 0
      ? await Promise.all([
          supabase.from('profiles').select('id, name, role_title, group_names').in('id', ids),
          supabase.from('staff_phone_numbers').select('user_id, phone').in('user_id', ids),
        ])
      : [{ data: [] as { id: string; name: string; role_title: string | null; group_names: string[] | null }[] }, { data: [] as { user_id: string; phone: string }[] }];
    setDetail({
      recipients: (profRes.data ?? []) as NonNullable<typeof detail>['recipients'],
      responses: (respRes.data ?? []) as NonNullable<typeof detail>['responses'],
      options: (checkRes.data?.options ?? []) as { key: string; label: string; color: string }[],
      phones: Object.fromEntries(((phoneRes.data ?? []) as { user_id: string; phone: string }[]).map(p => [p.user_id, p.phone])),
    });
    setDetailLoading(false);
  };

  // 発信履歴の行をクリックしたとき、誰が回答したか・未回答は誰かを読み込む
  const toggleDetail = (checkId: string) => {
    if (expandedCheckId === checkId) { setExpandedCheckId(null); setDetail(null); return; }
    setExpandedCheckId(checkId);
    setDetail(null);
    loadDetail(checkId);
  };

  // 未回答者への再送（/safety の集計画面と同じEdge Functionを呼ぶ）
  const doResend = async (checkId: string) => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('safety-check-send', { body: { mode: 'remind', check_id: checkId } });
    setBusy(false);
    if (error || data?.error) { setSuccessMsg('⚠ 再送できませんでした: ' + (data?.error || error?.message)); return; }
    setSuccessMsg(`未回答の${data?.resent ?? 0}人に再送しました`);
  };

  // 代行入力（電話で聞いた内容を記録。本人が後から自分で回答すれば本人の回答が優先される）
  const submitProxy = async () => {
    if (!proxyTarget || !proxyChoice) return;
    setBusy(true);
    const { error } = await supabase.rpc('submit_safety_response_proxy', {
      p_check_id: proxyTarget.checkId, p_target_user_id: proxyTarget.userId,
      p_choice: proxyChoice, p_comment: proxyComment.trim() || null,
    });
    setBusy(false);
    if (error) { setSuccessMsg('⚠ 記録できませんでした: ' + error.message); return; }
    setSuccessMsg(`${proxyTarget.name}さんの回答を代行で記録しました`);
    const cid = proxyTarget.checkId;
    setProxyTarget(null); setProxyChoice(''); setProxyComment('');
    loadDetail(cid);   // 展開したまま中身だけ更新する
    load();            // 一覧の「回答 n/m人」も更新する
  };

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

  // 終了・取消（後片付け。発信者が終わらせ忘れたまま放置されることがあるため管理画面にも置く）
  const doCloseOrCancel = async (checkId: string, kind: 'close' | 'cancel') => {
    setBusy(true);
    const { error } = await supabase.rpc(kind === 'close' ? 'close_safety_check' : 'cancel_safety_check', { p_check_id: checkId });
    setBusy(false);
    setActionConfirm(null);
    if (error) { setSuccessMsg(`⚠ ${kind === 'close' ? '終了' : '取消'}できませんでした: ` + error.message); return; }
    setSuccessMsg(kind === 'close' ? '終了しました' : '取消しました（宛先全員に「誤送信でした」の通知を送りました）');
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


      {/* 定型メッセージ（既定で閉じる。見出しを枠付きのボタン風にして「押せる」ことを分かるようにする。
          文字だけの見出しだとクリックできると気づけなかったため） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: showTemplates ? 8 : 24 }}>
        <button type="button" onClick={() => setShowTemplates(v => !v)}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
            padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
            background: showTemplates ? (isDarkMode ? '#2d3561' : '#e8f0fe') : cardBg,
            border: `1px solid ${showTemplates ? '#1976d2' : border}`,
            color: text, fontSize: 15, fontWeight: 'bold',
          }}>
          <span style={{ fontSize: 13, color: '#1976d2' }}>{showTemplates ? '▼' : '▶'}</span>
          📝 定型メッセージ
          <span style={{ fontSize: 12, fontWeight: 'normal', color: sub }}>（{templates.length}件）</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 'normal', color: '#1976d2' }}>
            {showTemplates ? '閉じる' : 'クリックして開く'}
          </span>
        </button>
        {showTemplates && !showNew && !editingId && (
          <button type="button" onClick={startNew}
            style={{ padding: '10px 14px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
            ＋ 追加
          </button>
        )}
      </div>

      {showTemplates && (<>

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

      {/* 1件1行にまとめて表示密度を上げる（縦に広がると下の発信履歴まで届かないため）。
          本文は1行で省略し、行をクリックすると全文が開く */}
      <div style={{ border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 28 }}>
        {templates.length === 0 && <p style={{ fontSize: 13, color: sub, padding: 12, margin: 0 }}>定型メッセージがありません</p>}
        {templates.map((t, i) => (
          <div key={t.id} style={{ background: i % 2 === 0 ? cardBg : (isDarkMode ? '#3d4349' : '#f8f9fa'), borderBottom: i < templates.length - 1 ? `1px solid ${border}` : 'none', opacity: t.active ? 1 : 0.55 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                <button type="button" onClick={() => move(t, -1)} disabled={i === 0} title="上へ"
                  style={{ padding: '0 4px', background: 'none', border: `1px solid ${border}`, color: i === 0 ? border : sub, borderRadius: 3, cursor: i === 0 ? 'default' : 'pointer', fontSize: 8, lineHeight: 1.4 }}>▲</button>
                <button type="button" onClick={() => move(t, 1)} disabled={i === templates.length - 1} title="下へ"
                  style={{ padding: '0 4px', background: 'none', border: `1px solid ${border}`, color: i === templates.length - 1 ? border : sub, borderRadius: 3, cursor: i === templates.length - 1 ? 'default' : 'pointer', fontSize: 8, lineHeight: 1.4 }}>▼</button>
              </div>
              <div onClick={() => setExpandedTemplateId(v => v === t.id ? null : t.id)}
                title="クリックで本文を開く"
                style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{t.title}</span>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: isDarkMode ? '#495057' : '#eef2f7', color: sub, whiteSpace: 'nowrap' }}>
                    {PATTERN_LABEL[t.pattern].split('（')[0]}
                  </span>
                  {!t.active && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: isDarkMode ? '#495057' : '#e9ecef', color: sub }}>発信画面に出さない</span>}
                </div>
                {/* 開いていないときは1行に省略（縦幅を取らない） */}
                <div style={{
                  fontSize: 11, color: sub,
                  ...(expandedTemplateId === t.id
                    ? {}
                    : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }),
                }}>{t.body}</div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button type="button" onClick={() => startEdit(t)}
                  style={{ padding: '3px 9px', background: 'none', border: '1px solid #1976d2', color: '#1976d2', borderRadius: 5, cursor: 'pointer', fontSize: 11 }}>編集</button>
                <button type="button" onClick={() => toggleActive(t)}
                  style={{ padding: '3px 9px', background: 'none', border: `1px solid ${border}`, color: sub, borderRadius: 5, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>
                  {t.active ? '隠す' : '出す'}
                </button>
                <button type="button" onClick={() => setDeleteConfirmId(t.id)}
                  style={{ padding: '3px 9px', background: 'none', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 5, cursor: 'pointer', fontSize: 11 }}>削除</button>
              </div>
            </div>
            {deleteConfirmId === t.id && (
              <div style={{ margin: '0 10px 8px', padding: '8px 10px', background: isDarkMode ? '#3a1f1f' : '#fff5f5', border: '1px solid #fca5a5', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
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
      </>)}

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
                const isOpen = expandedCheckId === c.id;
                return (
                  <React.Fragment key={c.id}>
                    <tr onClick={() => toggleDetail(c.id)} title="クリックで回答状況を開く"
                      style={{ background: isOpen ? (isDarkMode ? '#2d3561' : '#e8f0fe') : i % 2 === 0 ? (isDarkMode ? '#343a40' : '#fff') : (isDarkMode ? '#3d4349' : '#f8f9fa'), cursor: 'pointer' }}>
                      <td style={{ border: `1px solid ${border}`, padding: '5px 8px', color: text, whiteSpace: 'nowrap' }}>
                        <span style={{ color: sub, marginRight: 4 }}>{isOpen ? '▼' : '▶'}</span>{fmt(c.created_at)}
                      </td>
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
                    {isOpen && (
                      <tr>
                        <td colSpan={7} style={{ border: `1px solid ${border}`, padding: '10px 12px', background: isDarkMode ? '#2c2c3e' : '#fbfcfe' }}>
                          {detailLoading || !detail ? (
                            <span style={{ fontSize: 12, color: sub }}>読み込み中...</span>
                          ) : (() => {
                            const answered = new Set(detail.responses.map(r => r.user_id));
                            const unanswered = detail.recipients.filter(p => !answered.has(p.id));
                            const nameOf = (id: string) => detail.recipients.find(p => p.id === id)?.name ?? userName(id);
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div>
                                  <p style={{ fontSize: 12, fontWeight: 'bold', color: text, margin: '0 0 4px' }}>回答した人（{detail.responses.length}人）</p>
                                  {detail.responses.length === 0 ? (
                                    <span style={{ fontSize: 12, color: sub }}>まだ回答がありません</span>
                                  ) : (
                                    /* 回答内容ごとにまとめ、対応が必要なもの（赤→橙→青→緑）から先に出す。
                                       名前・所属・時刻を列で揃える（中央寄せだと名前の長さで位置がばらつくため） */
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                      {[...detail.options]
                                        .sort((a, b) => ({ red: 0, amber: 1, blue: 2, green: 3 }[a.color] ?? 9) - ({ red: 0, amber: 1, blue: 2, green: 3 }[b.color] ?? 9))
                                        .map(o => {
                                          const group = detail.responses.filter(r => r.choice === o.key);
                                          if (group.length === 0) return null;
                                          const c = TONE[o.color] ?? TONE.green;
                                          return (
                                            <div key={o.key}>
                                              <div style={{ fontSize: 11, fontWeight: 'bold', marginBottom: 3 }}>
                                                <span style={{ padding: '2px 8px', borderRadius: 10, background: isDarkMode ? c.darkBg : c.bg, color: isDarkMode ? c.darkText : c.text, border: `1px solid ${c.border}` }}>
                                                  {o.label}
                                                </span>
                                                <span style={{ color: sub, marginLeft: 6, fontWeight: 'normal' }}>{group.length}人</span>
                                              </div>
                                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 4 }}>
                                                {group.map(r => {
                                                  const p = detail.recipients.find(x => x.id === r.user_id);
                                                  const affiliation = [teamOf(p?.group_names, teams), p?.role_title].filter(Boolean).join('・');
                                                  return (
                                                    <div key={r.user_id} style={{ fontSize: 12, color: text }}>
                                                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                                        <span style={{ minWidth: 110, fontWeight: 'bold' }}>{nameOf(r.user_id)}</span>
                                                        <span style={{ minWidth: 130, fontSize: 11, color: sub }}>{affiliation || '—'}</span>
                                                        <span style={{ fontSize: 11, color: sub }}>{fmt(r.answered_at)}</span>
                                                        {r.is_proxy && <span style={{ fontSize: 11, color: sub }}>（代行：{userName(r.proxy_by ?? '')}）</span>}
                                                      </div>
                                                      {r.comment && <div style={{ fontSize: 11, color: sub, paddingLeft: 8 }}>「{r.comment}」</div>}
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          );
                                        })}
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <p style={{ fontSize: 12, fontWeight: 'bold', color: text, margin: '0 0 4px' }}>未回答（{unanswered.length}人）</p>
                                  {unanswered.length === 0 ? (
                                    <span style={{ fontSize: 12, color: '#28a745', fontWeight: 'bold' }}>全員回答済みです</span>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      {unanswered.map(p => (
                                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, border: `1px solid ${border}`, borderRadius: 6, padding: '5px 8px' }}>
                                          <span style={{ minWidth: 110, color: text, fontWeight: 'bold' }}>{p.name}</span>
                                          <span style={{ flex: 1, fontSize: 11, color: sub }}>{[teamOf(p.group_names, teams), p.role_title].filter(Boolean).join('・') || '—'}</span>
                                          {detail.phones[p.id] ? (
                                            <a href={`tel:${detail.phones[p.id]}`} style={{ color: isDarkMode ? '#90caf9' : '#1976d2', fontSize: 11, whiteSpace: 'nowrap' }}>📞 {detail.phones[p.id]}</a>
                                          ) : (
                                            <span style={{ color: sub, fontSize: 11 }}>番号なし</span>
                                          )}
                                          <button type="button" onClick={() => { setProxyTarget({ checkId: c.id, userId: p.id, name: p.name }); setProxyChoice(''); setProxyComment(''); }}
                                            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, border: `1px solid ${isDarkMode ? '#90caf9' : '#1976d2'}`, background: 'transparent', color: isDarkMode ? '#90caf9' : '#1976d2', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                            代行入力
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {/* 代行入力（電話で聞いた内容を記録する） */}
                                  {proxyTarget?.checkId === c.id && (
                                    <div style={{ marginTop: 8, border: `1px solid ${isDarkMode ? '#90caf9' : '#1976d2'}`, borderRadius: 8, padding: 10 }}>
                                      <p style={{ fontSize: 12, fontWeight: 'bold', color: text, margin: '0 0 6px' }}>{proxyTarget.name}さんの代行入力（電話で確認した内容）</p>
                                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                                        {detail.options.map(o => (
                                          <button key={o.key} type="button" onClick={() => setProxyChoice(o.key)}
                                            style={{ padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer', border: `1px solid ${proxyChoice === o.key ? '#1976d2' : border}`, background: proxyChoice === o.key ? '#1976d2' : 'transparent', color: proxyChoice === o.key ? '#fff' : text }}>
                                            {o.label}
                                          </button>
                                        ))}
                                      </div>
                                      <input value={proxyComment} onChange={e => setProxyComment(e.target.value)} placeholder="例：電話で確認。自宅で無事とのこと"
                                        style={{ ...inputStyle, fontSize: 12, marginBottom: 8 }} />
                                      <div style={{ display: 'flex', gap: 6 }}>
                                        <button type="button" disabled={!proxyChoice || busy} onClick={submitProxy}
                                          style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: proxyChoice ? '#1976d2' : (isDarkMode ? '#495057' : '#e9ecef'), color: proxyChoice ? '#fff' : sub, fontSize: 12, fontWeight: 'bold', cursor: proxyChoice ? 'pointer' : 'default' }}>
                                          記録する
                                        </button>
                                        <button type="button" onClick={() => setProxyTarget(null)}
                                          style={{ padding: '5px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 12, cursor: 'pointer' }}>キャンセル</button>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* 操作（終了・取消・再送・集計画面へ） */}
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: `1px solid ${border}`, paddingTop: 10 }}>
                                  {c.status === 'active' && !c.cancelled && unanswered.length > 0 && (
                                    <button type="button" disabled={busy} onClick={() => doResend(c.id)}
                                      style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#90caf9' : '#1976d2'}`, background: 'transparent', color: isDarkMode ? '#90caf9' : '#1976d2', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                                      未回答の{unanswered.length}人に再送
                                    </button>
                                  )}
                                  {c.status === 'active' && !c.cancelled && (
                                    <button type="button" onClick={() => setActionConfirm({ id: c.id, kind: 'close' })}
                                      style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: sub, fontSize: 12, cursor: 'pointer' }}>
                                      終了する
                                    </button>
                                  )}
                                  {!c.cancelled && (
                                    <button type="button" onClick={() => setActionConfirm({ id: c.id, kind: 'cancel' })}
                                      style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #dc3545', background: 'transparent', color: '#dc3545', fontSize: 12, cursor: 'pointer' }}>
                                      取消（誤発信）
                                    </button>
                                  )}
                                  <button type="button" onClick={() => navigate(`/safety?check=${c.id}`)}
                                    style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: sub, fontSize: 12, cursor: 'pointer' }}>
                                    集計画面を開く →
                                  </button>
                                </div>

                                {actionConfirm?.id === c.id && (
                                  <div style={{ border: `2px solid ${actionConfirm.kind === 'cancel' ? '#dc3545' : border}`, borderRadius: 8, padding: 10 }}>
                                    <p style={{ fontSize: 12, color: text, margin: '0 0 8px', fontWeight: 'bold' }}>
                                      {actionConfirm.kind === 'close'
                                        ? 'この安否確認を終了しますか？（終了後も遅れた回答は受け付けます）'
                                        : 'この安否確認を取消しますか？ 宛先全員の画面から消え、「誤送信でした」の通知が送られます'}
                                    </p>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                      <button type="button" disabled={busy} onClick={() => doCloseOrCancel(c.id, actionConfirm.kind)}
                                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: actionConfirm.kind === 'cancel' ? '#dc3545' : '#856404', color: '#fff', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                                        {busy ? '処理中...' : 'はい'}
                                      </button>
                                      <button type="button" onClick={() => setActionConfirm(null)}
                                        style={{ padding: '5px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 12, cursor: 'pointer' }}>キャンセル</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
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
