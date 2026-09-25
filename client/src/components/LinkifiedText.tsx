import React from 'react';

// 文中の URL（http / https）だけを押せるリンクにして表示する（2026-09-25）。
// 🚨 連絡板の本文は、それまで URL がただの文字で押せなかった（実機指摘）。
// ・http / https で始まるものだけ（javascript: などは文字のまま）。React が文字を安全に扱うので、本文に HTML が混ざっても実行されない
// ・末尾の句読点・閉じかっこは URL に含めない（備品申請の renderNote と同じ区切り）
// ・別のタブで開く。押したときに外側の「行を押すと開く」などが動かないよう、クリックを外へ伝えない
// 🚨 一覧の2〜3行の要約には使わない（行を押すと開く作りなので、押し間違いのもとになる）
const URL_RE = /(https?:\/\/[^\s\u3000、。）」』】]+)/g;   // \u3000＝全角スペース（そのまま書くと ESLint に止められる）

const LinkifiedText: React.FC<{ text: string; linkColor?: string }> = ({ text, linkColor = '#4a90d9' }) => {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//i.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ color: linkColor, textDecoration: 'underline', wordBreak: 'break-all' }}>
            {part}
          </a>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

export default LinkifiedText;
