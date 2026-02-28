const fs = require('fs');
const { BASE_URL, PORTAL_URL, COOKIES_FILE, IVAS_EMAIL, IVAS_PASSWORD, LOGIN_URL } = require('./config');

// ============================================================
// CREDENTIALS (from .env)
// ============================================================


// ============================================================
// STATE
// Browser stays OPEN after login so fetcher.js can use
// page.evaluate() to make POST requests inside the real
// browser context — this avoids 403 from Cloudflare
// ============================================================
let browser              = null;
let page                 = null;
let csrfToken            = null;
let sessionCookies       = [];
let sessionValid         = false;
let pageReady            = false;
let sessionRefreshTimer  = null;

// ============================================================
// COOKIE HELPERS
// ============================================================
function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_FILE)) {
            sessionCookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
            console.log(`✅ Loaded ${sessionCookies.length} cookies from file`);
            return true;
        }
    } catch (err) {
        console.error('Error loading cookies:', err.message);
    }
    return false;
}

function saveCookies(cookies) {
    try {
        fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
        sessionCookies = cookies;
        console.log(`✅ Saved ${cookies.length} cookies to file`);
    } catch (err) {
        console.error('Error saving cookies:', err.message);
    }
}

// ============================================================
// GETTERS
// ============================================================
function getCookies()      { return sessionCookies; }
function getCsrfToken()    { return csrfToken; }
function setCsrfToken(t)   { csrfToken = t; }
function isSessionValid()  { return sessionValid; }
function isPageReady()     { return pageReady; }
function getPage()         { return page; }
function getBrowser()      { return browser; }
function getCookieHeader() { return sessionCookies.map(c => `${c.name}=${c.value}`).join('; '); }

// ============================================================
// SESSION REFRESH
// Called after every navigation to keep tokens fresh
// Also runs on a timer every 5 minutes automatically
// ============================================================
async function refreshSession() {
    if (!page) return;
    try {
        // Fresh cookies
        const fresh = await page.cookies();
        if (fresh.length > 0) saveCookies(fresh);

        // Fresh CSRF token — try multiple sources
        const token = await page.evaluate(() => {
            const meta   = document.querySelector('meta[name="csrf-token"]');
            if (meta)    return meta.getAttribute('content');
            const input  = document.querySelector('input[name="_token"]');
            if (input)   return input.value;
            if (window.csrf_token) return window.csrf_token;
            return null;
        });

        if (token) {
            csrfToken = token;
            console.log('🔄 Session refreshed — fresh CSRF token');
        }

        // Log XSRF cookie presence
        const xsrf = fresh.find(c => c.name === 'XSRF-TOKEN');
        if (xsrf) console.log('🔄 XSRF-TOKEN cookie present');

    } catch (err) {
        console.error('Session refresh error:', err.message);
    }
}

function startAutoRefresh() {
    if (sessionRefreshTimer) clearInterval(sessionRefreshTimer);
    sessionRefreshTimer = setInterval(async () => {
        if (!page || !sessionValid) return;
        console.log('🔄 Auto-refreshing session...');
        try {
            await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await refreshSession();
        } catch (e) {
            console.error('Auto-refresh error:', e.message);
        }
    }, 5 * 60 * 1000); // every 5 minutes
}

// ============================================================
// ENSURE PAGE IS ON SMS RECEIVED
// Used by fetcher before every SMS check cycle
// ============================================================
async function ensureOnSmsPage() {
    if (!page) return false;
    try {
        const url = page.url();
        if (!url.includes('/portal/sms/received')) {
            await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 1500));
            await refreshSession();
        }
        return true;
    } catch (e) {
        console.error('ensureOnSmsPage error:', e.message);
        return false;
    }
}

// ============================================================
// CLOUDFLARE WAIT
// turnstile:true in puppeteer-real-browser auto-clicks CF —
// this function just waits for the challenge to resolve
// ============================================================
async function waitForCloudflare(pg, maxWaitMs = 40000) {
    console.log('⏳ Waiting for Cloudflare to clear...');
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const isCf = await pg.evaluate(() => {
                const body  = document.body?.innerText?.toLowerCase() || '';
                const title = document.title.toLowerCase();
                return (
                    title.includes('just a moment')                   ||
                    body.includes('performing security verification')  ||
                    body.includes('checking your browser')            ||
                    body.includes('verify you are human')
                );
            });

            if (!isCf) { console.log('✅ Cloudflare cleared!'); return true; }
        } catch (e) {}

        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n⚠️ CF wait timeout — continuing anyway');
    return false;
}

// ============================================================
// AUTO LOGIN
// Fills email/password and submits the login form
// ============================================================
async function doLogin(pg) {
    if (!IVAS_EMAIL || !IVAS_PASSWORD) {
        console.log('⚠️ IVAS_EMAIL / IVAS_PASSWORD not set in .env — skipping auto login');
        return false;
    }

    try {
        console.log('🔑 Navigating to login page...');
        await pg.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
        await waitForCloudflare(pg, 20000);
        await new Promise(r => setTimeout(r, 1000));

        const hasForm = await pg.evaluate(() =>
            !!(document.querySelector('input[type="email"], input[name="email"]'))
        );

        if (!hasForm) {
            console.log('⚠️ Login form not visible — may still be on CF page');
            return false;
        }

        // Fill email
        await pg.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_EMAIL, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        // Fill password
        await pg.click('input[type="password"], input[name="password"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_PASSWORD, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        console.log('📝 Credentials entered — clicking Log in...');

        // Use realClick if available (puppeteer-real-browser), else fallback
        try {
            await pg.realClick('button[type="submit"]');
        } catch (e) {
            await pg.evaluate(() => {
                const btn = document.querySelector('button[type="submit"], input[type="submit"]');
                if (btn) btn.click();
            });
        }

        await pg.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        await waitForCloudflare(pg, 15000);

        const currentUrl = pg.url();
        console.log('📍 Post-login URL:', currentUrl);

        if (currentUrl.includes('/login')) {
            const errorText = await pg.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error-message, .invalid-feedback');
                return el ? el.textContent.trim() : 'Unknown error';
            });
            console.log('❌ Still on login page:', errorText);
            return false;
        }

        console.log('✅ Auto-login successful!');
        return true;

    } catch (err) {
        console.error('❌ Login error:', err.message);
        return false;
    }
}

