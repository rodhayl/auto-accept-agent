const vscode = require('vscode');
const { STRIPE_LINKS } = require('./config');

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
            // If requesting prompt mode but panel is open, reveal it and update mode
            SettingsPanel.currentPanel.panel.reveal(column);
            SettingsPanel.currentPanel.updateMode(mode);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            mode === 'prompt' ? 'Auto Accept Agent' : 'Auto Accept Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context, mode);
    }

    static showUpgradePrompt(context) {
        SettingsPanel.createOrShow(context.extensionUri, context, 'prompt');
    }

    constructor(panel, extensionUri, context, mode) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.context = context;
        this.mode = mode; // 'settings' | 'prompt'
        this.disposables = [];

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'setFrequency':
                        if (this.isPro()) {
                            await this.context.globalState.update('auto-accept-frequency', message.value);
                            vscode.commands.executeCommand('auto-accept.updateFrequency', message.value);
                        }
                        break;
                    case 'getStats':
                        this.sendStats();
                        break;
                    case 'getROIStats':
                        this.sendROIStats();
                        break;
                    case 'updateBannedCommands':
                        if (this.isPro()) {
                            await this.context.globalState.update('auto-accept-banned-commands', message.commands);
                            vscode.commands.executeCommand('auto-accept.updateBannedCommands', message.commands);
                        }
                        break;
                    case 'getBannedCommands':
                        this.sendBannedCommands();
                        break;
                    case 'updateSchedule':
                        if (this.isPro()) {
                            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
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
                    case 'upgrade':
                        // Existing upgrade logic (maybe from Settings mode)
                        // For prompt mode, links are direct <a> tags usually, but if we need logic:
                        this.openUpgrade(message.promoCode); // Keeps existing logic for legacy/settings
                        this.startPolling(this.getUserId());
                        break;
                    case 'checkPro':
                        this.handleCheckPro();
                        break;
                    case 'dismissPrompt':
                        await this.handleDismiss();
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    async handleDismiss() {
        // Persist dismissal timestamp
        const now = Date.now();
        await this.context.globalState.update('auto-accept-lastDismissedAt', now);
        this.dispose();
    }

    async handleCheckPro() {
        const isPro = await this.checkProStatus(this.getUserId());
        if (isPro) {
            await this.context.globalState.update('auto-accept-isPro', true);
            vscode.window.showInformationMessage('Auto Accept: Pro status verified!');
            this.update();
        } else {
            // New: Downgrade logic if check fails (e.g. subscription cancelled)
            await this.context.globalState.update('auto-accept-isPro', false);
            vscode.window.showWarningMessage('Pro license not found. Standard limits applied.');
            this.update();
        }
    }

    isPro() {
        return this.context.globalState.get('auto-accept-isPro', false);
    }

    getUserId() {
        let userId = this.context.globalState.get('auto-accept-userId');
        if (!userId) {
            // Generate UUID v4 format
            userId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
            this.context.globalState.update('auto-accept-userId', userId);
        }
        return userId;
    }

    openUpgrade(promoCode) {
        // Fallback legacy method or used by Settings
        // We might not need this if we use direct links, but keeping for compatibility
    }

    updateMode(mode) {
        this.mode = mode;
        this.panel.title = mode === 'prompt' ? 'Auto Accept Agent' : 'Auto Accept Settings';
        this.update();
    }

    sendStats() {
        const stats = this.context.globalState.get('auto-accept-stats', {
            clicks: 0,
            sessions: 0,
            lastSession: null
        });
        const isPro = this.isPro();
        // If not Pro, force display of 300ms
        const frequency = isPro ? this.context.globalState.get('auto-accept-frequency', 1000) : 300;

        this.panel.webview.postMessage({
            command: 'updateStats',
            stats,
            frequency,
            isPro
        });
    }

    async sendROIStats() {
        try {
            const roiStats = await vscode.commands.executeCommand('auto-accept.getROIStats');
            this.panel.webview.postMessage({
                command: 'updateROIStats',
                roiStats
            });
        } catch (e) {
            // ROI stats not available yet
        }
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
        const bannedCommands = this.context.globalState.get('auto-accept-banned-commands', defaultBannedCommands);
        this.panel.webview.postMessage({
            command: 'updateBannedCommands',
            bannedCommands
        });
    }

    sendSchedule() {
        const config = vscode.workspace.getConfiguration('auto-accept.schedule');
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

    update() {
        this.panel.webview.html = this.getHtmlContent();
        setTimeout(() => {
            this.sendStats();
            this.sendROIStats();
            this.sendSchedule();
        }, 100);
    }

    getHtmlContent() {
        const isPro = this.isPro();
        const isPrompt = this.mode === 'prompt';
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
                max-width: ${isPrompt ? '500px' : '640px'};
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

            .prompt-card {
                background: var(--card-bg);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 32px;
                text-align: center;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            }
            .prompt-title { font-size: 20px; font-weight: 800; margin-bottom: 12px; letter-spacing: -0.5px; }
            .prompt-text { font-size: 15px; color: var(--fg-dim); line-height: 1.6; margin-bottom: 24px; }
            
            /* Toggle Switch */
            .switch { position: relative; display: inline-block; width: 40px; height: 20px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); transition: .4s; border-radius: 20px; }
            .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .slider { background-color: var(--accent); }
            input:checked + .slider:before { transform: translateX(20px); }
        `;

        if (isPrompt) {
            return `<!DOCTYPE html>
            <html>
            <head><style>${css}</style></head>
            <body>
                <div class="container">
                    <div class="prompt-card">
                        <div style="font-size: 32px; margin-bottom: 20px;">⏸️</div>
                        <div class="prompt-title">Workflow Paused</div>
                        <div class="prompt-text">
                            Your Antigravity agent is waiting for approval.<br/><br/>
                            <strong style="color: var(--accent); opacity: 1;">Pro users auto-resume 94% of these interruptions.</strong>
                        </div>
                        <a href="${stripeLinks.MONTHLY}" class="btn-primary" style="margin-bottom: 12px;">
                            🚀 Unlock Auto-Recovery — $5/mo
                        </a>
                        <a href="${stripeLinks.YEARLY}" class="btn-primary" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">
                            Annual Plan — $29/year
                        </a>

                        <a class="link-secondary" onclick="dismiss()" style="margin-top: 24px; opacity: 0.6;">
                            Continue manually for now
                        </a>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    function dismiss() {
                        vscode.postMessage({ command: 'dismissPrompt' });
                    }
                </script>
            </body>
            </html>`;
        }

        // Settings Mode
        return `<!DOCTYPE html>
        <html>
        <head><style>${css}</style></head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Auto Accept <span class="pro-badge">Pro</span></h1>
                    <div class="subtitle">Multi-agent automation for Antigravity & Cursor</div>
                </div>

                ${!isPro ? `
                <div class="section" style="background: var(--accent-soft); border-color: var(--accent); position: relative; overflow: hidden;">
                    <div style="position: absolute; top: -20px; right: -20px; font-size: 80px; opacity: 0.05; transform: rotate(15deg);">🚀</div>
                    <div class="section-label" style="color: white; margin-bottom: 12px; font-size: 14px;">🔥 Upgrade to Pro</div>
                    <div style="font-size: 14px; line-height: 1.6; margin-bottom: 24px; color: rgba(255,255,255,0.9);">
                        Automate up to 5 agents in parallel. Join 500+ devs saving hours every week.
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <a href="${stripeLinks.MONTHLY}" class="btn-primary">
                            $5 / Month
                        </a>
                        <a href="${stripeLinks.YEARLY}" class="btn-primary" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">
                            $29 / Year
                        </a>
                    </div>
                </div>
                ` : ''}

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

                <div class="section" id="performanceSection">
                    <div class="section-label">
                        <span>⚡ Performance Mode</span>
                        <span class="val-display" id="freqVal" style="color: var(--accent);">...</span>
                    </div>
                    <div class="${!isPro ? 'locked' : ''}">
                        <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
                            <span style="font-size: 12px; opacity: 0.5;">Instant</span>
                            <div style="flex: 1;"><input type="range" id="freqSlider" min="200" max="3000" step="100" value="1000"></div>
                            <span style="font-size: 12px; opacity: 0.5;">Battery Saving</span>
                        </div>
                    </div>
                    ${!isPro ? '<div class="pro-tip">Locked: Pro users get 200ms ultra-low latency mode</div>' : ''}
                </div>

                <div class="section">
                    <div class="section-label">⏰ Scheduled Prompts</div>
                    <div class="${!isPro ? 'locked' : ''}">
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
                });

                // Initial load
                refreshStats();
                vscode.postMessage({ command: 'getBannedCommands' });
                vscode.postMessage({ command: 'getSchedule' });
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
        return new Promise((resolve) => {
            const https = require('https');
            https.get(`${LICENSE_API}/verify?userId=${userId}`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.isPro === true);
                    } catch (e) {
                        resolve(false);
                    }
                });
            }).on('error', () => resolve(false));
        });
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
                await this.context.globalState.update('auto-accept-isPro', true);
                vscode.window.showInformationMessage('Auto Accept: Pro status verified! Thank you for your support.');
                this.update(); // Refresh UI
                vscode.commands.executeCommand('auto-accept.updateFrequency', 1000);
            }
        }, 5000);
    }
}

module.exports = { SettingsPanel };
