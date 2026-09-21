import React, { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { downloadCSV } from '../../utils';
import {
  addMonth, spanOf, compareSpanOf, diffText, thisMonth, todayStr, shiftDay,
  type Mode, type Compare,
} from '../../lib/faqPeriod';


// 社外FAQ（お客様向けウィジェット）の集計。
//
// 【この画面の目的】
// アクセス数を眺めることではなく、**「次にどの回答を書き直すか／どんな質問を足すか」**を決めること。
// だから並びの既定は「問い合わせに進んだ数の多い順」＝そのまま直す優先順にしてある。
//
// 【主に見る数字は「問い合わせ率」であって「解決率」ではない】
// 🚨 「はい（解決した）」は押されないのが普通。解決した人ほど黙って去り、
//    解決しなかった人は「問い合わせたい」という動機があるので押す。
//    つまり解決率は必ず悪いほうに偏り、しかもどれだけ偏っているか分からない。
//    一方「問い合わせに進んだ率」はお客様が実際に取った行動なので、押す・押さないに左右されない。
//
// 🚨 集計はDB側の faq_public_event_summary に任せる（クライアントで1,000件ずつ読まない）。
//    この表は読んでいる最中も匿名から書き込まれ続けるため、ページを送ると
//    途中で新しい行が入り、二度読み・読み飛ばしが起きる。

interface SummaryRow {
  kind: string;
  reason: string | null;
  channel: string | null;
  topic_id: string | null;
  topic_question: string | null;
  school: string | null;
  course: string | null;
  n: number;
}

/** 来た方の内訳（端末・社内社外・国・都道府県・ブラウザ・流入元・時間帯・曜日）。
 *  🚨 「社内か社外か」は、集計のたびに**いまの会社のIPの一覧で判定し直している**
 *     （あとから会社のIPを登録しても、過去の記録に遡って効く） */
interface VisitorRow { dim: string; value: string; n: number; sessions: number }

/** 滞在時間。🚨 2つの測り方（操作の間隔／閉じるときの実測）の大きいほうを採っている */
interface DwellRow {
  sessions: number;
  median_sec: number | null;
  avg_sec: number | null;
  over_1min: number;
  measured: number;
}

/** よく見る期間。🚨 日数は「今日を含む」数え方（7日間＝今日と、その前の6日） */
const QUICK_RANGES = [
  { days: 1, label: '今日' },
  { days: 7, label: '7日間' },
  { days: 30, label: '30日間' },
] as const;

/** 内訳を出す順番。🚨 ここに無い項目は出さない（DB が増えても画面が勝手に変わらないように） */
const VISITOR_DIMS = ['端末', '社内/社外', '都道府県', '国', 'ブラウザ', '流入元', '時間帯', '曜日'] as const;

interface Props {
  /** 会社のIP（社内と見なす範囲）を変えられるのは管理者だけ。app_settings の書き込みが管理者限定のため */
  canEditSettings?: boolean;
  isDarkMode: boolean;
  /** 集計で「⚠️ 要確認」を付けたあと、一覧を読み直してもらう */
  onChanged: () => void;
}

/** CSVの1セル。
 *  🚨 お客様が打った文字がそのまま入るので、= + - @ で始まると Excel が数式として解釈する。
 *     先頭に ' を付けて必ず文字として扱わせる */
const cell = (v: unknown): string => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

const REASON_LABEL: Record<string, string> = {
  unsolved: '回答を読んだが解決しない',
  search_nomatch: '検索候補が的外れ',
  search_nohit: '検索候補が0件',
  unknown: '校・コースに該当なし',
  noanswer: '有効な回答が無い',
  load_error: '読み込みに失敗',
};

const REASON_ACTION: Record<string, string> = {
  unsolved: 'その回答を書き直す',
  search_nomatch: '検索の手がかり語を足す',
  search_nohit: '新しい質問と回答を作る',
  unknown: '既存の回答に対象を足す',
  noanswer: '下書きを公開する／期限を延ばす',
  load_error: '不具合。開発担当へ',
};

const FaqAnalytics: React.FC<Props> = ({ isDarkMode, onChanged, canEditSettings = false }) => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('month');
  const [ym, setYm] = useState(thisMonth);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [from, setFrom] = useState(() => `${thisMonth()}-01`);
  const [to, setTo] = useState(todayStr);
  const [cmp, setCmp] = useState<Compare>('none');
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [prevRows, setPrevRows] = useState<SummaryRow[] | null>(null);
  const [spanLabel, setSpanLabel] = useState('');
  const [cmpLabel, setCmpLabel] = useState('');
  const [words, setWords] = useState<{ word: string; n: number }[]>([]);
  const [visitors, setVisitors] = useState<VisitorRow[] | null>(null);
  const [dwell, setDwell] = useState<DwellRow | null>(null);
  const [staffWords, setStaffWords] = useState<{ word: string; n: number; miss: number }[]>([]);
  const [ipText, setIpText] = useState('');
  const [ipMsg, setIpMsg] = useState('');
  const [ipFail, setIpFail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [marking, setMarking] = useState<string | null>(null);

  const text = isDarkMode ? '#fff' : '#1a1a2e';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const bg = isDarkMode ? '#343a40' : '#fff';

  /** 期間ぶんの集計を取る（比べる相手があれば2回目も取る）。
   *  🚨 期間の組み立ては spanOf / compareSpanOf の1か所に集約している。
   *     画面のあちこちで日付を計算すると、境目のずれが1か所だけ直らずに残る */
  const load = useCallback(async (
    m: Mode, targetYm: string, targetYear: number, f: string, t: string, c: Compare,
  ) => {
    setLoading(true); setErr('');
    const span = spanOf(m, targetYm, targetYear, f, t);
    const prev = compareSpanOf(c, m, targetYm, targetYear, f, t);
    setSpanLabel(span.label);
    setCmpLabel(prev?.label ?? '');
    try {
      const { data, error } = await supabase.rpc('faq_public_event_summary', { p_from: span.from, p_to: span.to });
      // 🚨 rpc は 4xx/5xx でも throw しない。error を必ず見る（「通信を確認」で握りつぶさない）
      if (error) { setErr(`集計を読み込めませんでした：${error.message}`); setRows(null); return; }
      setRows((data ?? []) as SummaryRow[]);

      if (prev) {
        const { data: pd, error: perr } = await supabase.rpc('faq_public_event_summary', { p_from: prev.from, p_to: prev.to });
        if (perr) { setErr(`比べる期間を読み込めませんでした：${perr.message}`); setPrevRows(null); }
        else setPrevRows((pd ?? []) as SummaryRow[]);
      } else {
        setPrevRows(null);
      }

      // 「答えられなかった言葉」は既存の質問ログから取る（新しい表には検索語を持たせていない）
      // 🚨 件数を必ず指定する。指定しないと Supabase が1,000行で黙って打ち切る
      const { data: qs, error: qerr } = await supabase
        .from('faq_query_log')
        .select('raw_query')
        .eq('audience', 'public')
        .eq('had_match', false)
        .gte('created_at', span.from)
        .lt('created_at', span.to)
        .limit(500);
      if (qerr) { setErr(`検索ログを読み込めませんでした：${qerr.message}`); setWords([]); return; }
      const map = new Map<string, number>();
      for (const q of (qs ?? []) as { raw_query: string }[]) {
        map.set(q.raw_query, (map.get(q.raw_query) ?? 0) + 1);
      }
      setWords([...map.entries()].map(([word, n]) => ({ word, n })).sort((a, b) => b.n - a.n));

      // 来た方の内訳（端末・社内社外・都道府県 ほか）
      const { data: vd, error: verr } = await supabase.rpc('faq_public_visitor_summary', { p_from: span.from, p_to: span.to });
      if (verr) { setErr(`来た方の内訳を読み込めませんでした：${verr.message}`); setVisitors(null); }
      else setVisitors((vd ?? []) as VisitorRow[]);

      // 滞在時間
      const { data: dd, error: derr } = await supabase.rpc('faq_public_dwell_summary', { p_from: span.from, p_to: span.to });
      if (derr) { setErr(`滞在時間を読み込めませんでした：${derr.message}`); setDwell(null); }
      else setDwell(((dd ?? [])[0] ?? null) as DwellRow | null);

      // 社内FAQ（スタッフ用）の検索ワード。🚨 社内は検索ワードだけ（IP・端末は取っていない）
      // 🚨 件数を必ず指定する。指定しないと Supabase が1,000行で黙って打ち切る
      const { data: sq, error: sqerr } = await supabase
        .from('faq_query_log')
        .select('raw_query, had_match')
        .neq('audience', 'public')
        .gte('created_at', span.from)
        .lt('created_at', span.to)
        .limit(500);
      if (sqerr) { setErr(`社内の検索ログを読み込めませんでした：${sqerr.message}`); setStaffWords([]); }
      else {
        const sm = new Map<string, { n: number; miss: number }>();
        for (const q of (sq ?? []) as { raw_query: string; had_match: boolean }[]) {
          const cur = sm.get(q.raw_query) ?? { n: 0, miss: 0 };
          cur.n += 1;
          if (!q.had_match) cur.miss += 1;
          sm.set(q.raw_query, cur);
        }
        setStaffWords([...sm.entries()].map(([word, v]) => ({ word, ...v })).sort((a, b) => b.n - a.n));
      }

      // 会社のIP（社内と見なす範囲）。読めなくても集計は出す（設定欄が空になるだけ）
      const { data: ipRow } = await supabase
        .from('app_settings').select('value').eq('key', 'faq_internal_ips').maybeSingle();
      const ips = (ipRow?.value as { ips?: string[] } | null)?.ips;
      setIpText(Array.isArray(ips) ? ips.join(', ') : '');
    } catch (e) {
      setErr(`集計を読み込めませんでした：${e instanceof Error ? e.message : String(e)}`);
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = (o?: { mode?: Mode; ym?: string; year?: number; from?: string; to?: string; cmp?: Compare }) =>
    load(o?.mode ?? mode, o?.ym ?? ym, o?.year ?? year, o?.from ?? from, o?.to ?? to, o?.cmp ?? cmp);

  /** 会社のIPを保存する。
   *  🚨 upsert は0件でもエラーにならないので .select('key') で件数を見る（直したつもりで直っていないを防ぐ） */
  const saveIps = async () => {
    setIpMsg(''); setIpFail(false);
    const list = ipText.split(',').map(s => s.trim()).filter(Boolean);
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ key: 'faq_internal_ips', value: { ips: list } }, { onConflict: 'key' })
      .select('key');
    if (error) { setIpFail(true); setIpMsg(`保存できませんでした：${error.message}`); return; }
    if (!data || data.length === 0) {
      setIpFail(true); setIpMsg('保存できませんでした（0件）。管理者のアカウントでお試しください'); return;
    }
    setIpMsg(`保存しました（${list.length}件）`);
    reload();   // 「社内/社外」は集計のたびに判定し直すので、過去の記録にも効く
  };

  /** よく見る期間の日付を作る（今日を含めて days 日ぶん） */
  const quickSpan = (days: number) => {
    const t = todayStr();
    return { from: days <= 1 ? t : shiftDay(t, -(days - 1)), to: t };
  };
  const quickRange = (days: number) => {
    const { from: f, to: t } = quickSpan(days);
    setMode('range'); setFrom(f); setTo(t);
    reload({ mode: 'range', from: f, to: t });
  };
  /** いま選ばれているのがその期間か（ボタンを青くするため） */
  const isQuick = (days: number): boolean => {
    if (mode !== 'range') return false;
    const q = quickSpan(days);
    return from === q.from && to === q.to;
  };

  const openAndLoad = () => { setOpen(true); reload(); };
  /** ◀▶。月のときは月、年のときは年を動かす */
  const move = (diff: number) => {
    if (mode === 'month') { const next = addMonth(ym, diff); setYm(next); reload({ ym: next }); return; }
    const next = year + diff; setYear(next); reload({ year: next });
  };

  /** 質問ごとにまとめる（閲覧・問い合わせ・はい） */
  const byTopic = (() => {
    if (!rows) return [];
    const m = new Map<string, { id: string; q: string; views: number; contacts: number; solved: number }>();
    for (const r of rows) {
      if (!r.topic_id) continue;
      const cur = m.get(r.topic_id) ?? { id: r.topic_id, q: r.topic_question ?? '(質問が削除されています)', views: 0, contacts: 0, solved: 0 };
      if (r.kind === 'topic_view') cur.views += r.n;
      if (r.kind === 'contact') cur.contacts += r.n;
      if (r.kind === 'solved') cur.solved += r.n;
      if (r.topic_question) cur.q = r.topic_question;
      m.set(r.topic_id, cur);
    }
    // 既定は「問い合わせに進んだ数の多い順」＝直す優先順
    return [...m.values()].sort((a, b) => b.contacts - a.contacts || b.views - a.views);
  })();

  const sum = (src: SummaryRow[] | null, kind: string, reason?: string): number =>
    (src ?? []).filter(r => r.kind === kind && (reason === undefined || r.reason === reason))
      .reduce((s, r) => s + r.n, 0);

  const total = (kind: string, reason?: string): number => sum(rows, kind, reason);
  /** 比べる期間の数。比較しないときは null */
  const before = (kind: string, reason?: string): number | null =>
    prevRows === null ? null : sum(prevRows, kind, reason);

  /** 「120回（前月 95回 ／ +25）」の形。比較しないときは数だけ */
  const withDiff = (kind: string, reason?: string): string => {
    const n = total(kind, reason);
    const b = before(kind, reason);
    if (b === null) return `${n} 回`;
    return `${n} 回（${cmpLabel} ${b} 回 ／ ${diffText(n, b)}）`;
  };

  /** 質問ごとの、比べる期間の問い合わせ数 */
  const prevContactsByTopic = (() => {
    const m = new Map<string, number>();
    for (const r of prevRows ?? []) {
      if (!r.topic_id || r.kind !== 'contact') continue;
      m.set(r.topic_id, (m.get(r.topic_id) ?? 0) + r.n);
    }
    return m;
  })();

  /** 校・コースに該当が無かったもの */
  const unknownByPlace = (() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      if (r.kind !== 'contact' || r.reason !== 'unknown') continue;
      const key = [r.school, r.course].filter(Boolean).join('・') || '（未選択）';
      m.set(key, (m.get(key) ?? 0) + r.n);
    }
    return [...m.entries()].map(([place, n]) => ({ place, n })).sort((a, b) => b.n - a.n);
  })();

  /** その質問に「⚠️ 要確認」を付ける（判断 → 行動を1画面で閉じる） */
  const markReview = async (topicId: string, question: string) => {
    setMarking(topicId); setErr('');
    const { data, error } = await supabase
      .from('faq_topics')
      .update({ needs_review: true, review_note: `集計で問い合わせが多い（${ym}）` })
      .eq('id', topicId)
      .select('id');
    setMarking(null);
    // 🚨 update は0件でもエラーにならない。件数を必ず見る
    if (error) { setErr(`「要確認」を付けられませんでした：${error.message}`); return; }
    if (!data || data.length === 0) { setErr(`「要確認」を付けられませんでした（対象が見つかりません）：${question}`); return; }
    onChanged();
  };

  const exportCsv = () => {
    const head = ['質問', '閲覧', '問い合わせに進んだ', '問い合わせ率(%)', 'はい'];
    const lines = [head.map(cell).join(',')];
    for (const t of byTopic) {
      const rate = t.views > 0 ? Math.round((t.contacts / t.views) * 100) : '';
      lines.push([t.q, t.views, t.contacts, rate, t.solved].map(cell).join(','));
    }
    lines.push('');
    lines.push([cell('答えられなかった言葉'), cell('回数')].join(','));
    for (const w of words) lines.push([w.word, w.n].map(cell).join(','));
    downloadCSV(lines.join('\n'), `FAQ集計_${spanLabel.replace(/[^0-9A-Za-z年月-]/g, '_')}.csv`);
  };

  // 択一トグルの青（🎨🔒 固定ルール・例外なし）。他画面と同じ形にそろえる
  const pill = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold',
    border: `2px solid ${active ? '#1565c0' : '#90caf9'}`,
    background: active ? '#1976d2' : '#e3f2fd',
    color: active ? '#fff' : '#1565c0',
  });
  // 🚨 1グループ＝1行。見出しの幅を固定して、行をまたいでボタンの左端を揃える
  const filterRow: React.CSSProperties = {
    display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6,
  };
  const filterLabel: React.CSSProperties = {
    width: 34, flexShrink: 0, fontSize: 11, fontWeight: 'bold', color: sub,
  };
  const navBtn: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
    border: `1px solid ${border}`, background: bg, color: text,
  };
  const dateInput: React.CSSProperties = {
    padding: '4px 8px', borderRadius: 6, fontSize: 13,
    border: `1px solid ${border}`, background: bg, color: text,
  };

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 12, color: sub, borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: text, borderBottom: `1px solid ${border}` };

  if (!open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <button type="button" onClick={openAndLoad}
          style={{ padding: '8px 16px', borderRadius: 8, fontSize: 14, cursor: 'pointer', border: `2px solid #90caf9`, background: '#e3f2fd', color: '#1565c0' }}>
          📋 利用状況の集計を見る
        </button>
        <div style={{ fontSize: 12, color: sub, marginTop: 6 }}>
          お客様がどこでつまずいたかを集計します（押したときに読み込みます）
        </div>
      </div>
    );
  }

  const views = total('topic_view');
  const contacts = total('contact');

  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <strong style={{ fontSize: 14, color: text }}>📋 利用状況の集計（お客様向け）</strong>
        <button type="button" onClick={exportCsv} disabled={!rows}
          style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
          CSVで書き出す
        </button>
        <button type="button" onClick={() => setOpen(false)}
          style={{ padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
          閉じる
        </button>
      </div>

      {/* 期間の選び方。
          🚨 1行1グループにする（絞り込みを1行に詰めると、どこで区切れているか見えなくなる。
             備品精算の履歴で実際に起きた）。
          🚨 配色は択一トグルの青（🎨🔒 固定・未選択 #e3f2fd／選択 #1976d2ベタ） */}
      <div style={filterRow}>
        <span style={filterLabel}>期間</span>
        <button type="button" style={pill(mode === 'month')}
          onClick={() => { setMode('month'); reload({ mode: 'month' }); }}>月ごと</button>
        <button type="button" style={pill(mode === 'year')}
          onClick={() => { setMode('year'); reload({ mode: 'year' }); }}>年ごと</button>
        <button type="button" style={pill(mode === 'range')}
          onClick={() => { setMode('range'); reload({ mode: 'range' }); }}>期間を指定</button>

        {mode === 'range' ? (
          <>
            <input type="date" value={from} max={to}
              onChange={e => { setFrom(e.target.value); reload({ from: e.target.value }); }} style={dateInput} />
            <span style={{ fontSize: 13, color: sub }}>〜</span>
            <input type="date" value={to} min={from}
              onChange={e => { setTo(e.target.value); reload({ to: e.target.value }); }} style={dateInput} />
          </>
        ) : (
          <>
            <button type="button" onClick={() => move(-1)} style={navBtn} aria-label="前へ">◀</button>
            <span style={{ fontSize: 14, color: text, fontWeight: 'bold', minWidth: 74, textAlign: 'center' }}>
              {mode === 'month' ? ym : `${year}年`}
            </span>
            <button type="button" onClick={() => move(1)} style={navBtn} aria-label="次へ">▶</button>
          </>
        )}
      </div>

      {/* よく見る期間。押すと「期間を指定」に切り替わり、日付が入る。
          🚨 日付の組み立ては faqPeriod の shiftDay を通す（自前で引き算しない。境目がずれる） */}
      <div style={filterRow}>
        <span style={filterLabel}>よく見る</span>
        {QUICK_RANGES.map(q => (
          <button key={q.days} type="button" style={pill(isQuick(q.days))}
            onClick={() => quickRange(q.days)}>{q.label}</button>
        ))}
      </div>

      <div style={filterRow}>
        <span style={filterLabel}>比較</span>
        <button type="button" style={pill(cmp === 'none')}
          onClick={() => { setCmp('none'); reload({ cmp: 'none' }); }}>比較しない</button>
        <button type="button" style={pill(cmp === 'prev')}
          onClick={() => { setCmp('prev'); reload({ cmp: 'prev' }); }}>
          {mode === 'year' ? '前年' : mode === 'month' ? '前月' : '直前の同じ日数'}
        </button>
        {/* 年ごとのときは「前年」と「前年同期」が同じものになるので出さない */}
        {mode !== 'year' && (
          <button type="button" style={pill(cmp === 'lastYear')}
            onClick={() => { setCmp('lastYear'); reload({ cmp: 'lastYear' }); }}>前年同期</button>
        )}
        {cmpLabel && (
          <span style={{ fontSize: 12, color: sub }}>
            {spanLabel} と {cmpLabel} を比べています
          </span>
        )}
      </div>

      {err && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13, color: '#721c24' }}>
          {err}
        </div>
      )}

      {loading && <div style={{ fontSize: 13, color: sub }}>読み込んでいます...</div>}

      {!loading && rows && (
        <>
          <div style={{ fontSize: 13, color: text, marginBottom: 10 }}>
            <div>ページを開いた {withDiff('page_view')}（参考値）</div>
            <div>回答を読んだ <strong>{withDiff('topic_view')}</strong></div>
            <div>問い合わせに進んだ <strong>{withDiff('contact')}</strong></div>
            <div>電話・フォームを押した {withDiff('contact_click')}</div>
            <div>「はい」 {withDiff('solved')}</div>
          </div>

          {views === 0 && contacts === 0 && (
            <div style={{ background: '#fff3cd', border: '2px solid #ffc107', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13, color: '#856404', lineHeight: 1.7 }}>
              この期間の記録が0件です。<br />
              ウィジェットがホームページ（WordPress）に設置されているかを確認してください。
              設置されていないと、いつまでも0件のままです。
            </div>
          )}

          {/* 主表：直す優先順 */}
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 620 }}>
              <thead>
                <tr>
                  <th style={th}>質問</th>
                  <th style={th}>閲覧</th>
                  <th style={th}>問い合わせに進んだ</th>
                  <th style={th}>問い合わせ率</th>
                  {prevRows !== null && <th style={th}>{cmpLabel}</th>}
                  {prevRows !== null && <th style={th}>増減</th>}
                  <th style={th}>はい</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {byTopic.length === 0 && (
                  <tr><td style={td} colSpan={prevRows !== null ? 8 : 6}><span style={{ color: sub }}>この期間の記録はありません</span></td></tr>
                )}
                {byTopic.map(t => (
                  <tr key={t.id}>
                    <td style={{ ...td, minWidth: 220 }}>{t.q}</td>
                    <td style={td}>{t.views}</td>
                    <td style={{ ...td, fontWeight: t.contacts > 0 ? 'bold' : 'normal' }}>{t.contacts}</td>
                    <td style={td}>{t.views > 0 ? `${Math.round((t.contacts / t.views) * 100)}%` : '-'}</td>
                    {prevRows !== null && <td style={td}>{prevContactsByTopic.get(t.id) ?? 0}</td>}
                    {/* 🚨 増減に色は付けない。問い合わせは減ったほうが良いので、
                        赤字＝悪い という一般的な感覚と逆になる */}
                    {prevRows !== null && <td style={td}>{diffText(t.contacts, prevContactsByTopic.get(t.id) ?? 0)}</td>}
                    <td style={td}>{t.solved}</td>
                    <td style={td}>
                      <button type="button" disabled={marking === t.id}
                        onClick={() => markReview(t.id, t.q)}
                        style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #f59e0b', background: '#fff8e1', color: '#92400e', whiteSpace: 'nowrap' }}>
                        {marking === t.id ? '…' : '⚠️ 要確認にする'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* つまずいた理由の内訳＝やるべきこと */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>つまずいた理由と、やるべきこと</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
                <thead><tr><th style={th}>理由</th><th style={th}>件数</th><th style={th}>やるべきこと</th></tr></thead>
                <tbody>
                  {Object.keys(REASON_LABEL).map(k => (
                    <tr key={k}>
                      <td style={td}>{REASON_LABEL[k]}</td>
                      <td style={{ ...td, fontWeight: total('contact', k) > 0 ? 'bold' : 'normal' }}>{total('contact', k)}</td>
                      <td style={{ ...td, color: sub }}>{REASON_ACTION[k]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 答えられなかった言葉 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>
              答えられなかった言葉（新しい質問を作る材料）
            </div>
            {words.length === 0
              ? <div style={{ fontSize: 13, color: sub }}>この期間はありません</div>
              : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {words.map(w => (
                    <span key={w.word} style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, border: `1px solid ${border}`, color: text }}>
                      {w.word} <span style={{ color: sub }}>×{w.n}</span>
                    </span>
                  ))}
                </div>}
          </div>

          {/* 校・コースに該当が無かったもの */}
          {unknownByPlace.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>
                校・コースの回答が足りない（既存の回答に対象を足す）
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {unknownByPlace.map(u => (
                  <span key={u.place} style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, border: `1px solid ${border}`, color: text }}>
                    {u.place} <span style={{ color: sub }}>×{u.n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 滞在時間。🚨 2つの測り方の大きいほうを採っていることを画面にも書く（数字の意味が変わるため） */}
          {dwell !== null && dwell.sessions > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>滞在時間</div>
              <div style={{ fontSize: 13, color: text, lineHeight: 1.9 }}>
                {dwell.sessions}人 ／ 中央値 <strong>{dwell.median_sec ?? '-'}秒</strong>
                ／ 平均 {dwell.avg_sec ?? '-'}秒 ／ 1分以上 {dwell.over_1min}人
              </div>
              <div style={{ fontSize: 12, color: sub, lineHeight: 1.7 }}>
                ※ {dwell.measured}人ぶんは「閉じたとき」に実測できた時間。
                残りは<strong>最初と最後の操作の差</strong>で数えているので、
                読んだだけで何も押さなかった方は<strong>0秒</strong>になります（短めに出ます）
              </div>
            </div>
          )}

          {/* 来た方の内訳 */}
          {visitors !== null && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>来た方の内訳</div>
              {visitors.length === 0
                ? <div style={{ fontSize: 13, color: sub }}>この期間の記録はありません</div>
                : VISITOR_DIMS.map(d => {
                    const list = visitors.filter(v => v.dim === d).sort((a, b) => b.n - a.n);
                    if (list.length === 0) return null;
                    return (
                      <div key={d} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: sub, width: 70, flexShrink: 0 }}>{d}</span>
                        {list.map(v => (
                          <span key={v.value} style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, border: `1px solid ${border}`, color: text }}>
                            {v.value} <span style={{ color: sub }}>{v.n}件 / {v.sessions}人</span>
                          </span>
                        ))}
                      </div>
                    );
                  })}
              <div style={{ fontSize: 12, color: sub, lineHeight: 1.7, marginTop: 4 }}>
                ※ 「社内/社外」は、⚙️ の<strong>会社のIP</strong>の設定と照らして判定します。
                未設定のあいだは全部「社外」になります（<strong>あとから設定すれば過去の記録にも反映されます</strong>）<br />
                ※ 「都道府県」は<strong>毎晩4時20分にまとめて調べます</strong>（その日のぶんは翌朝に入ります）。
                <strong>未調査</strong>＝まだ調べていない／<strong>不明</strong>＝調べたが分からなかった（海外・社内のIPなど）
              </div>
              {/* GeoLite2 の出典。🚨 条件は「使っていると述べる広告・説明資料に出すこと」。
                  都道府県はこの社内の集計でしか使わないので、その画面に1行置いておけば足りる。
                  🚨 短くしても「GeoLite2」「MaxMind」「リンク」の3つは必ず残すこと */}
              <div style={{ fontSize: 11, color: sub, marginTop: 6 }}>
                地域の判定：GeoLite2 データ（MaxMind）{' '}
                <a href="https://www.maxmind.com" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>https://www.maxmind.com</a>
              </div>

              {/* 会社のIPの設定（管理者だけ） */}
              {canEditSettings && (
                <div style={{ marginTop: 10, padding: '10px 12px', border: `1px solid ${border}`, borderRadius: 8 }}>
                  <div style={{ fontSize: 12.5, color: text, marginBottom: 6 }}>
                    会社のIP（ここから来たアクセスを「社内」と数えます）
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      value={ipText}
                      onChange={e => { setIpText(e.target.value); setIpMsg(''); }}
                      placeholder="例：203.0.113.45, 192.168.0.0/24"
                      style={{ flex: '1 1 260px', minWidth: 200, padding: '7px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${border}`, background: bg, color: text }}
                    />
                    <button type="button" onClick={saveIps}
                      style={{ padding: '7px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
                      保存
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: sub, marginTop: 6, lineHeight: 1.7 }}>
                    カンマで区切って複数書けます。範囲（192.168.0.0/24 のような書き方）も使えます。<br />
                    🚨 分からないときは空のままで構いません（全部「社外」として数えます）
                  </div>
                  {ipMsg && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
                      background: ipFail ? '#f8d7da' : '#d4edda',
                      border: `1px solid ${ipFail ? '#f5c2c7' : '#c3e6cb'}`,
                      color: ipFail ? '#842029' : '#155724',
                    }}>
                      {ipFail ? '' : '✓ '}{ipMsg}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 社内FAQ（スタッフ用）の検索ワード。🚨 社内は検索ワードだけ（端末・IPは取らない） */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>
              社内FAQで検索された言葉（スタッフ用）
            </div>
            {staffWords.length === 0
              ? <div style={{ fontSize: 13, color: sub }}>この期間はありません</div>
              : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {staffWords.map(w => (
                    <span key={w.word} style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, border: `1px solid ${border}`, color: text }}>
                      {w.word} <span style={{ color: sub }}>×{w.n}</span>
                      {w.miss > 0 && <span style={{ color: '#b35900' }}>（見つからず {w.miss}）</span>}
                    </span>
                  ))}
                </div>}
            <div style={{ fontSize: 12, color: sub, marginTop: 4 }}>
              ※ 社内は<strong>検索した言葉だけ</strong>を記録しています（端末・IP・滞在時間は取っていません）
            </div>
          </div>

          <div style={{ fontSize: 12, color: sub, lineHeight: 1.8, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
            ・見るべきは「<strong>問い合わせ率</strong>」です。「はい」は押されないほうが普通なので、
            少ないからといって悪いとは限りません<br />
            ・「ページを開いた」回数は、検索するプログラム（ボット）も数えるため<strong>参考値</strong>です<br />
            ・同じ方が翌日また来た場合は<strong>別の方として数えます</strong>（誰かを追いかける記録は持っていません）<br />
            ・電話は画面が切り替わるため、<strong>押しても記録が間に合わないことがあります</strong><br />
            ・<strong>2026-09-05 より前の記録はありません</strong>（この集計はその日から取り始めました）。<br />
            　記録は<strong>24か月</strong>で自動的に消えます（前年同期との比較はそのぶんまで）
          </div>
        </>
      )}
    </div>
  );
};

export default FaqAnalytics;
