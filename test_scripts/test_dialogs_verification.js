const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. MOCKING INFRASTRUCTURE ---

// Store original require to allow loading node modules
const originalRequire = Module.prototype.require;

// Mock Objects
const mockVscode = {
    window: {
        createStatusBarItem: () => ({ show: () => {}, hide: () => {}, text: '', tooltip: '', command: '' }),
        createOutputChannel: () => ({ appendLine: () => {} }),
        createWebviewPanel: () => ({
            webview: { 
                onDidReceiveMessage: () => {},
                html: ''
            },
            onDidDispose: () => {},
            reveal: () => {}
        }),
        onDidChangeWindowState: () => ({ dispose: () => {} }),
        showInformationMessage: async (msg, options, ...items) => {
            mockVscode.lastInfoMsg = { msg, items };
            // Simulate user clicking the first button (usually the affirmative action)
            return items[0]; 
        },
        showWarningMessage: async (msg, options, ...items) => {
             mockVscode.lastWarnMsg = { msg, items };
             return items[0];
        },
        showErrorMessage: () => {}
    },
    commands: {
        registerCommand: (cmd, callback) => {
            mockVscode.commands.registry[cmd] = callback;
            return { dispose: () => {} };
        },
        registry: {},
        executeCommand: () => Promise.resolve()
    },
    workspace: {
        getConfiguration: () => ({
            get: (key, def) => def,
            update: () => Promise.resolve()
        })
    },
    env: { appName: 'Code' },
    StatusBarAlignment: { Right: 1 },
    Uri: { joinPath: () => ({ fsPath: '' }) },
    ViewColumn: { One: 1 },
    ThemeColor: class {},
    ConfigurationTarget: { Global: 1 }
};

// Mock internal modules to avoid side effects
const mockCdpHandler = {
    CDPHandler: class {
        constructor() { 
            this.setProStatus = () => {};
            this.setLogFile = () => {};
        }
        isCDPAvailable() { return Promise.resolve(true); }
        start() { return Promise.resolve(); }
        stop() { return Promise.resolve(); }
        getAwayActions() { return Promise.resolve(0); }
        getConnectionCount() { return 1; }
        resetStats() { return Promise.resolve({ clicks: 0, blocked: 0 }); }
        getSessionSummary() { return Promise.resolve({ clicks: 0 }); }
    }
};

const mockRelauncher = {
    Relauncher: class {
        constructor() {}
    },
    BASE_CDP_PORT: 9000
};

const mockSettingsPanel = {
    SettingsPanel: class {
        static createOrShow() {
            mockSettingsPanel.lastCall = 'createOrShow';
        }
    }
};

// Hook require
Module.prototype.require = function(request) {
    if (request === 'vscode') return mockVscode;
    if (request.includes('cdp-handler')) return mockCdpHandler;
    if (request.includes('relauncher')) return mockRelauncher;
    // We want the real settings-panel to load if we want to test it, 
    // but here we just want to verify extension.js calls it.
    // However, extension.js lazy loads it using require('./settings-panel').
    // Let's allow it to load but since it requires vscode, it will get our mock.
    // actually, let's mock it to verify calls easily.
    if (request.endsWith('settings-panel') || request.endsWith('settings-panel.js')) return mockSettingsPanel;
    
    return originalRequire.apply(this, arguments);
};

// --- 2. LOAD EXTENSION ---
const extension = require('../extension.js');

// --- 3. TEST SUITE ---
async function runTests() {
    console.log('🚀 Starting Dialog Verification Tests...\n');
    
    const context = {
        subscriptions: [],
        globalState: {
            data: {},
            get: (key, def) => {
                // Force version popup to show by returning false
                if (key === 'auto-accept-version-7.0-notification-shown') return false;
                // Force Pro status to true to test background toggle
                if (key === 'auto-accept-isPro') return true;
                // Force Background Dont Show to false
                if (key === 'auto-accept-background-dont-show') return false;
                // Force Background Mode to false initially so we can toggle it ON with dialog
                if (key === 'auto-accept-background-mode') return false;
                // Default enabled
                if (key === 'auto-accept-enabled-global') return true;
                
                return context.globalState.data[key] !== undefined ? context.globalState.data[key] : def;
            },
            update: (key, val) => {
                context.globalState.data[key] = val;
                return Promise.resolve();
            }
        },
        extensionPath: __dirname,
        extensionUri: {}
    };

    // --- TEST 1: Version Notification ---
    console.log('Test 1: Verifying Version Notification Options...');
    
    // Activate extension (triggering version check)
    await extension.activate(context);
    
    const infoCall = mockVscode.lastInfoMsg;
    assert.ok(infoCall, 'Version notification should be shown on activation');
    
    const versionOptions = infoCall.items;
    console.log('   Found options:', versionOptions);
    
    assert.ok(versionOptions.includes('Open Prompt Mode'), 'FAIL: Missing "Open Prompt Mode"');
    assert.ok(versionOptions.includes('Enable Background Mode'), 'FAIL: Missing "Enable Background Mode"');
    assert.ok(versionOptions.includes('View Dashboard'), 'FAIL: Missing "View Dashboard"');
    
    console.log('✅ PASS: Version notification has all required options.\n');


    // --- TEST 2: Turn Off Warning Dialog ---
    console.log('Test 2: Verifying Turn Off Warning Options...');
    
    // Reset mock state
    mockVscode.lastWarnMsg = null;
    
    // Trigger toggle command (turning OFF)
    await mockVscode.commands.registry['auto-accept.toggle']();
    
    const warnCall = mockVscode.lastWarnMsg;
    assert.ok(warnCall, 'Warning dialog should be shown when turning off');
    
    const warnOptions = warnCall.items;
    console.log('   Found options:', warnOptions);
    
    assert.ok(warnOptions.includes('Open Prompt Mode'), 'FAIL: Missing "Open Prompt Mode"');
    assert.ok(warnOptions.includes('View Dashboard'), 'FAIL: Missing "View Dashboard"');
    assert.ok(!warnOptions.includes('Cancel'), 'FAIL: "Cancel" button should be removed');
    
    console.log('✅ PASS: Turn off warning has correct options and no Cancel button.\n');


    // --- TEST 3: Background Mode Dialog ---
    console.log('Test 3: Verifying Background Mode Dialog Options...');
    
    // Reset mock state
    mockVscode.lastInfoMsg = null;
    
    // Trigger background toggle
    await mockVscode.commands.registry['auto-accept.toggleBackground']();
    
    const bgCall = mockVscode.lastInfoMsg;
    assert.ok(bgCall, 'Background mode dialog should be shown');
    
    const bgOptions = bgCall.items;
    console.log('   Found options:', bgOptions);
    
    assert.ok(bgOptions.includes('Enable'), 'FAIL: Missing "Enable"');
    assert.ok(bgOptions.includes("Don't Show Again & Enable"), 'FAIL: Missing "Don\'t Show Again"');
    assert.ok(!bgOptions.includes('Cancel'), 'FAIL: "Cancel" button should be removed');
    
    console.log('✅ PASS: Background mode dialog has correct options and no Cancel button.\n');

    console.log('🎉 ALL TESTS PASSED!');
}

runTests().catch(e => {
    console.error('❌ TEST FAILED:', e);
    process.exit(1);
});
