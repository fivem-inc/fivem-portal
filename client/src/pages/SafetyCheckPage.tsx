import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { useSafetyPendingCount } from '../hooks/useSafetyPendingCount';
import { loadDraft, saveDraft } from '../lib/draftStorage';

interface SafetyCheckPageProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
}

type Pattern = 'safety3' | 'safety4' | 'attendance2' | 'support';
type Choice = { key: string; label: string; color: 'green' | 'blue' | 'amber' | 'red' };

interface SafetyCheck {
  id: string;
  title: string;
  body: string;
  pattern: Pattern;
  options: Choice[];
  is_test: boolean;
  status: 'active' | 'closed';
  created_by: string;
  created_at: string;
  closed_by: string | null;
  closed_at: string | null;
  cancelled: boolean;
  cancelled_at: string | null;
  remind_interval_min: number;
  remind_max: number;
  remind_count: number;
  next_remind_at: string | null;
  all_answered_at: string | null;
}

interface SafetyResponse {
  check_id: string;
  user_id: string;
  choice: string;
  comment: string | null;
  is_proxy: boolean;
  proxy_by: string | null;
  answered_at: string;
}

interface Template {
  id: string;
  title: string;
  body: string;
  pattern: Pattern;
  sort_order: number;
  active: boolean;
}

const PATTERN_LABEL: Record<Pattern, string> = {
  safety3: '安否確認（無事です／被害あり）',
  safety4: '安否＋出勤確認（台風・大雪）',
  attendance2: '出勤可否のみ',
  support: '応援要請（お願い・手を挙げてもらう）',
};

// パターンの分類（発信画面で見出しを挟んで並べる。何を送るのか一目で分かるようにするため）
//   訓練は本番の災害用と混ざらないよう最後に独立させる（タイトルに「訓練」を含むもの）
const PATTERN_GROUPS: { heading: string; note: string; patterns: Pattern[]; training?: boolean }[] = [
  { heading: '🆘 災害時の安否確認', note: '全員に回答してもらいます（未回答の人には自動で再送）', patterns: ['safety3', 'safety4'] },
  { heading: '🚃 出勤の確認', note: '電車が止まった・大雪などで出勤の可否を聞きます', patterns: ['attendance2'] },
  { heading: '🙋 応援のお願い', note: '手が空いている人に手を挙げてもらいます（催促はしません）', patterns: ['support'] },
  { heading: '🧪 訓練', note: '操作を練習するための文面です（本番と同じように届きます）', patterns: ['safety3', 'safety4', 'attendance2', 'support'], training: true },
];

const isTrainingTemplate = (title: string) => title.includes('訓練');

// 発信時に「実際にスタッフの画面に出る回答ボタン」を見せるための一覧。
// ⚠️ supabase/functions/safety-check-send の PRESET_OPTIONS と必ず同じ内容にすること（片方だけ変えない）。
const PATTERN_OPTIONS: Record<Pattern, Choice[]> = {
  safety3: [
    { key: 'safe', label: '無事です', color: 'green' },
    { key: 'damaged_ok', label: '被害あり（助けは不要）', color: 'amber' },
    { key: 'damaged_help', label: '被害あり・助けが必要', color: 'red' },
  ],
  safety4: [
    { key: 'safe_can_work', label: '無事・出勤できます', color: 'green' },
    { key: 'safe_late', label: '無事・遅れて出勤します', color: 'blue' },
    { key: 'safe_cannot_work', label: '無事・出勤できません', color: 'amber' },
    { key: 'damaged_help', label: '被害あり・助けが必要', color: 'red' },
  ],
  attendance2: [
    { key: 'can_work', label: '出勤できます', color: 'green' },
    { key: 'cannot_work', label: '出勤できません', color: 'amber' },
  ],
  // 応援要請：安否確認と違い「お願い」なので催促しない（発信時のリマインド既定を0回にする）
  support: [
    { key: 'can_support', label: '応援に入れます', color: 'green' },
    { key: 'partial_support', label: '一部の時間なら入れます', color: 'blue' },
    { key: 'cannot_support', label: '今回は難しいです', color: 'amber' },
  ],
};

// 回答ボタンの色（信号色。選択肢が並んだとき同じ色が続かないよう4段階にしている）
const COLOR_STYLE: Record<'green' | 'blue' | 'amber' | 'red', { bg: string; border: string; text: string }> = {
  green: { bg: '#dcfce7', border: '#22c55e', text: '#166534' },
  blue:  { bg: '#e3f2fd', border: '#1976d2', text: '#0c447c' },
  amber: { bg: '#fff3cd', border: '#ffc107', text: '#856404' },
  red:   { bg: '#f8d7da', border: '#dc3545', text: '#721c24' },
};

// 自動リマインドの間隔・回数の選択肢。
//   停電・充電切れ・電波の輻輳で、連絡が取りづらい人ほど遅れて電源を入れる。
//   短い設定だけだと「一番心配な人に届く前にリマインドが尽きる」ので長い間隔も選べるようにしている。
//   例）6時間ごと×12回＝3日間 ／ 1日ごと×7回＝1週間
const REMIND_INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440];
const REMIND_COUNTS = [1, 2, 3, 4, 6, 8, 12, 24];

const intervalLabel = (min: number): string =>
  min >= 1440 ? `${min / 1440}日` : min >= 60 ? `${min / 60}時間` : `${min}分`;

const durationLabel = (min: number): string => {
  if (min >= 1440) {
    const d = min / 1440;
    return Number.isInteger(d) ? `${d}日` : `${Math.floor(d)}日${Math.round((d % 1) * 24)}時間`;
  }
  return min >= 60 ? `${Math.round(min / 60)}時間` : `${min}分`;
};

const PENDING_QUEUE_KEY = 'fivem_safety_pending_responses'; // { [checkId]: { choice, comment, clientKey, savedAt } }

type PendingQueue = Record<string, { choice: string; comment: string; clientKey: string; savedAt: number }>;

