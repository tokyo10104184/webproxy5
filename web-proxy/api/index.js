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

        // テキストデータの処理
        if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
            let content = response.data.toString('utf-8');

            // URL書き換え関数
            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#') || urlStr.startsWith('javascript:')) return urlStr;
                    // HTMLエンティティ(&amp;)などを簡易デコード
                    urlStr = urlStr.replace(/&amp;/g, '&');
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // 1. CSSの url(...) 書き換え (CSSファイルでもHTMLでも実行)
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => `url("${rewriteUrl(url)}")`);

            // 2. HTMLの場合のみ、タグの属性書き換えとスクリプト注入を行う
            // ★ここが修正ポイント：CSSファイルに誤って干渉しないようにした
            if (contentType.includes('text/html')) {
                
                // リンク書き換え (src, href, action, srcset)
                content = content.replace(/(src|href|action|srcset)=["']([^"']+)["']/g, (match, attr, url) => {
                    if (attr === 'srcset') {
                        return `srcset="${url.split(',').map(p => {
                            const [u, d] = p.trim().split(' ');
                            return `${rewriteUrl(u)} ${d||''}`;
                        }).join(', ')}"`;
                    }
                    return `${attr}="${rewriteUrl(url)}"`;
                });

                // スパイ・スクリプト (フォーム送信とリンククリックの監視)
                const injectScript = `
                <script>
                    (function() {
                        const currentOrigin = '${targetUrl}';
                        
                        document.addEventListener('click', function(e) {
                            const anchor = e.target.closest('a');
                            if (anchor && anchor.href) {
                                // プロキシ経由でないリンクだけ捕まえる
                                if (!anchor.href.includes('/proxy?url=')) {
                                    e.preventDefault();
                                    try {
                                        const absoluteUrl = new URL(anchor.getAttribute('href'), currentOrigin).href;
                                        window.location.href = '/proxy?url=' + encodeURIComponent(absoluteUrl);
                                    } catch(err) {
                                        window.location.href = anchor.href;
                                    }
                                }
                            }
                        });

                        document.addEventListener('submit', function(e) {
                            e.preventDefault();
                            const form = e.target;
                            const method = (form.method || 'GET').toUpperCase();
                            const action = form.getAttribute('action') || '';
                            
                            try {
                                const absoluteAction = new URL(action, currentOrigin).href;
                                if (method === 'GET') {
                                    const formData = new FormData(form);
                                    const params = new URLSearchParams(formData);
                                    const separator = absoluteAction.includes('?') ? '&' : '?';
                                    window.location.href = '/proxy?url=' + encodeURIComponent(absoluteAction + separator + params.toString());
                                } else {
                                    // POSTなどもとりあえずGETとして送ってみる（検索などは動くことが多い）
                                    form.action = '/proxy?url=' + encodeURIComponent(absoluteAction);
                                    form.submit();
                                }
                            } catch(err) {
                                console.error(err);
                            }
                        });
                    })();
                </script>
                `;
                
                // </body>の前にスクリプトを入れる
                if (content.includes('</body>')) {
                    content = content.replace('</body>', injectScript + '</body>');
                } else {
                    content += injectScript;
                }
            }

            res.send(content);
        } else {
            // 画像ファイルなど
            res.send(response.data);
        }

    } catch (error) {
        // CSSなどが404でもエラー画面を出さず、空を返す（画面崩れを最小限にするため）
        if (req.url.includes('.css')) {
            res.send('');
        } else {
            res.status(500).send('Proxy Error: ' + error.message);
        }
    }
});