// ============================================================
// CHECK IF PORTAL IS AUTHENTICATED
// ============================================================
async function checkLoggedIn(pg) {
    return pg.evaluate(() =>
        !!(
            document.querySelector('.user-panel') &&
            (document.querySelector('#spa-content') || document.querySelector('.content-wrapper')) &&
            window.location.href.includes('/portal')
        )
    ).catch(() => false);
}

// ============================================================
// INIT BROWSER — main entry point
// Flow:
//   1. Launch puppeteer-real-browser (handles CF Turnstile)
//   2. Load saved cookies
//   3. Navigate to portal — check if already logged in
//   4. If not → auto login with email/password
//   5. If auto login fails → wait 90s for manual login
//   6. Extract CSRF token + save cookies
//   7. Start auto-refresh timer (every 5 min)
//   8. Browser stays OPEN — fetcher uses page.evaluate()
// ============================================================
async function initBrowser() {
    try {
        console.log('🚀 Launching Puppeteer Real Browser...');
        pageReady = false;

        // Close existing browser if any
        if (browser) {
            try { await browser.close(); } catch (e) {}
            browser = null;
            page    = null;
        }

        const { connect } = require('puppeteer-real-browser');

        const { browser: rb, page: rp } = await connect({
            headless:      false,
            args:          ['--no-sandbox', '--disable-dev-shm-usage'],
            customConfig:  {
                chromePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            },
            turnstile:     true,   // auto-solves Cloudflare Turnstile
            connectOption: { defaultViewport: null },
            disableXvfb:   process.platform === 'win32', // true=Windows, false=Linux/Render
            ignoreAllFlags: false,
        });

        browser = rb;
        page    = rp;

        await page.setDefaultNavigationTimeout(90000);
        await page.setDefaultTimeout(60000);

        // Load saved cookies into browser
        if (sessionCookies.length > 0) {
            await page.setCookie(...sessionCookies);
            console.log('✅ Loaded cookies into browser');
        }

        // ── Step 1: Navigate to portal ──────────────────────
        console.log('🌐 Navigating to portal...');
        try {
            await page.goto(BASE_URL + '/portal', { waitUntil: 'load', timeout: 90000 });
        } catch (e) {
            console.log('⚠️ Page load timeout — continuing...');
        }

        await waitForCloudflare(page, 40000);
        await new Promise(r => setTimeout(r, 2000));

        // ── Step 2: Check if already logged in ──────────────
        let isLoggedIn = await checkLoggedIn(page);

        // ── Step 3: Auto login if needed ────────────────────
        if (!isLoggedIn) {
            console.log('🔒 Not logged in — attempting auto login...');
            const loginOk = await doLogin(page);

            if (loginOk) {
                await page.goto(BASE_URL + '/portal', { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000));
                await waitForCloudflare(page, 10000);
                isLoggedIn = await checkLoggedIn(page);
            }

            // ── Step 4: Wait for manual login if auto failed ─
            if (!isLoggedIn) {
                console.log('\n⚠️ Auto login failed — waiting up to 90s for manual login...');
                let waited = 0;
                while (waited < 90000) {
                    await new Promise(r => setTimeout(r, 3000));
                    waited += 3000;
                    isLoggedIn = await checkLoggedIn(page);
                    if (isLoggedIn) break;
                    process.stdout.write(`\r⏳ Waiting for manual login... (${Math.floor(waited / 1000)}s)`);
                }
                if (!isLoggedIn) console.log(''); // newline
            }
        }

        if (!isLoggedIn) {
            console.log('\n❌ Could not authenticate — check credentials or cookies');
            sessionValid = false;
            return false;
        }

        console.log('\n✅ Portal authenticated!');

        // ── Step 5: Navigate to SMS page + extract CSRF ──────
        await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        await refreshSession();  // saves cookies + CSRF in one call

        if (!csrfToken) {
            console.log('⚠️ No CSRF token found — session may be incomplete');
            sessionValid = false;
            return false;
        }

        sessionValid = true;
        pageReady    = true;

        // ── Step 6: Start auto-refresh every 5 minutes ──────
        startAutoRefresh();

        console.log('✅ Session ready — auto-refresh every 5 minutes');
        return true;

    } catch (err) {
        console.error('❌ Browser init error:', err.message);
        sessionValid = false;
        return false;
    }
}

// ============================================================
// SET SESSION COOKIES FROM OUTSIDE (admin panel)
// ============================================================
function setSessionCookies(cookies) {
    sessionCookies = cookies;
    saveCookies(cookies);
    csrfToken    = null;
    sessionValid = false;
    pageReady    = false;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    // Init
    initBrowser,
    // Cookie management
    loadCookies,
    saveCookies,
    getCookies,
    getCookieHeader,
    setSessionCookies,
    // CSRF
    getCsrfToken,
    setCsrfToken,
    // State checks
    isSessionValid,
    isPageReady,
    // Page access (used by fetcher)
    getPage,
    getBrowser,
    ensureOnSmsPage,
    // Session refresh (used by fetcher after navigation)
    refreshSession,
};