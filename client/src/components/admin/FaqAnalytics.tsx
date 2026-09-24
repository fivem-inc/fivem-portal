import React, { useState, useCallback, useRef } from 'react';
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

/** 検索ログを一度に読む上限。🚨 これに達したら「打ち切っています」と画面に出す
 *  （黙って切れると、件数が多い月ほど「検索して見つからなかった言葉」のランキングが静かに狂う）。
 *  🚨 order を付けて「新しい順の◯件」と意味を確定させている（付けないとどの◯件か不定） */
const LOG_LIMIT = 500;

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

/** その理由の問い合わせに「どの質問か」が付いているか。
 *  🚨 呼び出し元を1つずつ当たって確かめた（2026-09-24・FaqWidget.tsx）：
 *      unsolved  … 回答の画面から押す      → 質問が付く
 *      noanswer  … 質問を開いた直後         → 質問が付く
 *      unknown   … 校・コースを選んだあと   → 質問が付く
 *      search_nomatch / search_nohit … 検索結果の画面から押す → **質問が決まっていない**
 *      load_error … 画面が出る前            → 付かない
 *  🚨 付かない理由のところを空欄にしない。空欄だと「出ていないだけ」なのか
 *     「不具合で消えている」のか見分けが付かないので、記録できない旨を書く */
const REASON_HAS_TOPIC: Record<string, boolean> = {
  unsolved: true,
  search_nomatch: false,
  search_nohit: false,
  unknown: true,
  noanswer: true,
  load_error: false,
};

/** 理由の下に出す質問の数。これを超えたぶんは「ほか◯件の質問」とだけ書く */
const REASON_TOPIC_TOP = 3;

const REASON_ACTION: Record<string, string> = {
  unsolved: 'その回答を書き直す',
  search_nomatch: '検索の手がかり語を足す',
  search_nohit: '新しい質問と回答を作る',
  unknown: '既存の回答に対象を足す',
  noanswer: '下書きを公開する／期限を延ばす',
  load_error: '不具合。開発担当へ',
};

/** 問い合わせ率。🚨 表とCSVの**両方がこれを呼ぶ**（同じ式を2か所に書かない）。
 *  🚨 100% を超えたら数字を出さない。分母は「読んだ人の数」、分子は「問い合わせに回った人の数」なので、
 *     100% を超えるのは数え方がずれている証拠。黙って変な数字を出すより、出さないほうがよい
 *     （2026-09-22 まで実際にずれていて 150% と表示されていた）。null＝出せない */
function contactRate(views: number, contacts: number): number | null {
  if (views <= 0) return null;
  const r = Math.round((contacts / views) * 100);
  return r > 100 ? null : r;
}

/** 横棒で出すときの1行 */
interface BarItem { key: string; label: string; n: number; note?: string }

/** 折りたたまずに出す上限。🚨 これを超えたぶんは「残り◯件を見る」で広げる
 *  （言葉の一覧は何十個にもなるので、全部出すと画面が縦に伸びて他の項目が見えなくなる） */
const BAR_LIMIT = 10;

/** 時間帯・曜日の並び。🚨 この2つだけは「多い順」にしない。
 *  多い順にすると 17時→10時→03時… と並び、**いつ来るかという形が読めなくなる**。
 *  記録が0の時間・曜日も並べる（「深夜は来ない」こと自体が読み取れるように） */
