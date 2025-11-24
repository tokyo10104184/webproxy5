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
        // まずはヘッダー情報だけを取得して、コンテンツタイプを調べる
        // (いきなり全データを取ると動画の場合にパンクするため)
        const headResponse = await axios.head(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
            validateStatus: () => true,
            family: 4
        });

        const contentType = headResponse.headers['content-type'] || '';

        // --- A. 動画や音声ファイルの場合 (ストリーミング転送) ---
        // ここが新機能！データをダウンロード完了を待たずに、パイプで流し込む
        if (contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType.startsWith('application/octet-stream')) {
            
            const streamResponse = await axios.get(targetUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                    'Range': req.headers.range // 動画のシーク(早送り)に対応するためにRangeヘッダを転送
                },
                responseType: 'stream', // ストリームとして取得
                validateStatus: () => true,
                family: 4
            });

            // ヘッダーを転送 (Content-Lengthなどをブラウザに伝える)
            res.set({
                'Content-Type': contentType,
                'Content-Length': streamResponse.headers['content-length'],
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*'
            });

            // ストリームのステータスコードを転送 (206 Partial Contentなど)
            res.status(streamResponse.status);

            // サーバーから来たデータをそのままブラウザに流す (パイプ処理)
            streamResponse.data.pipe(res);
            return; // ここで処理終了
        }

        // --- B. それ以外のテキストや画像 (これまで通りの書き換え処理) ---
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4
        });

        // セキュリティ制限解除
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

            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => `url("${rewriteUrl(url)}")`);

            if (contentType.includes('text/html')) {
                content = content.replace(/(src|href|srcset)=["']([^"']+)["']/g, (match, attr, url) => {
                    if (attr === 'srcset') {
                        return `srcset="${url.split(',').map(p => {
                            const [u, d] = p.trim().split(' ');
                            return `${rewriteUrl(u)} ${d||''}`;
                        }).join(', ')}"`;
                    }
                    return `${attr}="${rewriteUrl(url)}"`;
                });

                const injectScript = `
                <script>
                    (function() {
                        const currentOrigin = '${targetUrl}';
                        document.addEventListener('click', function(e) {
                            const anchor = e.target.closest('a');
                            if (anchor && anchor.href && !anchor.href.includes('/proxy?url=')) {
                                e.preventDefault();
                                try {
                                    const absoluteUrl = new URL(anchor.getAttribute('href'), currentOrigin).href;
                                    window.location.href = '/proxy?url=' + encodeURIComponent(absoluteUrl);
                                } catch(err) { window.location.href = anchor.href; }
                            }
                        });
                        document.addEventListener('submit', function(e) {
                            e.preventDefault();
                            const form = e.target;
                            const action = form.getAttribute('action') || '';
                            try {
                                const absoluteAction = new URL(action, currentOrigin).href;
                                const formData = new FormData(form);
                                const params = new URLSearchParams(formData);
                                const separator = absoluteAction.includes('?') ? '&' : '?';
                                window.location.href = '/proxy?url=' + encodeURIComponent(absoluteAction + separator + params.toString());
                            } catch(err) { console.error(err); }
                        });
                    })();
                </script>
                `;
                if (content.includes('</body>')) content = content.replace('</body>', injectScript + '</body>');
                else content += injectScript;
            }
            res.send(content);
        } else {
            res.send(response.data);
        }

    } catch (error) {
        // エラー時はログを出して終了
        if (!res.headersSent) {
            if (req.url.includes('.css') || req.url.includes('.js')) res.send('');
            else res.status(500).send('Proxy Error: ' + error.message);
        }
    }
});
