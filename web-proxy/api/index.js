const express = require('express');
const axios = require('axios');
const app = express();

// Vercel等のサーバーレス環境では /api/index.js がエントリポイントになることが多い
// ローカル実行用とサーバーレス用の両方に対応できる記述にします

app.get('/api/index.js', async (req, res) => {
    const targetUrl = req.query.url;

    // URLがない場合はエラー
    if (!targetUrl) {
        return res.status(400).send('URL parameter is required (e.g. ?url=https://example.com)');
    }

    try {
        // ターゲットサイトへリクエスト
        const response = await axios.get(targetUrl, {
            headers: {
                // 一般的なブラウザのUser-Agentを偽装してブロック回避
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            // バイナリデータ（画像など）も扱えるようにarraybufferで受け取る
            responseType: 'arraybuffer',
            validateStatus: () => true // 404や500でも処理を続行
        });

        // レスポンスヘッダの設定
        const contentType = response.headers['content-type'];
        res.setHeader('Content-Type', contentType);
        
        // CORS許可
        res.setHeader('Access-Control-Allow-Origin', '*');

        // HTMLの場合のみ書き換え処理を行う
        if (contentType && contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const baseUrl = new URL(targetUrl); // ベースURLを取得

            // --- ヘルパー関数: URLをプロキシ経由に変換 ---
            const proxyfy = (urlStr) => {
                try {
                    // 相対パスを絶対パスに変換
                    const absoluteUrl = new URL(urlStr, baseUrl.href).href;
                    // プロキシURLとして返す
                    return `/api/index.js?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) {
                    return urlStr;
                }
            };

            // --- HTML書き換え処理 (簡易的なRegex置換) ---
            
            // href="..." の書き換え
            html = html.replace(/href=["'](.*?)["']/g, (match, p1) => {
                // #リンクやjavascript:などは除外
                if (p1.startsWith('#') || p1.startsWith('javascript:')) return match;
                return `href="${proxyfy(p1)}"`;
            });

            // src="..." の書き換え
            html = html.replace(/src=["'](.*?)["']/g, (match, p1) => {
                return `src="${proxyfy(p1)}"`;
            });

            // action="..." (フォーム) の書き換え
            // ただし、actionだけ変えてもinputのクエリパラメータがうまく渡らないことが多いため、
            // 下記の注入スクリプトで補完します。ここでは絶対パス化しておく。
            html = html.replace(/action=["'](.*?)["']/g, (match, p1) => {
                 return `action="${proxyfy(p1)}"`;
            });


            // --- 重要: 検索フォームなどを正常動作させるためのスクリプト注入 ---
            // </body>の直前にスクリプトを埋め込む
            const injectionScript = `
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    // フォーム送信をフック
                    document.querySelectorAll('form').forEach(form => {
                        form.addEventListener('submit', function(e) {
                            e.preventDefault(); // 本来の送信をキャンセル
                            
                            // フォームの送信先URLを作成
                            const formData = new FormData(form);
                            const searchParams = new URLSearchParams(formData);
                            
                            // 元のaction属性を取得（プロキシURLになっているはずだが、元のターゲットURLを復元する必要がある）
                            let actionUrl = form.getAttribute('action');
                            
                            // もしactionがプロキシ形式 (/api/index.js?url=...) なら、
                            // その中の実際のターゲットURLを取り出す処理
                            let targetBase = "";
                            try {
                                const urlObj = new URL(actionUrl, window.location.origin);
                                targetBase = urlObj.searchParams.get('url');
                            } catch(err) { }

                            if (!targetBase) {
                                // 万が一取得できなければ現在のURLを使うなどのフォールバック
                                targetBase = window.location.href; 
                            }

                            // GETメソッドの場合、クエリパラメータをターゲットURLに結合
                            if (form.method.toLowerCase() === 'get') {
                                // ターゲットURLに '?' が既にあるか確認
                                const separator = targetBase.includes('?') ? '&' : '?';
                                const finalTargetUrl = targetBase + separator + searchParams.toString();
                                
                                // プロキシ経由で遷移
                                window.location.href = '/api/index.js?url=' + encodeURIComponent(finalTargetUrl);
                            } else {
                                // POSTメソッドなどは複雑なため今回はGET(検索)メインで対応
                                // 必要であればここにPOST処理を追加
                                console.log('POST forms not fully supported in simple proxy');
                            }
                        });
                    });
                });
            </script>
            `;
            
            // 閉じるbodyタグの前にスクリプトを挿入
            html = html.replace('</body>', injectionScript + '</body>');

            res.send(html);

        } else {
            // HTML以外（画像、CSS、JSなど）はそのまま返す
            res.send(response.data);
        }

    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).send(`Error fetching URL: ${error.message}`);
    }
});

// ローカルでのテスト実行用
// Vercel上ではエクスポートされた関数が使われるため、listenは不要だが
// 開発用に残しておく場合は if (require.main === module) で囲むのが一般的
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Proxy server running on port ${PORT}`));
}

module.exports = app;
