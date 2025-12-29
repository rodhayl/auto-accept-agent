const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// states

const GLOBAL_STATE_KEY = 'multi-purpose-agent-enabled-global';
const PRO_STATE_KEY = 'multi-purpose-agent-isPro';
const FREQ_STATE_KEY = 'multi-purpose-agent-frequency';
const BANNED_COMMANDS_KEY = 'multi-purpose-agent-banned-commands';
const ROI_STATS_KEY = 'multi-purpose-agent-roi-stats'; // For ROI notification
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per auto-accept
const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';
// Locking
const LOCK_KEY = 'multi-purpose-agent-instance-lock';
const HEARTBEAT_KEY = 'multi-purpose-agent-instance-heartbeat';
const INSTANCE_ID = Math.random().toString(36).substring(7);

let isEnabled = false;
let isPro = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free
let bannedCommands = []; // List of command patterns to block

// Background Mode state
let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = 'multi-purpose-agent-background-dont-show';
const BACKGROUND_MODE_KEY = 'multi-purpose-agent-background-mode';
const VERSION_7_0_KEY = 'multi-purpose-agent-version-7.0-notification-shown';
const STARTUP_SETUP_PROMPT_KEY = 'multi-purpose-agent-startup-setup-prompt-last';
const STARTUP_SETUP_PROMPT_COOLDOWN_MS = 1000 * 60 * 60 * 24;

// --- Scheduler Class ---
class Scheduler {
    constructor(context, cdpHandler, log) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = log;
        this.timer = null;
        this.lastRunTime = 0;
        this.enabled = false;
        this.config = {};
        this.promptQueue = Promise.resolve(); // Queue for prompt serialization
    }

    start() {
        this.loadConfig();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 60000); // Check every minute
        this.log('Scheduler started.');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    loadConfig() {
        const cfg = vscode.workspace.getConfiguration('multi-purpose-agent.schedule');
        this.enabled = cfg.get('enabled', false);
        this.config = {
            mode: cfg.get('mode', 'interval'),
            value: cfg.get('value', '30'),
            prompt: cfg.get('prompt', 'Status report please')
        };
        this.log(`Scheduler Config: ${JSON.stringify(this.config)}, Enabled: ${this.enabled}`);
    }

    async check() {
        // Reload config to catch changes dynamically
        this.loadConfig();

        if (!this.enabled || !this.cdpHandler) return;

        const now = new Date();
        const mode = this.config.mode;
        const val = this.config.value;

        if (mode === 'interval') {
            const minutes = parseInt(val) || 30;
            const ms = minutes * 60 * 1000;
            if (Date.now() - this.lastRunTime > ms) {
                this.log(`Scheduler: Interval triggered (${minutes}m)`);
                await this.trigger();
            }
        } else if (mode === 'daily') {
            const [targetH, targetM] = val.split(':').map(Number);
            if (now.getHours() === targetH && now.getMinutes() === targetM) {
                // Debounce: prevent running multiple times in the same minute
                if (Date.now() - this.lastRunTime > 60000) {
                    this.log(`Scheduler: Daily triggered (${val})`);
                    await this.trigger();
                }
            }
        }
    }

    async queuePrompt(text) {
        // Chain the new trigger to the end of the queue to ensure serialization
        this.promptQueue = this.promptQueue.then(async () => {
            this.lastRunTime = Date.now();
            if (text && this.cdpHandler) {
                this.log(`Scheduler: Sending prompt "${text}"`);
                await this.cdpHandler.sendPrompt(text);
                vscode.window.showInformationMessage(`Multi Purpose Agent: Scheduled prompt sent.`);
            }
        }).catch(err => {
            this.log(`Scheduler Error: ${err.message}`);
        });

        return this.promptQueue;
    }

    async trigger() {
        const text = this.config.prompt;
        return this.queuePrompt(text);
    }
}

