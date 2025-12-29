const { execSync } = require('child_process');

const tests = [
    'test_scripts/background_mode_test.js',
    'test_scripts/scheduler_test.js',
    'test_scripts/verify_bundle.js'
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
