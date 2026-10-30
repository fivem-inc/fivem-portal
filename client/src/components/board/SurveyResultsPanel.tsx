// 連絡板のアンケート：送った人・写しの代表者・管理者が回答を見る枠（2026-10-29・見本の③）。
// 受信トレイの詳細（自分あてに送ったとき・管理者）と送信トレイの詳細の両方が使う。
//
// ・［すべて］［回答済み］［未回答］で絞る。未回答の人の名前も出す（催促は今の［リマインド送信］）
// ・［Excel で出す］（1人1行・質問ごとに列・数式として読まれない形）
// ・回答が0件のうちは［質問を直す］（DB が0件を確かめる）。届いたあとは「この質問で新しく作る」を案内
// 🚨 だれに何を返すかは DB の board_survey_results

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type SurveyDef, answerText, cleanSurvey, sheetSafe, surveyDraftProblem } from '../../lib/boardSurvey';
import { loadSurveyResults, updateSurveyQuestions, type SurveyResults } from '../../lib/boardSurveyApi';
import { backBtn, primaryBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import SurveyResultsView from './SurveyResultsView';
import SurveyEditor from './SurveyEditor';
import OfferDialog from './OfferDialog';
import { loadOfferStates, OFFER_LABEL, toneStyle, type OfferState } from '../../lib/boardOfferApi';
import { mdDow } from '../../lib/appRequests';
import { tintBtn } from '../../lib/buttonStyles';
import type { SurveyResultRow } from '../../lib/boardSurveyApi';

interface Props {
  messageId: string;
  subject: string;
  survey: SurveyDef;
  isDark: boolean;
  profiles: { id: string; name: string | null }[];
  /** 送った本人か（［質問を直す］は本人だけ） */
  isSender: boolean;
  /** 質問を直したあと、親の一覧を読み直す */
  onSurveyChanged?: () => void;
  /** 「この質問で新しく作る」（今の［コピーして作成］） */
  onCopy?: () => void;
  /** ご提案（申請につなぐ）を使うアンケートか・ご提案を送れる人か（2026-10-30 段2-3） */
  surveyOnegai?: boolean;
  canOffer?: boolean;
}

type Filter = 'all' | 'done' | 'notyet';

const SurveyResultsPanel: React.FC<Props> = ({ messageId, subject, survey, isDark, profiles, isSender, onSurveyChanged, onCopy, surveyOnegai = false, canOffer = false }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const [results, setResults] = useState<SurveyResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<SurveyDef | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);

  // ご提案の札（2026-10-30 段2-3）。判定は DB の board_survey_offer_states の1か所
  const [offers, setOffers] = useState<Map<string, OfferState>>(new Map());
  const [offerErr, setOfferErr] = useState<string | null>(null);
  const [offerFor, setOfferFor] = useState<SurveyResultRow | null>(null);
  const [offerSent, setOfferSent] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await loadSurveyResults(messageId);
    if (r.error) { setError(r.error); return; }
    setResults(r.results);
    if (surveyOnegai && r.results?.mode === 'full') {
      const st = await loadOfferStates(messageId);
      if (st.error) { setOfferErr(st.error); return; }
      setOfferErr(null);
      setOffers(new Map(st.states.map(x => [x.recipient_id, x])));
    }
  }, [messageId, surveyOnegai]);
  /** 回答の中の日付（日付の質問すべて）＝ご提案の窓に最初から入れる */
  const answerDates = (r: SurveyResultRow): string[] =>
    survey.questions.filter(q => q.kind === 'date').flatMap(q => ((r.answers?.[q.id] as { dates?: string[] } | undefined)?.dates ?? []));
  const offerRow = (r: SurveyResultRow) => {
    if (!surveyOnegai) return null;
    const st = offers.get(r.user_id);
    const label = OFFER_LABEL[st ? st.label : 'answered'];
    const tone = toneStyle(label.tone, isDark);
    const canSend = canOffer && (!st || st.status === 'withdrawn' || st.status === 'consult');
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${border}`, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, fontWeight: 'bold', padding: '2px 10px', borderRadius: 12, border: `1px solid ${tone.border}`, background: tone.background, color: tone.color }}>{label.text}</span>
        {st?.round && st.round > 1 && <span style={{ fontSize: 12, color: sub }}>{st.round}回目</span>}
        {st?.due_date && (st.label === 'awaiting' || st.label === 'overdue') && <span style={{ fontSize: 12, color: sub }}>返事の期限 {mdDow(st.due_date)}</span>}
        {st?.status === 'consult' && st.consult_note && <span style={{ fontSize: 13, color: text, width: '100%' }}>「{st.consult_note}」</span>}
        {canSend && (
          <button type="button" data-net="write" onClick={() => { setOfferFor(r); setOfferSent(null); }}
            style={{ ...tintBtn(isDark), minHeight: 40, padding: '6px 12px', fontSize: 13 }}>
            {st?.status === 'consult' ? '決まった内容でもう一度ご提案する' : 'この内容でご提案する'}
          </button>
        )}
      </div>
    );
  };
  useEffect(() => { void load(); }, [load]);

  const full = results && results.mode === 'full' ? results : null;
  const nameOf = (id: string) => profiles.find(p => p.id === id)?.name || '不明';
  const doneIds = useMemo(() => new Set(full?.rows.map(r => r.user_id) ?? []), [full]);
  const notYet = useMemo(() => (full?.recipients ?? []).filter(id => !doneIds.has(id)), [full, doneIds]);
  const rows = full ? (filter === 'notyet' ? [] : full.rows) : [];

  const exportExcel = async () => {
    if (!full) return;
    setExcelError(null);
    try {
      const XLSX = await import('xlsx');
      const head = ['名前', '回答した日時', '直した日時', '期限後', ...survey.questions.map((q, i) => `${i + 1}. ${q.label}`)];
      const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('ja-JP') : '');
      const body = full.rows.map(r => [
        sheetSafe(r.name || nameOf(r.user_id)), when(r.answered_at), (r.edit_count ?? 0) > 0 ? when(r.updated_at) : '', r.is_late ? '期限後' : '',
        ...survey.questions.map(q => sheetSafe(answerText(q, r.answers?.[q.id]))),
      ]);
      const notYetRows = notYet.map(id => [sheetSafe(nameOf(id)), '未回答', '', '', ...survey.questions.map(() => '')]);
      const ws = XLSX.utils.aoa_to_sheet([head, ...body, ...notYetRows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '回答');
      XLSX.writeFile(wb, `アンケート_${subject}.xlsx`.replace(/[\\/:*?"<>|]/g, ''));
    } catch (e) {
      setExcelError(`Excel を作れませんでした：${(e as Error)?.message || '不明なエラー'}`);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const p = surveyDraftProblem(editing);
    if (p) { setEditError(p.message); return; }
    setSaving(true); setEditError(null);
    const err = await updateSurveyQuestions(messageId, cleanSurvey(editing));
    setSaving(false);
    if (err) { setEditError(err); return; }
    setEditing(null); setSaved(true);
    onSurveyChanged?.();
    void load();
  };

  const tab = (f: Filter, label: string) => (
    <button key={f} type="button" onClick={() => setFilter(f)}
      style={{ padding: '6px 12px', minHeight: 36, borderRadius: 18, fontSize: 13, cursor: 'pointer',
        border: `1.5px solid ${filter === f ? TOGGLE_BLUE : border}`, background: filter === f ? TOGGLE_BLUE : 'transparent', color: filter === f ? '#fff' : text }}>
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${border}`, background: isDark ? '#1e2a3a' : '#f8fbff' }}>
      <div style={{ fontSize: 14, fontWeight: 'bold', color: text, marginBottom: 8 }}>📋 アンケートの回答</div>
      {error && (
        <div style={{ fontSize: 13, color: '#dc3545' }}>
          回答を読み込めませんでした（{error}）
          <button type="button" onClick={() => void load()} style={{ ...backBtn(isDark), padding: '4px 10px', fontSize: 12, marginLeft: 8 }}>再読み込み</button>
        </div>
      )}
      {!error && !results && <div style={{ fontSize: 13, color: sub }}>読み込んでいます…</div>}
      {saved && <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#166534', fontWeight: 600, marginBottom: 8 }}>✓ 質問を直しました</div>}

      {full && !editing && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {tab('all', `すべて ${full.recipients.length}`)}
            {tab('done', `回答済み ${full.rows.length}`)}
            {tab('notyet', `未回答 ${notYet.length}`)}
          </div>
          {full.rows.length === 0 && filter !== 'notyet' && (
            <div style={{ fontSize: 13, color: sub, marginBottom: 8 }}>まだ回答はありません（0/{full.recipients.length}人）</div>
          )}
          {filter === 'notyet'
            ? <div style={{ fontSize: 14, color: text }}>{notYet.length === 0 ? '全員が回答しました' : notYet.map(nameOf).join('、')}</div>
            : <SurveyResultsView survey={survey} results={full} rows={rows} isDark={isDark} profiles={profiles} rowExtra={surveyOnegai ? offerRow : undefined} />}
          {offerErr && <div style={{ fontSize: 13, color: '#dc3545', marginTop: 6 }}>ご提案の状態を{offerErr}</div>}
          {offerSent && <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#166534', fontWeight: 600, marginTop: 8 }}>✓ {offerSent}さんにご提案を送りました</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button type="button" onClick={() => void exportExcel()} style={{ ...backBtn(isDark), padding: '8px 14px', fontSize: 13 }}>Excel で出す</button>
            {isSender && full.rows.length === 0 && (
              <button type="button" data-net="write" onClick={() => { setEditing(survey); setSaved(false); setEditError(null); }}
                style={{ ...backBtn(isDark), padding: '8px 14px', fontSize: 13 }}>質問を直す</button>
            )}
          </div>
          {excelError && <div style={{ fontSize: 13, color: '#dc3545', marginTop: 6 }}>{excelError}</div>}
          {isSender && full.rows.length > 0 && (
            <div style={{ fontSize: 12, color: sub, marginTop: 8 }}>
              回答が届いているため、質問は直せません（本文は直せます）。質問を変えたいときは
              {onCopy ? <button type="button" onClick={onCopy} style={{ background: 'none', border: 'none', color: TOGGLE_BLUE, cursor: 'pointer', padding: '0 4px', fontSize: 12, textDecoration: 'underline' }}>この質問で新しく作る</button> : '［コピーして作成］'}
              で作り直し、このお知らせは削除してください（届いた回答も消えます）。
            </div>
          )}
        </>
      )}

      {offerFor && (() => {
        const st = offers.get(offerFor.user_id);
        const name = offerFor.name || nameOf(offerFor.user_id);
        return (
          <OfferDialog messageId={messageId} recipientId={offerFor.user_id} recipientName={name} isDark={isDark}
            initialDates={st && st.status !== 'withdrawn' ? st.target_dates : answerDates(offerFor)}
            initialKind={st?.kind ?? null} initialOt={st?.ot_content ?? null}
            answerSeen={offerFor.updated_at ?? null}
            consultNote={st?.status === 'consult' ? st.consult_note : null}
            onClose={() => setOfferFor(null)}
            onSent={() => { setOfferFor(null); setOfferSent(name); void load(); }} />
        );
      })()}

      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: sub }}>まだ回答が届いていないので、質問を直せます。</div>
          <SurveyEditor value={editing} onChange={setEditing} isDark={isDark} problemIndex={surveyDraftProblem(editing)?.index ?? null} />
          {editError && <div style={{ fontSize: 13, color: '#dc3545' }}>{editError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => setEditing(null)} style={{ ...backBtn(isDark), flex: 1 }}>やめる</button>
            <button type="button" data-net="write" disabled={saving} onClick={() => void saveEdit()} style={{ ...primaryBtn({ disabled: saving }), flex: 2 }}>
              {saving ? '保存しています…' : 'この質問にする'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SurveyResultsPanel;
