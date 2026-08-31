import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  postPurchaseComment, fetchPurchaseCommentReads, markPurchaseCommentsSeen,
  type PurchaseComment, type PurchaseCommentKind, type PurchaseCommentRead,
} from '../lib/purchaseComments';
import QuoteFileUploader from './QuoteFileUploader';
import { openReceiptImage } from '../lib/receiptView';

// 備品購入申請の「質問・回答」と「共有ファイル」。履歴・承認画面・管理画面の3か所で共用する。
//
// 🚨 使われずに終わらせないための決まりごと（過去の失敗の再発防止）
//  ・0件でも必ず入口を出す（「対応中マーク」が他人に見えず意味を成さなかった件と同型）
//  ・文字だけの見出しにしない。枠付きボタン＋動詞（「質問する」）にする
//    （定型メッセージの折りたたみが「押せると気づけなかった」失敗があった）
//  ・発言者の名前と役職を必ず出す（誰が答えるべきか分からないと放置される）
//
// 🚨 「質問」と「共有」を区別する（2026-09-01）
//  ・赤い「回答待ち」は質問にだけ出す。共有に出すと、返事の要らない投稿で
//    申請者と承認者全員に「あなたが答える番」と読める表示が残り続ける
//    （実機で発生。確定見積書を共有しただけの投稿に6人全員へ赤が出た）。
//  ・共有の出口は「確認した」。返事を書かずに終われるようにする。
//    そこから質問もできるよう「質問する」を並べる。
//  ・🚨 説明文（「返事は不要です」等）は足さない。ボタンの語だけで通す
//    ＝画面の文字を増やさない（2026-09-01 ユーザー決定）。
//
// 🚨 共有ファイルについて
//  ・承認の根拠になった相見積もり（purchase_request_item_quotes）は承認確定後に
//    書き換えられない（RLSが拒否する）。あとから届いた確定見積書・納品書は
//    ここに「追記」として残す。承認済みの内容は一切変わらない。
//  ・添付できる人は制限しない（経理が請求書を貼る、承認者が資料を貼る等があるため）。
//    誰が貼ったかは名前と時刻で必ず残る。
//  ・ファイルを開く処理は props で受け取らず直接 import する。
//    3画面それぞれに配線すると、必ずどこかで渡し忘れて「その画面だけ開けない」になる。

interface Props {
  requestId: string;
  itemName: string;
  comments: PurchaseComment[];
  names: Record<string, string>;
  roles?: Record<string, string>;
  currentUserId: string;
  currentUserName: string;
  isDark: boolean;
  /** 承認画面など、最初から開いておきたい場所で true */
  defaultOpen?: boolean;
  onPosted: () => void;
}

// ファイルの種類の名札。既定は「確定見積書」＝今いちばん多い用途なので、
// そのまま送れば選ぶ手間が増えない。
const FILE_LABELS = ['確定見積書', '納品書', '請求書', 'カタログ・仕様書', 'その他'] as const;

