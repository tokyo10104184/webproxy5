const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required.');

    try {
        const urlObj = new URL(targetUrl);
        const targetOrigin = urlObj.origin;

        // ヘッダーはしっかり偽装する（これはサイトを表示させるために必須）
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetOrigin + '/',
            'Cookie': req.headers.cookie || '' // テーマ設定などのためにCookieは通す
        };

        const response = await axios.get(targetUrl, {
            headers: headers,
            responseType: 'arraybuffer', // 文字化け防止
            validateStatus: () => true,
            family: 4
        });

        const contentType = response.headers['content-type'] || '';
        
        // レスポンスヘッダーの設定
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        // Set-Cookieがあれば転送（テーマ維持）
        if (response.headers['set-cookie']) {
            const cookies = response.headers['set-cookie'].map(c => 
                c.replace(/Domain=[^;]+;/i, '').replace(/Secure/i, '').replace(/SameSite=[^;]+;/i, '')
            );
            res.setHeader('Set-Cookie', cookies);
        }

        // --- ここが修正の核心 ---
        // テキストデータの時だけ処理するが、「JavaScriptの中身」はいじらない！
        if (contentType.includes('text/html')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#') || urlStr.startsWith('http')) return urlStr; // httpで始まる絶対パスはJSの可能性があるので一旦無視
                    // 相対パスだけを狙い撃ちで書き換える
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // 旧版と同じように、HTMLタグの「属性」だけをピンポイントで書き換える
            // JSコード内のURL（動画リンクなど）は書き換えないので、ブラウザが直接取りに行ける
            content = content.replace(
                /(href|src|action|poster|data-src|data-poster)=["']([^"']+)["']/g, 
                (match, attr, url) => {
                    // httpから始まるURL（絶対パス）は、画像以外は書き換えない（動画プレイヤーへの干渉を防ぐ）
                    if (url.startsWith('http')) {
                        if (url.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) {
                            return `${attr}="/proxy?url=${encodeURIComponent(url)}"`;
                        }
                        return match; // そのままにする
                    }
                    
                    // 相対パス（/img/logo.pngなど）はプロキシ経由にする
                    return `${attr}="${rewriteUrl(url)}"`;
                }
            );
            
            // CSSのurl()だけは書き換える（背景画像などのため）
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                if (url.startsWith('http') && !url.match(/\.(css|jpg|png|gif)$/i)) return full;
                return `url("${rewriteUrl(url)}")`;
            });

            // 検索バーなどを動かすための最低限のJSだけ入れる（動画プレイヤーの邪魔はしない）
            const injectScript = `
            <script>
                // リンククリック時だけプロキシを通す
                document.addEventListener('click', e => {
                    const a = e.target.closest('a');
                    if(a && a.href && !a.href.includes('/proxy') && a.host !== window.location.host) {
                        e.preventDefault();
                        window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
                    }
                });
                // 検索フォーム対策
                document.addEventListener('submit', e => {
                    e.preventDefault();
                    const form = e.target;
                    const act = new URL(form.getAttribute('action')||'', '${targetUrl}').href;
                    const params = new URLSearchParams(new FormData(form)).toString();
                    window.location.href = '/proxy?url=' + encodeURIComponent(act + (act.includes('?')?'&':'?') + params);
                });
            </script>
            `;
            
            content = content.replace('</body>', injectScript + '</body>');
            res.send(content);
        } else if (contentType.includes('text/css')) {
            // CSSファイル内のパス書き換え
            let content = response.data.toString('utf-8');
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                try { return `url("/proxy?url=${encodeURIComponent(new URL(url, targetUrl).href)}")`; } catch(e){return full;}
            });
            res.send(content);
        } else {
            // 画像やその他のファイルはそのまま流す
            res.send(response.data);
        }

    } catch (error) {
        // エラーでも何か返す
        if (!res.headersSent) res.send('');
    }
});
