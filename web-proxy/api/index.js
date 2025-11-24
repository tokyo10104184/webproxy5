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

        // ★強化ポイント1: 身元（Referer/Origin）を偽装するヘッダー設定
        // これがないと動画サーバーに拒否されます
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetOrigin + '/',  // 「あなたのサイトから見てますよ」と嘘をつく
            'Origin': targetOrigin,
            'Range': req.headers.range || '' // シークバー対応
        };

        // コンテンツタイプ確認用のヘッドリクエスト
        const headResponse = await axios.head(targetUrl, {
            headers: headers,
            validateStatus: () => true,
            family: 4
        });

        const contentType = headResponse.headers['content-type'] || '';

        // --- A. 動画・音声・バイナリのストリーミング ---
        if (contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType.startsWith('application/octet-stream')) {
            const streamResponse = await axios.get(targetUrl, {
                headers: headers,
                responseType: 'stream',
                validateStatus: () => true,
                family: 4
            });

            res.set({
                'Content-Type': contentType,
                'Content-Length': streamResponse.headers['content-length'],
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*'
            });
            res.status(streamResponse.status);
            streamResponse.data.pipe(res);
            return;
        }

        // --- B. HLS (m3u8) プレイリストの特殊処理 ---
        // 動画が細切れに分割されている場合、そのリストの中身も書き換える必要がある
        if (contentType.includes('mpegurl') || contentType.includes('x-mpegURL')) {
            const response = await axios.get(targetUrl, { 
                headers: headers, 
                responseType: 'text', // テキストとして取得
                family: 4 
            });
            
            let m3u8Content = response.data;
            const lines = m3u8Content.split('\n');
            const rewrittenLines = lines.map(line => {
                line = line.trim();
                // コメント行(#)でもなく、空行でもないならURLとみなす
                if (line && !line.startsWith('#')) {
                    try {
                        const absoluteUrl = new URL(line, targetUrl).href;
                        return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    } catch (e) { return line; }
                }
                return line;
            });
            
            res.set({
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            res.send(rewrittenLines.join('\n'));
            return;
        }

        // --- C. 通常のWebページ (HTML/CSS/JS) ---
        const response = await axios.get(targetUrl, {
            headers: headers,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            family: 4
        });

        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
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
                // 通常のリンク書き換え
                content = content.replace(/(src|href|poster)=["']([^"']+)["']/g, (match, attr, url) => {
                    return `${attr}="${rewriteUrl(url)}"`;
                });
                
                // srcset書き換え
                content = content.replace(/srcset=["']([^"']+)["']/g, (match, srcsetContent) => {
                    return `srcset="${srcsetContent.split(',').map(p => {
                        const [u, d] = p.trim().split(' ');
                        return `${rewriteUrl(u)} ${d||''}`;
                    }).join(', ')}"`;
                });

                // スパイ・スクリプト (JS内のURL生成もフックする強力版)
                const injectScript = `
                <script>
                    (function() {
                        const currentOrigin = '${targetUrl}';
                        
                        // XMLHttpRequest (Ajax) の乗っ取り: 動画プレイヤーが裏で叩く通信もプロキシ経由にする
                        const originalOpen = XMLHttpRequest.prototype.open;
                        XMLHttpRequest.prototype.open = function(method, url) {
                            if (url && !url.startsWith('/proxy') && !url.startsWith('data:')) {
                                try {
                                    const absUrl = new URL(url, currentOrigin).href;
                                    arguments[1] = '/proxy?url=' + encodeURIComponent(absUrl);
                                } catch(e){}
                            }
                            return originalOpen.apply(this, arguments);
                        };

                        // fetch の乗っ取り
                        const originalFetch = window.fetch;
                        window.fetch = function(input, init) {
                            if (typeof input === 'string' && !input.startsWith('/proxy') && !input.startsWith('data:')) {
                                try {
                                    input = '/proxy?url=' + encodeURIComponent(new URL(input, currentOrigin).href);
                                } catch(e){}
                            }
                            return originalFetch(input, init);
                        };

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
        if (!res.headersSent) {
             if (req.url.includes('.css') || req.url.includes('.js')) res.send('');
             else res.status(500).send('Proxy Error');
        }
    }
});
