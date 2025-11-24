const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    // もしURLパラメータがない場合でも、リファラー（前のページ）があれば復旧を試みる
    if (!targetUrl) {
        return res.status(400).send('URL is required. (Navigation Error)');
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

            // --- 1. これまでの静的書き換え（画像表示用） ---
            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#') || urlStr.startsWith('javascript:')) return urlStr;
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // 画像などのリソース読み込み系だけサーバー側で書き換える
            content = content.replace(/(src|srcset|href)=["']([^"']+)["']/g, (match, attr, url) => {
                // CSSファイルや画像ファイルへのリンクは直接書き換える
                if(url.match(/\.(css|jpg|jpeg|png|gif|svg|js)$/i) || attr === 'srcset') {
                     // srcset対応
                    if (attr === 'srcset') {
                        return `srcset="${url.split(',').map(p => {
                            const [u, d] = p.trim().split(' ');
                            return `${rewriteUrl(u)} ${d||''}`;
                        }).join(', ')}"`;
                    }
                    return `${attr}="${rewriteUrl(url)}"`;
                }
                return match; // 通常のリンクやフォームは下のJSで処理させるのでスルー気味にする
            });
            
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => `url("${rewriteUrl(url)}")`);

            // --- 2. ページ遷移バグを直す「スパイ・スクリプト」を注入 ---
            // これが検索バーやリンククリックを監視して、正しいURLに導きます
            const injectScript = `
            <script>
                (function() {
                    const currentOrigin = '${targetUrl}';
                    
                    // リンククリックの監視
                    document.addEventListener('click', function(e) {
                        const anchor = e.target.closest('a');
                        if (anchor && anchor.href) {
                            e.preventDefault();
                            // 絶対パスに変換してからプロキシを通す
                            const absoluteUrl = new URL(anchor.getAttribute('href'), currentOrigin).href;
                            window.location.href = '/proxy?url=' + encodeURIComponent(absoluteUrl);
                        }
                    });

                    // 検索フォームなどの送信監視 (ここが今回の修正の肝)
                    document.addEventListener('submit', function(e) {
                        e.preventDefault();
                        const form = e.target;
                        const method = (form.method || 'GET').toUpperCase();
                        const action = form.getAttribute('action') || '';
                        
                        // フォームの送信先URLを絶対パス化
                        const absoluteAction = new URL(action, currentOrigin).href;

                        if (method === 'GET') {
                            // 入力されたデータをURLパラメータとして結合する
                            const formData = new FormData(form);
                            const params = new URLSearchParams(formData);
                            // 既に?があるなら&でつなぐ
                            const separator = absoluteAction.includes('?') ? '&' : '?';
                            const finalUrl = absoluteAction + separator + params.toString();
                            
                            // プロキシ経由で移動
                            window.location.href = '/proxy?url=' + encodeURIComponent(finalUrl);
                        } else {
                            // POSTの場合などは今回は未対応だがアラートを出さずに何もしない(高度な実装が必要)
                            console.log('POST forms are not fully supported in this prototype');
                        }
                    });
                })();
            </script>
            `;

            // HTMLの </body> の直前にスクリプトを挿入
            if (content.includes('</body>')) {
                content = content.replace('</body>', injectScript + '</body>');
            } else {
                content += injectScript;
            }

            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        console.error(error);
        res.status(500).send('Error: ' + error.message);
    }
});
