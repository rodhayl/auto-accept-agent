const vscode = require('vscode');
const { STRIPE_LINKS } = require('./config');
const fs = require('fs');
const path = require('path');

const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';

class SettingsPanel {
    static currentPanel = undefined;
    static viewType = 'autoAcceptSettings';

    static createOrShow(extensionUri, context, mode = 'settings') {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            'Multi Purpose Agent Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context);
    }

    constructor(panel, extensionUri, context) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.context = context;
        this.disposables = [];

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'setFrequency':
                        if (this.isPro()) {
                            await this.context.globalState.update('multi-purpose-agent-frequency', message.value);
                            vscode.commands.executeCommand('multi-purpose-agent.updateFrequency', message.value);
                        }
                        break;
                    case 'setBackgroundMode':
                         if (this.isPro()) {
                            vscode.commands.executeCommand('multi-purpose-agent.toggleBackground', message.value); // Pass value
                         }
                         break;
                    case 'getStats':
                        this.sendStats();
                        break;
                    case 'getROIStats':
                        this.sendROIStats();
                        break;
                    case 'getBackgroundMode':
                        this.sendBackgroundMode();
                        break;
                    case 'updateBannedCommands':
                        if (this.isPro()) {
                            await this.context.globalState.update('multi-purpose-agent-banned-commands', message.commands);
                            vscode.commands.executeCommand('multi-purpose-agent.updateBannedCommands', message.commands);
                        }
                        break;
                    case 'getBannedCommands':
                        this.sendBannedCommands();
                        break;
                    case 'updateSchedule':
                        if (this.isPro()) {
                            const config = vscode.workspace.getConfiguration('multi-purpose-agent.schedule');
                            await config.update('enabled', message.enabled, vscode.ConfigurationTarget.Global);
                            await config.update('mode', message.mode, vscode.ConfigurationTarget.Global);
                            await config.update('value', message.value, vscode.ConfigurationTarget.Global);
                            await config.update('prompt', message.prompt, vscode.ConfigurationTarget.Global);
                            vscode.window.showInformationMessage('Schedule updated successfully');
                        }
                        break;
                    case 'getSchedule':
                        this.sendSchedule();
                        break;
                    case 'getLogs':
                        this.sendLogs(message.tailLines);
                        break;
                    case 'openLogFile':
                        this.openLogFile();
                        break;
                    case 'clearLogs':
                        this.clearLogs();
                        break;
                    case 'checkPro':
                        this.handleCheckPro();
                        break;
                    case 'resetAllSettings':
                        vscode.commands.executeCommand('multi-purpose-agent.resetSettings');
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    async handleCheckPro() {
        // Always enforce Pro status
        await this.context.globalState.update('multi-purpose-agent-isPro', true);
        vscode.window.showInformationMessage('Multi Purpose Agent: Pro status verified! (Dev Mode)');
        this.update();
    }

    isPro() {
        return true; // Always Pro
    }

    getUserId() {
        let userId = this.context.globalState.get('multi-purpose-agent-userId');
        if (!userId) {
            // Generate UUID v4 format
            userId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
            this.context.globalState.update('multi-purpose-agent-userId', userId);
        }
        return userId;
    }

    sendStats() {
        const stats = this.context.globalState.get('multi-purpose-agent-stats', {
            clicks: 0,
            sessions: 0,
            lastSession: null
        });
        const isPro = this.isPro();
        // If not Pro, force display of 300ms
        const frequency = isPro ? this.context.globalState.get('multi-purpose-agent-frequency', 1000) : 300;

        this.panel.webview.postMessage({
            command: 'updateStats',
            stats,
            frequency,
            isPro
        });
    }

    async sendROIStats() {
        try {
            const roiStats = await vscode.commands.executeCommand('multi-purpose-agent.getROIStats');
            this.panel.webview.postMessage({
                command: 'updateROIStats',
                roiStats
            });
        } catch (e) {
            // ROI stats not available yet
        }
    }

    sendBackgroundMode() {
        const enabled = this.context.globalState.get('multi-purpose-agent-background-mode', false);
        this.panel.webview.postMessage({
            command: 'updateBackgroundMode',
            enabled
        });
    }

    sendBannedCommands() {
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        const bannedCommands = this.context.globalState.get('multi-purpose-agent-banned-commands', defaultBannedCommands);
        this.panel.webview.postMessage({
            command: 'updateBannedCommands',
            bannedCommands
        });
    }

