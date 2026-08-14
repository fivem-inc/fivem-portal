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
  // 開いているカテゴリ（すべて表示のときの折りたたみ）
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

  const toggleCategory = (cat: string) => {
    setOpenCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

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
  // 絞り込みボタンに出すカテゴリ。カテゴリを選んでいる間も全部のボタンを出したいので
  // categoryFilter を掛ける前の一覧から作る
  const allCategories = useMemo(() => {
    const map = new Map<string, number>();
    topics.filter(t => isTopicVisible(t, viewer)).forEach(t => {
      map.set(t.category, (map.get(t.category) ?? 0) + 1);
    });
    return [...map.entries()];
  }, [topics, viewer]);

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

  // カテゴリの絞り込みボタン（択一トグル＝アプリ共通の青。ライト・ダーク共通の固定色）
  const catChipStyle = (selected: boolean): React.CSSProperties => ({
    fontSize: 12, fontWeight: 'bold', padding: '6px 12px', borderRadius: 16, cursor: 'pointer',
    background: selected ? '#1976d2' : '#e3f2fd',
    border: `2px solid ${selected ? '#1565c0' : '#90caf9'}`,
    color: selected ? '#fff' : '#1565c0',
  });

  // よくある質問。出す位置がカテゴリの選択で変わるので、中身を1か所にまとめておく
  const featuredBlock = (!submitted && !opened && featured.length > 0) ? (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 }}>
        {categoryFilter ? 'ほかのよくある質問' : 'よくある質問'}
      </div>
      {featured.map(t => (
        <button key={t.id} type="button" onClick={() => openTopic(t)}
          style={{ ...cardStyle, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block' }}>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: text }}>{t.question}</div>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '16px 16px 40px' }}>
      <h2 style={{ fontSize: 20, textAlign: 'center', color: text, margin: '0 0 16px' }}>💡 FAQ（よくある質問）</h2>

      {/* 説明枠（他ページと同じ黄色。ライト・ダーク共通の固定色）。
          番号バッジは他ページと同じ形（22px・数字）に揃える */}
      <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【全スタッフ】</p>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 6px' }}>
          <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>社内サイトの使い方を調べられます</span>
        </div>
        <p style={{ fontSize: 12, color: '#856404', margin: 0, lineHeight: 1.7 }}>
          ※あなたの役職に合わせた手順が表示されます。<br />
          ※知りたいことが見つからない場合は、お手数ですが直接おたずねください。
        </p>
      </div>

      {/* カテゴリの絞り込み。各ページの「💡 FAQ」から来たときは、そのカテゴリが選ばれた状態で開く */}
      {!submitted && !opened && allCategories.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          <button type="button" onClick={() => setSearchParams({}, { replace: true })} style={catChipStyle(!categoryFilter)}>
            すべて
          </button>
          {allCategories.map(([cat, count]) => (
            <button key={cat} type="button"
              onClick={() => setSearchParams({ category: cat }, { replace: true })}
              style={catChipStyle(categoryFilter === cat)}>
              {cat}（{count}）
            </button>
          ))}
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

      {/* よくある質問。カテゴリを選んでいるときは、選んだカテゴリの一覧を先に見せたいので下に回す */}
      {!categoryFilter && featuredBlock}

      {/* カテゴリ別の一覧。
          項目が多いので、すべて表示のときは折りたたんで見出しだけ並べる（何があるか一目で分かる）。
          カテゴリを選んだときは中身を開いて出す。 */}
      {!submitted && !opened && !loading && (
        categories.length === 0 ? (
          <p style={{ fontSize: 14, color: subText }}>
            {categoryFilter ? `「${categoryFilter}」の項目はまだありません。` : 'まだ項目が登録されていません。'}
          </p>
        ) : (
          categories.map(([cat, list]) => {
            const isOpen = !!categoryFilter || openCategories.has(cat);
            return (
              <div key={cat} style={{ marginBottom: 10 }}>
                <button type="button" onClick={() => toggleCategory(cat)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    background: isDark ? '#495057' : '#eef2f7', border: `1px solid ${borderColor}`, borderRadius: 8,
                    padding: '10px 12px', cursor: 'pointer', color: text, fontSize: 14, fontWeight: 'bold',
                  }}>
                  <span>{cat}</span>
                  <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>
                    {list.length}件 {isOpen ? '▲' : '▼'}
                  </span>
                </button>
                {isOpen && (
                  <div style={{ marginTop: 6 }}>
                    {list.map(t => (
                      <button key={t.id} type="button" onClick={() => openTopic(t)}
                        style={{ ...cardStyle, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block', marginBottom: 6 }}>
                        <div style={{ fontSize: 14, color: text }}>{t.question}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )
      )}

      {/* カテゴリを選んでいるときは、その一覧の後ろに「よくある質問」を出す */}
      {categoryFilter && (
        <div style={{ marginTop: 20 }}>{featuredBlock}</div>
      )}
    </div>
  );
};

export default HelpPage;
