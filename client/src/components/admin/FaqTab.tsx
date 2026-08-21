import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useDarkMode } from '../../hooks/useDarkMode';
import { supabase } from '../../lib/supabaseClient';
import {
  fetchFaqTopics,
  createFaqTopic,
  updateFaqTopic,
  deleteFaqTopic,
  saveFaqTopicRelations,
  saveFaqAnswer,
  deleteFaqAnswer,
  answerState,
  ANSWER_STATE_LABEL,
  resolveAnswer,
  FAQ_SCHOOL_OPTIONS,
  FAQ_COURSE_OPTIONS,
  type FaqTopic,
  type FaqAnswer,
  type FaqAudience,
  type FaqTopicInput,
  type FaqAnswerInput,
} from '../../lib/faq';
import { todayJstStr } from '../../lib/breakCalc';

// FAQ管理タブ。
// ・質問を作り、その下に「回答」を複数ぶら下げる。回答は対象（役職／校・コース）と期間を持つ。
// ・回答の期間があるので、料金改定などを「その日から切り替わる」形で予約できる。
//   当日に手で差し替える必要がなく、切り替え忘れが構造的に起きない。
// ・共有アカウント（Q&A編集専用）で使うため、保存時に編集者の名前を残す。
// alert()/confirm() は使わず、確認はインラインで表示する。

const AUDIENCE_LABEL: Record<FaqAudience, string> = {
  internal: '社内向け（スタッフ）',
  public: '社外向け（お客様）',
};

// 社内向けの出し分けは役職で行う（社内サイトは既に役職で画面を出し分けているため同じ基準）
const ROLE_OPTIONS = ['パート', '一般', 'フロア責任者', 'リーダー', 'マネージャー', '社長', '管理者'];

// 社外向けの出し分けは校×コース。定義は lib/faq.ts（お客様向けウィジェットと共用）
const SCHOOL_OPTIONS = FAQ_SCHOOL_OPTIONS;
const COURSE_OPTIONS = FAQ_COURSE_OPTIONS;

const emptyTopicForm = (audience: FaqAudience): FaqTopicInput => ({
  audience,
  category: '',
  question: '',
  keywords: [],
  is_published: false,
  is_featured: false,
  needs_review: false,
  review_note: null,
  sort_order: 0,
});

const emptyAnswerForm = (): FaqAnswerInput => ({
  body: '',
  source_label: null,
  source_url: null,
  valid_from: null,
  valid_until: null,
  needs_refresh: false,
  refresh_note: null,
  targets: [],
});

interface FaqTabProps {
  /** 管理者だけが「Q&A編集アカウント」の設定を触れる。専用アカウント自身には出さない */
  canManageEditors?: boolean;
}