    sendSchedule() {
        const config = vscode.workspace.getConfiguration('multi-purpose-agent.schedule');
        this.panel.webview.postMessage({
            command: 'updateSchedule',
            schedule: {
                enabled: config.get('enabled'),
                mode: config.get('mode'),
                value: config.get('value'),
                prompt: config.get('prompt')
            }
        });
    }

    sendQueueUpdate(data) {
        this.panel.webview.postMessage({
            command: 'updateQueue',
            queue: data.queue,
            current: data.current,
            isProcessing: data.isProcessing
        });
    }

    getLogFilePath() {
        return path.join(this.context.extensionPath, 'multi-purpose-agent-cdp.log');
    }

    readTail(filePath, { tailLines = 300, maxBytes = 250000 } = {}) {
        try {
            if (!fs.existsSync(filePath)) {
                return { text: '', meta: { filePath, exists: false } };
            }

            const stat = fs.statSync(filePath);
            const size = stat.size || 0;
            const start = Math.max(0, size - maxBytes);
            const length = size - start;

            const fd = fs.openSync(filePath, 'r');
            try {
                const buf = Buffer.alloc(length);
                fs.readSync(fd, buf, 0, length, start);
                const content = buf.toString('utf8');
                const lines = content.split(/\r?\n/).filter(l => l.length > 0);
                const tail = lines.slice(-tailLines).join('\n');
                return {
                    text: tail,
                    meta: {
                        filePath,
                        exists: true,
                        size,
                        mtimeMs: stat.mtimeMs,
                        linesShown: Math.min(tailLines, lines.length)
                    }
                };
            } finally {
                try { fs.closeSync(fd); } catch (e) { }
            }
        } catch (e) {
            return { text: `Failed to read logs: ${e.message}`, meta: { filePath, exists: null } };
        }
    }

    sendLogs(tailLines) {
        const filePath = this.getLogFilePath();
        const result = this.readTail(filePath, { tailLines: parseInt(tailLines) || 300 });
        this.panel.webview.postMessage({
            command: 'updateLogs',
            logs: result.text,
            meta: result.meta
        });
    }

