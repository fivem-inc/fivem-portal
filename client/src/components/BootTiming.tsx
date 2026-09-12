// 「アプリを開くのに何秒かかったか」の内訳を出す（管理者だけに見せる調べもの用）
//
// 【なぜ作ったか（2026-09-12）】
// 利用者から「ページを開くのに時間がかかる」と言われたが、
// 🚨 **人の感覚では数百ミリ秒の差は判断できない**（実際に「早くなった気もする／分からない」となった）。
// 推測で直す場所を決めると外す（この日いちど外している）ので、実際の数字で決められるようにした。
//
// 【この部品がやらないこと】
// 🚨 **計測用の処理をアプリに1つも足していない。** ブラウザが最初から自分で記録している
//    Performance API を**読むだけ**。動きは何も変わらない。
// 🚨 **記録をどこにも保存しない**（DBに書かない＝掃除の cron も上限も要らない。CLAUDE.md の決まり）。
//    見ているその場の1回ぶんだけ。画面を離れれば消える。
//
// 【いちばん知りたいこと】
// 部品のファイルが「端末の写し」から読めているか。
// 🚨 同じ場所（same-origin）のファイルは `transferSize === 0` かつ中身の大きさがある＝**写しから読めた**。
//    数字が入っていれば通信している。2026-09-12 の Cache-Control の修正が効いたかはこれで分かる。
// 🚨 Supabase は別の場所（cross-origin）なので、大きさは全部 0 で返る（ブラウザの決まり）。
//    ここは「いつ始まって、いつ終わったか」だけを見る。だから大きさは「—」と出す。

import { useState } from 'react';

interface Props {
  isDark: boolean;
}

interface Row {
  label: string;
  start: number;      // 開始（ミリ秒・ページを開いた時点からの経過）
  end: number;        // 終了
  bytes: number | null;   // 通信した量。null＝別の場所のファイルで分からない
  body: number;       // 中身の大きさ（写しから読んだかの判定に使う）
  kind: 'asset' | 'api' | 'other';
}

interface Snapshot {
  htmlDone: number;       // サイトのHTMLを受け取り終わるまで
  scriptDone: number;     // JSを読んで動き出すまで
  firstPaint: number;     // 最初の絵（起動スケルトン）が出るまで
  lastLoad: number;       // 最後の読み込みが終わるまで（ファイル・問い合わせの両方を含む）
  rows: Row[];
  serialMs: number;       // 「前が終わってから次が始まった」ぶんの合計＝順番待ち
}

const s = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;
// 🚨 測れなかった値を「0.00 秒」と出さない。一瞬で終わったように読めてしまう
const sOrDash = (ms: number) => (ms > 0 ? s(ms) : '測れませんでした');
const kb = (b: number) => `${Math.round(b / 1024)} KB`;

function collect(): Snapshot | null {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return null;

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paints = performance.getEntriesByType('paint');
  const fcp = paints.find(p => p.name === 'first-contentful-paint');
  const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  if (!nav && res.length === 0) return null;

  const origin = typeof location !== 'undefined' ? location.origin : '';
  const rows: Row[] = [];

  for (const r of res) {
    const isSameOrigin = origin !== '' && r.name.startsWith(origin);
    const path = r.name.replace(origin, '').split('?')[0];

    let kind: Row['kind'] = 'other';
    let label = path;

    if (isSameOrigin && /\.(js|css)$/.test(path)) {
      kind = 'asset';
      label = path.replace('/assets/', '');
    } else if (r.name.includes('.supabase.co')) {
      kind = 'api';
      // /rest/v1/profiles → profiles ／ /auth/v1/token → ログイン確認
      const m = r.name.match(/\/(rest|auth|functions)\/v1\/([^?/]*)/);
      label = m ? (m[1] === 'auth' ? `ログイン確認（${m[2]}）` : m[2] || m[1]) : 'supabase';
    } else {
      continue; // 画像やアイコンは今回の調べものに関係しないので出さない
    }

    rows.push({
      label,
      start: r.startTime,
      end: r.startTime + r.duration,
      // 🚨 別の場所のファイルは大きさが必ず 0 で返る。0 を「写しから読めた」と誤読しないよう null にする
      bytes: isSameOrigin ? r.transferSize : null,
      body: r.decodedBodySize,
      kind,
    });
  }

  rows.sort((a, b) => a.start - b.start);

  // 「順番待ち」の量：問い合わせを時間順に並べ、前が終わってから次が始まっている分を足す
  const calls = rows.filter(r => r.kind === 'api');
  let serialMs = 0;
  let prevEnd = 0;
  for (const c of calls) {
    if (prevEnd > 0 && c.start >= prevEnd) serialMs += c.end - c.start;
    prevEnd = Math.max(prevEnd, c.end);
  }

  return {
    htmlDone: nav ? nav.responseEnd : 0,
    scriptDone: nav ? nav.domContentLoadedEventEnd : 0,
    firstPaint: fcp ? fcp.startTime : 0,
    lastLoad: rows.length > 0 ? Math.max(...rows.map(r => r.end)) : 0,
    rows,
    serialMs,
  };
}