const FaqTab: React.FC<FaqTabProps> = ({ canManageEditors = false }) => {
  const isDarkMode = useDarkMode();

  const [audience, setAudience] = useState<FaqAudience>('internal');
  const [topics, setTopics] = useState<FaqTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  // 編集者の名前（共有アカウント対策：誰が直したかを残す）
  // 共有アカウントではログイン情報から本人を特定できないため、保存のたびに名前を入力してもらう
  const [editorName, setEditorName] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // 🚨 名前欄は画面のいちばん上、編集フォームはずっと下に出る。
  //    名前が空だと保存されないが、エラーが画面外に出るため「押しても効かない」ように見えていた。
  //    そこで①フォームの中（保存ボタンの上）にも理由を出し、②名前欄を赤くしてそこまでスクロールする。
  const editorNameRef = React.useRef<HTMLDivElement | null>(null);
  const [editorNameError, setEditorNameError] = useState(false);

  /** 名前が未入力なら、理由を出して名前欄まで運ぶ（保存できないときの共通処理） */
  const requireEditorName = (): boolean => {
    if (editorName.trim()) return true;
    setEditorNameError(true);
    setErrorMsg('画面上部の「編集する方のお名前」を入力してください（誰が直したかを記録に残すため必要です）');
    editorNameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  };

  // 質問フォーム
  const [topicEditId, setTopicEditId] = useState<string | null>(null);
  const [topicForm, setTopicForm] = useState<FaqTopicInput>(emptyTopicForm('internal'));
  const [keywordText, setKeywordText] = useState('');
  // 関連質問（違う場合はこちら）。似た質問（25日ルール3種など）を取り違えたとき、
  // 回答の下のボタン1つで正しい方に移れるようにする
  const [relForm, setRelForm] = useState<{ related_topic_id: string; label: string }[]>([]);
  const [showTopicForm, setShowTopicForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteTopic, setConfirmDeleteTopic] = useState<string | null>(null);

  // 回答フォーム
  const [answerTopicId, setAnswerTopicId] = useState<string | null>(null);
  const [answerEditId, setAnswerEditId] = useState<string | null>(null);
  const [answerForm, setAnswerForm] = useState<FaqAnswerInput>(emptyAnswerForm());
  const [confirmDeleteAnswer, setConfirmDeleteAnswer] = useState<string | null>(null);

  // Q&A編集アカウントの設定（管理者のみ）
  const [showEditorSetting, setShowEditorSetting] = useState(false);
  const [staffList, setStaffList] = useState<{ id: string; name: string; email: string; is_faq_editor: boolean }[]>([]);
  const [editorBusyId, setEditorBusyId] = useState<string | null>(null);

  // 展開している質問
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // プレビューの基準日（予約した回答が正しく切り替わるか事前に確認するため）
  const [previewDate, setPreviewDate] = useState(todayJstStr());

  // 一覧の絞り込み（件数が多いと目的の質問を探せないため）
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | 'published' | 'unpublished' | 'review' | 'refresh' | 'scheduled' | 'expired' | 'noanswer'>('all');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${borderColor}`,
    fontSize: 14, boxSizing: 'border-box', background: inputBg, color: text,
  };

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await fetchFaqTopics(audience);
    setTopics(rows);
    setLoading(false);
  }, [audience]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  const loadStaff = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, name, email, is_faq_editor')
      .eq('is_active', true)
      .order('name');
    setStaffList((data ?? []) as typeof staffList);
  }, []);

  useEffect(() => { if (canManageEditors && showEditorSetting) loadStaff(); }, [canManageEditors, showEditorSetting, loadStaff]);

  // Q&A編集アカウントのON/OFF。profiles の直接更新は管理者のみ許可されているため、
  // 専用アカウント自身がここを操作して権限を増やすことはできない（DB側で拒否される）
  const toggleEditor = async (id: string, next: boolean) => {
    setEditorBusyId(id);
    const { error } = await supabase.from('profiles').update({ is_faq_editor: next }).eq('id', id).select('id');
    setEditorBusyId(null);
    if (error) { setErrorMsg(`変更できませんでした：${error.message}`); return; }
    flashSaved(next ? 'Q&A編集をONにしました' : 'Q&A編集をOFFにしました');
    loadStaff();
  };

  const flashSaved = (msg: string) => {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 3000);
  };

  // ---- 質問の保存 ----
  const startNewTopic = () => {
    setTopicEditId(null);
    setTopicForm(emptyTopicForm(audience));
    setKeywordText('');
    setRelForm([]);
    setShowTopicForm(true);
    setErrorMsg('');
  };

  const startEditTopic = (t: FaqTopic) => {
    setTopicEditId(t.id);
    setTopicForm({
      audience: t.audience, category: t.category, question: t.question, keywords: t.keywords,
      is_published: t.is_published, is_featured: t.is_featured,
      needs_review: t.needs_review, review_note: t.review_note, sort_order: t.sort_order,
    });
    setKeywordText(t.keywords.join(' '));
    setRelForm(t.related.map(r => ({ related_topic_id: r.topic_id, label: r.label ?? '' })));
    setShowTopicForm(true);
    setErrorMsg('');
  };

  const saveTopic = async () => {
    if (!topicForm.question.trim()) { setErrorMsg('質問文を入力してください'); return; }
    if (!topicForm.category.trim()) { setErrorMsg('カテゴリを入力してください'); return; }
    if (!requireEditorName()) return;
    setSaving(true);
    setErrorMsg('');
    const input: FaqTopicInput = {
      ...topicForm,
      audience,
      keywords: keywordText.split(/[\s,、]+/).map(s => s.trim()).filter(Boolean),
    };
    let savedTopicId = topicEditId;
    if (topicEditId) {
      const res = await updateFaqTopic(topicEditId, input, currentUserId, editorName.trim());
      if (res.error) { setSaving(false); setErrorMsg(`保存できませんでした：${res.error.message}`); return; }
    } else {
      const res = await createFaqTopic(input, currentUserId, editorName.trim());
      if (res.error || !res.data) { setSaving(false); setErrorMsg(`保存できませんでした：${res.error?.message ?? ''}`); return; }
      savedTopicId = res.data.id;
    }
    // 関連質問も一緒に保存（未選択の行は除外）
    if (savedTopicId) {
      const rels = relForm
        .filter(r => r.related_topic_id)
        .map(r => ({ related_topic_id: r.related_topic_id, label: r.label.trim() || null }));
      const relRes = await saveFaqTopicRelations(savedTopicId, rels);
      if (relRes.error) { setSaving(false); setErrorMsg(`関連質問を保存できませんでした：${relRes.error}`); return; }
    }
    setSaving(false);
    setShowTopicForm(false);
    flashSaved('保存しました');
    load();
  };

  const removeTopic = async (id: string) => {
    const { error } = await deleteFaqTopic(id);
    setConfirmDeleteTopic(null);
    if (error) { setErrorMsg(`削除できませんでした：${error.message}`); return; }
    flashSaved('削除しました');
    load();
  };

  // ---- 回答の保存 ----
  const startNewAnswer = (topicId: string) => {
    setAnswerTopicId(topicId);
    setAnswerEditId(null);
    setAnswerForm(emptyAnswerForm());
    setErrorMsg('');
  };

  const startEditAnswer = (topicId: string, a: FaqAnswer) => {
    setAnswerTopicId(topicId);
    setAnswerEditId(a.id);
    setAnswerForm({
      body: a.body, source_label: a.source_label, source_url: a.source_url,
      valid_from: a.valid_from, valid_until: a.valid_until,
      needs_refresh: a.needs_refresh, refresh_note: a.refresh_note,
      targets: a.targets.map(t => ({ school: t.school, course: t.course, role_title: t.role_title })),
    });
    setErrorMsg('');
  };

  const saveAnswer = async () => {
    if (!answerTopicId) return;
    if (!answerForm.body.trim()) { setErrorMsg('回答文を入力してください'); return; }
    if (!requireEditorName()) return;
    setSaving(true);
    setErrorMsg('');
    const { error } = await saveFaqAnswer(answerTopicId, answerEditId, answerForm, currentUserId, editorName.trim());
    setSaving(false);
    if (error) { setErrorMsg(`保存できませんでした：${error}`); return; }
    setAnswerTopicId(null);
    flashSaved('保存しました');
    load();
  };

  const removeAnswer = async (id: string) => {
    const { error } = await deleteFaqAnswer(id);
    setConfirmDeleteAnswer(null);
    if (error) { setErrorMsg(`削除できませんでした：${error.message}`); return; }
    flashSaved('削除しました');
    load();
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const needsReviewCount = useMemo(() => topics.filter(t => t.needs_review).length, [topics]);

  // 絞り込みに出すカテゴリ（登録済みのものだけ・件数つき）
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    topics.forEach(t => map.set(t.category, (map.get(t.category) ?? 0) + 1));
    return [...map.entries()];
  }, [topics]);

  // 検索は質問文だけでなく、カテゴリ・キーワード・回答本文も対象にする
  // （「この文章どこに書いたっけ」で探せるようにするため）
  const filteredTopics = useMemo(() => {
    const q = search.trim().toLowerCase();
    return topics.filter(t => {
      if (catFilter && t.category !== catFilter) return false;

      if (stateFilter === 'published' && !t.is_published) return false;
      if (stateFilter === 'unpublished' && t.is_published) return false;
      if (stateFilter === 'review' && !t.needs_review) return false;
      if (stateFilter === 'refresh' && !t.answers.some(a => a.needs_refresh)) return false;
      if (stateFilter === 'scheduled' && !t.answers.some(a => answerState(a, previewDate) === 'scheduled')) return false;
      if (stateFilter === 'expired' && !t.answers.some(a => answerState(a, previewDate) === 'expired')) return false;
      if (stateFilter === 'noanswer' && resolveAnswer(t, {}, previewDate)) return false;

      if (!q) return true;
      const haystack = [
        t.question, t.category, ...(t.keywords ?? []),
        ...t.answers.map(a => `${a.body} ${a.source_label ?? ''}`),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [topics, search, catFilter, stateFilter, previewDate]);
  const needsRefreshCount = useMemo(
    () => topics.reduce((n, t) => n + t.answers.filter(a => a.needs_refresh).length, 0), [topics]);

  // 対象（役職 or 校コース）の追加・削除
  const addTarget = () => {
    setAnswerForm(f => ({
      ...f,
      targets: [...f.targets, audience === 'internal' ? { role_title: ROLE_OPTIONS[0] } : { school: SCHOOL_OPTIONS[0], course: COURSE_OPTIONS[0] }],
    }));
  };
  const updateTarget = (i: number, patch: Record<string, string | null>) => {
    setAnswerForm(f => ({ ...f, targets: f.targets.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  };
  const removeTarget = (i: number) => {
    setAnswerForm(f => ({ ...f, targets: f.targets.filter((_, idx) => idx !== i) }));
  };

  const stateColor = (s: ReturnType<typeof answerState>) =>
    s === 'active' ? '#16a34a' : s === 'scheduled' ? '#1976d2' : s === 'draft' ? '#9a3412' : '#6b7280';

  return (
    <div style={{ color: text }}>
      <h3 style={{ margin: '0 0 4px', color: text }}>❓ FAQ管理</h3>
      <p style={{ fontSize: 12, color: subText, margin: '0 0 16px', lineHeight: 1.7 }}>
        質問と回答を登録します。回答は「いつから・いつまで」を持てるので、料金改定などをあらかじめ予約でき、当日の差し替え作業が要りません。
        表示されるのはここに登録した文章そのままで、システムが文章を作ることはありません。
      </p>

      {/* 編集者の名前（共有アカウント対策）。
          未入力のまま保存を押すと、ここが赤くなり自動でここまでスクロールしてくる */}
      <div ref={editorNameRef} style={{
        background: editorNameError ? (isDarkMode ? '#4a2b30' : '#fdecea') : (isDarkMode ? '#495057' : '#f8f9fa'),
        border: `1px solid ${editorNameError ? '#e24b4a' : borderColor}`,
        borderRadius: 8, padding: 12, marginBottom: 16, scrollMarginTop: 100,
      }}>
        <label style={{ fontSize: 13, fontWeight: 'bold', color: editorNameError ? '#dc3545' : text, display: 'block', marginBottom: 6 }}>
          編集する方のお名前 <span style={{ color: '#dc3545' }}>*</span>
        </label>
        <input value={editorName}
          onChange={e => { setEditorName(e.target.value); if (e.target.value.trim()) { setEditorNameError(false); setErrorMsg(''); } }}
          placeholder="例：山田 太郎"
          style={{ ...inputStyle, maxWidth: 260, borderColor: editorNameError ? '#e24b4a' : undefined }} />
        <p style={{ fontSize: 11, color: subText, margin: '6px 0 0' }}>
          共有のアカウントで編集する場合があるため、「誰が直したか」を記録に残します。
        </p>
      </div>

      {/* Q&A編集アカウントの設定（管理者のみ） */}
      {canManageEditors && (
        <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, marginBottom: 16, overflow: 'hidden' }}>
          <button type="button" onClick={() => setShowEditorSetting(v => !v)}
            style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: isDarkMode ? '#495057' : '#f8f9fa', border: 'none', color: text, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>🔑 Q&amp;Aを編集できる人の設定</span>
            <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>{showEditorSetting ? '閉じる ▲' : 'クリックして開く ▼'}</span>
          </button>
          {showEditorSetting && (
            <div style={{ padding: 14, background: bg }}>
              <p style={{ fontSize: 12, color: subText, margin: '0 0 10px', lineHeight: 1.7 }}>
                ONにした方は、ログインすると<strong>この FAQ 管理画面だけ</strong>が開きます（他の管理機能は見えません）。
                スタッフで共有して使うアカウントを想定しています。設定を変えられるのは管理者だけです。
              </p>
              <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${borderColor}`, borderRadius: 6 }}>
                {staffList.map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${borderColor}` }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
                      <input type="checkbox" checked={s.is_faq_editor} disabled={editorBusyId === s.id}
                        onChange={e => toggleEditor(s.id, e.target.checked)} />
                      <span style={{ fontSize: 13, color: text }}>{s.name || '(名前未設定)'}</span>
                      <span style={{ fontSize: 11, color: subText }}>{s.email}</span>
                    </label>
                    {s.is_faq_editor && <span style={{ fontSize: 11, background: '#e3f2fd', color: '#1565c0', padding: '2px 8px', borderRadius: 4 }}>Q&amp;A編集</span>}
                  </div>
                ))}
                {staffList.length === 0 && <p style={{ fontSize: 13, color: subText, padding: 12, margin: 0 }}>読み込んでいます...</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 社内向け／社外向けの切り替え */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['internal', 'public'] as FaqAudience[]).map(a => (
          <button key={a} type="button" onClick={() => setAudience(a)}
            style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 14, cursor: 'pointer',
              fontWeight: audience === a ? 'bold' : 'normal',
              border: `2px solid ${audience === a ? '#1565c0' : '#90caf9'}`,
              background: audience === a ? '#1976d2' : '#e3f2fd',
              color: audience === a ? '#fff' : '#1565c0',
            }}>
            {AUDIENCE_LABEL[a]}
          </button>
        ))}
      </div>

      {/* 要対応の件数 */}
      {(needsReviewCount > 0 || needsRefreshCount > 0) && (
        <div style={{ background: '#fff8e1', border: '1px solid #f59e0b', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          {needsReviewCount > 0 && <div style={{ fontSize: 13, color: '#92400e' }}>⚠️ 内容の確認が必要な質問が {needsReviewCount} 件あります</div>}
          {needsRefreshCount > 0 && <div style={{ fontSize: 13, color: '#92400e', marginTop: needsReviewCount > 0 ? 4 : 0 }}>🔄 定期的な見直しが必要な回答が {needsRefreshCount} 件あります</div>}
        </div>
      )}

      {savedMsg && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 14, fontWeight: 'bold', color: '#166534' }}>
          ✓ {savedMsg}
        </div>
      )}
      {errorMsg && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 14, color: '#842029' }}>
          {errorMsg}
        </div>
      )}

      {/* プレビュー基準日 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: subText }}>表示を確認する日：</span>
        <input type="date" value={previewDate} onChange={e => setPreviewDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        {previewDate !== todayJstStr() && (
          <button type="button" onClick={() => setPreviewDate(todayJstStr())}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
            今日に戻す
          </button>
        )}
        <span style={{ fontSize: 11, color: subText }}>※未来の日付にすると、予約した回答が正しく切り替わるか確認できます</span>
      </div>

      {/* 一覧の絞り込み。件数が増えると目的の質問を探せなくなるため */}
      <div style={{ background: isDarkMode ? '#343a40' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 10, padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="質問・キーワード・回答の文章で探す"
            style={{ ...inputStyle, flex: 1, minWidth: 200 }}
          />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: 150 }}>
            <option value="">カテゴリ：すべて</option>
            {categoryCounts.map(([cat, count]) => (
              <option key={cat} value={cat}>{cat}（{count}）</option>
            ))}
          </select>
          {(search || catFilter || stateFilter !== 'all') && (
            <button type="button" onClick={() => { setSearch(''); setCatFilter(''); setStateFilter('all'); }}
              style={{ fontSize: 12, padding: '8px 14px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
              ✕ 絞り込みを外す
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {([
            ['all', 'すべて'],
            ['published', '公開中'],
            ['unpublished', '非公開'],
            ['review', '⚠️ 要確認'],
            ['refresh', '🔄 要更新'],
            ['scheduled', '予約あり'],
            ['expired', '期限切れあり'],
            ['noanswer', 'この日に出る回答なし'],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setStateFilter(key)}
              style={{
                fontSize: 12, fontWeight: 'bold', padding: '6px 12px', borderRadius: 16, cursor: 'pointer',
                background: stateFilter === key ? '#1976d2' : '#e3f2fd',
                border: `2px solid ${stateFilter === key ? '#1565c0' : '#90caf9'}`,
                color: stateFilter === key ? '#fff' : '#1565c0',
              }}>
              {label}
            </button>
          ))}
        </div>
        {(search || catFilter || stateFilter !== 'all') && (
          <div style={{ fontSize: 12, color: subText, marginTop: 10 }}>
            {topics.length}件中 {filteredTopics.length}件を表示中
          </div>
        )}
      </div>

      <button type="button" onClick={startNewTopic}
        style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer', marginBottom: 16 }}>
        ＋ 質問を追加
      </button>

      {/* 質問フォーム */}
      {showTopicForm && (
        <div style={{ background: bg, border: `2px solid #1976d2`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <h4 style={{ margin: '0 0 12px', color: text, fontSize: 15 }}>{topicEditId ? '質問を編集' : '質問を追加'}</h4>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>カテゴリ <span style={{ color: '#dc3545' }}>*</span></label>
              <input value={topicForm.category} onChange={e => setTopicForm(f => ({ ...f, category: e.target.value }))}
                placeholder={audience === 'internal' ? '例：休暇申請' : '例：体験レッスン'} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>質問文 <span style={{ color: '#dc3545' }}>*</span></label>
              <input value={topicForm.question} onChange={e => setTopicForm(f => ({ ...f, question: e.target.value }))}
                placeholder="例：欠席・振替はどうすればいいですか？" style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>検索キーワード（空白区切り）</label>
              <input value={keywordText} onChange={e => setKeywordText(e.target.value)}
                placeholder="例：欠席 振替 休む 連絡 やり方" style={inputStyle} />
              <p style={{ fontSize: 11, color: subText, margin: '4px 0 0' }}>
                利用者が入力しそうな言い換えを並べます。ここに無い言葉では見つかりません。
              </p>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13, color: text, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={topicForm.is_published} onChange={e => setTopicForm(f => ({ ...f, is_published: e.target.checked }))} />
                公開する
              </label>
              <label style={{ fontSize: 13, color: text, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={topicForm.is_featured} onChange={e => setTopicForm(f => ({ ...f, is_featured: e.target.checked }))} />
                「よくあるご質問」に出す
              </label>
              <label style={{ fontSize: 13, color: text, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={topicForm.needs_review} onChange={e => setTopicForm(f => ({ ...f, needs_review: e.target.checked }))} />
                内容の確認が必要
              </label>
            </div>
            {topicForm.needs_review && (
              <div>
                <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>何を確認するか</label>
                <input value={topicForm.review_note ?? ''} onChange={e => setTopicForm(f => ({ ...f, review_note: e.target.value || null }))}
                  placeholder="例：対象年齢の下限を確認する" style={inputStyle} />
              </div>
            )}
            <div>
              <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>並び順（小さいほど上）</label>
              <input type="number" value={topicForm.sort_order} onChange={e => setTopicForm(f => ({ ...f, sort_order: Number(e.target.value) || 0 }))}
                style={{ ...inputStyle, width: 120 }} />
            </div>

            {/* 関連質問（違う場合はこちら）。今はお客様向けの画面だけが表示する */}
            {audience === 'public' && (
              <div>
                <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>関連質問（「違う場合はこちら」のボタン）</label>
                <p style={{ fontSize: 11, color: subText, margin: '0 0 6px', lineHeight: 1.7 }}>
                  似た質問（例：予約の25日ルールが3種類）を間違えて開いた方が、ボタン1つで正しい方に移れます。
                  参照先の質問が削除されるとボタンも自動で消えます。
                </p>
                {relForm.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select value={r.related_topic_id}
                      onChange={e => setRelForm(list => list.map((x, idx) => (idx === i ? { ...x, related_topic_id: e.target.value } : x)))}
                      style={{ ...inputStyle, width: 'auto', minWidth: 220, maxWidth: 340 }}>
                      <option value="">（質問を選ぶ）</option>
                      {topics
                        .filter(o => o.id !== topicEditId)
                        .map(o => <option key={o.id} value={o.id}>{o.question}</option>)}
                    </select>
                    <input value={r.label}
                      onChange={e => setRelForm(list => list.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
                      placeholder="ボタンの文言（空欄＝質問文のまま）"
                      style={{ ...inputStyle, width: 'auto', minWidth: 200, flex: 1 }} />
                    <button type="button" onClick={() => setRelForm(list => list.filter((_, idx) => idx !== i))}
                      style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                      外す
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => setRelForm(list => [...list, { related_topic_id: '', label: '' }])}
                  style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px dashed ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                  ＋ 関連質問を追加
                </button>
              </div>
            )}
          </div>
          {/* 🚨 押した場所で理由が分かるように、フォームの中にもエラーを出す。
                 画面上部のエラーだけだと、下のフォームからは見えず「押しても効かない」と誤解される */}
          {errorMsg && (
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6, padding: '8px 12px', marginTop: 12, fontSize: 12.5, color: '#842029' }}>
              {errorMsg}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={() => setShowTopicForm(false)}
              style={{ padding: '9px 18px', borderRadius: 8, border: `1px solid ${borderColor}`, background: 'none', color: text, fontSize: 14, cursor: 'pointer' }}>
              キャンセル
            </button>
            <button type="button" onClick={saveTopic} disabled={saving}
              style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: saving ? '#6c757d' : '#28a745', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}>
              {saving ? '保存中...' : '保存する'}
            </button>
          </div>
        </div>
      )}

      {/* 質問一覧 */}
      {loading ? (
        <p style={{ color: subText, fontSize: 14 }}>読み込んでいます...</p>
      ) : topics.length === 0 ? (
        <p style={{ color: subText, fontSize: 14 }}>まだ質問が登録されていません。「＋ 質問を追加」から作成してください。</p>
      ) : filteredTopics.length === 0 ? (
        <p style={{ color: subText, fontSize: 14 }}>絞り込みに当てはまる質問がありません。条件を変えるか「✕ 絞り込みを外す」を押してください。</p>
      ) : (
        filteredTopics.map(t => {
          const shown = resolveAnswer(t, {}, previewDate);
          const isOpen = expanded.has(t.id);
          return (
            <div key={t.id} style={{ background: bg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, background: isDarkMode ? '#495057' : '#eef2f7', color: subText, padding: '2px 8px', borderRadius: 4 }}>{t.category}</span>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: t.is_published ? '#dcfce7' : '#f3f4f6', color: t.is_published ? '#166534' : '#6b7280' }}>
                      {t.is_published ? '公開中' : '非公開'}
                    </span>
                    {t.is_featured && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#e3f2fd', color: '#1565c0' }}>よくある質問</span>}
                    {t.needs_review && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#fff8e1', color: '#92400e', fontWeight: 'bold' }}>⚠️ 要確認</span>}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{t.question}</div>
                  {t.needs_review && t.review_note && (
                    <div style={{ fontSize: 12, color: '#92400e', marginTop: 4 }}>確認事項：{t.review_note}</div>
                  )}
                  <div style={{ fontSize: 11, color: subText, marginTop: 4 }}>
                    回答 {t.answers.length}件
                    {shown ? '' : '　※この日に出る回答がありません（利用者には表示されません）'}
                    {t.updated_by_name ? `　／　最終更新：${t.updated_by_name}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => toggleExpand(t.id)}
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                    {isOpen ? '閉じる' : '回答を見る'}
                  </button>
                  {/* 質問カードと回答カードの両方に編集ボタンがあるため、どちらを直すのか名前で分ける。
                      1つの質問に回答が複数ぶら下がる作りなので、ボタン自体は分かれているのが正しい */}
                  <button type="button" onClick={() => startEditTopic(t)}
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                    質問を編集
                  </button>
                  <button type="button" onClick={() => setConfirmDeleteTopic(t.id)}
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid #dc3545', background: 'none', color: '#dc3545', cursor: 'pointer' }}>
                    削除
                  </button>
                </div>
              </div>

              {confirmDeleteTopic === t.id && (
                <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: 12, marginTop: 10 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: '#842029' }}>
                    この質問と、ぶら下がっている回答をすべて削除します。元に戻せません。
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={() => setConfirmDeleteTopic(null)}
                      style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid #842029', background: 'none', color: '#842029', cursor: 'pointer' }}>
                      キャンセル
                    </button>
                    <button type="button" onClick={() => removeTopic(t.id)}
                      style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', fontWeight: 'bold', cursor: 'pointer' }}>
                      削除する
                    </button>
                  </div>
                </div>
              )}

              {isOpen && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${borderColor}` }}>
                  {t.answers.length === 0 && (
                    <p style={{ fontSize: 13, color: subText, margin: '0 0 10px' }}>まだ回答がありません。</p>
                  )}
                  {[...t.answers]
                    .sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''))
                    .map(a => {
                      const st = answerState(a, previewDate);
                      return (
                        <div key={a.id} style={{ border: `1px solid ${st === 'active' ? '#86efac' : borderColor}`, borderRadius: 8, padding: 10, marginBottom: 8, background: isDarkMode ? '#3d4349' : '#fbfcfd' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 'bold', color: stateColor(st) }}>{ANSWER_STATE_LABEL[st]}</span>
                            <span style={{ fontSize: 11, color: subText }}>
                              {a.valid_from ? `${a.valid_from}〜${a.valid_until ?? ''}` : '（適用開始日が未設定）'}
                            </span>
                            {a.needs_refresh && <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#fff8e1', color: '#92400e' }}>🔄 要更新</span>}
                          </div>
                          {a.targets.length > 0 && (
                            <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>
                              対象：{a.targets.map(tg => [tg.role_title, tg.school, tg.course].filter(Boolean).join('・')).join(' / ')}
                            </div>
                          )}
                          {a.targets.length === 0 && (
                            <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>対象：全員（共通の回答）</div>
                          )}
                          <div style={{ fontSize: 13, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{a.body}</div>
                          {a.source_label && (
                            <div style={{ fontSize: 11, color: subText, marginTop: 6 }}>出典：{a.source_label}</div>
                          )}
                          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            {/* 「この回答を出す相手（対象）」や適用期間はここから直す。
                                質問カード右上の「質問を編集」では変えられないため、名前で区別する */}
                            <button type="button" onClick={() => startEditAnswer(t.id, a)}
                              style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                              回答を編集
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteAnswer(a.id)}
                              style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid #dc3545', background: 'none', color: '#dc3545', cursor: 'pointer' }}>
                              削除
                            </button>
                          </div>
                          {confirmDeleteAnswer === a.id && (
                            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6, padding: 10, marginTop: 8 }}>
                              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#842029' }}>この回答を削除します。元に戻せません。</p>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button type="button" onClick={() => setConfirmDeleteAnswer(null)}
                                  style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid #842029', background: 'none', color: '#842029', cursor: 'pointer' }}>
                                  キャンセル
                                </button>
                                <button type="button" onClick={() => removeAnswer(a.id)}
                                  style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', fontWeight: 'bold', cursor: 'pointer' }}>
                                  削除する
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}

                  <button type="button" onClick={() => startNewAnswer(t.id)}
                    style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px dashed ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                    ＋ 回答を追加
                  </button>

                  {/* 回答フォーム */}
                  {answerTopicId === t.id && (
                    <div style={{ background: bg, border: '2px solid #1976d2', borderRadius: 10, padding: 14, marginTop: 10 }}>
                      <h5 style={{ margin: '0 0 10px', fontSize: 14, color: text }}>{answerEditId ? '回答を編集' : '回答を追加'}</h5>
                      <div style={{ display: 'grid', gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>回答文 <span style={{ color: '#dc3545' }}>*</span></label>
                          <textarea value={answerForm.body} onChange={e => setAnswerForm(f => ({ ...f, body: e.target.value }))}
                            rows={5} style={{ ...inputStyle, resize: 'vertical' }} placeholder="利用者にそのまま表示される文章です" />
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 150 }}>
                            <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>この日から出す</label>
                            <input type="date" value={answerForm.valid_from ?? ''} onChange={e => setAnswerForm(f => ({ ...f, valid_from: e.target.value || null }))} style={inputStyle} />
                            <p style={{ fontSize: 11, color: subText, margin: '4px 0 0' }}>空欄のままだと下書き扱いで、利用者には出ません。</p>
                          </div>
                          <div style={{ flex: 1, minWidth: 150 }}>
                            <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>この日まで出す（任意）</label>
                            <input type="date" value={answerForm.valid_until ?? ''} onChange={e => setAnswerForm(f => ({ ...f, valid_until: e.target.value || null }))} style={inputStyle} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 150 }}>
                            <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>出典の名前</label>
                            <input value={answerForm.source_label ?? ''} onChange={e => setAnswerForm(f => ({ ...f, source_label: e.target.value || null }))}
                              placeholder="例：入会のしおり（四条本校）" style={inputStyle} />
                          </div>
                          <div style={{ flex: 1, minWidth: 150 }}>
                            <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>出典のリンク</label>
                            <input value={answerForm.source_url ?? ''} onChange={e => setAnswerForm(f => ({ ...f, source_url: e.target.value || null }))}
                              placeholder="https://..." style={inputStyle} />
                          </div>
                        </div>

                        {/* 対象 */}
                        <div>
                          <label style={{ fontSize: 13, color: text, display: 'block', marginBottom: 4 }}>
                            この回答を出す相手
                          </label>
                          <p style={{ fontSize: 11, color: subText, margin: '0 0 6px' }}>
                            何も指定しなければ全員向けの共通の回答になります。
                            {audience === 'internal' ? '役職を指定すると、その役職の方だけに出ます。' : '校・コースを指定すると、その方だけに出ます。'}
                          </p>
                          {answerForm.targets.map((tg, i) => (
                            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {audience === 'internal' ? (
                                <select value={tg.role_title ?? ''} onChange={e => updateTarget(i, { role_title: e.target.value })} style={{ ...inputStyle, width: 'auto', minWidth: 140 }}>
                                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                              ) : (
                                <>
                                  <select value={tg.school ?? ''} onChange={e => updateTarget(i, { school: e.target.value || null })} style={{ ...inputStyle, width: 'auto', minWidth: 130 }}>
                                    <option value="">（校を問わない）</option>
                                    {SCHOOL_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                  </select>
                                  <select value={tg.course ?? ''} onChange={e => updateTarget(i, { course: e.target.value || null })} style={{ ...inputStyle, width: 'auto', minWidth: 180 }}>
                                    <option value="">（コースを問わない）</option>
                                    {COURSE_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                </>
                              )}
                              <button type="button" onClick={() => removeTarget(i)}
                                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                                外す
                              </button>
                            </div>
                          ))}
                          <button type="button" onClick={addTarget}
                            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px dashed ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
                            ＋ 対象を追加
                          </button>
                        </div>

                        <label style={{ fontSize: 13, color: text, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="checkbox" checked={answerForm.needs_refresh} onChange={e => setAnswerForm(f => ({ ...f, needs_refresh: e.target.checked }))} />
                          定期的な見直しが必要（季節もの・料金など）
                        </label>
                        {answerForm.needs_refresh && (
                          <input value={answerForm.refresh_note ?? ''} onChange={e => setAnswerForm(f => ({ ...f, refresh_note: e.target.value || null }))}
                            placeholder="例：シーズンごとに案内ページのリンクを差し替える" style={inputStyle} />
                        )}
                      </div>
                      {/* 🚨 押した場所で理由が分かるように、フォームの中にもエラーを出す（質問フォームと同じ理由） */}
                      {errorMsg && (
                        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6, padding: '8px 12px', marginTop: 10, fontSize: 12.5, color: '#842029' }}>
                          {errorMsg}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <button type="button" onClick={() => setAnswerTopicId(null)}
                          style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${borderColor}`, background: 'none', color: text, fontSize: 13, cursor: 'pointer' }}>
                          キャンセル
                        </button>
                        <button type="button" onClick={saveAnswer} disabled={saving}
                          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: saving ? '#6c757d' : '#28a745', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}>
                          {saving ? '保存中...' : '保存する'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};

export default FaqTab;