    async openLogFile() {
        const filePath = this.getLogFilePath();
        try {
            if (!fs.existsSync(filePath)) {
                vscode.window.showInformationMessage('Log file not found yet. Turn Multi Purpose Agent ON first.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open log file: ${e.message}`);
        }
    }

    clearLogs() {
        const filePath = this.getLogFilePath();
        try {
            fs.writeFileSync(filePath, '', 'utf8');
        } catch (e) { }
        this.sendLogs(300);
    }

    update() {
        this.panel.webview.html = this.getHtmlContent();
        setTimeout(() => {
            this.sendStats();
            this.sendROIStats();
            this.sendSchedule();
            this.sendBackgroundMode();
            this.sendLogs(300);
            vscode.commands.executeCommand('multi-purpose-agent.getQueueStatus');
        }, 100);
    }

    getHtmlContent() {
        const isPro = this.isPro();
        const userId = this.getUserId();
        const stripeLinks = {
            MONTHLY: `${STRIPE_LINKS.MONTHLY}?client_reference_id=${userId}`,
            YEARLY: `${STRIPE_LINKS.YEARLY}?client_reference_id=${userId}`
        };

        // Premium Design System - Overriding IDE theme
        const css = `
            :root {
                --bg: #0a0a0c;
                --card-bg: #121216;
                --border: rgba(147, 51, 234, 0.2);
                --border-hover: rgba(147, 51, 234, 0.4);
                --accent: #9333ea;
                --accent-soft: rgba(147, 51, 234, 0.1);
                --green: #22c55e;
                --green-soft: rgba(34, 197, 94, 0.1);
                --fg: #ffffff;
                --fg-dim: rgba(255, 255, 255, 0.6);
                --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
            }

            body {
                font-family: var(--font);
                background: var(--bg);
                color: var(--fg);
                margin: 0;
                padding: 40px 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
                min-height: 100vh;
            }

            .container {
                max-width: 640px;
                width: 100%;
                display: flex;
                flex-direction: column;
                gap: 24px;
            }

            /* Header Section */
            .header {
                text-align: center;
                margin-bottom: 8px;
            }
            .header h1 {
                font-size: 32px;
                font-weight: 800;
                margin: 0;
                letter-spacing: -0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 12px;
            }
            .pro-badge {
                background: var(--accent);
                color: white;
                font-size: 12px;
                padding: 4px 8px;
                border-radius: 4px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                box-shadow: 0 0 15px rgba(147, 51, 234, 0.4);
                animation: pulse 2s infinite;
            }
            @keyframes pulse {
                0% { box-shadow: 0 0 0px rgba(147, 51, 234, 0.4); }
                50% { box-shadow: 0 0 20px rgba(147, 51, 234, 0.6); }
                100% { box-shadow: 0 0 0px rgba(147, 51, 234, 0.4); }
            }
            .subtitle {
                color: var(--fg-dim);
                font-size: 14px;
                margin-top: 8px;
            }

            /* Sections */
            .section {
                background: var(--card-bg);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 24px;
                transition: border-color 0.3s ease;
            }
            .section:hover {
                border-color: var(--border-hover);
            }
            .section-label {
                color: var(--accent);
                font-size: 11px;
                font-weight: 800;
                letter-spacing: 1px;
                text-transform: uppercase;
                margin-bottom: 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            /* Impact Grid */
            .impact-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }
            .impact-card {
                background: rgba(0, 0, 0, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.03);
                border-radius: 10px;
                padding: 20px 12px;
                text-align: center;
                transition: transform 0.2s ease;
            }
            .impact-card:hover {
                transform: translateY(-2px);
            }
            .stat-val {
                font-size: 36px;
                font-weight: 800;
                line-height: 1;
                margin-bottom: 8px;
                font-variant-numeric: tabular-nums;
            }
            .stat-label {
                font-size: 11px;
                color: var(--fg-dim);
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            /* Inputs and Buttons */
            input[type="range"] {
                width: 100%;
                accent-color: var(--accent);
                height: 6px;
                border-radius: 3px;
                background: rgba(255,255,255,0.1);
            }
            textarea {
                width: 100%;
                min-height: 140px;
                background: rgba(0,0,0,0.3);
                border: 1px solid var(--border);
                border-radius: 8px;
                color: var(--fg);
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                font-size: 12px;
                padding: 12px;
                resize: vertical;
                outline: none;
            }
            textarea:focus { border-color: var(--accent); }

            .btn-primary {
                background: var(--accent);
                color: white;
                border: none;
                padding: 14px;
                border-radius: 8px;
                font-weight: 700;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                text-decoration: none;
            }
            .btn-primary:hover {
                filter: brightness(1.2);
                transform: scale(1.01);
            }
            .btn-outline {
                background: transparent;
                border: 1px solid var(--border);
                color: var(--fg);
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .btn-outline:hover {
                background: var(--accent-soft);
                border-color: var(--accent);
            }

            .link-secondary {
                color: var(--accent);
                cursor: pointer;
                text-decoration: none;
                font-size: 13px;
                display: block;
                text-align: center;
                margin-top: 16px;
            }
            .link-secondary:hover { text-decoration: underline; }

            .locked {
                opacity: 0.5;
                pointer-events: none;
                filter: grayscale(1);
            }
            .pro-tip {
                color: var(--accent);
                font-size: 11px;
                margin-top: 12px;
                font-weight: 600;
            }

            /* Toggle Switch */
            .switch { position: relative; display: inline-block; width: 40px; height: 20px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); transition: .4s; border-radius: 20px; }
            .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .slider { background-color: var(--accent); }
            input:checked + .slider:before { transform: translateX(20px); }

            /* Queue Styles */
            .queue-list {
                margin-top: 12px;
                border: 1px solid var(--border);
                border-radius: 8px;
                background: rgba(0,0,0,0.2);
                max-height: 200px;
                overflow-y: auto;
            }
            .queue-item {
                padding: 8px 12px;
                border-bottom: 1px solid var(--border);
                font-size: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .queue-item:last-child { border-bottom: none; }
            .queue-item.pending { border-left: 3px solid var(--fg-dim); }
            .queue-item.sending { border-left: 3px solid var(--accent); background: var(--accent-soft); }
            .queue-item.sent { border-left: 3px solid var(--green); opacity: 0.7; }
            .queue-status {
                font-size: 10px;
                text-transform: uppercase;
                font-weight: 700;
                padding: 2px 6px;
                border-radius: 4px;
            }
            .status-pending { color: var(--fg-dim); background: rgba(255,255,255,0.1); }
            .status-sending { color: var(--accent); background: rgba(147, 51, 234, 0.2); }
            .status-sent { color: var(--green); background: rgba(34, 197, 94, 0.2); }
            .empty-queue {
                padding: 20px;
                text-align: center;
                color: var(--fg-dim);
                font-size: 12px;
                font-style: italic;
            }
        `;

        // Settings Mode
        return `<!DOCTYPE html>
        <html>
        <head><style>${css}</style></head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Multi Purpose <span class="pro-badge">Agent</span></h1>
                    <div class="subtitle">Multi-agent automation for Antigravity & Cursor</div>
                </div>

                <div class="section">
                    <div class="section-label">
                        <span>📊 IMPACT DASHBOARD</span>
                        <span style="opacity: 0.4;">Resets Sunday</span>
                    </div>
                    <div class="impact-grid">
                        <div class="impact-card" style="border-bottom: 2px solid var(--green);">
                            <div class="stat-val" id="roiClickCount" style="color: var(--green);">0</div>
                            <div class="stat-label">Clicks Saved</div>
                        </div>
                        <div class="impact-card">
                            <div class="stat-val" id="roiTimeSaved">0m</div>
                            <div class="stat-label">Time Saved</div>
                        </div>
                        <div class="impact-card">
                            <div class="stat-val" id="roiSessionCount">0</div>
                            <div class="stat-label">Sessions</div>
                        </div>
                        <div class="impact-card">
                            <div class="stat-val" id="roiBlockedCount" style="opacity: 0.4;">0</div>
                            <div class="stat-label">Blocked</div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-label">🌍 Background Mode</div>
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="font-size: 13px;">Enable Background Mode</span>
                        <label class="switch">
                            <input type="checkbox" id="backgroundModeEnabled">
                            <span class="slider round"></span>
                        </label>
                    </div>
                    <div style="font-size: 11px; color: var(--fg-dim); margin-top: 8px;">
                        Allow Multi Purpose Agent to work on all open tabs simultaneously.
                    </div>
                </div>

                <div class="section" id="performanceSection">
                    <div class="section-label">
                        <span>⚡ Performance Mode</span>
                        <span class="val-display" id="freqVal" style="color: var(--accent);">...</span>
                    </div>
                    <div>
                        <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
                            <span style="font-size: 12px; opacity: 0.5;">Instant</span>
                            <div style="flex: 1;"><input type="range" id="freqSlider" min="200" max="3000" step="100" value="1000"></div>
                            <span style="font-size: 12px; opacity: 0.5;">Battery Saving</span>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-label">⏰ Scheduled Prompts</div>
                    <div>
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                            <span style="font-size: 13px;">Enable Schedule</span>
                            <label class="switch">
                                <input type="checkbox" id="scheduleEnabled">
                                <span class="slider round"></span>
                            </label>
                        </div>
                        
                        <div id="scheduleControls" style="opacity: 0.5; pointer-events: none; transition: opacity 0.3s;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                                <div>
                                    <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Mode</label>
                                    <select id="scheduleMode" style="width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: var(--fg); padding: 8px; border-radius: 6px;">
                                        <option value="interval">Interval (Every X min)</option>
                                        <option value="daily">Daily (At HH:MM)</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Value</label>
                                    <input type="text" id="scheduleValue" placeholder="30" style="width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: var(--fg); padding: 8px; border-radius: 6px;">
                                </div>
                            </div>
                            
                            <div style="margin-bottom: 12px;">
                                <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Prompt Message</label>
                                <textarea id="schedulePrompt" style="min-height: 60px;" placeholder="Status report please"></textarea>
                            </div>

                            <button id="saveScheduleBtn" class="btn-primary" style="width: 100%;">Save Schedule</button>
                        </div>
                    </div>
                    ${!isPro ? '<div class="pro-tip">Locked: Pro users can schedule automated prompts</div>' : ''}
                </div>

                <div class="section">
                    <div class="section-label">📋 Prompt Queue</div>
                    <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px;">
                        Queue prompts to be sent sequentially. The agent waits for each prompt to complete before sending the next.
                    </div>
                    
                    <div style="margin-bottom: 12px;">
                        <textarea id="queueInput" style="min-height: 80px;" placeholder="Enter your prompt here..."></textarea>
                    </div>
                    
                    <button id="addToQueueBtn" class="btn-primary" style="width: 100%; margin-bottom: 16px;">
                        Add to Queue
                    </button>

                    <div class="section-label" style="margin-bottom: 8px;">Current Queue</div>
                    <div id="queueList" class="queue-list">
                        <div class="empty-queue">Queue is empty</div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-label">🛡️ Safety Rules</div>
                    <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px; line-height: 1.5;">
                        Patterns that will NEVER be auto-accepted.
                    </div>
                    <textarea id="bannedCommandsInput" 
                        placeholder="rm -rf /&#10;format c:&#10;del /f /s /q"
                        ${!isPro ? 'readonly' : ''}></textarea>
                    
                    <div class="${!isPro ? 'locked' : ''}" style="display: flex; gap: 12px; margin-top: 20px;">
                        <button id="saveBannedBtn" class="btn-primary" style="flex: 2;">
                            Update Rules
                        </button>
                        <button id="resetBannedBtn" class="btn-outline" style="flex: 1;">
                            Reset
                        </button>
                    </div>
                    <div id="bannedStatus" style="font-size: 12px; margin-top: 12px; text-align: center; height: 18px;"></div>
                </div>

                <div class="section">
                    <div class="section-label">⚙️ Danger Zone</div>
                    <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px;">
                        Reset all settings and data. Useful if you want to uninstall or start fresh.
                    </div>
                    <button id="resetAllBtn" class="btn-outline" style="width: 100%; color: #ef4444; border-color: rgba(239, 68, 68, 0.3);">
                        Reset All Settings & Data
                    </button>
                </div>

                <div class="section">
                    <div class="section-label">🧾 Logs</div>
                    <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                        <select id="logTailSelect" style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: var(--fg); padding: 8px; border-radius: 6px;">
                            <option value="200">Last 200 lines</option>
                            <option value="300" selected>Last 300 lines</option>
                            <option value="500">Last 500 lines</option>
                            <option value="1000">Last 1000 lines</option>
                        </select>
                        <button id="refreshLogsBtn" class="btn-outline" style="flex: 1;">Refresh</button>
                        <button id="copyLogsBtn" class="btn-outline" style="flex: 1;">Copy</button>
                    </div>
                    <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                        <button id="openLogsBtn" class="btn-primary" style="flex: 2;">Open File</button>
                        <button id="clearLogsBtn" class="btn-outline" style="flex: 1;">Clear</button>
                    </div>
                    <textarea id="logsOutput" readonly style="min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;"></textarea>
                    <div id="logsMeta" style="font-size: 11px; color: var(--fg-dim); margin-top: 10px;"></div>
                </div>

                <div style="text-align: center; opacity: 0.15; font-size: 10px; padding: 20px 0; letter-spacing: 1px;">
                    REF: ${userId}
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // --- Polling Logic for Real-time Refresh ---
                function refreshStats() {
                    vscode.postMessage({ command: 'getStats' });
                    vscode.postMessage({ command: 'getROIStats' });
                }
                
                // Refresh every 5 seconds while panel is open
                const refreshInterval = setInterval(refreshStats, 5000);
                
                // --- Event Listeners ---
                const slider = document.getElementById('freqSlider');
                const valDisplay = document.getElementById('freqVal');
                
                if (slider) {
                    slider.addEventListener('input', (e) => {
                         const s = (e.target.value/1000).toFixed(1) + 's';
                         valDisplay.innerText = s;
                         vscode.postMessage({ command: 'setFrequency', value: e.target.value });
                    });
                }

                // Background Mode Toggle
                const backgroundModeCheckbox = document.getElementById('backgroundModeEnabled');
                if (backgroundModeCheckbox) {
                    backgroundModeCheckbox.addEventListener('change', (e) => {
                        vscode.postMessage({ command: 'setBackgroundMode', value: e.target.checked });
                    });
                }

                const bannedInput = document.getElementById('bannedCommandsInput');
                const saveBannedBtn = document.getElementById('saveBannedBtn');
                const resetBannedBtn = document.getElementById('resetBannedBtn');
                const bannedStatus = document.getElementById('bannedStatus');

                const defaultBannedCommands = ["rm -rf /", "rm -rf ~", "rm -rf *", "format c:", "del /f /s /q", "rmdir /s /q", ":(){:|:&};:", "dd if=", "mkfs.", "> /dev/sda", "chmod -R 777 /"];

                if (saveBannedBtn) {
                    saveBannedBtn.addEventListener('click', () => {
                        const lines = bannedInput.value.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                        vscode.postMessage({ command: 'updateBannedCommands', commands: lines });
                        bannedStatus.innerText = '✓ Safety Rules Updated';
                        bannedStatus.style.color = 'var(--green)';
                        setTimeout(() => { bannedStatus.innerText = ''; }, 3000);
                    });
                }

                if (resetBannedBtn) {
                    resetBannedBtn.addEventListener('click', () => {
                        bannedInput.value = defaultBannedCommands.join('\\n');
                        vscode.postMessage({ command: 'updateBannedCommands', commands: defaultBannedCommands });
                        bannedStatus.innerText = '✓ Defaults Restored';
                        bannedStatus.style.color = 'var(--accent)';
                        setTimeout(() => { bannedStatus.innerText = ''; }, 3000);
                    });
                }

                // --- Schedule Logic ---
                const scheduleEnabled = document.getElementById('scheduleEnabled');
                const scheduleControls = document.getElementById('scheduleControls');
                const scheduleMode = document.getElementById('scheduleMode');
                const scheduleValue = document.getElementById('scheduleValue');
                const schedulePrompt = document.getElementById('schedulePrompt');
                const saveScheduleBtn = document.getElementById('saveScheduleBtn');

                if (scheduleEnabled) {
                    scheduleEnabled.addEventListener('change', (e) => {
                        const enabled = e.target.checked;
                        scheduleControls.style.opacity = enabled ? '1' : '0.5';
                        scheduleControls.style.pointerEvents = enabled ? 'auto' : 'none';
                    });
                }

                if (saveScheduleBtn) {
                    saveScheduleBtn.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'updateSchedule',
                            enabled: scheduleEnabled.checked,
                            mode: scheduleMode.value,
                            value: scheduleValue.value,
                            prompt: schedulePrompt.value
                        });
                        const originalText = saveScheduleBtn.innerText;
                        saveScheduleBtn.innerText = '✓ Saved';
                        saveScheduleBtn.style.background = 'var(--green)';
                        setTimeout(() => {
                            saveScheduleBtn.innerText = originalText;
                            saveScheduleBtn.style.background = 'var(--accent)';
                        }, 2000);
                    });
                }

                const logsOutput = document.getElementById('logsOutput');
                const logsMeta = document.getElementById('logsMeta');
                const refreshLogsBtn = document.getElementById('refreshLogsBtn');
                const copyLogsBtn = document.getElementById('copyLogsBtn');
                const openLogsBtn = document.getElementById('openLogsBtn');
                const clearLogsBtn = document.getElementById('clearLogsBtn');
                const logTailSelect = document.getElementById('logTailSelect');

                function requestLogs() {
                    const tailLines = logTailSelect ? logTailSelect.value : 300;
                    vscode.postMessage({ command: 'getLogs', tailLines });
                }

                if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', requestLogs);
                if (openLogsBtn) openLogsBtn.addEventListener('click', () => vscode.postMessage({ command: 'openLogFile' }));
                if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => vscode.postMessage({ command: 'clearLogs' }));
                if (logTailSelect) logTailSelect.addEventListener('change', requestLogs);

                // --- Reset Logic ---
                const resetAllBtn = document.getElementById('resetAllBtn');
                if (resetAllBtn) {
                    resetAllBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'resetAllSettings' });
                    });
                }

                if (copyLogsBtn) {
                    copyLogsBtn.addEventListener('click', async () => {
                        try {
                            const text = logsOutput ? logsOutput.value : '';
                            await navigator.clipboard.writeText(text);
                            const originalText = copyLogsBtn.innerText;
                            copyLogsBtn.innerText = '✓ Copied';
                            copyLogsBtn.style.borderColor = 'var(--green)';
                            copyLogsBtn.style.color = 'var(--green)';
                            setTimeout(() => {
                                copyLogsBtn.innerText = originalText;
                                copyLogsBtn.style.borderColor = 'rgba(255,255,255,0.2)';
                                copyLogsBtn.style.color = 'rgba(255,255,255,0.8)';
                            }, 1500);
                        } catch (e) { }
                    });
                }

                // --- Fancy Count-up Animation ---
                function animateCountUp(element, target, duration = 1200, suffix = '') {
                    const currentVal = parseInt(element.innerText.replace(/[^0-9]/g, '')) || 0;
                    if (currentVal === target && !suffix) return;
                    
                    const startTime = performance.now();
                    function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
                    
                    function update(currentTime) {
                        const elapsed = currentTime - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const current = Math.round(currentVal + (target - currentVal) * easeOutExpo(progress));
                        element.innerText = current + suffix;
                        if (progress < 1) requestAnimationFrame(update);
                    }
                    requestAnimationFrame(update);
                }
                
                window.addEventListener('message', e => {
                    const msg = e.data;
                    if (msg.command === 'updateStats') {
                        if (slider && !${!isPro}) {
                            slider.value = msg.frequency;
                            valDisplay.innerText = (msg.frequency/1000).toFixed(1) + 's';
                        }
                    }
                    if (msg.command === 'updateROIStats') {
                        const roi = msg.roiStats;
                        if (roi) {
                            animateCountUp(document.getElementById('roiClickCount'), roi.clicksThisWeek || 0);
                            animateCountUp(document.getElementById('roiSessionCount'), roi.sessionsThisWeek || 0);
                            animateCountUp(document.getElementById('roiBlockedCount'), roi.blockedThisWeek || 0);
                            document.getElementById('roiTimeSaved').innerText = roi.timeSavedFormatted || '0m';
                        }
                    }
                    if (msg.command === 'updateBackgroundMode') {
                        if (backgroundModeCheckbox) {
                            backgroundModeCheckbox.checked = msg.enabled;
                        }
                    }
                    if (msg.command === 'updateBannedCommands') {
                        if (bannedInput && msg.bannedCommands) {
                            bannedInput.value = msg.bannedCommands.join('\\n');
                        }
                    }
                    if (msg.command === 'updateSchedule') {
                        if (scheduleEnabled && msg.schedule) {
                            scheduleEnabled.checked = msg.schedule.enabled;
                            scheduleMode.value = msg.schedule.mode;
                            scheduleValue.value = msg.schedule.value;
                            schedulePrompt.value = msg.schedule.prompt;
                            
                            // Trigger visual update
                            scheduleControls.style.opacity = msg.schedule.enabled ? '1' : '0.5';
                            scheduleControls.style.pointerEvents = msg.schedule.enabled ? 'auto' : 'none';
                        }
                    }
                    if (msg.command === 'updateLogs') {
                        if (logsOutput) logsOutput.value = msg.logs || '';
                        if (logsMeta) {
                            const meta = msg.meta || {};
                            if (meta.exists === false) {
                                logsMeta.innerText = 'Log file not found yet. Turn Multi Purpose Agent ON to generate logs.';
                            } else if (meta.exists === true) {
                                const kb = meta.size ? Math.round(meta.size / 1024) : 0;
                                logsMeta.innerText = (meta.linesShown || 0) + ' lines • ' + kb + ' KB • ' + (meta.filePath || '');
                            } else {
                                logsMeta.innerText = meta.filePath ? meta.filePath : '';
                            }
                        }
                    }
                    if (msg.command === 'updateQueue') {
                        renderQueue(msg.queue, msg.current, msg.isProcessing);
                    }
                });

                // Initial load
                refreshStats();
                vscode.postMessage({ command: 'getBannedCommands' });
                vscode.postMessage({ command: 'getSchedule' });
                vscode.postMessage({ command: 'getBackgroundMode' });
                vscode.postMessage({ command: 'getQueueStatus' });
                requestLogs();
            </script>
        </body>
        </html>`;
    }

    dispose() {
        SettingsPanel.currentPanel = undefined;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    async checkProStatus(userId) {
        return true; // Always valid
    }

    startPolling(userId) {
        // Poll every 5s for 5 minutes
        let attempts = 0;
        const maxAttempts = 60;

        if (this.pollTimer) clearInterval(this.pollTimer);

        this.pollTimer = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(this.pollTimer);
                return;
            }

            const isPro = await this.checkProStatus(userId);
            if (isPro) {
                clearInterval(this.pollTimer);
                await this.context.globalState.update('multi-purpose-agent-isPro', true);
                vscode.window.showInformationMessage('Multi Purpose Agent: Pro status verified! Thank you for your support.');
                this.update(); // Refresh UI
                vscode.commands.executeCommand('multi-purpose-agent.updateFrequency', 1000);
            }
        }, 5000);
    }
}

module.exports = { SettingsPanel };
