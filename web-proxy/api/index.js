const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    // 【追加】検索などでurlパラメータが消え、qパラメータなどが来た場合の救済措置は困難なため
    // 基本的にはエラーを返すが、デバッグ用にログを出す
    if (!targetUrl) {
        // console.log('Params missing. Query:', req.query); 
        return res.status(400).send(`
            <div style="padding:20px;font-family:sans-serif;">
                <h3>URL is required.</h3>
                <p>プロキシ経由のフォーム送信に失敗しました。</p>
                <p>現在のクエリ: ${JSON.stringify(req.query)}</p>
                <a href="/">トップに戻る</a>
            </div>
        `);
    }

    try {
        const urlObj = new URL(targetUrl);
        const targetOrigin = urlObj.origin;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetOrigin + '/', 
            'Origin': targetOrigin,
            'Cookie': req.headers.cookie || '' 
        };

        const response = await axios.get(targetUrl, {
            headers: headers,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4
        });

        const contentType = response.headers['content-type'] || '';

        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        // テキストデータ（HTMLなど）の時だけ書き換え処理をする
        if (contentType.includes('text')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#')) return urlStr;
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // 【重要修正 1】絶対パス除外ロジックを削除し、全て書き換えるように変更
            content = content.replace(
                /(href|src|action|poster|data-src|data-poster|data-image)=["']([^"']+)["']/g, 
                (match, attr, url) => {
                    return `${attr}="${rewriteUrl(url)}"`;
                }
            );

            // CSS書き換え
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                return `url("${rewriteUrl(url)}")`;
            });

            // 【重要修正 2】検索フォーム対策スクリプトの注入
            const scriptFix = `
            <script>
                // 1. 画像の遅延読み込み対策
                setInterval(() => {
                    document.querySelectorAll('img[data-src]').forEach(img => {
                        if (img.dataset.src && (!img.src || img.src.indexOf('loading') > -1)) {
                            img.src = img.dataset.src;
                            img.removeAttribute('data-src');
                        }
                    });
                }, 500);

                // 2. 検索フォーム(GET)のパラメータ消失対策
                document.addEventListener('submit', (e) => {
                    const form = e.target;
                    const method = (form.method || 'GET').toUpperCase();
                    
                    // GET送信、かつactionがプロキシを向いている場合
                    if (method === 'GET' && form.action.includes('/proxy')) {
                        try {
                            // action URLから本来のターゲットURL (url=...) を取り出す
                            const actionUrl = new URL(form.action, window.location.origin);
                            const params = new URLSearchParams(actionUrl.search);
                            const originalTarget = params.get('url');

                            if (originalTarget) {
                                // hidden inputを作成してフォームに追加
                                // これにより、送信時に 'url' パラメータが含まれるようになる
                                let input = form.querySelector('input[name="url"]');
                                if (!input) {
                                    input = document.createElement('input');
                                    input.type = 'hidden';
                                    input.name = 'url';
                                    form.appendChild(input);
                                }
                                input.value = originalTarget;
                            }
                        } catch (err) {
                            console.error('Proxy form fix error:', err);
                        }
                    }
                });
            </script>
            `;
            
            if (contentType.includes('html')) {
                // </body>の直前、なければ末尾に追加
                if(content.includes('</body>')) content = content.replace('</body>', scriptFix + '</body>');
                else content += scriptFix;
            }

            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        if (!res.headersSent) res.status(500).send('Proxy Error: ' + error.message);
    }
});
