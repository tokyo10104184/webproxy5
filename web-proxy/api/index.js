const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const path = require('path');
const app = express();

app.use(cookieParser());
// バイナリデータも含めて広く受け付ける設定
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.all('/api/index.js', async (req, res) => {
    // 1. URLの決定ロジック
    // クエリパラメータ ?url=... が最優先
    let targetUrl = req.query.url;

    // クエリパラメータがない場合、Cookieから「最後に訪れたサイト」を取得してパスを結合する
    // これが「3回目で404になる」「検索できない」を防ぐ安全策
    if (!targetUrl) {
        const lastSite = req.cookies['proxy_target_site']; // Cookieからドメイン取得
        const originalPath = req.headers['x-now-route-matches'] 
                             ? req.headers['x-now-route-matches'] // Vercel特有のパス取得
                             : req.originalUrl; // ローカル用

        if (lastSite && originalPath) {
            // 例: lastSite="https://xvideos.com", originalPath="/video123"
            // => "https://xvideos.com/video123" を構築
            try {
                // originalPathが /api/index.js 自体を指している場合は無視
                if (!originalPath.startsWith('/api/index.js')) {
                    const u = new URL(originalPath, lastSite);
                    targetUrl = u.href;
                }
            } catch (e) {}
        }
    }

    // それでもURLがない、かつトップページへのアクセスの場合は、入力フォーム(index.html)を返す
    if (!targetUrl) {
        // public/index.htmlの内容を返す簡易実装（fsを使わず直接HTMLを返す）
        // ※ Vercelのファイル読み込み構成に依存しないように文字列で返します
        return res.send(`
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Web Proxy V3</title>
                <style>
                    body{font-family:sans-serif;background:#f4f4f4;display:flex;flex-direction:column;height:100vh;margin:0}
                    header{background:#2c3e50;padding:10px;color:white;display:flex;gap:10px}
                    input{flex:1;padding:8px;border-radius:4px;border:none}
                    button{padding:8px;background:#3498db;color:white;border:none;border-radius:4px;cursor:pointer}
                    iframe{flex:1;border:none}
                </style>
            </head>
            <body>
                <header>
                    <b>Proxy V3</b>
                    <form id="f" style="display:flex;flex:1;gap:5px">
                        <input id="u" type="text" placeholder="https://example.com">
                        <button>Go</button>
                    </form>
                </header>
                <iframe id="frm"></iframe>
                <script>
                    document.getElementById('f').onsubmit = e => {
                        e.preventDefault();
                        let u = document.getElementById('u').value;
                        if(!u.startsWith('http')) u = 'https://' + u;
                        document.getElementById('frm').src = '/api/index.js?url=' + encodeURIComponent(u);
                    }
                </script>
            </body>
            </html>
        `);
    }

    // --- ここからプロキシ処理 ---

    try {
        // 2. Cookieの更新（現在アクセスしているドメインを保存）
        const urlObj = new URL(targetUrl);
        const currentOrigin = urlObj.origin;
        res.cookie('proxy_target_site', currentOrigin, { 
            maxAge: 900000, // 15分
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        });

        // 3. ターゲットへのリクエスト
        // 検索クエリ (?k=word) などが targetUrl に含まれているか確認し、
        // 含まれていない場合は req.query をそのまま転送する考慮も必要だが
        // 上記のロジックで targetUrl 自体が完全なURLになっているはず。

        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Referer': currentOrigin,
                'Cookie': req.headers['cookie'] // 必要ならCookieも転送（ログイン維持など）
            },
            data: req.body, // POSTデータ転送
            responseType: 'arraybuffer',
            validateStatus: () => true
        });

        // 4. レスポンスヘッダの設定
        const contentType = response.headers['content-type'] || '';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        // リダイレクト対応 (301, 302)
        // サイトがリダイレクトを返してきた場合、プロキシ内で完結させる
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers['location'];
            if (location) {
                const absoluteRedirect = new URL(location, targetUrl).href;
                return res.redirect(`/api/index.js?url=${encodeURIComponent(absoluteRedirect)}`);
            }
        }

        // --- コンテンツ書き換えヘルパー ---
        const proxyfy = (path) => {
            if (!path) return '';
            if (path.startsWith('data:') || path.startsWith('#') || path.startsWith('javascript:')) return path;
            try {
                const absolute = new URL(path, targetUrl).href;
                return `/api/index.js?url=${encodeURIComponent(absolute)}`;
            } catch (e) { return path; }
        };

        // 5. HTML/CSSの書き換え
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');

            // 基本的なリンク書き換え
            html = html.replace(/(href|src|action|poster|data-src)=["'](.*?)["']/g, (_, attr, val) => `${attr}="${proxyfy(val)}"`);
            
            // CSS url()
            html = html.replace(/url\(['"]?(.*?)['"]?\)/g, (_, val) => `url('${proxyfy(val)}')`);

            // srcset
            html = html.replace(/srcset=["'](.*?)["']/g, (_, val) => {
                return `srcset="${val.split(',').map(p => {
                    const [u, s] = p.trim().split(' ');
                    return proxyfy(u) + (s ? ' ' + s : '');
                }).join(', ')}"`;
            });

            // 6. 強力なクライアントサイド補正スクリプト
            // 検索フォームとリンククリックを制御
            const script = `
            <script>
            (function(){
                const origin = '${currentOrigin}';
                
                // リンククリック監視
                document.body.addEventListener('click', e => {
                    const a = e.target.closest('a');
                    if(a && a.href && !a.href.startsWith('javascript') && !a.href.includes('/api/index.js')) {
                        e.preventDefault();
                        // リンク先が相対パスでも、ブラウザが解決した絶対パスを取得できる
                        const target = new URL(a.href, '${targetUrl}').href;
                        window.location.href = '/api/index.js?url=' + encodeURIComponent(target);
                    }
                }, true);

                // フォーム送信監視 (検索対策)
                document.querySelectorAll('form').forEach(f => {
                    f.addEventListener('submit', e => {
                        e.preventDefault();
                        const formData = new FormData(f);
                        const params = new URLSearchParams(formData).toString();
                        let action = f.getAttribute('action') || '';
                        
                        // actionを絶対URLに変換
                        let finalUrl;
                        try {
                            const u = new URL(action, '${targetUrl}'); // 現在のページをベースに解決
                            // クエリパラメータ結合
                            u.search += (u.search ? '&' : '') + params;
                            finalUrl = u.href;
                        } catch(err) {
                            finalUrl = '${targetUrl}?' + params;
                        }

                        window.location.href = '/api/index.js?url=' + encodeURIComponent(finalUrl);
                    });
                });
            })();
            </script>
            `;
            html = html.replace('</body>', script + '</body>');
            res.send(html);

        } else if (contentType.includes('text/css')) {
            let css = response.data.toString('utf-8');
            css = css.replace(/url\(['"]?(.*?)['"]?\)/g, (_, val) => `url('${proxyfy(val)}')`);
            res.send(css);
        } else {
            res.send(response.data);
        }

    } catch (e) {
        console.error(e);
        // エラー時もCookieがあればリトライできるかもしれないが、一旦エラー表示
        res.status(500).send('Proxy Error: ' + e.message);
    }
});

module.exports = app;