const ORDER_HOUR = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}時`);
const ORDER_DOW = ['月', '火', '水', '木', '金', '土', '日'];

/** 量を横棒で出す。内訳・言葉の一覧の**4か所すべてがこれを呼ぶ**（同じものを書き写さない）。
 *  🚨 チップ（枠付きの札）をやめた理由：**幅が文字数で決まる**ので量を逆に読ませる。
 *     実データで「未調査 1人」と「大阪府 3人」がほぼ同じ幅になっていた。棒なら長さが数に比例する。
 *  🚨 色は択一トグルの2色だけ（🎨🔒・新しい色は足さない）。
 *     棒の上に文字を載せない＝押せるボタンに見せないため */
const Bars: React.FC<{
  items: BarItem[];
  /** 数の単位。🚨 「人」と「回」が混ざるので、必ずその行に書く */
  unit: string;
  isDarkMode: boolean;
  /** true＝items の並びをそのまま使い、折りたたまない（時間帯・曜日）。
   *  🚨 順番に意味がある軸を上位10件で切ると、軸そのものが途中で切れて読めなくなる */
  keepOrder?: boolean;
}> = ({ items, unit, isDarkMode, keepOrder = false }) => {
  const [expanded, setExpanded] = useState(false);
  const text = isDarkMode ? '#fff' : '#1a1a2e';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const bg = isDarkMode ? '#343a40' : '#fff';
  // 🚨 並べ替えてから切る（切ってから並べ替えると、上位が上位でなくなる）
  const list = keepOrder ? items : [...items].sort((a, b) => b.n - a.n);
  const shown = (keepOrder || expanded) ? list : list.slice(0, BAR_LIMIT);
  const rest = list.length - shown.length;
  // 🚨 割る数を0にしない（全部0件のとき NaN になって棒が消える）
  const max = Math.max(1, ...list.map(i => i.n));
  const moreBtn: React.CSSProperties = {
    marginTop: 4, padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${border}`, background: bg, color: text,
  };
  return (
    <div>
      {shown.map(i => (
        <div key={i.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 12.5, color: i.n > 0 ? text : sub, width: 124, flexShrink: 0, overflowWrap: 'anywhere' }}>
            {i.label}
          </span>
          <span style={{ flex: '1 1 50px', minWidth: 36, height: 8, borderRadius: 4, background: '#e3f2fd', overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${Math.round((i.n / max) * 100)}%`, height: '100%', background: '#1976d2' }} />
          </span>
          <span style={{ fontSize: 12.5, color: i.n > 0 ? text : sub, width: 56, flexShrink: 0, textAlign: 'right' }}>
            {i.n} {unit}
          </span>
          {i.note && <span style={{ fontSize: 12, color: sub, flexShrink: 0 }}>{i.note}</span>}
        </div>
      ))}
      {rest > 0 && (
        <button type="button" onClick={() => setExpanded(true)} style={moreBtn}>
          残り {rest} 件を見る
        </button>
      )}
      {expanded && !keepOrder && list.length > BAR_LIMIT && (
        <button type="button" onClick={() => setExpanded(false)} style={moreBtn}>
          上位 {BAR_LIMIT} 件だけにする
        </button>
      )}
    </div>
  );
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
  // 検索ログが上限で切られたか（切られたまま黙っていると、ランキングが嘘になる）
  const [wordsCut, setWordsCut] = useState(false);
  const [staffWordsCut, setStaffWordsCut] = useState(false);
  const [ipText, setIpText] = useState('');
  const [ipMsg, setIpMsg] = useState('');
  const [ipFail, setIpFail] = useState(false);
  // 🚨 会社のIPを読み込めなかったとき（2026-09-22）。
  //    以前は error を受け取っておらず、読めないと入力欄が**空**になっていた。
  //    そのまま［保存］を押すと {"ips": []} で上書きされ、「保存しました（0件）」と緑で出る。
  //    社内/社外は集計のたびに判定し直すので、過去2年ぶんが全部「社外」に変わる。
  //    しかも app_settings は履歴を持たないので、消えた値はどこにも残らない。
  const [ipLoadErr, setIpLoadErr] = useState('');
  // 空にして保存する前のその場の確認
  const [ipClearConfirm, setIpClearConfirm] = useState(false);
  // 打ちかけを読み直しで消さないための印（期間ボタンを押すたびに load が走るため）
  const ipDirty = useRef(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [marking, setMarking] = useState<string | null>(null);

  const text = isDarkMode ? '#fff' : '#1a1a2e';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const bg = isDarkMode ? '#343a40' : '#fff';

  // 🚨 いちばん新しい読み込みだけが画面に書き込む（2026-09-22）。
  //    日付の入力は打つたびに reload を呼ぶので、読み込みが何本も重なる。
  //    順番の見張りが無いと、遅いほう（＝古い期間）が後から着地して
  //    「見出しは9月・中身は8月」になる。しかも画面にはどこにも手がかりが出ない
  const loadSeq = useRef(0);

  /** 期間ぶんの集計を取る（比べる相手があれば2回目も取る）。
   *  🚨 期間の組み立ては spanOf / compareSpanOf の1か所に集約している。
   *     画面のあちこちで日付を計算すると、境目のずれが1か所だけ直らずに残る */
  const load = useCallback(async (
    m: Mode, targetYm: string, targetYear: number, f: string, t: string, c: Compare,
  ) => {
    const seq = ++loadSeq.current;
    const latest = () => seq === loadSeq.current;
    setLoading(true); setErr('');
    // 🚨 先に全部まっさらにする。ここを消さないと、途中で失敗したときに
    //    **前の期間の内訳・滞在時間・検索ワードが残ったまま**新しい期間の表と並ぶ
    setRows(null); setPrevRows(null); setVisitors(null); setDwell(null);
    setWords([]); setStaffWords([]); setWordsCut(false); setStaffWordsCut(false);
    const span = spanOf(m, targetYm, targetYear, f, t);
    const prev = compareSpanOf(c, m, targetYm, targetYear, f, t);
    // 🚨 失敗したものだけを覚えておき、最後にまとめて出す。
    //    1本の文字列に setErr すると、後から来た失敗が前の失敗を消してしまう
    const problems: string[] = [];
    try {
      const { data, error } = await supabase.rpc('faq_public_event_summary', { p_from: span.from, p_to: span.to });
      if (!latest()) return;
      // 🚨 rpc は 4xx/5xx でも throw しない。error を必ず見る（「通信を確認」で握りつぶさない）
      if (error) problems.push(`集計を読み込めませんでした：${error.message}`);
      else setRows((data ?? []) as SummaryRow[]);

      if (prev) {
        const { data: pd, error: perr } = await supabase.rpc('faq_public_event_summary', { p_from: prev.from, p_to: prev.to });
        if (!latest()) return;
        if (perr) problems.push(`比べる期間を読み込めませんでした：${perr.message}`);
        else setPrevRows((pd ?? []) as SummaryRow[]);
      }

      // 「検索して見つからなかった言葉」は既存の質問ログから取る（新しい表には検索語を持たせていない）
      // 🚨 件数を必ず指定する。指定しないと Supabase が1,000行で黙って打ち切る
      const { data: qs, error: qerr } = await supabase
        .from('faq_query_log')
        .select('raw_query')
        .eq('audience', 'public')
        .eq('had_match', false)
        .gte('created_at', span.from)
        .lt('created_at', span.to)
        .order('created_at', { ascending: false })
        .limit(LOG_LIMIT);
      if (!latest()) return;
      // 🚨 ここで return しない。前は return していたので、これ以降（内訳・滞在時間）が
      //    前の期間のまま残っていた
      if (qerr) problems.push(`検索ログを読み込めませんでした：${qerr.message}`);
      else {
        setWordsCut((qs ?? []).length >= LOG_LIMIT);
        const map = new Map<string, number>();
        for (const q of (qs ?? []) as { raw_query: string }[]) {
          map.set(q.raw_query, (map.get(q.raw_query) ?? 0) + 1);
        }
        setWords([...map.entries()].map(([word, n]) => ({ word, n })).sort((a, b) => b.n - a.n));
      }

      // 来た方の内訳（端末・社内社外・都道府県 ほか）
      const { data: vd, error: verr } = await supabase.rpc('faq_public_visitor_summary', { p_from: span.from, p_to: span.to });
      if (!latest()) return;
      if (verr) problems.push(`来た方の内訳を読み込めませんでした：${verr.message}`);
      else setVisitors((vd ?? []) as VisitorRow[]);

      // 滞在時間
      const { data: dd, error: derr } = await supabase.rpc('faq_public_dwell_summary', { p_from: span.from, p_to: span.to });
      if (!latest()) return;
      if (derr) problems.push(`滞在時間を読み込めませんでした：${derr.message}`);
      else setDwell(((dd ?? [])[0] ?? null) as DwellRow | null);

      // 社内FAQ（スタッフ用）の検索ワード。🚨 社内は検索ワードだけ（IP・端末は取っていない）
      // 🚨 件数を必ず指定する。指定しないと Supabase が1,000行で黙って打ち切る
      const { data: sq, error: sqerr } = await supabase
        .from('faq_query_log')
        .select('raw_query, had_match')
        .neq('audience', 'public')
        .gte('created_at', span.from)
        .lt('created_at', span.to)
        .order('created_at', { ascending: false })
        .limit(LOG_LIMIT);
      if (!latest()) return;
      if (sqerr) problems.push(`社内の検索ログを読み込めませんでした：${sqerr.message}`);
      else {
        setStaffWordsCut((sq ?? []).length >= LOG_LIMIT);
        const sm = new Map<string, { n: number; miss: number }>();
        for (const q of (sq ?? []) as { raw_query: string; had_match: boolean }[]) {
          const cur = sm.get(q.raw_query) ?? { n: 0, miss: 0 };
          cur.n += 1;
          if (!q.had_match) cur.miss += 1;
          sm.set(q.raw_query, cur);
        }
        setStaffWords([...sm.entries()].map(([word, v]) => ({ word, ...v })).sort((a, b) => b.n - a.n));
      }

      // 会社のIP（社内と見なす範囲）。読めなくても集計は出す。
      // 🚨 ただし**入力欄は空にしない**。空のまま保存すると登録済みのIPが消え、
      //    過去2年ぶんの「社内/社外」が全部「社外」に変わる（履歴が無いので元に戻せない）
      const { data: ipRow, error: ipErr } = await supabase
        .from('app_settings').select('value').eq('key', 'faq_internal_ips').maybeSingle();
      if (!latest()) return;
      if (ipErr) {
        setIpLoadErr(`会社のIPを読み込めませんでした：${ipErr.message}`);
      } else {
        setIpLoadErr('');
        const ips = (ipRow?.value as { ips?: string[] } | null)?.ips;
        // 🚨 打ちかけがあるときは上書きしない（期間ボタンを押すたびに load が走るため）
        if (!ipDirty.current) setIpText(Array.isArray(ips) ? ips.join(', ') : '');
      }

      // 🚨 見出しは**中身が揃ってから**変える。先に変えると「9月と書いてあるのに8月の数字」になる
      setSpanLabel(span.label);
      setCmpLabel(prev?.label ?? '');
      setErr(problems.join('\n'));
    } catch (e) {
      if (!latest()) return;
      setErr(`集計を読み込めませんでした：${e instanceof Error ? e.message : String(e)}`);
      setRows(null);
    } finally {
      if (latest()) setLoading(false);
    }
  }, []);

  const reload = (o?: { mode?: Mode; ym?: string; year?: number; from?: string; to?: string; cmp?: Compare }) =>
    load(o?.mode ?? mode, o?.ym ?? ym, o?.year ?? year, o?.from ?? from, o?.to ?? to, o?.cmp ?? cmp);

  /** 会社のIPを保存する。
   *  🚨 upsert は0件でもエラーにならないので .select('key') で件数を見る（直したつもりで直っていないを防ぐ） */
  const saveIps = async (confirmedEmpty = false) => {
    setIpMsg(''); setIpFail(false);
    const list = ipText.split(',').map(s => s.trim()).filter(Boolean);
    // 🚨 空で保存＝登録済みのIPを消すこと。過去2年ぶんが全部「社外」に変わるので、必ず一度確かめる
    if (list.length === 0 && !confirmedEmpty) { setIpClearConfirm(true); return; }
    setIpClearConfirm(false);
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ key: 'faq_internal_ips', value: { ips: list } }, { onConflict: 'key' })
      .select('key');
    if (error) { setIpFail(true); setIpMsg(`保存できませんでした：${error.message}`); return; }
    if (!data || data.length === 0) {
      setIpFail(true); setIpMsg('保存できませんでした（0件）。管理者のアカウントでお試しください'); return;
    }
    setIpMsg(`保存しました（${list.length}件）`);
    ipDirty.current = false;   // 保存できたので、読み直しで上書きしてよい
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

  /** 質問ごとにまとめる（読んだ人・進んだ人・はい）。
   *  🚨 比べているときは、**当期と前期の質問の和集合**から作る（2026-09-22）。
   *     当期だけから作ると、前月50件あった質問を直して今月0件になったとき
   *     **その行が丸ごと消える**＝「直した効果があった」といういちばん見たい情報が見えない。
   *     逆に「今月急に増えた」だけが見えるので、悪い方向にだけ偏った表になっていた */
  const byTopic = (() => {
    if (!rows) return [];
    const m = new Map<string, { id: string; q: string; views: number; contacts: number; solved: number }>();
    const put = (r: SummaryRow, countIt: boolean) => {
      if (!r.topic_id) return;
      const cur = m.get(r.topic_id) ?? { id: r.topic_id, q: r.topic_question ?? '(質問が削除されています)', views: 0, contacts: 0, solved: 0 };
      if (countIt) {
        if (r.kind === 'topic_view') cur.views += r.n;
        if (r.kind === 'contact') cur.contacts += r.n;
        if (r.kind === 'solved') cur.solved += r.n;
      }
      if (r.topic_question) cur.q = r.topic_question;
      m.set(r.topic_id, cur);
    };
    for (const r of rows) put(r, true);
    // 🚨 前期の行は「質問を登場させる」だけ。数は足さない（当期の数字を汚さない）
    for (const r of (prevRows ?? [])) put(r, false);
    // 既定は「問い合わせに進んだ数の多い順」＝直す優先順。当期0件は自然に下へ行く
    return [...m.values()].sort((a, b) => b.contacts - a.contacts || b.views - a.views);
  })();

  const sum = (src: SummaryRow[] | null, kind: string, reason?: string): number =>
    (src ?? []).filter(r => r.kind === kind && (reason === undefined || r.reason === reason))
      .reduce((s, r) => s + r.n, 0);

  const total = (kind: string, reason?: string): number => sum(rows, kind, reason);
  /** 比べる期間の数。比較しないときは null */
  const before = (kind: string, reason?: string): number | null =>
    prevRows === null ? null : sum(prevRows, kind, reason);

  /** 「120人（前月 95人 ／ +25）」の形。比較しないときは数だけ。
   *  🚨 単位を引数で受ける。ウィジェットは `once` という鍵で「同じ方は1回だけ」に間引いており、
   *     数えているものが行によって違う（下の呼び出し側にどれが何かを書いてある）。
   *     以前はここが全部「回」の決め打ちで、**5行のうち4行が嘘になっていた**（2026-09-24 に判明） */
  const withDiff = (kind: string, unit: string, reason?: string): string => {
    const n = total(kind, reason);
    const b = before(kind, reason);
    if (b === null) return `${n} ${unit}`;
    return `${n} ${unit}（${cmpLabel} ${b} ${unit} ／ ${diffText(n, b)}）`;
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

  /** その理由の問い合わせが、どの質問から出たかを多い順に返す。
   *  🚨 「その回答を書き直す」と書いてあるのに、**どれを書き直すのかが画面に出ていなかった**
   *     （2026-09-24 ユーザー指摘）。記録そのものは最初から持っていた（topic_id）ので、出すだけ */
  const topicsForReason = (reason: string): { q: string; n: number }[] => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      if (r.kind !== 'contact' || r.reason !== reason || !r.topic_id) continue;
      const q = r.topic_question ?? '(質問が削除されています)';
      m.set(q, (m.get(q) ?? 0) + r.n);
    }
    return [...m.entries()].map(([q, n]) => ({ q, n })).sort((a, b) => b.n - a.n);
  };

  /** 来た方の内訳の1軸ぶんを、横棒に渡せる形にする。
   *  🚨 数えるのは **sessions（人）だけ**（2026-09-24）。
   *     もう一方の n は「記録の行数」で、`once` で間引かれたあとの数なので
   *     回でも人でもなく、業務上の意味を説明できなかった。出すのをやめた。
   *  🚨 時間帯・曜日は記録が0のぶんも並べる（「その時間は来ていない」ことを読ませるため）。
   *     想定していない値が来ても**落とさず末尾に足す**（DB側が増えたときに黙って消えないように） */
  const barsFor = (dim: string): { items: BarItem[]; keepOrder: boolean } => {
    const list = (visitors ?? []).filter(v => v.dim === dim);
    const order = dim === '時間帯' ? ORDER_HOUR : dim === '曜日' ? ORDER_DOW : null;
    if (!order) {
      return { items: list.map(v => ({ key: v.value, label: v.value, n: v.sessions })), keepOrder: false };
    }
    const m = new Map(list.map(v => [v.value, v.sessions]));
    const items: BarItem[] = order.map(v => ({ key: v, label: v, n: m.get(v) ?? 0 }));
    for (const v of list) {
      if (!order.includes(v.value)) items.push({ key: v.value, label: v.value, n: v.sessions });
    }
    return { items, keepOrder: true };
  };

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
    // 🚨 画面の列名と同じ言葉にする（片方だけ直すと、突き合わせるときに別のものに見える）
    const head = ['質問', '読んだ人', '進んだ人', '問い合わせ率(%)', 'はい'];
    const lines = [head.map(cell).join(',')];
    for (const t of byTopic) {
      const rate = contactRate(t.views, t.contacts) ?? '';
      lines.push([t.q, t.views, t.contacts, rate, t.solved].map(cell).join(','));
    }
    lines.push('');
    lines.push([cell('検索して見つからなかった言葉'), cell('回数')].join(','));
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

      {/* 🚨 失敗が複数あるときは全部出す（1本の文字列だと後から来た失敗が前を消していた） */}
      {err && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13, color: '#721c24', whiteSpace: 'pre-line' }}>
          {err}
        </div>
      )}

      {loading && <div style={{ fontSize: 13, color: sub }}>読み込んでいます...</div>}

      {!loading && rows && (
        <>
          {/* 🚨 単位は行ごとに書く（2026-09-24）。ウィジェットの `once` の鍵で
              何を数えているかが行ごとに違う。実測した鍵は次のとおり：
                ページを開いた       once='page'                    → 1人1回＝**人**
                回答を読んだ         once='topic:<質問>'            → 質問ごとに1人1回＝**のべ人**
                問い合わせに進んだ   once='contact:<質問>:<理由>'   → 質問・理由ごとに1人1回＝**のべ人**
                「はい」             once='solved:<質問>'           → **のべ人**
                電話・フォームを押した once **なし**                 → 押すたび＝**回**
              🚨 「回」なのは最後の1行だけ。ここを「回」で揃えると4行が嘘になる。
              🚨 唯一「回」の行はいちばん下に置く（人の行をまとめて読ませるため）。並べ替えないこと */}
          <div style={{ fontSize: 13, color: text, marginBottom: 10, lineHeight: 1.8 }}>
            <div>ページを開いた {withDiff('page_view', '人')}（参考値）</div>
            <div>
              回答を読んだ <strong>のべ {withDiff('topic_view', '人')}</strong>
              <span style={{ fontSize: 12, color: sub }}>（同じ方が2つ読めば 2）</span>
            </div>
            <div>問い合わせに進んだ <strong>のべ {withDiff('contact', '人')}</strong></div>
            <div>「はい」 のべ {withDiff('solved', '人')}</div>
            <div>
              電話・フォームを押した {withDiff('contact_click', '回')}
              <span style={{ fontSize: 12, color: sub }}>（この行だけ押すたびに数えます）</span>
            </div>
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
                  {/* 🚨 列名を「人」で言い切る（2026-09-24）。中身の数え方は1行も変えていない。
                      質問ごとに1人1回しか数えないので、**この表の中では**のべではなく実人数 */}
                  <th style={th}>読んだ人</th>
                  <th style={th}>進んだ人</th>
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
                    <td style={td}>{(() => { const r = contactRate(t.views, t.contacts); return r === null ? '-' : `${r}%`; })()}</td>
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
          {/* 🚨 上の「問い合わせに進んだ」と、この表の列の合計が合わない理由を書く（2026-09-22）。
              検索で見つからなかった等は質問に紐づかないので、この表には1件も出てこない。
              断りが無いと「表が壊れている」と読まれる */}
          {(() => {
            const inTable = byTopic.reduce((s, t) => s + t.contacts, 0);
            const outside = total('contact') - inTable;
            if (outside <= 0) return null;
            return (
              <div style={{ fontSize: 12, color: sub, marginTop: 4, lineHeight: 1.7 }}>
                ※ 上の「問い合わせに進んだ のべ <strong>{total('contact')}</strong> 人」のうち、<strong>{outside}</strong> 人はこの表に出ていません
                （検索で見つからなかった等、<strong>質問に紐づかない</strong>もの）。内訳は下の「つまずいた理由」をご覧ください
              </div>
            );
          })()}

          {/* つまずいた理由の内訳＝やるべきこと */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>つまずいた理由と、やるべきこと</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
                {/* 🚨 ここも「件数」ではなく「人数」。同じ方が同じ理由で何度押しても1人に間引かれる
                    （別の理由で押せば、その理由の行にも1人として入る） */}
                <thead><tr><th style={th}>理由</th><th style={th}>人数</th><th style={th}>やるべきこと</th></tr></thead>
                <tbody>
                  {Object.keys(REASON_LABEL).map(k => {
                    const n = total('contact', k);
                    const list = topicsForReason(k);
                    const head = list.slice(0, REASON_TOPIC_TOP);
                    const rest = list.length - head.length;
                    return (
                      <tr key={k}>
                        <td style={{ ...td, minWidth: 200 }}>
                          {REASON_LABEL[k]}
                          {/* 🚨 0件のときは何も足さない（読むところが増えるだけ） */}
                          {n > 0 && (
                            <div style={{ fontSize: 12, color: sub, marginTop: 3, lineHeight: 1.7 }}>
                              {!REASON_HAS_TOPIC[k]
                                ? '（どの質問かは記録できません。検索の結果から押すため、質問が決まっていません）'
                                : head.length === 0
                                  ? '（どの質問かが分かりませんでした）'
                                  : (
                                    <>
                                      {head.map(t => <div key={t.q}>・{t.q} {t.n} 人</div>)}
                                      {rest > 0 && <div>・ほか {rest} 件の質問</div>}
                                    </>
                                  )}
                            </div>
                          )}
                        </td>
                        <td style={{ ...td, fontWeight: n > 0 ? 'bold' : 'normal', verticalAlign: 'top' }}>{n}</td>
                        <td style={{ ...td, color: sub, verticalAlign: 'top' }}>{REASON_ACTION[k]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 答えられなかった言葉 */}
          <div style={{ marginBottom: 16 }}>
            {/* 🚨 見出しは短く、条件は下の説明行に逃がす（2026-09-24・ユーザー確定）。
                旧「答えられなかった言葉（新しい質問を作る材料）」は
                **お客様が打った言葉なのかどうかが読み取れず**、実際に聞かれた */}
            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 2 }}>
              検索して見つからなかった言葉
            </div>
            <div style={{ fontSize: 12, color: sub, marginBottom: 6, lineHeight: 1.7 }}>
              お客様が検索して、候補が1件も出なかった言葉です（同じ方が3回検索すれば 3回）
            </div>
            {words.length === 0
              ? <div style={{ fontSize: 13, color: sub }}>この期間はありません</div>
              : <Bars unit="回" isDarkMode={isDarkMode}
                  items={words.map(w => ({ key: w.word, label: w.word, n: w.n }))} />}
            {wordsCut && (
              <div style={{ fontSize: 12, color: '#b35900', marginTop: 4 }}>
                🚨 この期間の検索は多く、<strong>新しい順に{LOG_LIMIT}件までしか数えていません</strong>。上の並びは実際の多い順と違うことがあります
              </div>
            )}
          </div>

          {/* 校・コースに該当が無かったもの */}
          {unknownByPlace.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>
                校・コースの回答が足りない（既存の回答に対象を足す）
              </div>
              <Bars unit="人" isDarkMode={isDarkMode}
                items={unknownByPlace.map(u => ({ key: u.place, label: u.place, n: u.n }))} />
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
                    const { items, keepOrder } = barsFor(d);
                    if (items.length === 0) return null;
                    // 🚨 時間帯・曜日は0のぶんも並べるので、記録が1件も無い期間だと
                    //    「空の棒が24本」並ぶ。そのときは軸ごと出さない
                    if (items.every(i => i.n === 0)) return null;
                    return (
                      <div key={d} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 'bold', color: sub, marginBottom: 4 }}>{d}</div>
                        <Bars items={items} unit="人" isDarkMode={isDarkMode} keepOrder={keepOrder} />
                      </div>
                    );
                  })}
              <div style={{ fontSize: 12, color: sub, lineHeight: 1.7, marginTop: 4 }}>
                ※ 数字は<strong>人数</strong>です（同じ方がその日に何回見ても 1 人）。
                以前ここに並べていた「◯件」は<strong>記録の行数</strong>で、回数とも人数とも違う数だったため出すのをやめました<br />
                ※ <strong>時間帯・曜日は記録が0のぶんも並べます</strong>（来ていない時間が分かるように）。
                そのほかの項目は多い順で、多いほうから10件までを出します<br />
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
                  {/* 🚨 読み込めなかったときは、入力も保存もさせない。
                      空欄のまま保存されると、登録済みのIPが消えて元に戻せないため */}
                  {ipLoadErr ? (
                    <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12.5, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>
                      {ipLoadErr}<br />
                      いまは変更できません（空のまま保存すると、登録済みのIPが消えてしまうため）。画面を開き直してください。
                    </div>
                  ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      value={ipText}
                      onChange={e => { ipDirty.current = true; setIpText(e.target.value); setIpMsg(''); setIpClearConfirm(false); }}
                      placeholder="例：203.0.113.45, 192.168.0.0/24"
                      style={{ flex: '1 1 260px', minWidth: 200, padding: '7px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${border}`, background: bg, color: text }}
                    />
                    <button type="button" onClick={() => saveIps()}
                      style={{ padding: '7px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
                      保存
                    </button>
                  </div>
                  )}
                  {/* 空にして保存する前のその場の確認 */}
                  {ipClearConfirm && (
                    <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.7, background: '#fff3cd', border: '1px solid #f59e0b', color: '#856404' }}>
                      ⚠️ 会社のIPを<strong>0件</strong>にします。これまでの記録も<strong>すべて「社外」</strong>として数え直され、元のIPは残りません。よろしいですか？
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button type="button" onClick={() => setIpClearConfirm(false)}
                          style={{ padding: '5px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>やめる</button>
                        <button type="button" onClick={() => saveIps(true)}
                          style={{ padding: '5px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #dc3545', background: bg, color: '#dc3545' }}>0件にする</button>
                      </div>
                    </div>
                  )}
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
              : <Bars unit="回" isDarkMode={isDarkMode}
                  items={staffWords.map(w => ({
                    key: w.word, label: w.word, n: w.n,
                    note: w.miss > 0 ? `（見つからず ${w.miss}）` : undefined,
                  }))} />}
            {staffWordsCut && (
              <div style={{ fontSize: 12, color: '#b35900', marginTop: 4 }}>
                🚨 この期間の検索は多く、<strong>新しい順に{LOG_LIMIT}件までしか数えていません</strong>。上の並びは実際の多い順と違うことがあります
              </div>
            )}
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
