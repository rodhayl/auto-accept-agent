const assert = require('assert');
const Module = require('module');

// --- 1. MOCKING INFRASTRUCTURE ---

// Store original require to allow loading node modules
const originalRequire = Module.prototype.require;

// Mock VS Code API
const mockVscode = {
    window: {
        showInformationMessage: () => Promise.resolve()
    },
    workspace: {
        getConfiguration: () => ({
            get: (key, def) => {
                if (key === 'enabled') return true;
                if (key === 'mode') return 'interval';
                if (key === 'value') return '30';
                if (key === 'prompt') return 'Test Prompt';
                return def;
            }
        })
    }
};

// Mock CDP Handler with artificial delay
const mockCdpHandler = {
    sentPrompts: [],
    sendPrompt: async (text) => {
        // Simulate a slow operation (100ms)
        await new Promise(resolve => setTimeout(resolve, 100));
        mockCdpHandler.sentPrompts.push({
            text,
            time: Date.now()
        });
    }
};

// Hook require
Module.prototype.require = function(request) {
    if (request === 'vscode') return mockVscode;
    // For internal modules, just return empty/mock objects if needed
    // But Scheduler is inside extension.js, so we need to load extension.js
    // However, extension.js executes top-level code (activates) which we might not want.
    // We only want the Scheduler class.
    // extension.js does NOT export Scheduler class directly in module.exports.
    // It is internal.
    // So we need to copy the Scheduler class code or use a different approach.
    // Since we modified extension.js, let's read the file and eval the Scheduler class or 
    // better yet, we can modify extension.js to export it for testing if possible.
    // But user rules say "minimal file creation".
    
    // Alternative: We can use the 'Scheduler' class from the file content by regex or just duplicate it here for the test logic 
    // IF the logic is self-contained. 
    // But we want to test the ACTUAL code.
    
    return originalRequire.apply(this, arguments);
};

// We need to access the Scheduler class from extension.js. 
// Since it's not exported, we will "mock" the environment and eval the relevant part of extension.js 
// or simpler: we define the same class structure here to verify the LOGIC 
// OR we rely on the fact that we just modified it.
// Wait, testing the actual code is better. 
// Let's assume for this test script we can extract the Scheduler class definition.

// Strategy: Read extension.js, extract Scheduler class, and eval it.
const fs = require('fs');
const path = require('path');
const extensionPath = path.join(__dirname, '../extension.js');
const extensionContent = fs.readFileSync(extensionPath, 'utf8');

// Extract Scheduler class
const schedulerMatch = extensionContent.match(/class Scheduler \{[\s\S]*?\n\}/);
if (!schedulerMatch) {
    console.error('❌ Could not find Scheduler class in extension.js');
    process.exit(1);
}

// Prepare context for eval
const vscode = mockVscode; // used in class
// eval the class definition
// We need to capture the class in a variable
const SchedulerClass = eval(`(${schedulerMatch[0]})`);

// Now we have `Scheduler` class available in this scope.

// --- 2. TEST SUITE ---
async function runTests() {
    console.log('🚀 Starting Scheduler Safeguard Tests...\n');
    
    // Mock logger
    const logs = [];
    const log = (msg) => logs.push(msg);
    
    const context = {}; // Mock context
    const scheduler = new SchedulerClass(context, mockCdpHandler, log);
    
    // Load config
    scheduler.loadConfig();
    
    console.log('Test 1: Sequential Execution Verification');
    const start = Date.now();
    
    // Trigger twice rapidly with DIFFERENT prompts
    const p1 = scheduler.queuePrompt('Prompt A');
    const p2 = scheduler.queuePrompt('Prompt B');
    
    await Promise.all([p1, p2]);
    
    const end = Date.now();
    const duration = end - start;
    
    console.log(`Total duration: ${duration}ms`);
    console.log('Sent prompts:', mockCdpHandler.sentPrompts);
    
    // Verification
    assert.strictEqual(mockCdpHandler.sentPrompts.length, 2, 'Should have sent 2 prompts');
    
    const prompt1 = mockCdpHandler.sentPrompts[0];
    const prompt2 = mockCdpHandler.sentPrompts[1];

    assert.strictEqual(prompt1.text, 'Prompt A', 'First prompt should be A');
    assert.strictEqual(prompt2.text, 'Prompt B', 'Second prompt should be B');
    
    // Check timing
    // Each prompt takes 100ms.
    // If parallel: total time ~100ms, diff between times ~0.
    // If sequential: total time ~200ms, diff between times >= 100ms.
    
    const timeDiff = prompt2.time - prompt1.time;
    console.log(`Time difference between prompts: ${timeDiff}ms`);
    
    assert.ok(timeDiff >= 100, `Prompts should be sequential (diff >= 100ms), got ${timeDiff}ms`);
    assert.ok(duration >= 200, `Total duration should be >= 200ms, got ${duration}ms`);
    
    console.log('✅ PASS: Prompts executed sequentially.');

    // --- TEST 2: Error Resilience ---
    console.log('\nTest 2: Error Resilience Verification');
    
    // Reset mock
    mockCdpHandler.sentPrompts = [];
    
    // Inject a failure mode into mockCdpHandler temporarily
    const originalSendPrompt = mockCdpHandler.sendPrompt;
    let shouldFail = true;
    
    mockCdpHandler.sendPrompt = async (text) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (text === 'FAIL_ME') {
            throw new Error('Simulated CDP Error');
        }
        mockCdpHandler.sentPrompts.push({ text, time: Date.now() });
    };
    
    // Queue 3 prompts: Success, Fail, Success
    const q1 = scheduler.queuePrompt('Success 1');
    const q2 = scheduler.queuePrompt('FAIL_ME');
    const q3 = scheduler.queuePrompt('Success 2');
    
    await Promise.allSettled([q1, q2, q3]);
    
    // Restore mock
    mockCdpHandler.sendPrompt = originalSendPrompt;
    
    console.log('Sent prompts after failure:', mockCdpHandler.sentPrompts);
    
    assert.strictEqual(mockCdpHandler.sentPrompts.length, 2, 'Should have sent 2 successful prompts');
    assert.strictEqual(mockCdpHandler.sentPrompts[0].text, 'Success 1');
    assert.strictEqual(mockCdpHandler.sentPrompts[1].text, 'Success 2');
    
    console.log('✅ PASS: Queue continued processing after an error.');

    console.log('🎉 ALL TESTS PASSED!');
    process.exit(0);
}

runTests().catch(e => {
    console.error('❌ TEST FAILED:', e);
    process.exit(1);
});
