const WebSocket = require('ws');
const http = require('http');

async function getPages() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9000/json/list', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function runScript(wsUrl, script) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: script, returnByValue: true } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                resolve(msg.result?.result?.value || msg);
                ws.close();
            }
        });
        ws.on('error', reject);
        setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    });
}

(async () => {
    try {
        const pages = await getPages();
        console.log('Checking all ' + pages.length + ' pages for buttons...\n');
        
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            if (!page.webSocketDebuggerUrl) continue;
            
            console.log('--- Page ' + i + ': ' + (page.title || 'untitled') + ' ---');
            console.log('URL: ' + page.url.substring(0, 80));
            
            try {
                const result = await runScript(page.webSocketDebuggerUrl, `
                    (function() {
                        const btns = document.querySelectorAll('button, [role="button"], div[class*="button"], .bg-ide-button-background');
                        let report = 'Found ' + btns.length + ' buttons';
                        if (btns.length > 0) {
                            report += ':\\n';
                            for (let i = 0; i < Math.min(15, btns.length); i++) {
                                const b = btns[i];
                                const txt = (b.textContent || '').trim().substring(0, 35).replace(/\\n/g, ' ');
                                const cls = (b.className || '').substring(0, 40);
                                const aria = b.getAttribute('aria-label') || '';
                                report += '  ' + i + ': "' + txt + '" class="' + cls + '" aria="' + aria + '"\\n';
                            }
                        }
                        return report;
                    })()
                `);
                console.log(result);
            } catch (e) {
                console.log('Error connecting: ' + e.message);
            }
            console.log('');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
})();
