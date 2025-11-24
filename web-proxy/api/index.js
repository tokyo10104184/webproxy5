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

        // 【重要】ここで「私は公式サイトです」と身分を偽る（画像表示に必須）
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetOrigin + '/', // これがないと画像サーバーに弾かれる
            'Origin': targetOrigin,
            'Cookie': req.headers.cookie || '' // テーマ設定などの維持
        };

        // データ取得
        const response = await axios.get(targetUrl, {
            headers: headers,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4
        });

        const contentType = response.headers['content-type'] || '';

        // ヘッダー調整
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        // テキストデータ（HTML/CSS）の時だけ書き換え処理をする
        if (contentType.includes('text')) {
            let content = response.data.toString('utf-8');

            const rewriteUrl = (urlStr) => {
                try {
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#')) return urlStr;
                    // 相対パスを絶対パスにしてからプロキシURLで包む
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) { return urlStr; }
            };

            // 【旧版ベースの改良ロジック】
            // 余計なJS書き換えは一切せず、画像とリンクだけを確実に書き換える
            content = content.replace(
                // src, href, action に加えて、"data-src", "poster" も対象にする（サムネ対策）
                /(href|src|action|poster|data-src|data-poster|data-image)=["']([^"']+)["']/g, 
                (match, attr, url) => {
                    
                    // 1. 画像系 (src, poster, data-src...)
                    // これらはサーバーのチェックが厳しいので、絶対パスだろうが何だろうが
                    // 「全てプロキシ経由」にして、サーバー側でReferer偽装を行うようにする
                    if (['src', 'poster', 'data-src', 'data-poster', 'data-image'].includes(attr)) {
                         return `${attr}="${rewriteUrl(url)}"`;
                    }

                    // 2. リンク系 (href, action)
                    // httpで始まる絶対パスは「書き換えない」
                    // → これにより動画プレイヤー内のリンクや、JSが生成するURLを壊さずに済む
                    if (url.startsWith('http') || url.startsWith('//')) {
                        return match; 
                    }

                    // 3. 相対パス (例: /video123)
                    // これはプロキシ経由にしないとリンク切れになるので書き換える
                    return `${attr}="${rewriteUrl(url)}"`;
                }
            );

            // CSSのurl()書き換え
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => {
                return `url("${rewriteUrl(url)}")`;
            });

            // </body>の前に、遅延読み込み画像を強制表示させる小さなスクリプトだけ足す
            const lazyLoadFix = `
            <script>
                // 1秒ごとに data-src を src にコピーして表示させる
                setInterval(() => {
                    document.querySelectorAll('img[data-src]').forEach(img => {
                        if (img.dataset.src && (!img.src || img.src.indexOf('loading') > -1)) {
                            img.src = img.dataset.src;
                            img.removeAttribute('data-src');
                        }
                    });
                }, 500);
            </script>
            `;
            
            // HTMLならスクリプト挿入
            if (contentType.includes('html')) {
                if(content.includes('</body>')) content = content.replace('</body>', lazyLoadFix + '</body>');
                else content += lazyLoadFix;
            }

            res.send(content);
        } else {
            // 画像ファイルなどはそのまま返す
            res.send(response.data);
        }

    } catch (error) {
        if (!res.headersSent) res.status(500).send('');
    }
});
