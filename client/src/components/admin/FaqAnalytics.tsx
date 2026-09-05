import React, { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { downloadCSV } from '../../utils';

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

interface Props {
  isDarkMode: boolean;
  /** 集計で「⚠️ 要確認」を付けたあと、一覧を読み直してもらう */
  onChanged: () => void;
}

/** 月の初日 / 翌月の初日（JST）。
 *  🚨 toISOString() は UTC なので使わない。日付の境目が9時間ずれて前日になる */
const monthRange = (ym: string): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${ym}-01T00:00:00+09:00`, to: `${next}-01T00:00:00+09:00` };
};

const addMonth = (ym: string, diff: number): string => {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + diff;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

const thisMonth = (): string => {
  const now = new Date();
  // 端末時刻そのままでよい（日本国内で使う画面）
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

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

const FaqAnalytics: React.FC<Props> = ({ isDarkMode, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [ym, setYm] = useState(thisMonth);
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [words, setWords] = useState<{ word: string; n: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [marking, setMarking] = useState<string | null>(null);

  const text = isDarkMode ? '#fff' : '#1a1a2e';
  const sub = isDarkMode ? '#adb5bd' : '#666';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const bg = isDarkMode ? '#343a40' : '#fff';

  const load = useCallback(async (targetYm: string) => {
    setLoading(true); setErr('');
    const { from, to } = monthRange(targetYm);
    try {
      const { data, error } = await supabase.rpc('faq_public_event_summary', { p_from: from, p_to: to });
      // 🚨 rpc は 4xx/5xx でも throw しない。error を必ず見る（「通信を確認」で握りつぶさない）
      if (error) { setErr(`集計を読み込めませんでした：${error.message}`); setRows(null); return; }
      setRows((data ?? []) as SummaryRow[]);

      // 「答えられなかった言葉」は既存の質問ログから取る（新しい表には検索語を持たせていない）
      // 🚨 件数を必ず指定する。指定しないと Supabase が1,000行で黙って打ち切る
      const { data: qs, error: qerr } = await supabase
        .from('faq_query_log')
        .select('raw_query')
        .eq('audience', 'public')
        .eq('had_match', false)
        .gte('created_at', from)
        .lt('created_at', to)
        .limit(500);
      if (qerr) { setErr(`検索ログを読み込めませんでした：${qerr.message}`); setWords([]); return; }
      const map = new Map<string, number>();
      for (const q of (qs ?? []) as { raw_query: string }[]) {
        map.set(q.raw_query, (map.get(q.raw_query) ?? 0) + 1);
      }
      setWords([...map.entries()].map(([word, n]) => ({ word, n })).sort((a, b) => b.n - a.n));
    } catch (e) {
      setErr(`集計を読み込めませんでした：${e instanceof Error ? e.message : String(e)}`);
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const openAndLoad = () => { setOpen(true); load(ym); };
  const move = (diff: number) => { const next = addMonth(ym, diff); setYm(next); load(next); };

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

  const total = (kind: string, reason?: string): number =>
    (rows ?? []).filter(r => r.kind === kind && (reason === undefined || r.reason === reason))
      .reduce((s, r) => s + r.n, 0);

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
    downloadCSV(lines.join('\n'), `FAQ集計_${ym}.csv`);
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
        <button type="button" onClick={() => move(-1)} style={{ ...th, cursor: 'pointer', border: `1px solid ${border}`, borderRadius: 6, background: bg, padding: '4px 10px' }}>◀</button>
        <span style={{ fontSize: 14, color: text, fontWeight: 'bold' }}>{ym}</span>
        <button type="button" onClick={() => move(1)} style={{ ...th, cursor: 'pointer', border: `1px solid ${border}`, borderRadius: 6, background: bg, padding: '4px 10px' }}>▶</button>
        <button type="button" onClick={exportCsv} disabled={!rows}
          style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
          CSVで書き出す
        </button>
        <button type="button" onClick={() => setOpen(false)}
          style={{ padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color: text }}>
          閉じる
        </button>
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
            ページを開いた {total('page_view')} 回（参考値）　／　回答を読んだ <strong>{views}</strong> 回　／
            問い合わせに進んだ <strong>{contacts}</strong> 回　／　電話・フォームを押した {total('contact_click')} 回　／
            「はい」 {total('solved')} 回
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
                  <th style={th}>はい</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {byTopic.length === 0 && (
                  <tr><td style={td} colSpan={6}><span style={{ color: sub }}>この期間の記録はありません</span></td></tr>
                )}
                {byTopic.map(t => (
                  <tr key={t.id}>
                    <td style={{ ...td, minWidth: 220 }}>{t.q}</td>
                    <td style={td}>{t.views}</td>
                    <td style={{ ...td, fontWeight: t.contacts > 0 ? 'bold' : 'normal' }}>{t.contacts}</td>
                    <td style={td}>{t.views > 0 ? `${Math.round((t.contacts / t.views) * 100)}%` : '-'}</td>
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

          <div style={{ fontSize: 12, color: sub, lineHeight: 1.8, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
            ・見るべきは「<strong>問い合わせ率</strong>」です。「はい」は押されないほうが普通なので、
            少ないからといって悪いとは限りません<br />
            ・「ページを開いた」回数は、検索するプログラム（ボット）も数えるため<strong>参考値</strong>です<br />
            ・同じ方が翌日また来た場合は<strong>別の方として数えます</strong>（誰かを追いかける記録は持っていません）<br />
            ・電話は画面が切り替わるため、<strong>押しても記録が間に合わないことがあります</strong><br />
            ・<strong>2026-09-05 より前の記録はありません</strong>（この集計はその日から取り始めました）
          </div>
        </>
      )}
    </div>
  );
};

export default FaqAnalytics;
