const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('URL is required.');
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4 
        });

        const contentType = response.headers['content-type'] || '';
        
        // ヘッダー処理
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#') || urlStr.startsWith('javascript:')) return urlStr;
                    urlStr = urlStr.replace(/&amp;/g, '&');
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // CSS書き換え
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => `url("${rewriteUrl(url)}")`);

            if (contentType.includes('text/html')) {
                // ★修正ポイント: 'action' をここから削除しました！
                // フォームの送信先(action)は、下のJSに任せて、ここでは書き換えません。
                content = content.replace(/(src|href|srcset)=["']([^"']+)["']/g, (match, attr, url) => {
                    if (attr === 'srcset') {
                        return `srcset="${url.split(',').map(p => {
                            const [u, d] = p.trim().split(' ');
                            return `${rewriteUrl(u)} ${d||''}`;
                        }).join(', ')}"`;
                    }
                    return `${attr}="${rewriteUrl(url)}"`;
                });

                // フォーム送信とリンククリックを制御するJS
                const injectScript = `
                <script>
                    (function() {
                        const currentOrigin = '${targetUrl}';
                        
                        // リンククリック監視
                        document.addEventListener('click', function(e) {
                            const anchor = e.target.closest('a');
                            if (anchor && anchor.href) {
                                // すでにプロキシ経由になっているリンクは無視
                                if (!anchor.href.includes('/proxy?url=')) {
                                    e.preventDefault();
                                    try {
                                        // hrefが相対パスでも絶対パスでも正しく計算する
                                        const absoluteUrl = new URL(anchor.getAttribute('href'), currentOrigin).href;
                                        window.location.href = '/proxy?url=' + encodeURIComponent(absoluteUrl);
                                    } catch(err) {
                                        // 計算失敗したらそのまま移動（フェイルセーフ）
                                        window.location.href = anchor.href;
                                    }
                                }
                            }
                        });

                        // フォーム送信監視（ここが検索機能のキモ）
                        document.addEventListener('submit', function(e) {
                            e.preventDefault();
                            const form = e.target;
                            const action = form.getAttribute('action') || '';
                            
                            try {
                                // action属性（例: /w/index.php）を、正しいWikipediaのURLに変換
                                const absoluteAction = new URL(action, currentOrigin).href;
                                
                                // フォームに入力されたデータ（検索ワードなど）を取得
                                const formData = new FormData(form);
                                const params = new URLSearchParams(formData);
                                
                                // ?があるかどうかでつなぎ文字を変える
                                const separator = absoluteAction.includes('?') ? '&' : '?';
                                
                                // 最終的に「プロキシURL + Wikipedia検索URL + 検索ワード」の形にして移動
                                window.location.href = '/proxy?url=' + encodeURIComponent(absoluteAction + separator + params.toString());
                            } catch(err) {
                                console.error('Form processing error:', err);
                            }
                        });
                    })();
                </script>
                `;
                
                if (content.includes('</body>')) {
                    content = content.replace('</body>', injectScript + '</body>');
                } else {
                    content += injectScript;
                }
            }

            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        if (req.url.includes('.css')) res.send('');
        else res.status(500).send('Proxy Error: ' + error.message);
    }
});