let pollTimer;
let statsCollectionTimer; // For periodic stats collection
let scheduler; // Scheduler instance
let statusBarItem;
let statusSettingsItem;
let statusBackgroundItem; // New: Background Mode toggle
let outputChannel;
let currentIDE = 'unknown'; // 'cursor' | 'antigravity'
let globalContext;
let lastStatusText = ''; // For tracking status changes

// Handlers (used by both IDEs now)
let cdpHandler;
let relauncher;

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);

        // Write to global log file for Settings Panel visibility
        if (globalContext) {
            const logPath = path.join(globalContext.extensionPath, 'multi-purpose-agent-cdp.log');
            try {
                fs.appendFileSync(logPath, `${logLine}\n`, 'utf8');
            } catch (e) {
                // Ignore file write errors to prevent loop
            }
        }
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // only supporting these 3 for now
}

const IS_FIRST_RUN_KEY = 'multi-purpose-agent-is-first-run-v1';

async function activate(context) {
    globalContext = context;
    console.log('Multi Purpose Agent Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'multi-purpose-agent.toggle';
        statusBarItem.text = '$(sync~spin) MPA: Loading...';
        statusBarItem.tooltip = 'Multi Purpose Agent is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'multi-purpose-agent.openSettings';
        statusSettingsItem.text = '$(gear)';
        statusSettingsItem.tooltip = 'Multi Purpose Agent Settings & Pro Features';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Background Mode status bar item
        statusBackgroundItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        statusBackgroundItem.command = 'multi-purpose-agent.toggleBackground';
        statusBackgroundItem.text = '$(globe) Background: OFF';
        statusBackgroundItem.tooltip = 'Background Mode (Pro) - Works on all chats';
        context.subscriptions.push(statusBackgroundItem);
        // Don't show by default - only when Agent is ON

        console.log('Multi Purpose Agent: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        // Check for fresh install/first run
        const isFirstRun = !context.globalState.get(IS_FIRST_RUN_KEY, false);

        if (isFirstRun) {
            // Force OFF on first run
            isEnabled = false;
            await context.globalState.update(GLOBAL_STATE_KEY, false);
            await context.globalState.update(IS_FIRST_RUN_KEY, true);

            // Prompt for restart
            vscode.window.showInformationMessage(
                "Multi Purpose Agent installed! Please restart the IDE to complete setup.",
                "Restart IDE"
            ).then(selection => {
                if (selection === "Restart IDE") {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            });
        } else {
            isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);
        }

        isPro = true;

        // Load frequency
        pollFrequency = context.globalState.get(FREQ_STATE_KEY, 2000);

        // Load background mode state
        backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);


        // 1.5 Verify License Background Check
        // verifyLicense(context).then(isValid => { ... });
        log('License verification skipped (Dev Mode: All Features Enabled)');

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Multi Purpose Agent');
        context.subscriptions.push(outputChannel);

        log(`Multi Purpose Agent: Activating...`);
        log(`Multi Purpose Agent: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - Both IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher, BASE_CDP_PORT } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(BASE_CDP_PORT, BASE_CDP_PORT + 10, log);
            if (cdpHandler.setProStatus) {
                cdpHandler.setProStatus(isPro);
            }

            // Persistence logging
            try {
                const logPath = path.join(context.extensionPath, 'multi-purpose-agent-cdp.log');
                cdpHandler.setLogFile(logPath);
                log(`CDP logging to: ${logPath}`);
            } catch (e) {
                log(`Failed to set log file: ${e.message}`);
            }

            relauncher = new Relauncher(log);
            log(`CDP handlers initialized for ${currentIDE}.`);

            // Initialize Scheduler
            scheduler = new Scheduler(context, cdpHandler, log);
            scheduler.start();
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Multi Purpose Agent Error: ${err.message}`);
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('multi-purpose-agent.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('multi-purpose-agent.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('multi-purpose-agent.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('multi-purpose-agent.toggleBackground', () => handleBackgroundToggle(context)),
            vscode.commands.registerCommand('multi-purpose-agent.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('multi-purpose-agent.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('multi-purpose-agent.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('multi-purpose-agent.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('multi-purpose-agent.resetSettings', async () => {
                const choice = await vscode.window.showWarningMessage(
                    "Are you sure you want to reset ALL Multi Purpose Agent settings? This cannot be undone.",
                    { modal: true },
                    "Reset All",
                    "Cancel"
                );

                if (choice === "Reset All") {
                    try {
                        // Reset all global keys
                        await context.globalState.update(GLOBAL_STATE_KEY, undefined);
                        await context.globalState.update(PRO_STATE_KEY, undefined);
                        await context.globalState.update(FREQ_STATE_KEY, undefined);
                        await context.globalState.update(BANNED_COMMANDS_KEY, undefined);
                        await context.globalState.update(ROI_STATS_KEY, undefined);
                        await context.globalState.update(BACKGROUND_MODE_KEY, undefined);
                        await context.globalState.update(IS_FIRST_RUN_KEY, undefined);

                        vscode.window.showInformationMessage("All settings have been reset. Please restart VS Code.");
                    } catch (e) {
                        vscode.window.showErrorMessage(`Reset failed: ${e.message}`);
                    }
                }
            })
        );

        // 6. Register URI Handler for deep links (e.g., from Stripe success page)
        const uriHandler = {
            handleUri(uri) {
                log(`URI Handler received: ${uri.toString()}`);
                if (uri.path === '/activate' || uri.path === 'activate') {
                    log('Activation URI detected - verifying pro status...');
                    handleProActivation(context);
                }
            }
        };
        context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
        log('URI Handler registered for activation deep links.');

        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 8. Show Version 5.0 Notification (Once)
        showVersionNotification(context);

        log('Multi Purpose Agent: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Multi Purpose Agent Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return;

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
    } else {
        log('CDP not found on expected ports (9000-9030).');
        // Only show the relaunch dialog if explicitly requested (user action)
        if (showPrompt && relauncher) {
            log('Prompting user for relaunch...');
            await relauncher.showRelaunchPrompt();
        } else {
            log('Skipping relaunch prompt (startup). User can click status bar to trigger.');
        }
    }
}

async function maybePromptStartupSetup(context) {
    if (!context || !cdpHandler || !relauncher) return;
    if (!isEnabled) return;

    try {
        const cdpAvailable = await cdpHandler.isCDPAvailable();
        if (cdpAvailable) return;

        const now = Date.now();
        const lastPrompt = context.globalState.get(STARTUP_SETUP_PROMPT_KEY, 0);
        if (now - lastPrompt < STARTUP_SETUP_PROMPT_COOLDOWN_MS) return;

        await context.globalState.update(STARTUP_SETUP_PROMPT_KEY, now);
        await relauncher.showRelaunchPrompt();
    } catch (e) {
        log(`Startup setup prompt failed: ${e.message}`);
    }
}

async function checkEnvironmentAndStart() {
    if (isEnabled) {
        log('Initializing Multi Purpose Agent environment...');
        await maybePromptStartupSetup(globalContext);
        await ensureCDPOrPrompt(false);
        await startPolling();
        // Start stats collection if already enabled on startup
        startStatsCollection(globalContext);
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        if (isEnabled) {
            const choice = await vscode.window.showWarningMessage(
                "Are you sure you want to turn off Multi Purpose Agent?",
                { modal: true },
                "Turn Off",
                "Open Prompt Mode",
                "View Dashboard"
            );
            if (choice === "View Dashboard" || choice === "Open Prompt Mode") {
                const panel = getSettingsPanel();
                if (panel) panel.createOrShow(context.extensionUri, context);
                return;
            }
            if (choice !== "Turn Off") {
                log('  Toggle cancelled by user');
                return;
            }
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Multi Purpose Agent: Enabled');
            // These operations happen in background
            ensureCDPOrPrompt(true).then(() => startPolling());
            startStatsCollection(context);
            incrementSessionCount(context);
        } else {
            log('Multi Purpose Agent: Disabled');

            // Fire-and-forget: Show session summary notification (non-blocking)
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop in background
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating Relaunch...');
    const result = await relauncher.relaunchWithCDP();
    if (!result.success) {
        vscode.window.showErrorMessage(`Relaunch failed: ${result.message}`);
    }
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.globalState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    // Only Pro users can customize the banned list
    if (!isPro) {
        log('Banned commands customization requires Pro');
        return;
    }
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBackgroundToggle(context, forceValue) {
    log(`Background toggle clicked. Force: ${forceValue}`);

    // Free tier: Show Pro message

    if (!isPro) {
        vscode.window.showInformationMessage(
            'Background Mode is a Pro feature.',
            'Learn More'
        ).then(choice => {
            if (choice === 'Learn More') {
                const panel = getSettingsPanel();
                if (panel) panel.createOrShow(context.extensionUri, context);
            }
        });
        return;
    }

    if (forceValue !== undefined) {
        backgroundModeEnabled = forceValue;
    } else {
        backgroundModeEnabled = !backgroundModeEnabled;
    }

    await context.globalState.update(BACKGROUND_MODE_KEY, backgroundModeEnabled);
    log(`Background mode set to: ${backgroundModeEnabled}`);

    // Hide overlay in background if being disabled
    if (!backgroundModeEnabled && cdpHandler) {
        cdpHandler.hideBackgroundOverlay().catch(() => { });
    }

    // Update UI immediately
    updateStatusBar();

    // Sync sessions in background (don't block)
    if (isEnabled) {
        syncSessions().catch(() => { });
    }

    // Update Settings Panel if open (to sync toggle switch)
    const PanelClass = getSettingsPanel();
    if (PanelClass && PanelClass.currentPanel) {
        PanelClass.currentPanel.sendBackgroundMode();
    }
}



async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions (Mode: ${backgroundModeEnabled ? 'Background' : 'Simple'})...`);
        try {
            await cdpHandler.start({
                isPro,
                isBackgroundMode: backgroundModeEnabled,
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        } finally {
            updateStatusBar();
        }
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Multi Purpose Agent: Monitoring session...');

    // Initial trigger
    await syncSessions();

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // Check for instance locking - only the first extension instance should control CDP
        const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
        const activeInstance = globalContext.globalState.get(lockKey);
        const myId = globalContext.extension.id;

        if (activeInstance && activeInstance !== myId) {
            const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
            if (lastPing && (Date.now() - lastPing) < 15000) {
                if (!isLockedOut) {
                    log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                    isLockedOut = true;
                    updateStatusBar();
                }
                return;
            }
        }

        // We are the leader or lock is dead
        globalContext.globalState.update(lockKey, myId);
        globalContext.globalState.update(`${lockKey}-ping`, Date.now());

        if (isLockedOut) {
            log('CDP Control: Lock acquired. Resuming control.');
            isLockedOut = false;
            updateStatusBar();
        }

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (cdpHandler) await cdpHandler.stop();
    log('Multi Purpose Agent: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.globalState.update(ROI_STATS_KEY, stats);
    }

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `📊 Last week, Multi Purpose Agent saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `✅ This session:`,
        `• ${summary.clicks} actions auto-accepted`,
        `• ${summary.terminalCommands} terminal commands`,
        `• ${summary.fileEdits} file edits`,
        `• ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n⏱ Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `🤖 Multi Purpose Agent: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `🚀 Multi Purpose Agent handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- BACKGROUND MODE UPSELL ---
// Called when free user switches tabs (could have been auto-handled)
async function showBackgroundModeUpsell(context) {
    if (isPro) return; // Already Pro, no upsell

    const UPSELL_COOLDOWN_KEY = 'auto-accept-bg-upsell-last';
    const UPSELL_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes between upsells

    const lastUpsell = context.globalState.get(UPSELL_COOLDOWN_KEY, 0);
    const now = Date.now();

    if (now - lastUpsell < UPSELL_COOLDOWN_MS) return; // Too soon

    await context.globalState.update(UPSELL_COOLDOWN_KEY, now);

    const choice = await vscode.window.showInformationMessage(
        `💡 Multi Purpose Agent could've handled this tab switch automatically.`,
        { detail: 'Enable Background Mode to keep all your agents moving in parallel—no manual tab switching needed.' },
        'Enable Background Mode',
        'Not Now'
    );

    if (choice === 'Enable Background Mode') {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.globalState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.globalState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions
    statsCollectionTimer = setInterval(() => {
        if (isEnabled) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Multi Purpose Agent is running.`;
        let bgColor = undefined;
        let command = 'multi-purpose-agent.toggle';

        if (cdpHandler) {
            const injectedCount = typeof cdpHandler.getInjectedCount === 'function' ? cdpHandler.getInjectedCount() : 0;
            const connectionCount = typeof cdpHandler.getConnectionCount === 'function' ? cdpHandler.getConnectionCount() : 0;

            if (injectedCount > 0) {
                tooltip += ` (CDP Active: ${injectedCount})`;
            } else if (connectionCount > 0) {
                statusText = 'ON (No Chat)';
                tooltip += ' (CDP Connected - Open a chat view to attach)';
                bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                statusText = 'ON (Disconnected)';
                tooltip += ' (CDP Disconnected - Click to relaunch with CDP)';
                bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                command = 'multi-purpose-agent.relaunch';
            }
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }

        statusBarItem.text = `$(check) Multi Purpose Agent: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;
        statusBarItem.command = command;

        // Log status changes for debugging
        const newStatusText = `ON|${statusText}|bg=${backgroundModeEnabled}`;
        if (lastStatusText !== newStatusText) {
            log(`Status changed: "${lastStatusText}" → "${newStatusText}"`);
            lastStatusText = newStatusText;
        }

        // Show Background Mode toggle when Multi Purpose Agent is ON
        if (statusBackgroundItem) {
            if (backgroundModeEnabled) {
                statusBackgroundItem.text = '$(sync~spin) Background: ON';
                statusBackgroundItem.tooltip = 'Background Mode is on. Click to turn off.';
                statusBackgroundItem.backgroundColor = undefined;
            } else {
                statusBackgroundItem.text = '$(globe) Background: OFF';
                statusBackgroundItem.tooltip = 'Click to turn on Background Mode (works on all your chats).';
                statusBackgroundItem.backgroundColor = undefined;
            }
            statusBackgroundItem.show();
        }

    } else {
        statusBarItem.text = '$(circle-slash) Multi Purpose Agent: OFF';
        statusBarItem.tooltip = 'Click to enable Multi Purpose Agent.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.command = 'multi-purpose-agent.toggle';

        // Log status changes for debugging
        const newStatusText = `OFF`;
        if (lastStatusText !== newStatusText) {
            log(`Status changed: "${lastStatusText}" → "${newStatusText}"`);
            lastStatusText = newStatusText;
        }

        // Hide Background Mode toggle when Multi Purpose Agent is OFF
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    }
}

// Re-implement checkInstanceLock correctly with context
async function checkInstanceLock() {
    if (isPro) return true;
    if (!globalContext) return true; // Should not happen

    const lockId = globalContext.globalState.get(LOCK_KEY);
    const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
    const now = Date.now();

    // 1. If no lock or lock is stale (>10s), claim it
    if (!lockId || (now - lastHeartbeat > 10000)) {
        await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 2. If we own the lock, update heartbeat
    if (lockId === INSTANCE_ID) {
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 3. Someone else owns the lock and it's fresh
    return false;
}

async function verifyLicense(context) {
    return true;
}

// Handle Pro activation (called from URI handler or command)
async function handleProActivation(context) {
    log('Pro Activation: Starting verification process...');

    // Show progress notification
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Auto Accept: Verifying Pro status...',
            cancellable: false
        },
        async (progress) => {
            progress.report({ increment: 30 });

            // Give webhook a moment to process (Stripe webhooks can have slight delay)
            await new Promise(resolve => setTimeout(resolve, 1500));
            progress.report({ increment: 30 });

            // Verify license
            const isProNow = await verifyLicense(context);
            progress.report({ increment: 40 });

            if (isProNow) {
                // Update state
                isPro = true;
                await context.globalState.update(PRO_STATE_KEY, true);

                // Update CDP handler if running
                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(true);
                }

                // Update poll frequency to pro default
                pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

                // Sync sessions with new pro status
                if (isEnabled) {
                    await syncSessions();
                }

                // Update UI
                updateStatusBar();

                log('Pro Activation: SUCCESS - User is now Pro!');
                vscode.window.showInformationMessage(
                    '🎉 Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                    'Open Dashboard'
                ).then(choice => {
                    if (choice === 'Open Dashboard') {
                        const panel = getSettingsPanel();
                        if (panel) panel.createOrShow(context.extensionUri, context);
                    }
                });
            } else {
                log('Pro Activation: License not found yet. Starting background polling...');
                // Start background polling in case webhook is delayed
                startProPolling(context);
            }
        }
    );
}

// Background polling for delayed webhook scenarios
let proPollingTimer = null;
let proPollingAttempts = 0;
const MAX_PRO_POLLING_ATTEMPTS = 24; // 2 minutes (5s intervals)

function startProPolling(context) {
    if (proPollingTimer) {
        clearInterval(proPollingTimer);
    }

    proPollingAttempts = 0;
    log('Pro Polling: Starting background verification (checking every 5s for up to 2 minutes)...');

    vscode.window.showInformationMessage(
        'Payment received! Verifying your Pro status... This may take a moment.'
    );

    proPollingTimer = setInterval(async () => {
        proPollingAttempts++;
        log(`Pro Polling: Attempt ${proPollingAttempts}/${MAX_PRO_POLLING_ATTEMPTS}`);

        if (proPollingAttempts > MAX_PRO_POLLING_ATTEMPTS) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;
            log('Pro Polling: Max attempts reached. User should check manually.');
            vscode.window.showWarningMessage(
                'Pro verification is taking longer than expected. Please click "Check Pro Status" in settings, or contact support if the issue persists.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
            return;
        }

        const isProNow = await verifyLicense(context);
        if (isProNow) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;

            // Update state
            isPro = true;
            await context.globalState.update(PRO_STATE_KEY, true);

            if (cdpHandler && cdpHandler.setProStatus) {
                cdpHandler.setProStatus(true);
            }

            pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

            if (isEnabled) {
                await syncSessions();
            }

            updateStatusBar();

            log('Pro Polling: SUCCESS - Pro status confirmed!');
            vscode.window.showInformationMessage(
                '🎉 Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                'Open Dashboard'
            ).then(choice => {
                if (choice === 'Open Dashboard') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
        }
    }, 5000);
}

async function showVersionNotification(context) {
    const hasShown = context.globalState.get(VERSION_7_0_KEY, false);
    if (hasShown) return;

    // Copy for v7.0
    const title = "🚀 What's new in Multi Purpose Agent 7.0";
    const body = `Smarter. Faster. More reliable.

✅ Smart Away Notifications — Get notified only when actions happened while you were truly away.

📊 Session Insights — See exactly what happened when you turn off Multi Purpose Agent: file edits, terminal commands, and blocked interruptions.

⚡ Improved Background Mode — Faster, more reliable multi-chat handling.

🛡️ Enhanced Stability — Complete analytics rewrite for rock-solid tracking.`;
    const btnDashboard = "View Dashboard";
    const btnGotIt = "Got it";

    // Mark as shown immediately to prevent loops/multiple showings
    await context.globalState.update(VERSION_7_0_KEY, true);

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        btnGotIt,
        btnDashboard,
        "Open Prompt Mode",
        "Enable Background Mode"
    );

    if (selection === btnDashboard) {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    } else if (selection === "Open Prompt Mode") {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context, 'prompt');
    } else if (selection === "Enable Background Mode") {
        await handleBackgroundToggle(context);
    }
}

function deactivate() {
    stopPolling();
    if (scheduler) {
        scheduler.stop();
    }
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate };
