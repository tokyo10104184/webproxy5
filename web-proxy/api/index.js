const express = require('express');
const axios = require('axios');
const app = express();

module.exports = app;

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required.');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            responseType: 'arraybuffer', 
            validateStatus: () => true 
        });

        const contentType = response.headers['content-type'] || '';
        
        // ヘッダー削除（セキュリティ制限回避）
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
            let content = response.data.toString('utf-8');
            const rewriteUrl = (match) => {
                try { return `/proxy?url=${encodeURIComponent(new URL(match, targetUrl).href)}`; } 
                catch (e) { return match; }
            };
            
            // リンク書き換え
            content = content.replace(/(?:href|src|action)=["']([^"']+)["']/g, (full, url) => {
                const parts = full.split('=');
                return `${parts[0]}="${rewriteUrl(url)}"`;
            });
            content = content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, url) => `url("${rewriteUrl(url)}")`);
            
            res.send(content);
        } else {
            res.send(response.data);
        }
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});
