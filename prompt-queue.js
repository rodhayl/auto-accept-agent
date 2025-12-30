class PromptQueue {
    constructor(cdpHandler, log) {
        this.cdpHandler = cdpHandler;
        this.log = log;
        this.queue = [];
        this.isProcessing = false;
        this.currentPrompt = null;
        this.statusChangeCallback = null;
    }

    onQueueChanged(callback) {
        this.statusChangeCallback = callback;
    }

    notifyChange() {
        if (this.statusChangeCallback) {
            this.statusChangeCallback({
                queue: this.queue,
                current: this.currentPrompt,
                isProcessing: this.isProcessing
            });
        }
    }

    add(text) {
        this.queue.push({ id: Date.now().toString(), text, status: 'pending' });
        this.log(`PromptQueue: Added "${text}"`);
        this.notifyChange();
        this.process();
    }

    async process() {
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;
        this.notifyChange();

        try {
            while (this.queue.length > 0) {
                // 1. Check if IDE is busy
                const isBusy = await this.cdpHandler.isBusy();
                if (isBusy) {
                    this.log('PromptQueue: IDE is busy, waiting...');
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                // 2. Take next prompt
                this.currentPrompt = this.queue.shift();
                this.currentPrompt.status = 'sending';
                this.notifyChange();

                this.log(`PromptQueue: Sending "${this.currentPrompt.text}"`);
                
                // 3. Send prompt
                await this.cdpHandler.sendPrompt(this.currentPrompt.text);
                
                this.currentPrompt.status = 'sent';
                this.notifyChange();

                // 4. Wait for it to START processing (busy state to appear)
                // We give it up to 5 seconds to become busy
                let becameBusy = false;
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    if (await this.cdpHandler.isBusy()) {
                        becameBusy = true;
                        break;
                    }
                }

                if (becameBusy) {
                    this.log('PromptQueue: Detected processing started.');
                } else {
                    this.log('PromptQueue: Warning - Did not detect busy state after sending.');
                }

                this.currentPrompt = null;
                this.notifyChange();
            }
        } catch (err) {
            this.log(`PromptQueue Error: ${err.message}`);
        } finally {
            this.isProcessing = false;
            this.currentPrompt = null;
            this.notifyChange();
        }
    }
    
    getQueue() {
        return this.queue;
    }

    clear() {
        this.queue = [];
        this.notifyChange();
    }
}

module.exports = { PromptQueue };
