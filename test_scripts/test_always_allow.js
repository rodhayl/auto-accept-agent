const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'main_scripts', 'auto_accept.js');

console.log('=== RUNNING ALWAYS ALLOW DETECTION TEST ===');

try {
    let code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Mock imports and exports
    code = code.replace(/import \* as utils from '\.\/utils\.js';/g, 'const utils = { assert: () => {} };');
    code = code.replace(/export function/g, 'function');
    
    // Add logic to expose isAcceptButton
    code += '\n\nglobal.isAcceptButton = isAcceptButton;';

    const sandbox = {
        global: {},
        window: {
            getComputedStyle: () => ({
                display: 'block',
                visibility: 'visible',
                opacity: '1',
                pointerEvents: 'auto'
            })
        },
        console: console
    };
    
    // Mock Element class
    class MockElement {
        constructor(text) {
            this.textContent = text;
            this.disabled = false;
            this.ownerDocument = {
                defaultView: sandbox.window
            };
        }
        
        getBoundingClientRect() {
            return { width: 10, height: 10 };
        }
        
        hasAttribute() { return false; }
    }
    sandbox.window.Element = MockElement;

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const isAcceptButton = sandbox.global.isAcceptButton;

    // Test Cases
    const cases = [
        { text: 'Always allow', expected: true },
        { text: 'Always Allow', expected: true },
        { text: 'always allow', expected: true },
        { text: 'Allow Once', expected: true },
        { text: 'Allow', expected: false }, // "Allow" is NOT in auto_accept.js patterns
        { text: 'Cancel', expected: false },
        { text: 'Run', expected: true },
        { text: "Don't Allow", expected: false },
        { text: "don't allow", expected: false },
        { text: "Not Now", expected: false }
    ];

    let passed = 0;
    let failed = 0;

    cases.forEach(c => {
        const el = new MockElement(c.text);
        const result = isAcceptButton(el);
        if (result === c.expected) {
            console.log(`✓ "${c.text}" -> ${result}`);
            passed++;
        } else {
            console.error(`✖ "${c.text}" -> ${result} (Expected: ${c.expected})`);
            failed++;
        }
    });

    if (failed > 0) {
        console.error(`\nFAILED: ${failed} tests failed.`);
        process.exit(1);
    } else {
        console.log(`\nPASSED: All ${passed} tests passed.`);
        process.exit(0);
    }

} catch (e) {
    console.error('Error running test:', e);
    process.exit(1);
}
