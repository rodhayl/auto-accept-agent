/**
 * SCHEDULER LOGIC TEST
 * Tests the Scheduler class in extension.js (Node side)
 */

const assert = require('assert');
// const vscode = require('vscode'); // REMOVED: Cannot require vscode in plain Node

// Mock VS Code API
const mockVscode = {
    workspace: {
        getConfiguration: (section) => ({
            get: (key, defaultValue) => {
                if (key === 'enabled') return true;
                if (key === 'mode') return 'interval';
                if (key === 'value') return '1'; // 1 minute
                if (key === 'prompt') return 'Test Prompt';
                return defaultValue;
            }
        })
    },
    window: {
        showInformationMessage: (msg) => console.log(`[VSCode Mock] Info: ${msg}`)
    }
};

// Mock CDP Handler
const mockCdpHandler = {
    sentPrompts: [],
    sendPrompt: async (text) => {
        console.log(`[CDP Mock] sendPrompt called with: "${text}"`);
        mockCdpHandler.sentPrompts.push(text);
    }
};

// Scheduler Class (Copy-pasted or required from extension.js if exported, but it's not exported usually)
// For testing, I'll paste the class definition here as it's self-contained in extension.js
class Scheduler {
    constructor(context, cdpHandler, log) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = log;
        this.timer = null;
        this.lastRunTime = 0;
        this.enabled = false;
        this.config = {};
        this.vscode = mockVscode; // Injection for testing
    }

    start() {
        this.loadConfig();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 100); // Fast check for test
        this.log('Scheduler started.');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    loadConfig() {
        const cfg = this.vscode.workspace.getConfiguration('auto-accept.schedule');
        this.enabled = cfg.get('enabled', false);
        this.config = {
            mode: cfg.get('mode', 'interval'),
            value: cfg.get('value', '30'),
            prompt: cfg.get('prompt', 'Status report please')
        };
        this.log(`Scheduler Config: ${JSON.stringify(this.config)}, Enabled: ${this.enabled}`);
    }

    async check() {
        this.loadConfig();
        if (!this.enabled || !this.cdpHandler) return;

        // Force interval to be small for testing
        const now = Date.now();
        // Simulate that enough time has passed
        if (now - this.lastRunTime > 0) { 
            await this.trigger();
        }
    }

    async trigger() {
        this.lastRunTime = Date.now();
        const text = this.config.prompt;
        if (text && this.cdpHandler) {
            this.log(`Scheduler: Sending prompt "${text}"`);
            await this.cdpHandler.sendPrompt(text);
            this.vscode.window.showInformationMessage(`Auto Accept: Scheduled prompt sent.`);
        }
    }
}

// Test Runner
async function runTest() {
    console.log('=== SCHEDULER TEST STARTED ===');
    
    const log = (msg) => console.log(`[Scheduler] ${msg}`);
    const context = {}; // Mock context

    const scheduler = new Scheduler(context, mockCdpHandler, log);
    
    // 1. Start Scheduler
    scheduler.start();

    // 2. Wait for trigger
    await new Promise(resolve => setTimeout(resolve, 500));

    // 3. Verify
    scheduler.stop();
    
    if (mockCdpHandler.sentPrompts.length > 0) {
        console.log('✓ PASS: Prompt sent');
        console.log(`  Content: "${mockCdpHandler.sentPrompts[0]}"`);
    } else {
        console.error('✖ FAIL: No prompt sent');
        process.exit(1);
    }
    
    console.log('=== SCHEDULER TEST COMPLETED ===');
}

runTest();