// 年まで出す（後から履歴を見たときに「いつの災害か」が分かるように）
function fmtDateTime(s: string | null): string {
  if (!s) return '';
  const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const SafetyCheckPage: React.FC<SafetyCheckPageProps> = ({ user, roleTitle, isAdmin }) => {
  const isDark = useDarkMode();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { refetch: refetchPending } = useSafetyPendingCount(user.id);

  const isManagerPlus = isAdmin || ['マネージャー', '社長', '管理者'].includes(roleTitle);
  const isLeader = roleTitle === 'リーダー';

  const card = isDark ? '#2c2c3e' : '#ffffff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#3d3d55' : '#e9ecef';

  const [view, setView] = useState<'answer' | 'send' | 'summary' | 'history'>('answer');
  const [allChecks, setAllChecks] = useState<SafetyCheck[]>([]);   // active(全件・閲覧権限のあるもの)＋自分が発信者/対象のclosed
  const [loading, setLoading] = useState(true);
  const [myResponses, setMyResponses] = useState<Record<string, SafetyResponse>>({});
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null); // 回答を変更中のcheck
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(searchParams.get('check'));

  const [errMsg, setErrMsg] = useState('');
  const [okMsg, setOkMsg] = useState('');

  // ---- データ取得 ----
  const loadAll = useCallback(async () => {
    setLoading(true);
    const { data: checks } = await supabase
      .from('safety_checks')
      .select('id, title, body, pattern, options, is_test, status, created_by, created_at, closed_by, closed_at, cancelled, cancelled_at, remind_interval_min, remind_max, remind_count, next_remind_at, all_answered_at')
      .order('created_at', { ascending: false })
      .limit(50);
    setAllChecks((checks ?? []) as SafetyCheck[]);

    const { data: myRes } = await supabase
      .from('safety_check_responses')
      .select('check_id, user_id, choice, comment, is_proxy, proxy_by, answered_at')
      .eq('user_id', user.id);
    const map: Record<string, SafetyResponse> = {};
    (myRes ?? []).forEach((r: SafetyResponse) => { map[r.check_id] = r; });
    setMyResponses(map);
    setLoading(false);
  }, [user.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // URLの ?check= で開いたとき（プッシュ・メール・バナー経由）にどのタブを出すか。
  // ⚠️ 自分がまだ回答していなければ必ず「回答」を優先する。
  //    マネージャーも被災者の一人なので、集計を先に出すと自分の回答が置き去りになる。
  //    回答済みで、かつ集計を見られる役職のときだけ集計を開く。
  useEffect(() => {
    const c = searchParams.get('check');
    if (!c || loading) return;
    setSelectedSummaryId(c);
    const iAnswered = !!myResponses[c];
    if (!iAnswered) setView('answer');
    else if (isManagerPlus || isLeader) setView('summary');
  }, [searchParams, isManagerPlus, isLeader, loading, myResponses]);

  // ---- オフライン再送キュー ----
  const flushQueue = useCallback(async () => {
    const queue = loadDraft<PendingQueue>(PENDING_QUEUE_KEY) ?? {};
    const keys = Object.keys(queue);
    if (keys.length === 0) return;
    for (const checkId of keys) {
      const item = queue[checkId];
      const { error } = await supabase.rpc('submit_safety_response', {
        p_check_id: checkId, p_choice: item.choice, p_comment: item.comment || null, p_client_key: item.clientKey,
      });
      if (!error) {
        delete queue[checkId];
        saveDraft(PENDING_QUEUE_KEY, queue);
        window.dispatchEvent(new CustomEvent('safety-pending-changed'));
      }
    }
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    flushQueue();
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    const interval = setInterval(flushQueue, 30000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(interval); };
  }, [flushQueue]);

  const pendingQueue = loadDraft<PendingQueue>(PENDING_QUEUE_KEY) ?? {};

  // ---- 回答 ----
  const submitAnswer = async (checkId: string, choice: string, comment: string) => {
    setErrMsg('');
    const clientKey = crypto.randomUUID();
    const { error } = await supabase.rpc('submit_safety_response', {
      p_check_id: checkId, p_choice: choice, p_comment: comment || null, p_client_key: clientKey,
    });
    if (error) {
      // ネットワーク不調の可能性が高い場合は端末に保留し、回線復帰後に自動再送する
      const isOffline = !navigator.onLine || /fetch|network/i.test(error.message || '');
      if (isOffline) {
        const queue = loadDraft<PendingQueue>(PENDING_QUEUE_KEY) ?? {};
        queue[checkId] = { choice, comment, clientKey, savedAt: Date.now() };
        saveDraft(PENDING_QUEUE_KEY, queue);
        setOkMsg('送信を保留しました。電波が戻ると自動で送信されます');
        setEditingCheckId(null);
        return;
      }
      setErrMsg('送信できませんでした。時間をおいてお試しください');
      return;
    }
    setOkMsg('回答を送信しました');
    setEditingCheckId(null);
    setTimeout(() => setOkMsg(''), 4000);
    loadAll();
    refetchPending();
    window.dispatchEvent(new CustomEvent('safety-pending-changed'));
  };

  const activeChecks = allChecks.filter(c => c.status === 'active' && !c.cancelled);
  const historyChecks = allChecks.filter(c => c.status === 'closed' || c.cancelled);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: sub }}>読み込み中...</div>;

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div>
        <h2 style={{ textAlign: 'center', margin: '12px 0 16px', fontSize: 20, fontWeight: 'bold', color: text }}>🆘 安否・緊急連絡</h2>

        {/* このページの説明（他ページと同様式。枠は常に黄色なので中身はライト配色固定） */}
        <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left' }}>
          <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【全スタッフ】</p>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>災害時の安否確認・出勤確認に回答できます</span>
          </div>
          {isManagerPlus && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px' }}>
              <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>2</span>
              <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>安否確認を発信し、回答状況を確認できます</span>
            </div>
          )}
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※ 電波が不安定でも、回答は端末に保存され、つながり次第きちんと送信されます。</p>
        </div>

        {okMsg && (
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 14, fontWeight: 700, color: '#166534' }}>
            ✓ {okMsg}
          </div>
        )}
        {errMsg && (
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#842029' }}>
            {errMsg}
          </div>
        )}

        {/* タブ */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { key: 'answer' as const, label: '回答', show: true },
            { key: 'send' as const, label: '🆘 発信', show: isManagerPlus },
            { key: 'summary' as const, label: '集計', show: isManagerPlus || isLeader },
            { key: 'history' as const, label: '履歴', show: true },
          ].filter(t => t.show).map(t => (
            <button key={t.key} type="button" onClick={() => { setView(t.key); setSearchParams({}); }}
              style={{
                padding: '7px 16px', borderRadius: 20, border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                background: view === t.key ? '#dc3545' : (isDark ? '#3d3d55' : '#e9ecef'),
                color: view === t.key ? '#fff' : sub,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {view === 'answer' && (
          <AnswerView
            checks={activeChecks}
            myResponses={myResponses}
            editingCheckId={editingCheckId}
            setEditingCheckId={setEditingCheckId}
            onSubmit={submitAnswer}
            pendingQueue={pendingQueue}
            isDark={isDark} card={card} text={text} sub={sub} border={border}
          />
        )}

        {view === 'send' && isManagerPlus && (
          <SendView
            userId={user.id}
            onSent={(checkId) => { setOkMsg('送信しました'); setView('summary'); setSelectedSummaryId(checkId); setSearchParams({ check: checkId }); loadAll(); setTimeout(() => setOkMsg(''), 4000); }}
            isDark={isDark} card={card} text={text} sub={sub} border={border}
          />
        )}

        {view === 'summary' && (isManagerPlus || isLeader) && (
          <SummaryView
            checks={activeChecks.concat(historyChecks)}
            selectedId={selectedSummaryId}
            onSelect={(id) => { setSelectedSummaryId(id); setSearchParams(id ? { check: id } : {}); }}
            isManagerPlus={isManagerPlus}
            onClosed={loadAll}
            isDark={isDark} card={card} text={text} sub={sub} border={border}
          />
        )}

        {view === 'history' && (
          <HistoryView
            checks={historyChecks}
            myResponses={myResponses}
            isManagerPlus={isManagerPlus}
            onOpenSummary={(id) => { setView('summary'); setSelectedSummaryId(id); setSearchParams({ check: id }); }}
            isDark={isDark} card={card} text={text} sub={sub} border={border}
          />
        )}

        <button type="button" onClick={() => navigate('/')}
          style={{ display: 'block', width: '100%', marginTop: 24, padding: '12px', background: 'none', border: `1px solid ${border}`, borderRadius: 12, color: sub, cursor: 'pointer', fontSize: 14 }}>
          ホームに戻る
        </button>
      </div>
    </div>
  );
};

// ============================================================
// 回答ビュー
// ============================================================
const AnswerView: React.FC<{
  checks: SafetyCheck[];
  myResponses: Record<string, SafetyResponse>;
  editingCheckId: string | null;
  setEditingCheckId: (id: string | null) => void;
  onSubmit: (checkId: string, choice: string, comment: string) => void;
  pendingQueue: PendingQueue;
  isDark: boolean; card: string; text: string; sub: string; border: string;
}> = ({ checks, myResponses, editingCheckId, setEditingCheckId, onSubmit, pendingQueue, isDark, card, text, sub, border }) => {
  if (checks.length === 0) {
    return <div style={{ background: card, borderRadius: 12, padding: '32px 20px', textAlign: 'center', color: sub, fontSize: 14 }}>現在、進行中の安否確認はありません</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {checks.map(c => {
        const myRes = myResponses[c.id];
        const pending = pendingQueue[c.id];
        const isEditing = editingCheckId === c.id || (!myRes && !pending);
        return (
          <div key={c.id} style={{ background: card, border: '2px solid #dc3545', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#ff9aa2' : '#721c24', marginBottom: 4 }}>
              {c.is_test && '【テスト】'}安否確認（{fmtDateTime(c.created_at)}）
            </div>
            <div style={{ fontSize: 14, color: text, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{c.body}</div>

            {pending && !isEditing && (
              <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#856404', fontWeight: 700 }}>
                ⏳ 送信待ち：電波が戻ると自動で送信されます（{c.options.find(o => o.key === pending.choice)?.label}）
              </div>
            )}

            {myRes && !isEditing && !pending && (
              <div>
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#166534', fontWeight: 700, marginBottom: 8 }}>
                  ✓ 回答済み：{c.options.find(o => o.key === myRes.choice)?.label}（{fmtDateTime(myRes.answered_at)}）
                  {myRes.is_proxy && <span style={{ fontWeight: 400 }}> ・代行入力</span>}
                </div>
                <button type="button" onClick={() => setEditingCheckId(c.id)}
                  style={{ fontSize: 12, color: isDark ? '#90caf9' : '#1976d2', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  回答を変更する
                </button>
              </div>
            )}

            {isEditing && (
              <AnswerForm
                options={c.options}
                initialChoice={myRes?.choice}
                initialComment={myRes?.comment || ''}
                onSubmit={(choice, comment) => onSubmit(c.id, choice, comment)}
                onCancel={myRes ? () => setEditingCheckId(null) : undefined}
                isDark={isDark} border={border} sub={sub} text={text}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

const AnswerForm: React.FC<{
  options: Choice[];
  initialChoice?: string;
  initialComment: string;
  onSubmit: (choice: string, comment: string) => void;
  onCancel?: () => void;
  isDark: boolean; border: string; sub: string; text: string;
}> = ({ options, initialChoice, initialComment, onSubmit, onCancel, isDark, border, sub, text }) => {
  const [choice, setChoice] = useState(initialChoice || '');
  const [comment, setComment] = useState(initialComment);
  const needsComment = options.find(o => o.key === choice)?.color !== 'green';

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        {options.map(o => {
          const c = COLOR_STYLE[o.color];
          const selected = choice === o.key;
          return (
            <button key={o.key} type="button" onClick={() => setChoice(o.key)}
              style={{
                width: '100%', padding: '16px 14px', borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: 'pointer',
                border: `2px solid ${c.border}`,
                background: selected ? c.border : c.bg,
                color: selected ? '#fff' : c.text,
                textAlign: 'left',
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
      {choice && (
        <>
          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>
            コメント（任意）{needsComment && ' — よろしければ状況をお知らせください'}
          </label>
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
            style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: `1px solid ${needsComment ? '#dc3545' : border}`, background: isDark ? '#3d3d55' : '#fff', color: text, boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => onSubmit(choice, comment)}
              style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              回答を送信
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel}
                style={{ padding: '10px 16px', borderRadius: 8, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 13, cursor: 'pointer' }}>
                やめる
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================
// 発信ビュー（マネージャー以上）
// ============================================================
interface StaffOption { id: string; name: string; role_title: string | null; group_names: string[] | null; }

const SendView: React.FC<{
  userId: string;
  onSent: (checkId: string) => void;
  isDark: boolean; card: string; text: string; sub: string; border: string;
}> = ({ userId, onSent, isDark, card, text, sub, border }) => {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [teams, setTeams] = useState<string[]>([]);

  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [pattern, setPattern] = useState<Pattern>('safety3');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetMode, setTargetMode] = useState<'all' | 'filter'>('all');
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [isTest, setIsTest] = useState(false);
  const [testTargetIds, setTestTargetIds] = useState<Set<string>>(new Set([userId]));
  const [testSearch, setTestSearch] = useState('');
  const [remindInterval, setRemindInterval] = useState(60);
  const [remindMax, setRemindMax] = useState(6);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');

  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editPattern, setEditPattern] = useState<Pattern>('safety3');

  useEffect(() => {
    supabase.from('safety_check_templates').select('id, title, body, pattern, sort_order, active').eq('active', true).order('sort_order')
      .then(({ data }) => setTemplates((data ?? []) as Template[]));
    supabase.from('profiles').select('id, name, role_title, group_names').eq('is_active', true).order('name')
      .then(({ data }) => setStaff((data ?? []) as StaffOption[]));
    supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order')
      .then(({ data }) => setTeams((data ?? []).map((r: { value: string }) => r.value)));
  }, []);

  const applyTemplate = (id: string) => {
    setSelectedTemplateId(id);
    const t = templates.find(x => x.id === id);
    if (t) {
      setPattern(t.pattern); setTitle(t.title); setBody(t.body);
      // 応援要請は「お願い」なので既定では催促しない。安否確認は既定6回（1時間ごと）
      setRemindMax(t.pattern === 'support' ? 0 : 6);
    }
  };

  const roleOptions = ['パート', '一般', 'フロア責任者', 'リーダー', 'マネージャー', '社長', '管理者'];

  const filteredTargets = targetMode === 'all'
    ? staff
    : staff.filter(s =>
        (selectedTeams.size > 0 && (s.group_names || []).some(g => selectedTeams.has(g))) ||
        (selectedRoles.size > 0 && selectedRoles.has(s.role_title || ''))
      );

  const finalTargetIds = isTest ? [...testTargetIds] : filteredTargets.map(s => s.id);

  const toggleSet = (set: Set<string>, setSet: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setSet(next);
  };

  const saveTemplate = async () => {
    if (!editTitle.trim() || !editBody.trim()) return;
    const { data } = await supabase.from('safety_check_templates').insert({
      title: editTitle.trim(), body: editBody.trim(), pattern: editPattern, sort_order: templates.length + 1,
    }).select('id, title, body, pattern, sort_order, active').single();
    if (data) {
      setTemplates(prev => [...prev, data as Template]);
      setShowTemplateEditor(false);
      setEditTitle(''); setEditBody('');
    }
  };

  const doSend = async () => {
    setSending(true);
    setErr('');
    const { data, error } = await supabase.functions.invoke('safety-check-send', {
      body: {
        pattern, title, message: body, is_test: isTest, target_user_ids: finalTargetIds,
        remind_interval_min: remindInterval, remind_max: remindMax,
      },
    });
    setSending(false);
    if (error || !data || data.error) {
      // 何が起きたか分かるようにサーバーからの理由をそのまま出す（原因不明のまま止まらないように）
      let reason = data?.error as string | undefined;
      if (!reason && error) {
        // invoke は非2xxのとき本文をcontextに持つ。読めれば理由を取り出す
        const ctx = (error as unknown as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try { reason = (await ctx.json())?.error; } catch { /* 読めなければ既定文を使う */ }
        }
        if (!reason) reason = error.message;
      }
      setErr(reason || '送信できませんでした。時間をおいてお試しください');
      console.error('[safety-check-send] failed', { error, data });
      return;
    }
    setShowConfirm(false);
    onSent(data.check_id);
  };

  const filteredStaff = staff.filter(s => !testSearch || s.name.includes(testSearch));

  return (
    <div style={{ background: card, borderRadius: 12, padding: '18px 18px', border: `1px solid ${border}` }}>
      {/* 選ぶ前は一覧、選んだ後は選んだものだけを表示する。
          災害時に「いま何を送ろうとしているか」が他の文面に埋もれないようにするため */}
      {selectedTemplateId ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: sub, margin: 0, fontWeight: 700 }}>送る内容</p>
            <button type="button" onClick={() => { setSelectedTemplateId(''); setShowConfirm(false); }}
              style={{ fontSize: 12, color: isDark ? '#90caf9' : '#1976d2', background: 'none', border: `1px solid #1976d2`, borderRadius: 14, padding: '3px 12px', cursor: 'pointer' }}>
              選び直す
            </button>
          </div>
          {(() => {
            const t = templates.find(x => x.id === selectedTemplateId);
            const g = PATTERN_GROUPS.find(gr => gr.patterns.includes(pattern) && (isTrainingTemplate(t?.title || '') === !!gr.training));
            return (
              <div style={{ border: '2px solid #1976d2', background: isDark ? '#1e3a5f' : '#e3f2fd', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: isDark ? '#90caf9' : '#1565c0', marginBottom: 2 }}>{g?.heading}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#fff' : '#0c447c' }}>{t?.title}</div>
              </div>
            );
          })()}
        </div>
      ) : (
      <>
      <p style={{ fontSize: 12, color: sub, margin: '0 0 8px', fontWeight: 700 }}>何を送りますか？</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {/* 種類ごとに見出しで区切って並べる（何を送るのか分かりやすくするため） */}
        {PATTERN_GROUPS.map(group => {
          const groupTemplates = templates.filter(t =>
            group.patterns.includes(t.pattern) && isTrainingTemplate(t.title) === !!group.training
          );
          if (groupTemplates.length === 0) return null;
          return (
            <div key={group.heading} style={{ marginBottom: 4 }}>
              <div style={{ padding: '6px 0 2px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: text }}>{group.heading}</div>
                <div style={{ fontSize: 11, color: sub }}>{group.note}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {groupTemplates.map(t => (
                  <button key={t.id} type="button" onClick={() => applyTemplate(t.id)}
                    style={{
                      textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                      border: `1px solid ${border}`, background: 'transparent',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: text }}>{t.title}</div>
                    <div style={{ fontSize: 11, color: sub, margin: '2px 0 6px' }}>{t.body}</div>
                    {/* 実際にスタッフの画面に出る回答ボタンを見せる（何を送るのか選ぶ前に分かるように） */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {PATTERN_OPTIONS[t.pattern].map(o => (
                        <span key={o.key} style={{
                          fontSize: 10, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap',
                          background: COLOR_STYLE[o.color].bg, color: COLOR_STYLE[o.color].text,
                          border: `1px solid ${COLOR_STYLE[o.color].border}`,
                        }}>{o.label}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!showTemplateEditor ? (
          <button type="button" onClick={() => setShowTemplateEditor(true)}
            style={{ fontSize: 12, color: isDark ? '#90caf9' : '#1976d2', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0', textAlign: 'left' }}>
            ＋ 定型メッセージを追加
          </button>
        ) : (
          <div style={{ border: `1px dashed ${border}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="タイトル（例：豪雨の安否確認）"
              style={{ padding: '7px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text }} />
            <select value={editPattern} onChange={e => setEditPattern(e.target.value as Pattern)}
              style={{ padding: '7px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text }}>
              {(Object.keys(PATTERN_LABEL) as Pattern[]).map(p => <option key={p} value={p}>{PATTERN_LABEL[p]}</option>)}
            </select>
            <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={2} placeholder="本文"
              style={{ padding: '7px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={saveTemplate} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', fontSize: 12, cursor: 'pointer' }}>保存</button>
              <button type="button" onClick={() => setShowTemplateEditor(false)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 12, cursor: 'pointer' }}>キャンセル</button>
            </div>
          </div>
        )}
      </div>
      </>
      )}

      {selectedTemplateId && (
        <>
          <p style={{ fontSize: 12, color: sub, margin: '0 0 4px', fontWeight: 700 }}>タイトル</p>
          <input value={title} onChange={e => setTitle(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, marginBottom: 10, boxSizing: 'border-box' }} />

          <p style={{ fontSize: 12, color: sub, margin: '0 0 4px', fontWeight: 700 }}>定型メッセージ（編集できます）</p>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={3}
            style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, marginBottom: 10, boxSizing: 'border-box', resize: 'vertical' }} />

          {/* 相手の画面に出る回答ボタン（この内容で送られる） */}
          <p style={{ fontSize: 12, color: sub, margin: '0 0 4px', fontWeight: 700 }}>相手が押す回答ボタン</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {PATTERN_OPTIONS[pattern].map(o => (
              <div key={o.key} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700,
                background: COLOR_STYLE[o.color].bg, color: COLOR_STYLE[o.color].text,
                border: `1px solid ${COLOR_STYLE[o.color].border}`,
              }}>{o.label}</div>
            ))}
          </div>

          <p style={{ fontSize: 12, color: sub, margin: '0 0 4px', fontWeight: 700 }}>送る相手</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button type="button" onClick={() => { setTargetMode('all'); setIsTest(false); }}
              style={{ padding: '6px 14px', borderRadius: 16, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: targetMode === 'all' && !isTest ? '#1976d2' : (isDark ? '#3d3d55' : '#e9ecef'), color: targetMode === 'all' && !isTest ? '#fff' : sub }}>
              全スタッフ（{staff.length}人）
            </button>
            <button type="button" onClick={() => { setTargetMode('filter'); setIsTest(false); }}
              style={{ padding: '6px 14px', borderRadius: 16, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: targetMode === 'filter' && !isTest ? '#1976d2' : (isDark ? '#3d3d55' : '#e9ecef'), color: targetMode === 'filter' && !isTest ? '#fff' : sub }}>
              チーム・役職で絞る
            </button>
            <button type="button" onClick={() => setIsTest(true)}
              style={{ padding: '6px 14px', borderRadius: 16, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: isTest ? '#856404' : (isDark ? '#3d3d55' : '#e9ecef'), color: isTest ? '#fff' : sub }}>
              🧪 テスト送信
            </button>
          </div>

          {!isTest && targetMode === 'filter' && (
            <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <p style={{ fontSize: 11, color: sub, margin: '0 0 4px' }}>チーム</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {teams.map(t => (
                  <button key={t} type="button" onClick={() => toggleSet(selectedTeams, setSelectedTeams, t)}
                    style={{ padding: '4px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: selectedTeams.has(t) ? '1px solid #1976d2' : `1px solid ${border}`, background: selectedTeams.has(t) ? '#e3f2fd' : 'transparent', color: selectedTeams.has(t) ? '#1976d2' : sub }}>
                    {t}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: sub, margin: '0 0 4px' }}>役職</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {roleOptions.map(r => (
                  <button key={r} type="button" onClick={() => toggleSet(selectedRoles, setSelectedRoles, r)}
                    style={{ padding: '4px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: selectedRoles.has(r) ? '1px solid #1976d2' : `1px solid ${border}`, background: selectedRoles.has(r) ? '#e3f2fd' : 'transparent', color: selectedRoles.has(r) ? '#1976d2' : sub }}>
                    {r}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 12, color: text, margin: '8px 0 0', fontWeight: 700 }}>対象：{filteredTargets.length}人</p>
            </div>
          )}

          {isTest && (
            <div style={{ border: `1px solid #ffc107`, background: isDark ? '#3a2f0d' : '#fff9e6', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <p style={{ fontSize: 11, color: '#856404', margin: '0 0 6px' }}>テスト送信の宛先を選んでください（既定は自分のみ）。受信画面・履歴に【テスト】と表示されます</p>
              <input value={testSearch} onChange={e => setTestSearch(e.target.value)} placeholder="名前で検索..."
                style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, marginBottom: 6, boxSizing: 'border-box' }} />
              <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 6 }}>
                {filteredStaff.map(s => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', fontSize: 12, color: text, cursor: 'pointer' }}>
                    <input type="checkbox" checked={testTargetIds.has(s.id)} onChange={() => toggleSet(testTargetIds, setTestTargetIds, s.id)} />
                    {s.name}{s.id === userId && '（自分）'}
                  </label>
                ))}
              </div>
              {/* 選択中の人を必ず見せる。検索で絞ると選択済みの人が一覧から消え、
                  「1人だけ選んだつもりが3人に送る」事故になるため */}
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12, color: text, margin: '0 0 4px', fontWeight: 700 }}>テスト対象：{testTargetIds.size}人</p>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {[...testTargetIds].map(id => {
                    const s = staff.find(x => x.id === id);
                    return (
                      <span key={id} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#fff3cd', color: '#856404', border: '1px solid #ffc107', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {s?.name ?? '不明'}{id === userId && '（自分）'}
                        <button type="button" onClick={() => toggleSet(testTargetIds, setTestTargetIds, id)}
                          title="外す"
                          style={{ background: 'none', border: 'none', color: '#856404', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <p style={{ fontSize: 12, color: sub, margin: '0 0 4px', fontWeight: 700 }}>自動リマインド</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 12, color: text }}>
            <select value={remindMax} onChange={e => setRemindMax(Number(e.target.value))}
              style={{ padding: '5px 8px', fontSize: 12, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text }}>
              <option value={0}>送らない</option>
              {REMIND_COUNTS.map(n => <option key={n} value={n}>最大{n}回</option>)}
            </select>
            {remindMax > 0 && (
              <>
                <select value={remindInterval} onChange={e => setRemindInterval(Number(e.target.value))}
                  style={{ padding: '5px 8px', fontSize: 12, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text }}>
                  {REMIND_INTERVALS.map(n => <option key={n} value={n}>{intervalLabel(n)}ごと</option>)}
                </select>
                <span style={{ color: sub }}>未回答者にプッシュで再送します</span>
              </>
            )}
          </div>
          {/* 「いつまで続くか」を出す。停電・充電切れで翌日以降に電源を入れる人がいるため、
              長い災害では 6時間ごと×12回（3日間）のような設定を選べるようにしている */}
          {remindMax > 0 && (
            <p style={{ fontSize: 11, color: sub, margin: '-10px 0 16px' }}>
              最後の再送まで約{durationLabel(remindInterval * remindMax)}（{intervalLabel(remindInterval)}ごとに{remindMax}回）
            </p>
          )}

          {err && <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#842029', marginBottom: 10 }}>{err}</div>}

          {!showConfirm ? (
            <button type="button" disabled={finalTargetIds.length === 0 || !body.trim()} onClick={() => setShowConfirm(true)}
              style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: finalTargetIds.length === 0 ? (isDark ? '#3d3d55' : '#e9ecef') : '#dc3545', color: finalTargetIds.length === 0 ? sub : '#fff', fontSize: 15, fontWeight: 700, cursor: finalTargetIds.length === 0 ? 'default' : 'pointer' }}>
              {isTest ? `テスト送信する（${finalTargetIds.length}人）` : `${finalTargetIds.length}人に送信する`}
            </button>
          ) : (
            <div style={{ border: '2px solid #dc3545', borderRadius: 10, padding: 14 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: text, margin: '0 0 10px' }}>
                {finalTargetIds.length}人に送信しますか？
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={sending} onClick={doSend}
                  style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#dc3545', color: '#fff', fontSize: 14, fontWeight: 700, cursor: sending ? 'default' : 'pointer' }}>
                  {sending ? '送信中...' : '送信する'}
                </button>
                <button type="button" onClick={() => setShowConfirm(false)}
                  style={{ padding: '10px 16px', borderRadius: 8, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 13, cursor: 'pointer' }}>
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ============================================================
// 集計ビュー（マネージャー以上・進行中はリーダーも）
// ============================================================
const SummaryView: React.FC<{
  checks: SafetyCheck[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  isManagerPlus: boolean;
  onClosed: () => void;
  isDark: boolean; card: string; text: string; sub: string; border: string;
}> = ({ checks, selectedId, onSelect, isManagerPlus, onClosed, isDark, card, text, sub, border }) => {
  const check = checks.find(c => c.id === selectedId) || checks[0] || null;
  // ダーク背景に濃い青・濃い赤の文字は沈んで読めないので、暗い時は明るい色にする
  const linkColor = isDark ? '#90caf9' : '#1976d2';
  const dangerText = isDark ? '#ff9aa2' : '#721c24';
  const dangerBg = isDark ? '#4a2328' : '#f8d7da';

  const [recipients, setRecipients] = useState<{ id: string; name: string; role_title: string | null }[]>([]);
  const [responses, setResponses] = useState<SafetyResponse[]>([]);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [confirmAction, setConfirmAction] = useState<'close' | 'cancel' | null>(null);
  const [proxyForId, setProxyForId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attendingId, setAttendingId] = useState<string | null>(null); // 対応中マーク（このセッション内のみ）

  const load = useCallback(async () => {
    if (!check) return;
    const { data: recips } = await supabase.from('safety_check_recipients').select('user_id').eq('check_id', check.id);
    const ids = (recips ?? []).map((r: { user_id: string }) => r.user_id);
    if (ids.length === 0) { setRecipients([]); setResponses([]); return; }
    const { data: profs } = await supabase.from('profiles').select('id, name, role_title').in('id', ids);
    setRecipients((profs ?? []) as { id: string; name: string; role_title: string | null }[]);
    const { data: res } = await supabase.from('safety_check_responses').select('check_id, user_id, choice, comment, is_proxy, proxy_by, answered_at').eq('check_id', check.id);
    setResponses((res ?? []) as SafetyResponse[]);
    const { data: ph } = await supabase.from('staff_phone_numbers').select('user_id, phone').in('user_id', ids);
    setPhones(Object.fromEntries((ph ?? []).map((p: { user_id: string; phone: string }) => [p.user_id, p.phone])));
  }, [check]);

  useEffect(() => { load(); }, [load]);

  if (!check) return <div style={{ background: card, borderRadius: 12, padding: '32px 20px', textAlign: 'center', color: sub, fontSize: 14 }}>安否確認の履歴がありません</div>;

  const respondedIds = new Set(responses.map(r => r.user_id));
  const unanswered = recipients.filter(r => !respondedIds.has(r.id));
  const byChoice: Record<string, number> = {};
  responses.forEach(r => { byChoice[r.choice] = (byChoice[r.choice] || 0) + 1; });
  const helpNeeded = responses.filter(r => check.options.find(o => o.key === r.choice)?.color === 'red');
  const canOperate = isManagerPlus; // 再送・終了・取消・代行はマネージャー以上のみ（リーダーは閲覧のみ）
  const canProxy = isManagerPlus || (check.status === 'active');  // リーダーは進行中のみ（呼び出し元でも進行中しか見えない）

  const doResend = async () => {
    setBusy(true);
    await supabase.functions.invoke('safety-check-send', { body: { mode: 'remind', check_id: check.id } });
    setBusy(false);
  };

  const doClose = async () => {
    setBusy(true);
    await supabase.rpc('close_safety_check', { p_check_id: check.id });
    setBusy(false);
    setConfirmAction(null);
    onClosed();
  };

  const doCancel = async () => {
    setBusy(true);
    await supabase.rpc('cancel_safety_check', { p_check_id: check.id });
    setBusy(false);
    setConfirmAction(null);
    onClosed();
  };

  return (
    <div>
      {checks.length > 1 && (
        <select value={check.id} onChange={e => onSelect(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 8, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, marginBottom: 12 }}>
          {checks.map(c => <option key={c.id} value={c.id}>{c.is_test ? '【テスト】' : ''}{c.title}（{fmtDateTime(c.created_at)}）{c.status === 'closed' ? '・終了済み' : ''}</option>)}
        </select>
      )}

      <div style={{ background: card, borderRadius: 12, padding: '16px 18px', border: `1px solid ${border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: text }}>{check.is_test && '【テスト】'}{check.title}</span>
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: check.status === 'active' ? '#dcfce7' : (isDark ? '#3d3d55' : '#e9ecef'), color: check.status === 'active' ? '#166534' : sub, fontWeight: 700 }}>
            {check.cancelled ? '取消済み' : check.status === 'active' ? '進行中' : '終了'}
          </span>
        </div>
        <p style={{ fontSize: 12, color: sub, margin: '0 0 12px' }}>{fmtDateTime(check.created_at)}発信</p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {check.options.map(o => (
            <div key={o.key} style={{ flex: '1 1 80px', background: isDark ? '#1e1e2e' : '#f8f9fa', borderRadius: 8, padding: '8px', textAlign: 'center' }}>
              <p style={{ fontSize: 10, color: sub, margin: 0 }}>{o.label}</p>
              <p style={{ fontSize: 18, fontWeight: 700, margin: 0, color: COLOR_STYLE[o.color].border }}>{byChoice[o.key] || 0}</p>
            </div>
          ))}
          <div style={{ flex: '1 1 80px', background: isDark ? '#1e1e2e' : '#f8f9fa', borderRadius: 8, padding: '8px', textAlign: 'center' }}>
            <p style={{ fontSize: 10, color: sub, margin: 0 }}>未回答</p>
            <p style={{ fontSize: 18, fontWeight: 700, margin: 0, color: isDark ? '#ff6b6b' : '#dc3545' }}>{unanswered.length}</p>
          </div>
        </div>

        {helpNeeded.length > 0 && (
          <div style={{ background: dangerBg, border: '2px solid #dc3545', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: dangerText, margin: '0 0 6px' }}>⚠️ 助けが必要（{helpNeeded.length}人）</p>
            {helpNeeded.map(r => {
              const prof = recipients.find(p => p.id === r.user_id);
              return (
                <div key={r.user_id} style={{ fontSize: 12, color: dangerText, marginBottom: 3 }}>
                  <strong>{prof?.name || r.user_id}</strong>
                  {phones[r.user_id] && <> ・<a href={`tel:${phones[r.user_id]}`} style={{ color: dangerText }}>{phones[r.user_id]}</a></>}
                  {r.comment && <div style={{ fontSize: 11 }}>「{r.comment}」</div>}
                </div>
              );
            })}
          </div>
        )}

        {check.all_answered_at && <p style={{ fontSize: 12, color: isDark ? '#7bdca0' : '#166534', fontWeight: 700, margin: '0 0 10px' }}>✓ 全員の回答が揃いました（{fmtDateTime(check.all_answered_at)}）</p>}

        {unanswered.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: text, margin: '0 0 6px' }}>未回答（{unanswered.length}人）</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {unanswered.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, border: `1px solid ${border}`, borderRadius: 6, padding: '6px 8px' }}>
                  <span style={{ flex: 1, color: text }}>{p.name}{p.role_title ? `（${p.role_title}）` : ''}</span>
                  {phones[p.id] ? (
                    <a href={`tel:${phones[p.id]}`} style={{ color: linkColor, fontSize: 11, whiteSpace: 'nowrap' }}>📞 {phones[p.id]}</a>
                  ) : (
                    <span style={{ color: sub, fontSize: 11 }}>番号なし</span>
                  )}
                  <button type="button" onClick={() => setAttendingId(prev => prev === p.id ? null : p.id)}
                    style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, border: attendingId === p.id ? '1px solid #856404' : `1px solid ${border}`, background: attendingId === p.id ? '#fff3cd' : 'transparent', color: attendingId === p.id ? '#856404' : sub, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {attendingId === p.id ? '対応中' : '対応中にする'}
                  </button>
                  {canProxy && (
                    proxyForId === p.id ? null : (
                      <button type="button" onClick={() => setProxyForId(p.id)}
                        style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, border: '1px solid #1976d2', background: 'transparent', color: linkColor, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        代行入力
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
            {proxyForId && (
              <ProxyForm
                userName={recipients.find(p => p.id === proxyForId)?.name || ''}
                options={check.options}
                onSubmit={async (choice, comment) => {
                  await supabase.rpc('submit_safety_response_proxy', { p_check_id: check.id, p_target_user_id: proxyForId, p_choice: choice, p_comment: comment || null });
                  setProxyForId(null);
                  load();
                }}
                onCancel={() => setProxyForId(null)}
                isDark={isDark} border={border} sub={sub} text={text}
              />
            )}
          </div>
        )}

        {/* 回答した人は全員出す（コメントを書いた人だけだと「無事なのは誰か」が分からないため） */}
        {responses.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: text, margin: '0 0 6px' }}>回答した人（{responses.length}人）</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {responses.map(r => {
                const prof = recipients.find(p => p.id === r.user_id);
                const opt = check.options.find(o => o.key === r.choice);
                const c = opt ? COLOR_STYLE[opt.color] : COLOR_STYLE.green;
                return (
                  <div key={r.user_id} style={{ fontSize: 12, color: text, borderLeft: `3px solid ${c.border}`, paddingLeft: 8 }}>
                    <strong>{prof?.name ?? '不明'}</strong>
                    <span style={{ marginLeft: 6, padding: '1px 8px', borderRadius: 10, fontSize: 11, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>{opt?.label ?? r.choice}</span>
                    <span style={{ color: sub, marginLeft: 6 }}>{fmtDateTime(r.answered_at)}</span>
                    {r.is_proxy && <span style={{ color: sub }}> （代行入力）</span>}
                    {r.comment && <div style={{ color: sub }}>「{r.comment}」</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {canOperate && !check.cancelled && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            {check.status === 'active' && unanswered.length > 0 && (
              <button type="button" disabled={busy} onClick={doResend}
                style={{ flex: 1, minWidth: 140, padding: '9px', borderRadius: 8, border: '1px solid #1976d2', background: 'transparent', color: linkColor, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                未回答の{unanswered.length}人に再送
              </button>
            )}
            {check.status === 'active' && (
              <button type="button" onClick={() => setConfirmAction('close')}
                style={{ flex: 1, minWidth: 100, padding: '9px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: sub, fontSize: 12, cursor: 'pointer' }}>
                終了する
              </button>
            )}
            <button type="button" onClick={() => setConfirmAction('cancel')}
              style={{ flex: 1, minWidth: 100, padding: '9px', borderRadius: 8, border: '1px solid #dc3545', background: 'transparent', color: '#dc3545', fontSize: 12, cursor: 'pointer' }}>
              取消（誤発信）
            </button>
          </div>
        )}

        {confirmAction && (
          <div style={{ marginTop: 10, border: `2px solid ${confirmAction === 'cancel' ? '#dc3545' : border}`, borderRadius: 8, padding: 12 }}>
            <p style={{ fontSize: 13, color: text, margin: '0 0 10px', fontWeight: 700 }}>
              {confirmAction === 'close' ? 'この安否確認を終了しますか？ 回答自体は終了後も受け付けます' : 'この安否確認を取消しますか？ 全員の画面から即座に消え、「誤送信でした」という通知が送られます'}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={busy} onClick={confirmAction === 'close' ? doClose : doCancel}
                style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: confirmAction === 'cancel' ? '#dc3545' : '#856404', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {busy ? '処理中...' : 'はい'}
              </button>
              <button type="button" onClick={() => setConfirmAction(null)}
                style={{ padding: '9px 16px', borderRadius: 8, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 13, cursor: 'pointer' }}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ProxyForm: React.FC<{
  userName: string;
  options: Choice[];
  onSubmit: (choice: string, comment: string) => void;
  onCancel: () => void;
  isDark: boolean; border: string; sub: string; text: string;
}> = ({ userName, options, onSubmit, onCancel, isDark, border, sub, text }) => {
  const [choice, setChoice] = useState('');
  const [comment, setComment] = useState('');
  return (
    <div style={{ marginTop: 8, border: '1px solid #1976d2', borderRadius: 8, padding: 10 }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: text, margin: '0 0 6px' }}>{userName}さんの代行入力（電話で確認した内容を入力）</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {options.map(o => (
          <button key={o.key} type="button" onClick={() => setChoice(o.key)}
            style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${COLOR_STYLE[o.color].border}`, background: choice === o.key ? COLOR_STYLE[o.color].border : COLOR_STYLE[o.color].bg, color: choice === o.key ? '#fff' : COLOR_STYLE[o.color].text }}>
            {o.label}
          </button>
        ))}
      </div>
      <input value={comment} onChange={e => setComment(e.target.value)} placeholder="例：電話で確認。自宅で無事とのこと"
        style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text, marginBottom: 8, boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" disabled={!choice} onClick={() => onSubmit(choice, comment)}
          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: choice ? '#1976d2' : (isDark ? '#3d3d55' : '#e9ecef'), color: choice ? '#fff' : sub, fontSize: 12, fontWeight: 700, cursor: choice ? 'pointer' : 'default' }}>
          記録する
        </button>
        <button type="button" onClick={onCancel} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 12, cursor: 'pointer' }}>
          キャンセル
        </button>
      </div>
    </div>
  );
};

// ============================================================
// 履歴ビュー
// ============================================================
const HistoryView: React.FC<{
  checks: SafetyCheck[];
  myResponses: Record<string, SafetyResponse>;
  isManagerPlus: boolean;
  onOpenSummary: (id: string) => void;
  isDark: boolean; card: string; text: string; sub: string; border: string;
}> = ({ checks, myResponses, isManagerPlus, onOpenSummary, isDark, card, text, sub, border }) => {
  const dangerBg = isDark ? '#4a2328' : '#f8d7da';
  if (checks.length === 0) {
    return <div style={{ background: card, borderRadius: 12, padding: '32px 20px', textAlign: 'center', color: sub, fontSize: 14 }}>過去の安否確認はありません</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {checks.map(c => {
        const myRes = myResponses[c.id];
        return (
          <div key={c.id} onClick={() => isManagerPlus && onOpenSummary(c.id)}
            style={{ background: card, borderRadius: 10, padding: '12px 14px', border: `1px solid ${border}`, cursor: isManagerPlus ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: text }}>{c.is_test && '【テスト】'}{c.title}</span>
              {c.cancelled && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: dangerBg, color: '#842029' }}>取消済み</span>}
            </div>
            <p style={{ fontSize: 11, color: sub, margin: 0 }}>{fmtDateTime(c.created_at)}発信</p>
            {myRes && !c.cancelled && (
              <p style={{ fontSize: 12, color: isDark ? '#7bdca0' : '#166534', margin: '4px 0 0', fontWeight: 700 }}>あなたの回答：{c.options.find(o => o.key === myRes.choice)?.label}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SafetyCheckPage;