const fmt = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const PurchaseCommentThread: React.FC<Props> = ({
  requestId, itemName, comments, names, roles, currentUserId, currentUserName,
  isDark, defaultOpen = false, onPosted,
}) => {
  const [open, setOpen] = useState(defaultOpen || comments.length > 0);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 添付は複数可。アップロードが終わるたびに「送信待ちの一覧」に積む
  const [pendingFiles, setPendingFiles] = useState<{ path: string; label: string }[]>([]);
  const [labelChoice, setLabelChoice] = useState<string>(FILE_LABELS[0]);
  const [labelOther, setLabelOther] = useState('');
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  // 種別。null＝自動（添付があれば共有・本文だけなら質問）。
  // 押されたときだけ手動の値を覚える＝ふだんは何も操作せずに正しくなる
  const [kindChoice, setKindChoice] = useState<PurchaseCommentKind | null>(null);

  // 「確認した」。🚨 props で受け取らず自分で読む。
  //    3画面（履歴・承認・管理）に配線すると必ずどこかで渡し忘れ、
  //    その画面だけ確認できない状態になる（ファイルを開く処理と同じ方針）。
  //    開いたときだけ読むので、閉じたままの申請では通信しない。
  const [reads, setReads] = useState<PurchaseCommentRead[]>([]);
  const [acking, setAcking] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const loadReads = useCallback(async () => {
    const byId = await fetchPurchaseCommentReads([requestId]);
    setReads(byId[requestId] ?? []);
  }, [requestId]);

  const text = isDark ? '#e9ecef' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#5a6268' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2c3e50' : '#f1f7fd';
  const accentBorder = isDark ? '#4a90d9' : '#90caf9';

  // 名札は「その他」のときだけ自由入力。空なら「共有ファイル」に落とす（lib側でも同じ既定）
  const effectiveLabel = labelChoice === 'その他' ? labelOther.trim() : labelChoice;

  const files = comments.filter(c => c.file_path);
  const canSend = !!body.trim() || pendingFiles.length > 0;

  // 送信する種別。手で選んでいなければ添付の有無で決まる
  const kind: PurchaseCommentKind = kindChoice ?? (pendingFiles.length > 0 ? 'share' : 'question');

  // 開いたときだけ「確認した」を読む（閉じたままの申請では通信しない）
  useEffect(() => { if (open) loadReads(); }, [open, loadReads, comments.length]);

  // アップロード完了 → その時点の名札を付けて送信待ちに積む。
  // 積んだらアップローダーは空に戻る＝続けて2件目を添付できる
  const handleUploaded = (path: string | null) => {
    if (!path) return;
    setPendingFiles(prev => [...prev, { path, label: effectiveLabel || '共有ファイル' }]);
  };

  const openFile = async (path: string) => {
    setOpeningPath(path); setError('');
    const err = await openReceiptImage(path);
    setOpeningPath(null);
    if (err) setError(err);
  };

  const submit = async () => {
    setSaving(true); setError('');
    const res = await postPurchaseComment({
      requestId, body, authorId: currentUserId, authorName: currentUserName, itemName,
      kind, files: pendingFiles,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? '送信に失敗しました'); return; }
    setBody('');
    setPendingFiles([]);
    setLabelChoice(FILE_LABELS[0]);
    setLabelOther('');
    setKindChoice(null);
    onPosted();
  };

  // ── 「確認した」 ─────────────────────────────
  // 最新の投稿より後に見ていれば確認済み。新しい共有が来れば自然にまた未確認に戻る
  const newest = comments[comments.length - 1];
  const seenBy = newest
    ? reads.filter(r => new Date(r.last_seen_at).getTime() >= new Date(newest.created_at).getTime())
    : [];
  const iHaveSeen = seenBy.some(r => r.user_id === currentUserId);
  // 自分が最後に書いた本人なら押す意味がない
  const canAck = !!newest && newest.author_id !== currentUserId && !iHaveSeen;

  // ── 赤い「回答待ち」 ──────────────────────────
  // 🚨 共有には出さない。返事の要らない投稿で関係者全員に赤が残り続ける
  //    （誰も答えないので永久に消えない。2026-09-01 実機で発生）。
  // 🚨 「最後の投稿」ではなく「最後の質問」を見る。
  //    質問 →（誰も答えない）→ 経理が請求書を共有、でも赤が消えないようにするため。
  // 🚨 「確認した」を押していれば出さない。これが無いと、答えをもらった側に
  //    赤が移って往復し続け、最後は誰かが放置して終わる（案A・ユーザー決定）。
  const lastQuestion = [...comments].reverse().find(c => c.kind === 'question');
  const waiting = !!lastQuestion
    && lastQuestion.author_id !== currentUserId
    && !iHaveSeen;

  const ack = async () => {
    if (!newest) return;
    setAcking(true); setError('');
    const res = await markPurchaseCommentsSeen(requestId, currentUserId, newest.created_at);
    setAcking(false);
    if (!res.ok) { setError(res.error ?? '記録できませんでした'); return; }
    await loadReads();
  };

  // 共有を見てその場で聞けるようにする。種別を「質問」に倒して本文欄へ運ぶ
  const askFromShare = () => {
    setKindChoice('question');
    bodyRef.current?.focus();
    bodyRef.current?.scrollIntoView({ block: 'center' });
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        style={{
          marginTop: 8, padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${accentBorder}`,
          background: isDark ? '#2c3e50' : '#e8f4fd',
          color: isDark ? '#fff' : '#1565c0', fontSize: 12.5, fontWeight: 'bold',
        }}>
        {/* 「質問する」だけだと、ファイルを共有したい人がここが入口だと気づけない
            （実際に「どこで共有するのか」と迷われた）。役割を両方名乗る */}
        💬 質問・ファイル共有
        {/* ファイルが付いていることは閉じたままでも分かるようにする。
            開かないと気づけないと、せっかく共有しても見てもらえない */}
        {files.length > 0 && `　📎 ${files.length}件`}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, background: innerBg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 'bold', color: text }}>
          💬 質問・ファイル共有{comments.length > 0 ? `（${comments.length}件）` : ''}
        </span>
        {waiting && (
          <span style={{ fontSize: 11, fontWeight: 'bold', color: '#fff', background: '#e24b4a', borderRadius: 10, padding: '2px 8px' }}>
            回答待ち
          </span>
        )}
        <button type="button" onClick={() => setOpen(false)}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: subText }}>
          ▲ 閉じる
        </button>
      </div>

      {/* 共有ファイルだけを先にまとめて出す。やりとりに埋もれると後から探せない */}
      {files.length > 0 && (
        <div style={{ background: cardBg, border: `1px solid ${accentBorder}`, borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 6 }}>
            📎 共有ファイル（{files.length}件）
          </div>
          {files.map(c => (
            <div key={`f-${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
              <span style={{
                fontSize: 11, fontWeight: 'bold', borderRadius: 4, padding: '2px 8px',
                background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0',
                border: `1px solid ${accentBorder}`,
              }}>
                {c.file_label || '共有ファイル'}
              </span>
              <button type="button" onClick={() => openFile(c.file_path as string)}
                disabled={openingPath === c.file_path}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: 12.5, color: isDark ? '#90caf9' : '#1565c0', textDecoration: 'underline',
                }}>
                {openingPath === c.file_path ? '開いています...' : 'ファイルを開く'}
              </button>
              <span style={{ fontSize: 11, color: subText }}>
                {names[c.author_id] ?? '不明'} が共有　{fmt(c.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}

      {comments.map(c => (
        <div key={c.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 6, padding: '7px 10px', marginBottom: 6 }}>
          <div style={{ fontSize: 11.5, color: subText, marginBottom: 3 }}>
            {names[c.author_id] ?? '不明'}
            {roles?.[c.author_id] && `（${roles[c.author_id]}）`}
            　{fmt(c.created_at)}
          </div>
          {c.body && (
            <div style={{ fontSize: 13, color: text, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{c.body}</div>
          )}
          {c.file_path && (
            <button type="button" onClick={() => openFile(c.file_path as string)}
              disabled={openingPath === c.file_path}
              style={{
                marginTop: c.body ? 5 : 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 12.5, color: isDark ? '#90caf9' : '#1565c0', textDecoration: 'underline',
              }}>
              📎 {c.file_label || '共有ファイル'}
              {openingPath === c.file_path ? '（開いています...）' : ' を開く'}
            </button>
          )}
        </div>
      ))}

      {comments.length === 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: subText }}>まだやりとりはありません</p>
      )}

      {/* 赤い「回答待ち」の出口。返事を書かずに終われる。
          🚨 質問にも共有にも同じボタンを出す（2026-09-01 ユーザー決定・案A）。
             質問だけだと、答えをもらった側に赤が移って往復し、最後は放置で終わる。
             「押せば終わる」出口を1つ置くことで、赤は
             「まだ目を通していない、自分宛の書き込み」という意味になる。
          🚨 「未確認 N名」は出さない。誰が見ていないかを並べると催促になり、
             共有のたびに関係者全員が急かされる（今回の赤い回答待ちと同型の失敗）。 */}
      {(seenBy.length > 0 || canAck) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          {canAck && (
            <>
              <button type="button" onClick={ack} disabled={acking}
                style={{
                  padding: '5px 12px', borderRadius: 8, cursor: acking ? 'default' : 'pointer',
                  border: `1px solid ${accentBorder}`,
                  background: isDark ? '#2c3e50' : '#e8f4fd',
                  color: isDark ? '#fff' : '#1565c0', fontSize: 12, fontWeight: 'bold',
                }}>
                {acking ? '記録中...' : '✓ 確認した'}
              </button>
              <button type="button" onClick={askFromShare}
                style={{
                  padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${border}`, background: 'none',
                  color: subText, fontSize: 12, fontWeight: 'bold',
                }}>
                💬 質問する
              </button>
            </>
          )}
          {seenBy.length > 0 && (
            <span style={{ fontSize: 11, color: subText }}>
              ✓ 確認：{seenBy.slice(0, 3).map(r => names[r.user_id] ?? '不明').join('・')}
              {seenBy.length > 3 && ` 他${seenBy.length - 3}名`}
            </span>
          )}
        </div>
      )}

      {error && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: '#842029' }}>{error}</p>
        </div>
      )}

      {/* 種別の2択。既定は添付の有無で自動なので、ふだんは触らなくてよい。
          🚨 説明（「返事がほしい」等）は添えない。「質問」という語だけで返事が要ることは通じる
             ＝画面の文字を増やさない（2026-09-01 ユーザー決定） */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {([['question', '質問'], ['share', '共有']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setKindChoice(k)}
            style={{
              padding: '4px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold',
              border: `2px solid ${kind === k ? '#1565c0' : '#90caf9'}`,
              background: kind === k ? '#1976d2' : '#e3f2fd',
              color: kind === k ? '#fff' : '#1565c0',
            }}>
            {label}
          </button>
        ))}
      </div>

      <textarea ref={bodyRef} value={body} onChange={e => setBody(e.target.value)} rows={2}
        placeholder={kind === 'share' ? '例：確定見積書が届きました' : '例：この見積の送料は含まれていますか？'}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
          border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 13, resize: 'vertical',
        }} />

      {/* ファイルの添付（複数可）。承認済みでも使える（承認内容は変わらず、追記として残るだけ）。
          アップロードが終わると下の「送信待ち」一覧に積まれ、続けて次のファイルを添付できる */}
      <div style={{ marginTop: 6 }}>
        {pendingFiles.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {pendingFiles.map((f, i) => (
              <div key={`${f.path}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{
                  fontSize: 11, fontWeight: 'bold', borderRadius: 4, padding: '2px 8px',
                  background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0',
                  border: `1px solid ${accentBorder}`,
                }}>
                  {f.label}
                </span>
                <span style={{ fontSize: 12, color: subText }}>添付済み（{i + 1}件目）</span>
                <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: subText }}>
                  ✕ 外す
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 11.5, color: subText }}>ファイルの種類</span>
          <select value={labelChoice} onChange={e => setLabelChoice(e.target.value)}
            style={{
              padding: '5px 8px', borderRadius: 6, fontSize: 12.5,
              border: `1px solid ${border}`, background: cardBg, color: text,
            }}>
            {FILE_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          {labelChoice === 'その他' && (
            <input value={labelOther} onChange={e => setLabelOther(e.target.value)}
              placeholder="例：保証書"
              style={{
                padding: '5px 8px', borderRadius: 6, fontSize: 12.5, flex: 1, minWidth: 120,
                border: `1px solid ${border}`, background: cardBg, color: text,
              }} />
          )}
        </div>
        {/* value は常に null＝アップロード完了と同時に handleUploaded が送信待ちへ移し、
            アップローダー自体は空に戻る（2件目をすぐ添付できる） */}
        <QuoteFileUploader
          isDarkMode={isDark}
          userId={currentUserId}
          draftId={requestId}
          value={null}
          onChange={handleUploaded}
        />
        {pendingFiles.length > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 11, color: subText }}>
            もう1件添付する場合は、種類を選んで続けてアップロードしてください
          </p>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={submit} disabled={saving || !canSend}
          style={{
            padding: '7px 16px', borderRadius: 8, border: 'none', cursor: canSend ? 'pointer' : 'default',
            background: canSend ? '#1976d2' : (isDark ? '#495057' : '#ced4da'),
            color: '#fff', fontSize: 12.5, fontWeight: 'bold',
          }}>
          {/* 🚨 質問にファイルを付けたときは「共有する」と書かない。
                 返事が要る投稿を共有と読み違えると、そのまま放置される */}
          {saving ? '送信中...'
            : kind === 'question' || pendingFiles.length === 0 ? '送信'
            : pendingFiles.length === 1 ? `${pendingFiles[0].label}を共有する`
            : `ファイル${pendingFiles.length}件を共有する`}
        </button>
        <span style={{ fontSize: 11, color: subText }}>
          送信すると取り消せません。申請した人と承認した人に通知が届きます
        </span>
      </div>
    </div>
  );
};

export default PurchaseCommentThread;
