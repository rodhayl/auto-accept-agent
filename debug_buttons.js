// Debug script to find Accept buttons
(function() {
    const allButtons = document.querySelectorAll('button, [role="button"], div[class*="button"], [class*="btn"]');
    console.log('[DEBUG] Found ' + allButtons.length + ' button-like elements');
    
    allButtons.forEach((btn, i) => {
        const text = (btn.textContent || '').trim().substring(0, 50);
        const cls = (btn.className || '').substring(0, 60);
        const aria = btn.getAttribute('aria-label') || '';
        console.log('[DEBUG] Button ' + i + ': text="' + text + '" class="' + cls + '" aria="' + aria + '"');
    });
    
    // Also look for any element containing "Accept" or "Run" 
    const acceptEls = document.querySelectorAll('*');
    let found = [];
    acceptEls.forEach(el => {
        const t = (el.textContent || '').toLowerCase();
        if ((t.includes('accept') || t.includes('run ')) && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
            if (!found.includes(el)) {
                found.push(el);
            }
        }
    });
    console.log('[DEBUG] Elements with Accept/Run text: ' + found.length);
    found.slice(0, 15).forEach((el, i) => {
        console.log('[DEBUG] Accept/Run ' + i + ': tag=' + el.tagName + ' text="' + (el.textContent || '').trim().substring(0, 40) + '"');
    });
})();
