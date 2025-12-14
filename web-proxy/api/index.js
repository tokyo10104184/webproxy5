const express = require('express');
const axios = require('axios');
const app = express();

// クエリストリングなどの制限を緩和
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.get('/api/index.js', async (req, res) => {
    const targetUrl = req.query.url;

    // URLがない場合はエラー
    if (!targetUrl) {
        return res.status(400).send('URL parameter is required');
    }

    try {
        // URLの妥当性チェックと整形
        let validUrl = targetUrl;
        if (!validUrl.startsWith('http')) {
             // 万が一完全なURLでない場合
             return res.status(400).send('Invalid URL');
        }

        // ベースURL（相対パス解決用）
        const urlObj = new URL(validUrl);
        const baseUrl = urlObj.origin; 
        
        // ターゲットサイトへリクエスト
        const response = await axios.get(validUrl, {
            headers: {
                // PC用Chromeに偽装（モバイル版だと構造が変わりすぎて解析しにくい場合があるため）
                // 必要に応じてモバイルUAに変えてもOKですが、安定性のためPC UA推奨
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Referer': baseUrl // リファラ偽装（画像の読み込み制限回避などに有効）
            },
            responseType: 'arraybuffer', // 画像やフォントも扱えるようにバイナリで取得
            validateStatus: () => true // 404/500エラーでもプロキシ自体は動作させる
        });

        // レスポンスヘッダのコピー（CORS対策）
        const contentType = response.headers['content-type'] || '';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // --- ヘルパー関数: URLをプロキシ形式に変換 ---
        const proxyfy = (path) => {
            if (!path) return '';
            // データURIやハッシュは無視
            if (path.startsWith('data:') || path.startsWith('#') || path.startsWith('javascript:')) return path;
            
            try {
                // 相対パスを絶対パスに変換
                const absoluteUrl = new URL(path, validUrl).href;
                // 自分自身（プロキシAPI）を通してアクセスさせるURLを作成
                return `/api/index.js?url=${encodeURIComponent(absoluteUrl)}`;
            } catch (e) {
                return path;
            }
        };

        // --- コンテンツタイプ別の処理 ---

        // 1. HTMLの場合
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');

            // 正規表現で静的なリンクを書き換え
            // href, src, action, data-src(遅延ロード画像用), poster(動画サムネ用)
            const regexAttrs = /(href|src|action|data-src|poster)=["'](.*?)["']/g;
            html = html.replace(regexAttrs, (match, attr, path) => {
                return `${attr}="${proxyfy(path)}"`;
            });

            //srcset (レスポンシブ画像) の書き換え
            html = html.replace(/srcset=["'](.*?)["']/g, (match, content) => {
                // srcsetは "url size, url size" の形式
                const newContent = content.split(',').map(part => {
                    const trimmed = part.trim();
                    const spaceIndex = trimmed.lastIndexOf(' ');
                    if (spaceIndex === -1) return proxyfy(trimmed);
                    const url = trimmed.substring(0, spaceIndex);
                    const size = trimmed.substring(spaceIndex);
                    return proxyfy(url) + size;
                }).join(', ');
                return `srcset="${newContent}"`;
            });

            // CSSのstyleタグ内のurl()書き換え (background-imageなど)
            html = html.replace(/url\(['"]?(.*?)['"]?\)/g, (match, url) => {
                return `url('${proxyfy(url)}')`;
            });

            // --- 【重要】クライアントサイドでの動作補正スクリプト ---
            // 404回避と動的リンク対応のため、強力なスクリプトを注入します
            const injectionScript = `
            <script>
                (function() {
                    const currentProxyUrl = '/api/index.js?url=';
                    const targetOrigin = '${baseUrl}'; // 元サイトのオリジン
                    const currentTargetUrl = '${validUrl}'; // 現在見ているページ

                    // URLをプロキシ形式に変換する関数
                    function toProxyUrl(url) {
                        if(!url) return url;
                        if(url.startsWith('data:') || url.startsWith('#') || url.startsWith('javascript:')) return url;
                        // 既にプロキシ経由なら何もしない
                        if(url.includes('/api/index.js?url=')) return url;

                        try {
                            // 相対パスを絶対パスにしてからプロキシURL化
                            const absolute = new URL(url, currentTargetUrl).href;
                            return currentProxyUrl + encodeURIComponent(absolute);
                        } catch(e) { return url; }
                    }

                    document.addEventListener('DOMContentLoaded', function() {
                        
                        // 1. クリックイベントのハイジャック (これが404対策の肝)
                        // ページ内のどこをクリックしても、もしそれがリンクなら強制的にプロキシ経由にする
                        document.body.addEventListener('click', function(e) {
                            const anchor = e.target.closest('a');
                            if (anchor) {
                                const href = anchor.getAttribute('href');
                                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                                    e.preventDefault(); // 本来の遷移を止める
                                    window.location.href = toProxyUrl(href);
                                }
                            }
                        }, true);

                        // 2. フォーム送信のハイジャック (検索バー対策)
                        document.querySelectorAll('form').forEach(form => {
                            form.addEventListener('submit', function(e) {
                                e.preventDefault();
                                const formData = new FormData(form);
                                const params = new URLSearchParams(formData);
                                let action = form.getAttribute('action') || currentTargetUrl;
                                
                                // actionがプロキシURLになっていたら、元のターゲットURLを復元してパラメータを付ける
                                // 簡易的に、actionを絶対パス化してパラメータ結合し、再度プロキシ化する
                                try {
                                    const actionAbs = new URL(action, currentTargetUrl).href;
                                    // パラメータ結合
                                    const separator = actionAbs.includes('?') ? '&' : '?';
                                    const finalUrl = actionAbs + separator + params.toString();
                                    window.location.href = currentProxyUrl + encodeURIComponent(finalUrl);
                                } catch(err) {
                                    console.error(err);
                                }
                            });
                        });
                    });
                })();
            </script>
            `;

            // bodyの閉じタグ直前にスクリプト挿入
            html = html.replace('</body>', injectionScript + '</body>');
            res.send(html);

        } 
        // 2. CSSの場合 (ボタン崩れ対策)
        else if (contentType.includes('text/css')) {
            let css = response.data.toString('utf-8');
            // CSS内の url(...) を書き換え
            // ../fonts/icon.woff などを正しくプロキシ経由にする
            css = css.replace(/url\(['"]?(.*?)['"]?\)/g, (match, path) => {
                return `url('${proxyfy(path)}')`;
            });
            res.send(css);
        }
        // 3. その他（画像、フォント、JSファイルなど）
        else {
            // そのままバイナリとして返す
            res.send(response.data);
        }

    } catch (error) {
        console.error('Proxy Error:', error.message);
        // エラー内容を表示せず、元のプロキシトップに戻すか、エラーを表示する
        res.status(500).send(`
            <div style="color:red; padding:20px;">
                Proxy Error: ${error.message}<br>
                <a href="/">Go back to Home</a>
            </div>
        `);
    }
});

module.exports = app;
