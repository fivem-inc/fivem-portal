import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDarkMode } from '../hooks/useDarkMode';
import {
  fetchFaqTopics,
  matchFaqTopics,
  featuredTopics,
  resolveAnswer,
  isTopicVisible,
  logFaqQuery,
  type FaqTopic,
  type FaqAnswer,
} from '../lib/faq';

// スタッフ向けヘルプ（社内サイトの使い方）。
//
// ・ログイン済みなので役職が分かる → 入口で「あなたは誰ですか」を聞く必要がない。
//   その人の役職向けの回答が自動で選ばれる。
// ・検索窓に打つ／よくある質問を押す、のどちらでも使える
//   （打つのが苦手な人・何を打てばいいか分からない人のため）。
// ・表示されるのは管理画面に登録された回答の原文のみ。文章を自動生成することはしない。

interface Props {
  roleTitle: string;
}

const HelpPage: React.FC<Props> = ({ roleTitle }) => {
  const isDark = useDarkMode();
  const [topics, setTopics] = useState<FaqTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [opened, setOpened] = useState<{ topic: FaqTopic; answer: FaqAnswer } | null>(null);

  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#1a1a2e';
  const subText = isDark ? '#adb5bd' : '#666';
  const borderColor = isDark ? '#6c757d' : '#dee2e6';
  const inputBg = isDark ? '#495057' : 'white';

  const viewer = useMemo(() => ({ roleTitle }), [roleTitle]);

  // 各ページの「❓ 使い方」から来たときは、そのページの質問だけに絞る。
  // 🚨 URLは毎回読み直す（開いた瞬間に1回だけ読むと、同じページにいるまま
  //    別のカテゴリで開き直しても切り替わらない）
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryFilter = searchParams.get('category');

  useEffect(() => {
    fetchFaqTopics('internal').then(rows => {
      setTopics(rows);
      setLoading(false);
    });
  }, []);

  const featured = useMemo(() => featuredTopics(topics, viewer, 6), [topics, viewer]);
  const results = useMemo(
    () => (submitted ? matchFaqTopics(submitted, topics, viewer, 5) : []),
    [submitted, topics, viewer],
  );

  // 一覧に出せる質問（この役職向けの有効な回答があるものだけ）。
  // カテゴリ指定があればそのカテゴリだけに絞る
  const browsable = useMemo(
    () => topics.filter(t => isTopicVisible(t, viewer) && (!categoryFilter || t.category === categoryFilter)),
    [topics, viewer, categoryFilter],
  );
  const categories = useMemo(() => {
    const map = new Map<string, FaqTopic[]>();
    browsable.forEach(t => {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    });
    return [...map.entries()];
  }, [browsable]);

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    setSubmitted(q);
    setOpened(null);
    const hits = matchFaqTopics(q, topics, viewer, 5);
    // 答えられなかった質問を記録し、次のQ&A追加につなげる
    logFaqQuery({ audience: 'internal', rawQuery: q, hadMatch: hits.length > 0, viewer });
  }, [query, topics, viewer]);

  const openTopic = (t: FaqTopic) => {
    const a = resolveAnswer(t, viewer);
    if (!a) return;
    setOpened({ topic: t, answer: a });
    logFaqQuery({ audience: 'internal', rawQuery: t.question, hadMatch: true, viewer, pickedTopicId: t.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cardStyle: React.CSSProperties = {
    background: bg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: 14, marginBottom: 10,
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '16px 16px 40px' }}>
      <h2 style={{ fontSize: 20, textAlign: 'center', color: text, margin: '0 0 4px' }}>💡 FAQ（よくある質問）</h2>
      <p style={{ fontSize: 12, textAlign: 'center', color: subText, margin: '0 0 16px' }}>ファイブM スタッフサイト</p>

      {/* 説明枠（他ページと同じ黄色。ライト・ダーク共通の固定色） */}
      <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
        <p style={{ fontSize: 12, fontWeight: 'bold', textAlign: 'center', color: '#856404', margin: '0 0 8px' }}>【全スタッフ】</p>
        <p style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', margin: '0 0 6px', display: 'flex', gap: 6 }}>
          <span style={{ background: '#4a90d9', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>①</span>
          社内サイトの使い方を調べられます
        </p>
        <p style={{ fontSize: 12, color: '#856404', margin: 0, lineHeight: 1.7 }}>
          ※あなたの役職に合わせた手順が表示されます。<br />
          ※知りたいことが見つからない場合は、お手数ですが直接おたずねください。
        </p>
      </div>

      {/* カテゴリで絞り込み中の表示（各ページの「❓ 使い方」から来たとき） */}
      {categoryFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: isDark ? '#495057' : '#eef2f7', border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: text }}>「{categoryFilter}」の項目を表示中</span>
          <button type="button" onClick={() => setSearchParams({}, { replace: true })}
            style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
            すべての項目を見る
          </button>
        </div>
      )}

      {/* 検索窓 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
          placeholder="例：残業したらどこから報告する？"
          style={{
            flex: 1, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`,
            fontSize: 16, boxSizing: 'border-box', background: inputBg, color: text,
          }}
        />
        <button type="button" onClick={runSearch}
          style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer', flexShrink: 0 }}>
          検索
        </button>
      </div>

      {loading && <p style={{ fontSize: 14, color: subText }}>読み込んでいます...</p>}

      {/* 開いた回答 */}
      {opened && (
        <div style={{ ...cardStyle, border: '2px solid #1976d2' }}>
          <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 8 }}>{opened.topic.question}</div>
          <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
            この回答は【{opened.answer.targets.length > 0
              ? opened.answer.targets.map(t => t.role_title).filter(Boolean).join('・')
              : '全スタッフ'}】向けです
          </div>
          <div style={{ fontSize: 14, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{opened.answer.body}</div>
          {opened.answer.source_label && (
            <div style={{ fontSize: 11, color: subText, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${borderColor}` }}>
              出典：{opened.answer.source_url
                ? <a href={opened.answer.source_url} target="_blank" rel="noreferrer" style={{ color: isDark ? '#90caf9' : '#1565c0' }}>{opened.answer.source_label}</a>
                : opened.answer.source_label}
              {opened.answer.valid_from ? `（${opened.answer.valid_from}〜）` : ''}
            </div>
          )}
          <button type="button" onClick={() => setOpened(null)}
            style={{ marginTop: 12, fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer' }}>
            閉じる
          </button>
        </div>
      )}

      {/* 検索結果 */}
      {submitted && !opened && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: subText, marginBottom: 8 }}>
            「{submitted}」の検索結果：{results.length}件
          </div>
          {results.length === 0 ? (
            <div style={{ ...cardStyle, background: '#fff8e1', border: '1px solid #f59e0b' }}>
              <p style={{ fontSize: 14, color: '#92400e', margin: '0 0 6px', fontWeight: 'bold' }}>見つかりませんでした</p>
              <p style={{ fontSize: 13, color: '#92400e', margin: 0, lineHeight: 1.7 }}>
                別の言葉でもう一度お試しいただくか、下の一覧からお探しください。
                お手数ですが、見つからない場合は直接おたずねください。<br />
                （いただいた質問は記録し、今後の項目追加に役立てます）
              </p>
            </div>
          ) : (
            results.map(r => (
              <button key={r.topic.id} type="button" onClick={() => openTopic(r.topic)}
                style={{ ...cardStyle, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block' }}>
                <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>{r.topic.category}</div>
                <div style={{ fontSize: 14, fontWeight: 'bold', color: text }}>{r.topic.question}</div>
              </button>
            ))
          )}
          <button type="button" onClick={() => { setSubmitted(''); setQuery(''); }}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'none', color: text, cursor: 'pointer', marginTop: 4 }}>
            検索をやめて一覧を見る
          </button>
        </div>
      )}

      {/* よくある質問（検索していないとき） */}
      {!submitted && !opened && featured.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 }}>よくある質問</div>
          {featured.map(t => (
            <button key={t.id} type="button" onClick={() => openTopic(t)}
              style={{ ...cardStyle, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block' }}>
              <div style={{ fontSize: 14, fontWeight: 'bold', color: text }}>{t.question}</div>
            </button>
          ))}
        </div>
      )}

      {/* カテゴリ別の一覧 */}
      {!submitted && !opened && !loading && (
        categories.length === 0 ? (
          <p style={{ fontSize: 14, color: subText }}>
            まだ項目が登録されていません。
          </p>
        ) : (
          categories.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8, paddingBottom: 4, borderBottom: `1px solid ${borderColor}` }}>{cat}</div>
              {list.map(t => (
                <button key={t.id} type="button" onClick={() => openTopic(t)}
                  style={{ ...cardStyle, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block', marginBottom: 6 }}>
                  <div style={{ fontSize: 14, color: text }}>{t.question}</div>
                </button>
              ))}
            </div>
          ))
        )
      )}
    </div>
  );
};

export default HelpPage;
