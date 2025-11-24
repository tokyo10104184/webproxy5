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

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetOrigin + '/',
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

        if (response.headers['set-cookie']) {
            const cookies = response.headers['set-cookie'].map(c => 
                c.replace(/Domain=[^;]+;/i, '').replace(/Secure/i, '').replace(/SameSite=[^;]+;/i, '')
            );
            res.setHeader('Set-Cookie', cookies);
        }

        if (contentType.includes('text/html')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#')) return urlStr;
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // ★修正ポイント：
            // 画像系の属性（src, data-src, poster, data-poster）なら、
            // それが「絶対パス(http...)」であっても強制的にプロキシ経由にする！
            // href（リンク）や action（フォーム）は相対パスのときだけ書き換える（動画リンクへの干渉を避けるため）
            
            content = content.replace(
                /(href|src|action|poster|data-src|data-poster|data-image)=["']([^"']+)["']/g, 
                (match, attr, url) => {
                    
                    // 1. 画像系の属性は、どんなURLでも問答無用でプロキシを通す（サムネ表示のため）
                    if (['src', 'poster', 'data-src', 'data-poster', 'data-image'].includes(attr)) {
                        return `${attr}="${rewriteUrl(url)}"`;
                    }

                    // 2. リンク(href)やフォーム(action)の場合
                    // もし「http」から始まる絶対パスなら、書き換えない（動画への直接リンクを守る）
                    if (url.startsWith('http') || url.startsWith('//')) {
                        return match; 
                    }

                    // 3. 相対パスなら書き換える
                    return `${attr}="${rewriteUrl(url)}"`;
                }
            );
            
            // CSSのurl()書き換え
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                return `url("${rewriteUrl(url)}")`;
            });

            // 強制表示スクリプト (data-srcをsrcに移し替える処理)
            const injectScript = `
            <script>
                // 遅延読み込み画像を強制的に表示させる
                setInterval(() => {
                    document.querySelectorAll('img').forEach(img => {
                        // data-srcを持っていて、srcが空、またはloadingのままの場合
                        if (img.dataset.src && (!img.src || img.src.includes('loading'))) {
                            img.src = img.dataset.src; // プロキシURLが入っているはずなのでセットする
                            img.removeAttribute('data-src'); // ループしないように消す
                        }
                        // もしsrcがプロキシ経由になっていなければ書き換える
                        else if (img.src && !img.src.includes('/proxy') && !img.src.startsWith('data:')) {
                            // ただし動画プレイヤー関連の画像は除く（必要に応じて調整）
                        }
                    });
                }, 1000);

                // リンクと検索フォームの制御
                document.addEventListener('click', e => {
                    const a = e.target.closest('a');
                    // 内部リンク（相対パスが書き換えられたもの）以外で、外部への絶対リンクはJSでプロキシ化
                    // ただし、動画プレイヤーが動的に生成したリンクには触れないように注意が必要
                    if(a && a.href && !a.href.includes('/proxy') && a.host !== window.location.host) {
                        e.preventDefault();
                        window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
                    }
                });
                
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
            let content = response.data.toString('utf-8');
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                try { return `url("/proxy?url=${encodeURIComponent(new URL(url, targetUrl).href)}")`; } catch(e){return full;}
            });
            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        if (!res.headersSent) res.send('');
    }
});
