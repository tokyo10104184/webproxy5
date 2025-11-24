const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    // URLパラメータの取得（エンコードされたURLもデコードせずに受け取る工夫）
    let targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('URL is required.');
    }

    try {
        // Axiosでデータ取得
        const response = await axios.get(targetUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4 
        });

        const contentType = response.headers['content-type'] || '';
        
        // セキュリティ制限の解除
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        // テキストデータ（HTMLなど）の場合のみ書き換え処理を行う
        if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
            let content = response.data.toString('utf-8');

            // URL書き換え用のヘルパー関数
            const rewriteUrl = (urlStr) => {
                try {
                    // 空やjavascript:リンクは無視
                    if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('#') || urlStr.startsWith('javascript:')) {
                        return urlStr;
                    }
                    // 相対パスを絶対パスに変換 (例: /wiki/A -> https://ja.wikipedia.org/wiki/A)
                    const absoluteUrl = new URL(urlStr, targetUrl).href;
                    // プロキシ経由のURLに変換
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) {
                    return urlStr;
                }
            };

            // 1. 基本的なリンク (href, src, action) の書き換え
            // 検索バー(form action)もここで書き換わるため、検索が動くようになる
            content = content.replace(/(href|src|action)=["']([^"']+)["']/g, (match, attr, url) => {
                return `${attr}="${rewriteUrl(url)}"`;
            });

            // 2. CSS内の url(...) の書き換え
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url) => {
                return `url("${rewriteUrl(url)}")`;
            });

            // 3. 画像の srcset 属性の書き換え (これでWikipediaの画像が直る)
            // srcset="img1.jpg 1x, img2.jpg 2x" のような形式
            content = content.replace(/srcset=["']([^"']+)["']/g, (match, srcsetContent) => {
                const newSrcset = srcsetContent.split(',').map(part => {
                    const trimmed = part.trim();
                    const spaceIndex = trimmed.lastIndexOf(' ');
                    if (spaceIndex === -1) {
                        return rewriteUrl(trimmed);
                    }
                    const url = trimmed.substring(0, spaceIndex);
                    const descriptor = trimmed.substring(spaceIndex);
                    return `${rewriteUrl(url)}${descriptor}`;
                }).join(', ');
                return `srcset="${newSrcset}"`;
            });

            res.send(content);
        } else {
            // 画像ファイルなどはそのまま返す
            res.send(response.data);
        }

    } catch (error) {
        console.error(error);
        res.status(500).send(`Error: ${error.message}`);
    }
});
