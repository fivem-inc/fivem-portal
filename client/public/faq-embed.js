// ファイブM よくあるご質問ウィジェットの埋め込みスクリプト。
// WordPress側にはこの1行だけを貼る：
//   <script src="https://fivem-portal.vercel.app/faq-embed.js" async></script>
//
// やること：
// 1. scriptタグの直後に iframe を差し込む
// 2. ウィジェットから届く高さの連絡（postMessage）に合わせて iframe を伸縮させる
//    ※受け取るのは高さの数字だけ。送信元がウィジェット本体かを必ず確認する
(function () {
  var ORIGIN = 'https://fivem-portal.vercel.app';
  var script = document.currentScript;
  if (!script) return;

  var iframe = document.createElement('iframe');
  iframe.src = ORIGIN + '/faq-widget.html';
  iframe.title = 'ファイブM よくあるご質問';
  iframe.style.width = '100%';
  iframe.style.maxWidth = '680px';
  iframe.style.display = 'block';
  iframe.style.margin = '0 auto';
  iframe.style.border = 'none';
  iframe.style.height = '480px';
  iframe.setAttribute('loading', 'lazy');
  script.parentNode.insertBefore(iframe, script.nextSibling);

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    if (!e.data || e.data.type !== 'fivem-faq-height') return;
    var h = Number(e.data.height);
    if (h > 0 && h < 10000) iframe.style.height = h + 24 + 'px';
  });
})();