function asText(d: Snapshot): string {
  const lines: string[] = [];
  lines.push('【起動の内訳】');
  lines.push(`HTMLを受け取るまで      ${sOrDash(d.htmlDone)}`);
  lines.push(`JSを読んで動き出すまで   ${sOrDash(d.scriptDone)}`);
  lines.push(`最初の絵が出るまで       ${sOrDash(d.firstPaint)}`);
  lines.push(`最後の読み込みまで       ${sOrDash(d.lastLoad)}`);
  lines.push(`うち順番待ち             ${s(d.serialMs)}`);
  lines.push('');
  lines.push('【部品のファイル】');
  for (const r of d.rows.filter(x => x.kind === 'asset')) {
    const from = r.bytes === 0 && r.body > 0 ? '端末の写しから' : `通信した ${kb(r.bytes ?? 0)}`;
    lines.push(`  ${r.label}  ${from}  ${s(r.end - r.start)}`);
  }
  lines.push('');
  lines.push('【サーバーへの問い合わせ】');
  const calls = d.rows.filter(x => x.kind === 'api');
  if (calls.length === 0) lines.push('  （この画面では1件もありませんでした）');
  for (const r of calls) {
    lines.push(`  ${s(r.start)} → ${s(r.end)}  ${r.label}`);
  }
  return lines.join('\n');
}

export default function BootTiming({ isDark }: Props) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');

  const text = isDark ? '#fff' : '#333';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const panel = isDark ? '#495057' : '#f8f9fa';
  const card = isDark ? '#343a40' : '#fff';
  const line = isDark ? '#495057' : '#dee2e6';

  const openPanel = () => {
    setData(collect());
    setOpen(true);
    setCopied('');
  };

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(asText(data));
      setCopied('✓ コピーしました');
    } catch {
      setCopied('コピーできませんでした（下の文字を長押しで選んでください）');
    }
  };

  if (!open) {
    return (
      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <button
          onClick={openPanel}
          style={{
            padding: '6px 14px', fontSize: 12, color: sub, background: 'transparent',
            border: `1px solid ${line}`, borderRadius: 6, cursor: 'pointer',
          }}
        >
          🕐 起動の内訳を見る（管理者のみ）
        </button>
      </div>
    );
  }

  const span = data ? Math.max(data.lastLoad, data.scriptDone, 1) : 1;

  return (
    <div style={{ marginTop: 24, padding: 16, background: card, border: `1px solid ${line}`, borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ color: text, fontSize: 14 }}>🕐 起動の内訳</strong>
        <span style={{ color: sub, fontSize: 11 }}>この端末・この1回ぶんだけ。記録は残しません</span>
        <span style={{ flex: 1 }} />
        {/* 🚨 スマホで指で押すボタンなので小さくしない（375px幅で実測して広げた） */}
        <button onClick={copy} style={{ padding: '9px 16px', fontSize: 13, color: text, background: panel, border: `1px solid ${line}`, borderRadius: 6, cursor: 'pointer' }}>
          コピー
        </button>
        <button onClick={() => setOpen(false)} style={{ padding: '9px 12px', fontSize: 13, color: sub, background: 'transparent', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>
          閉じる
        </button>
      </div>

      {copied && <div style={{ color: sub, fontSize: 12, marginBottom: 8 }}>{copied}</div>}

      {!data && (
        <div style={{ color: sub, fontSize: 13 }}>
          このブラウザでは測れませんでした（記録の仕組みを持っていないか、開いてから時間が経ちすぎています）。
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 14px', fontSize: 13, color: text, marginBottom: 14 }}>
            <span>HTMLを受け取るまで</span><strong>{sOrDash(data.htmlDone)}</strong>
            <span>JSを読んで動き出すまで</span><strong>{sOrDash(data.scriptDone)}</strong>
            <span>最初の絵が出るまで</span><strong>{sOrDash(data.firstPaint)}</strong>
            <span>最後の読み込みまで</span><strong>{sOrDash(data.lastLoad)}</strong>
            <span style={{ color: sub }}>うち順番待ち</span><strong style={{ color: sub }}>{s(data.serialMs)}</strong>
          </div>

          <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>部品のファイル（「端末の写しから」なら通信していません）</div>
          <div style={{ marginBottom: 14 }}>
            {data.rows.filter(r => r.kind === 'asset').map((r, i) => {
              const cached = r.bytes === 0 && r.body > 0;
              return (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: text, padding: '3px 0', borderBottom: `1px solid ${line}`, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 150, wordBreak: 'break-all' }}>{r.label}</span>
                  <span style={{ color: sub }}>{kb(r.body)}</span>
                  <span>{cached ? '端末の写しから' : `通信した ${kb(r.bytes ?? 0)}`}</span>
                  <span style={{ color: sub }}>{s(r.end - r.start)}</span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>
            サーバーへの問い合わせ（棒が横に並んでいれば同時、縦に階段状なら順番待ち）
          </div>
          <div>
            {data.rows.filter(r => r.kind === 'api').length === 0 && (
              <div style={{ fontSize: 12, color: sub }}>（この画面では1件もありませんでした）</div>
            )}
            {data.rows.filter(r => r.kind === 'api').map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: text, padding: '2px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ wordBreak: 'break-all' }}>{r.label}</span>
                  <span style={{ color: sub, whiteSpace: 'nowrap' }}>{s(r.start)} → {s(r.end)}</span>
                </div>
                <div style={{ height: 5, background: panel, borderRadius: 3, position: 'relative', marginTop: 1 }}>
                  <div style={{
                    position: 'absolute', borderRadius: 3, height: '100%',
                    left: `${(r.start / span) * 100}%`,
                    width: `${Math.max((r.end - r.start) / span * 100, 0.6)}%`,
                    background: isDark ? '#adb5bd' : '#6c757d',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
