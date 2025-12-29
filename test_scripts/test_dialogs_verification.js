const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. MOCKING INFRASTRUCTURE ---

// Store original require to allow loading node modules
const originalRequire = Module.prototype.require;

// Mock Objects
const mockVscode = {
    window: {
        createStatusBarItem: () => ({ show: () => { }, hide: () => { }, text: '', tooltip: '', command: '' }),
        createOutputChannel: () => ({ appendLine: () => { } }),
        createWebviewPanel: () => ({
            webview: {
                onDidReceiveMessage: () => { },
                html: ''
            },
            onDidDispose: () => { },
            reveal: () => { }
        }),
        onDidChangeWindowState: () => ({ dispose: () => { } }),
        showInformationMessage: async (msg, options, ...items) => {
            mockVscode.lastInfoMsg = { msg, items };
            // Simulate user clicking the first button (usually the affirmative action)
            return items[0];
        },
        showWarningMessage: async (msg, options, ...items) => {
            mockVscode.lastWarnMsg = { msg, items };
            return items[0];
        },
        showErrorMessage: () => { },
        registerUriHandler: () => ({ dispose: () => { } })
    },
    commands: {
        registerCommand: (cmd, callback) => {
            mockVscode.commands.registry[cmd] = callback;
            return { dispose: () => { } };
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
    ThemeColor: class { },
    ConfigurationTarget: { Global: 1 }
};

// Mock internal modules to avoid side effects
const mockCdpHandler = {
    CDPHandler: class {
        constructor() {
            this.setProStatus = () => { };
            this.setLogFile = () => { };
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
        constructor() { }
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
Module.prototype.require = function (request) {
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
                // Bypass first-run detection (pretend we've run before)
                if (key === 'multi-purpose-agent-is-first-run-v1') return true;
                // Force version popup to show by returning false
                if (key === 'multi-purpose-agent-version-7.0-notification-shown') return false;
                // Force Pro status to true to test background toggle
                if (key === 'multi-purpose-agent-isPro') return true;
                // Force Background Dont Show to false
                if (key === 'multi-purpose-agent-background-dont-show') return false;
                // Force Background Mode to false initially so we can toggle it ON with dialog
                if (key === 'multi-purpose-agent-background-mode') return false;
                // Default enabled
                if (key === 'multi-purpose-agent-enabled-global') return true;

                return context.globalState.data[key] !== undefined ? context.globalState.data[key] : def;
            },
            update: (key, val) => {
                context.globalState.data[key] = val;
                return Promise.resolve();
            }
        },
        extensionPath: __dirname,
        extensionUri: {},
        extension: { id: 'test-extension-id' }
    };

    // --- TEST 1: Version Notification ---
    console.log('Test 1: Verifying Version Notification Options...');

    // Activate extension (triggering version check)
    await extension.activate(context);

    // Wait for async showVersionNotification to complete
    await new Promise(resolve => setTimeout(resolve, 100));

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
    await mockVscode.commands.registry['multi-purpose-agent.toggle']();

    const warnCall = mockVscode.lastWarnMsg;
    assert.ok(warnCall, 'Warning dialog should be shown when turning off');

    const warnOptions = warnCall.items;
    console.log('   Found options:', warnOptions);

    assert.ok(warnOptions.includes('Open Prompt Mode'), 'FAIL: Missing "Open Prompt Mode"');
    assert.ok(warnOptions.includes('View Dashboard'), 'FAIL: Missing "View Dashboard"');
    assert.ok(!warnOptions.includes('Cancel'), 'FAIL: "Cancel" button should be removed');

    console.log('✅ PASS: Turn off warning has correct options and no Cancel button.\n');


    // --- TEST 3: Background Mode Toggle (Pro users - silent toggle) ---
    console.log('Test 3: Verifying Background Mode Toggle...');

    // Ensure background mode is initially false
    context.globalState.data['multi-purpose-agent-background-mode'] = false;

    // Trigger background toggle
    await mockVscode.commands.registry['multi-purpose-agent.toggleBackground']();

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify state was toggled (Pro users get silent toggle, no dialog)
    assert.strictEqual(context.globalState.data['multi-purpose-agent-background-mode'], true, 'Background mode should be enabled');

    console.log('✅ PASS: Background mode toggles correctly for Pro users.\n');


    // --- TEST 4: Dialog Actions Verification ---
    console.log('Test 4: Verifying Dialog Actions...');

    // 4a. Verify "Open Prompt Mode" in Version Notification
    console.log('   4a. Version Notification -> Open Prompt Mode');
    mockVscode.window.showInformationMessage = async (msg, options, ...items) => "Open Prompt Mode"; // Simulate clicking "Open Prompt Mode"
    mockSettingsPanel.lastCall = null;

    // Reset notification state to allow it to show again
    context.globalState.data['multi-purpose-agent-version-7.0-notification-shown'] = false;

    // The previous attempt to wait for activate() failed because showVersionNotification is called without await
    // inside activate(). 
    // We will call the function logic directly via activate, but we need to ensure the promise chain resolves.

    // Let's modify the mock to resolve immediately but track the call
    let resolveDialog;
    const dialogPromise = new Promise(r => resolveDialog = r);

    mockVscode.window.showInformationMessage = async (msg, options, ...items) => {
        resolveDialog();
        return "Open Prompt Mode";
    };

    await extension.activate(context);
    await dialogPromise; // Wait for dialog to be shown/resolved
    await new Promise(resolve => setTimeout(resolve, 50)); // Wait for subsequent logic

    assert.strictEqual(mockSettingsPanel.lastCall, 'createOrShow', 'SettingsPanel.createOrShow should be called');

    // 4b. Verify "Enable Background Mode" in Version Notification
    console.log('   4b. Version Notification -> Enable Background Mode');
    // Reset state to force notification again (though in real code it checks globalState)
    context.globalState.data['multi-purpose-agent-version-7.0-notification-shown'] = false;
    context.globalState.data['multi-purpose-agent-background-mode'] = false; // Start disabled

    mockVscode.window.showInformationMessage = async (msg, options, ...items) => "Enable Background Mode";
    await extension.activate(context);
    await new Promise(resolve => setTimeout(resolve, 100)); // Increase wait time

    // Check if background mode was enabled
    assert.strictEqual(context.globalState.data['multi-purpose-agent-background-mode'], true, 'Background mode should be enabled');

    // 4c. Verify "Open Prompt Mode" in Turn Off Warning
    console.log('   4c. Turn Off Warning -> Open Prompt Mode');
    mockVscode.window.showWarningMessage = async (msg, options, ...items) => "Open Prompt Mode";
    mockSettingsPanel.lastCall = null;

    // Trigger toggle (which shows warning if enabled)
    context.globalState.data['multi-purpose-agent-enabled-global'] = true;
    await mockVscode.commands.registry['multi-purpose-agent.toggle']();
    await new Promise(resolve => setTimeout(resolve, 100)); // Increase wait time

    assert.strictEqual(mockSettingsPanel.lastCall, 'createOrShow', 'SettingsPanel should be opened');

    console.log('✅ PASS: All dialog actions trigger correct logic.\n');

    // --- TEST 5: ROI Stats Command ---
    console.log('Test 5: Verifying ROI Stats Command...');

    // Calculate week start to match extension logic and prevent reset
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    const expectedWeekStart = weekStart.getTime();

    // Mock ROI stats in global state
    context.globalState.data['multi-purpose-agent-roi-stats'] = {
        weekStart: expectedWeekStart,
        clicksThisWeek: 12, // 12 * 5s = 60s = 1 minute
        blockedThisWeek: 2,
        sessionsThisWeek: 1
    };

    const roiStats = await mockVscode.commands.registry['multi-purpose-agent.getROIStats']();
    console.log('   ROI Stats:', roiStats);

    assert.strictEqual(roiStats.clicksThisWeek, 12);
    assert.strictEqual(roiStats.timeSavedMinutes, 1);
    assert.strictEqual(roiStats.timeSavedFormatted, '1 minutes');

    console.log('✅ PASS: ROI Stats calculated correctly.\n');

    // --- TEST 6: Banned Commands (Pro Feature) ---
    console.log('Test 6: Verifying Banned Commands Update...');

    // Ensure Pro is enabled
    context.globalState.data['multi-purpose-agent-isPro'] = true;

    const newBanned = ['rm -rf /important', 'format c:'];
    await mockVscode.commands.registry['multi-purpose-agent.updateBannedCommands'](newBanned);

    const storedBanned = context.globalState.data['multi-purpose-agent-banned-commands'];
    assert.deepStrictEqual(storedBanned, newBanned, 'Banned commands should be updated in global state');

    console.log('✅ PASS: Banned commands updated successfully.\n');

    // --- TEST 7: Session Summary Notification ---
    console.log('Test 7: Verifying Session Summary Notification...');

    // Reset warning mock to allow turning off
    mockVscode.window.showWarningMessage = async (msg, options, ...items) => "Turn Off";

    // Mock CDP session summary via prototype since instance is already created
    mockCdpHandler.CDPHandler.prototype.getSessionSummary = async () => ({
        clicks: 5,
        terminalCommands: 2,
        fileEdits: 1,
        blocked: 0,
        estimatedTimeSaved: 0.5
    });

    // Reset notification mock
    mockVscode.lastInfoMsg = null;
    mockVscode.window.showInformationMessage = async (msg, options, ...items) => {
        mockVscode.lastInfoMsg = { msg, items };
        return items[0];
    };

    // Turn OFF extension (triggers summary)
    context.globalState.data['multi-purpose-agent-enabled-global'] = true;
    // We need to set internal isEnabled to true first via activate or just assume toggle flips it.
    // Since we called activate() earlier, isEnabled should be true from Test 1/2?
    // Actually handleToggle toggles the internal variable.
    // Let's force it to be ON first.
    // But we can't easily set the internal `isEnabled` variable of extension.js from here.
    // We have to rely on `toggle` logic.
    // If it's currently OFF (from Test 2), we toggle ON, then OFF.

    // Let's toggle ON first
    await mockVscode.commands.registry['multi-purpose-agent.toggle'](); // ON

    // Now toggle OFF to trigger summary
    await mockVscode.commands.registry['multi-purpose-agent.toggle'](); // OFF (triggers summary)

    // Wait for async summary
    await new Promise(resolve => setTimeout(resolve, 50));

    const summaryCall = mockVscode.lastInfoMsg;
    assert.ok(summaryCall, 'Session summary should be shown when turning off');
    assert.ok(summaryCall.msg.includes('5 actions handled'), 'Summary should mention click count');

    console.log('✅ PASS: Session summary notification shown.\n');

    console.log('🎉 ALL TESTS PASSED!');
    process.exit(0);
}

runTests().catch(e => {
    console.error('❌ TEST FAILED:', e);
    process.exit(1);
});
