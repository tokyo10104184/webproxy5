document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('proxy-form');
    const input = document.getElementById('url-input');
    const iframe = document.getElementById('content-frame');
    const clearBtn = document.getElementById('clear-button');

    // フォーム送信時の処理
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        let url = input.value.trim();

        if (!url) return;

        // http/httpsがない場合は補完
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        // プロキシAPI経由でiframeに読み込む
        // Vercel上のパス /api/index.js に urlパラメータを渡す
        const proxyUrl = `/api/index.js?url=${encodeURIComponent(url)}`;
        iframe.src = proxyUrl;
    });

    // クリアボタン
    clearBtn.addEventListener('click', () => {
        input.value = '';
        iframe.src = '';
    });
});
