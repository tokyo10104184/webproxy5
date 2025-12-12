const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    
    // 隠しフィールドから送信された場合など、クエリパラメータが散らばる可能性への対策
    if (!targetUrl && req.query.q) {
        // 一部のサイト検索で発生するケースへの保険（基本は下のJS対策でカバー）
        // ここでの完全な復元は難しいため、JSでの対策がメインになります
    }

    if (!targetUrl) return res.status(400).send('URL is required.');

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

        if (contentType.includes('text')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#')) return urlStr;
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            content = content.replace(
                /(href|src|action|poster|data-src|data-poster|data-image)=["']([^"']+)["']/g, 
                (match, attr, url) => {
                    // 【修正1】絶対パス(http...)もプロキシ経由に書き換えるように変更
                    // 元のコードにあった `if (url.startsWith('http')...` を削除しました。
                    // これにより、絶対パスのリンクや検索フォームも正しくプロキシ経由になります。

                    return `${attr}="${rewriteUrl(url)}"`;
                }
            );

            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                return `url("${rewriteUrl(url)}")`;
            });

            // 【修正2】検索フォーム(GET)対策と画像読み込みスクリプト
            const lazyLoadFix = `
            <script>
                // 画像の遅延読み込み対策
                setInterval(() => {
                    document.querySelectorAll('img[data-src]').forEach(img => {
                        if (img.dataset.src && (!img.src || img.src.indexOf('loading') > -1)) {
                            img.src = img.dataset.src;
                            img.removeAttribute('data-src');
                        }
                    });
                }, 500);

                // 【追加】検索フォーム対策
                // GETメソッドのフォーム送信時に、actionのURLパラメータが消えるのを防ぐ
                document.addEventListener('submit', (e) => {
                    const form = e.target;
                    // actionがプロキシを指しているか確認
                    if (form.action.includes('/proxy')) {
                        // URLから本来のターゲットURLを抽出
                        const actionUrl = new URL(form.action);
                        const params = new URLSearchParams(actionUrl.search);
                        const targetUrl = params.get('url');

                        if (targetUrl) {
                            // 既にhidden inputがあるか確認
                            if (!form.querySelector('input[name="url"]')) {
                                const input = document.createElement('input');
                                input.type = 'hidden';
                                input.name = 'url';
                                input.value = targetUrl;
                                form.appendChild(input);
                            }
                        }
                    }
                });
            </script>
            `;
            
            if (contentType.includes('html')) {
                if(content.includes('</body>')) content = content.replace('</body>', lazyLoadFix + '</body>');
                else content += lazyLoadFix;
            }

            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        // エラー詳細をログに出すとデバッグしやすいです
        console.error(error.message);
        if (!res.headersSent) res.status(500).send('Proxy Error');
    }
});
