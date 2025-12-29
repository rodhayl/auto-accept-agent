const { execSync } = require('child_process');

const tests = [
    // Core bundle tests
    'test_scripts/background_mode_test.js',
    'test_scripts/verify_bundle.js',

    // Feature tests
    'test_scripts/scheduler_test.js',
    'test_scripts/test_ux_notifications.js',
    'test_scripts/banned_commands_test.js',

    // Integration tests
    'test_scripts/prompt_injection_test.js',
    'test_scripts/test_scheduler_safeguard.js',
    'test_scripts/test_dialogs_verification.js',
    'test_scripts/test_cdp.js'

    // NOTE: Removed tests that require deleted standalone modules:
    // - test_analytics_module.js (requires deleted analytics/ module)
    // - test_always_allow.js (requires deleted auto_accept.js module)
    // Button detection and analytics are tested via background_mode_test.js

    // NOTE: Browser-only tests (require DOM, cannot run in Node.js):
    // - antigravity_background_poll_test.js
    // - cursor_background_poll_test.js
    // - overlay_test.js
    // - full_agent_test.js
    // - auto_accept_test.js
    // - test_bundle.js (this is a copy of full_cdp_script.js, NOT a test file)
];

console.log('=== RUNNING ALL TESTS ===\n');

let failed = false;

for (const test of tests) {
    console.log(`--- Running ${test} ---`);
    try {
        execSync(`node ${test}`, { stdio: 'inherit' });
        console.log(`✓ ${test} PASSED\n`);
    } catch (e) {
        console.error(`✖ ${test} FAILED`);
        failed = true;
    }
}

if (failed) {
    console.error('\n=== SOME TESTS FAILED ===');
    process.exit(1);
} else {
    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
}
