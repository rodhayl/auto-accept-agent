/**
 * PROMPT INJECTION TEST
 * Tests the __autoAcceptSendPrompt function in a mock DOM environment
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Mock DOM
class MockElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.value = '';
        this.innerText = '';
        this.events = {};
        this.classList = {
            contains: () => false
        };
        this.style = { display: 'block', visibility: 'visible' };
        this.isConnected = true;
    }

    addEventListener(event, handler) {
        this.events[event] = handler;
    }

    dispatchEvent(event) {
        console.log(`[DOM] Event dispatched on <${this.tagName}>: ${event.type}`);
        if (event.type === 'input') {
            // Simulate input
        }
    }

    focus() {
        console.log(`[DOM] <${this.tagName}> focused`);
    }

    click() {
        console.log(`[DOM] <${this.tagName}> clicked`);
        this.clicked = true;
    }
    
    getBoundingClientRect() {
        return { width: 100, height: 100, top: 0, left: 0 };
    }
}

class MockWindow {
    constructor() {
        // Fix: Define class first, then instance or assign prototype to a function
        function MockTextArea() {}
        MockTextArea.prototype = {};
        // Define 'value' as a property with setter to mimic native behavior
        Object.defineProperty(MockTextArea.prototype, 'value', {
            get() { return this._value || ''; },
            set(v) { this._value = v; console.log(`[DOM] <TEXTAREA> value set to: "${v}"`); },
            configurable: true
        });
        this.HTMLTextAreaElement = MockTextArea;

        this.document = {
            querySelectorAll: (sel) => this.querySelectorAll(sel),
            querySelector: (sel) => this.querySelector(sel)
        };
        this.elements = [];
        this.setTimeout = (fn, ms) => setTimeout(fn, ms);
        this.Event = class { constructor(type) { this.type = type; } };
        this.KeyboardEvent = class { constructor(type) { this.type = type; } };
    }

    querySelectorAll(selector) {
        // Simple mock selector engine
        return this.elements.filter(el => {
            if (selector === 'textarea' && el.tagName === 'TEXTAREA') return true;
            if (selector.includes('send-button') && el.tagName === 'DIV' && el.className === 'send-button') return true;
            return false;
        });
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    getComputedStyle(el) {
        return el.style;
    }
}

// Load the full CDP script
const scriptContent = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js'), 'utf8');

async function runTest() {
    console.log('=== PROMPT INJECTION TEST STARTED ===');

    const mockWindow = new MockWindow();
    
    // Create Input Box
    const inputBox = new MockElement('textarea');
    inputBox.placeholder = 'Ask a question...';
    mockWindow.elements.push(inputBox);

    // Create Send Button
    const sendBtn = new MockElement('div');
    sendBtn.className = 'send-button';
    sendBtn.tagName = 'DIV'; // As per script logic
    mockWindow.elements.push(sendBtn);

    // Setup VM context
    const sandbox = {
        window: mockWindow,
        document: mockWindow.document,
        setTimeout: setTimeout,
        console: console,
        Event: mockWindow.Event,
        KeyboardEvent: mockWindow.KeyboardEvent,
        HTMLTextAreaElement: mockWindow.HTMLTextAreaElement
    };
    
    vm.createContext(sandbox);
    
    // Execute script to define functions
    vm.runInContext(scriptContent, sandbox);

    // Trigger Injection
    console.log('[Test] Triggering __autoAcceptSendPrompt...');
    sandbox.window.__autoAcceptSendPrompt("Hello World");

    // Wait for async operations (simulated typing + send click)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify
    if (sendBtn.clicked) {
        console.log('✓ PASS: Send button clicked');
    } else {
        console.error('✖ FAIL: Send button not clicked');
        process.exit(1);
    }

    console.log('=== PROMPT INJECTION TEST COMPLETED ===');
}

runTest();
