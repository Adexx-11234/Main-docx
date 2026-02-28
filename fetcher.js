const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const {
    NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE, NUMBERS_CACHE_TTL, NUMBERS_PAGE_URL, LIVE_SMS_PAGE_URL, SEEN_SMS_FILE,
    PORTAL_URL, extractOTP, extractService, extractCountry, getCountryEmoji, getDateRange, LIVE_NUMBERS_URL, escapeHtml,
} = require('./config');

const { getCsrfToken, getPage, isPageReady, ensureOnSmsPage, setCsrfToken, refreshSession } = require('./browser');

// ─── PAGE LOCK (navigation only) ────────────────────────────
let pageLock = false;
let pageLockQueue = [];

function withPageLock(fn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            pageLock = true;
            Promise.resolve(fn()).then(resolve).catch(reject).finally(() => {
                pageLock = false;
                if (pageLockQueue.length > 0) pageLockQueue.shift()();
            });
        };
        pageLock ? pageLockQueue.push(run) : run();
    });
}

// ─── BROWSER-CONTEXT POST (parallel-safe, CF-safe) ──────────
async function pagePost(urlPath, formData) {
    const page = getPage();
    if (!page) throw new Error('No browser page');
    const token = getCsrfToken();
    if (!token) throw new Error('No CSRF token');

    const result = await page.evaluate(async (urlPath, formData, token) => {
        const body = new URLSearchParams({ _token: token, ...formData });
        const res = await fetch(urlPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: body.toString(),
            credentials: 'include',
        });
        return { status: res.status, text: await res.text() };
    }, urlPath, formData, token);

    if (result.status === 403) throw new Error('403 — session expired');
    if (result.status === 419) throw new Error('419 — CSRF expired');
    return result.text;
}

// ─── SEEN SMS ────────────────────────────────────────────────
function loadSeenSms() {
    try {
        if (fs.existsSync(SEEN_SMS_FILE))
            return new Set(JSON.parse(fs.readFileSync(SEEN_SMS_FILE, 'utf8')));
    } catch (e) {}
    return new Set();
}

function saveSeenSms(set) {
    try {
        fs.writeFileSync(SEEN_SMS_FILE, JSON.stringify([...set].slice(-10000)));
    } catch (e) {}
}

// True after the first successful full fetch — prevents startup flood
let seenInitialised = fs.existsSync(SEEN_SMS_FILE);

/**
 * seedSeenSms — called on first run when seen_sms.json doesn't exist yet.
 * Marks ALL currently visible SMS as seen WITHOUT sending them.
 * This means only SMS that arrive AFTER bot startup will be forwarded.
 */
async function seedSeenSms(smsResults) {
    const seen = loadSeenSms();
    let count = 0;
    for (const { number, smsList } of smsResults) {
        for (const smsText of smsList) {
            const msgId = makeMsgId(number, smsText);
            if (!seen.has(msgId)) { seen.add(msgId); count++; }
        }
    }
    saveSeenSms(seen);
    seenInitialised = true;
    console.log(`🌱 Seeded ${count} existing SMS as seen — only NEW SMS will be forwarded from now on`);
}

function makeMsgId(number, smsText) {
    return `${number}_${smsText.trim().substring(0, 60).replace(/\s+/g, '_')}`;
}

// ─── STEP 1: GET RANGES ──────────────────────────────────────
async function fetchSmsRanges() {
    return withPageLock(async () => {
        await ensureOnSmsPage();
        const { fromDisplay, toDisplay } = getDateRange();
        const page = getPage();

        // Set dates and clear old results
        await page.evaluate((fd, td) => {
            const s = document.querySelector('#start_date');
            const e = document.querySelector('#end_date');
            if (s) { s.value = fd; s.dispatchEvent(new Event('change')); }
            if (e) { e.value = td; e.dispatchEvent(new Event('change')); }
            const r = document.querySelector('#ResultCDR');
            if (r) r.innerHTML = '';
        }, fromDisplay, toDisplay);

        await new Promise(r => setTimeout(r, 500));

        // Click Get SMS
        await page.evaluate(() => {
            const btn = document.querySelector('button[onclick*="GetSMS"]');
            if (btn) btn.click();
        });

        // Wait for results to appear
        try {
            await page.waitForFunction(
                () => document.querySelector('#ResultCDR .card.card-body.mb-1.pointer') !== null,
                { timeout: 20000 }
            );
        } catch (e) {
            console.log('⚠️ No ranges loaded — no SMS in date range');
        }

        await new Promise(r => setTimeout(r, 500));

        // Refresh CSRF after AJAX
        const newToken = await page.evaluate(() =>
            document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
        );
        if (newToken) setCsrfToken(newToken);

        const ranges = await page.evaluate(() =>
            [...document.querySelectorAll('#ResultCDR .card.card-body.mb-1.pointer')]
                .map(el => el.getAttribute('onclick')?.match(/getDetials\('([^']+)'\)/)?.[1])
                .filter(Boolean)
        );

        console.log(`✅ Found ${ranges.length} ranges:`, ranges);
        return ranges;
    });
}

// ─── STEP 2: GET NUMBERS IN A RANGE ─────────────────────────
async function fetchNumbersForRange(rangeName) {
    const { from, to } = getDateRange();
    const html = await pagePost('/portal/sms/received/getsms/number', {
        start: from, end: to, range: rangeName,
    });

    const $ = cheerio.load(html);
    const numbers = [];

    // onclick="getDetialsNumberXXXXX('PHONENUMBER','ID')"
    $('[onclick]').each((_, el) => {
        const match = $(el).attr('onclick')?.match(/getDetialsNumber\w+\('(\d{7,15})'/);
        if (match && !numbers.includes(match[1])) numbers.push(match[1]);
    });

    console.log(`  📱 ${rangeName}: ${numbers.length} number(s)`);
    return numbers;
}

// ─── STEP 3: GET SMS FOR A NUMBER ───────────────────────────
async function fetchSmsForNumber(number, rangeName) {
    const { from, to } = getDateRange();
    const html = await pagePost('/portal/sms/received/getsms/number/sms', {
        start: from, end: to, Number: number, Range: rangeName,
    });

    const $ = cheerio.load(html);
    const messages = [];

    // Try specific selectors first, then fall back to <p> tags
    const selectors = [
        '.col-9.col-sm-6.text-center.text-sm-start p',
        '.sms-text', '.sms-message', '.message-content p',
        'table tbody tr td:nth-child(3)',
    ];

    for (const sel of selectors) {
        $(sel).each((_, el) => {
            const text = $(el).text().trim();
            if (text.length > 5 && !messages.includes(text)) messages.push(text);
        });
        if (messages.length > 0) break;
    }

    if (messages.length === 0) {
        $('p').each((_, el) => {
            const text = $(el).text().trim();
            if (text.length > 10 && text.length < 500 && !messages.includes(text)) messages.push(text);
        });
    }

    if (messages.length > 0) console.log(`  💬 ${number}: ${messages.length} SMS`);
    return messages;
}

// ─── MAIN: FETCH ALL NEW SMS ─────────────────────────────────
async function fetchAllSms() {
    if (!isPageReady()) {
        console.log('⏸ Page not ready (session refresh in progress) — skipping cycle');
        return [];
    }

    try {
        let ranges = await fetchSmsRanges();

        // If 0 ranges, do ONE retry after 3s — handles page not fully loaded
        if (ranges.length === 0 && isPageReady()) {
            console.log('↩️  0 ranges — waiting 3s and retrying once...');
            await new Promise(r => setTimeout(r, 3000));
            if (!isPageReady()) return [];
            ranges = await fetchSmsRanges();
        }

        if (ranges.length === 0) return [];

        await detectNewRanges(ranges);

        // Fetch numbers for all ranges in parallel
        const rangeResults = await Promise.all(
            ranges.map(rangeName =>
                fetchNumbersForRange(rangeName)
                    .then(numbers => ({ rangeName, numbers }))
                    .catch(() => ({ rangeName, numbers: [] }))
            )
        );

        // Fetch SMS for all numbers in parallel
        const smsResults = await Promise.all(
            rangeResults.flatMap(({ rangeName, numbers }) =>
                numbers.map(number =>
                    fetchSmsForNumber(number, rangeName)
                        .then(smsList => ({ number, rangeName, smsList }))
                        .catch(() => ({ number, rangeName, smsList: [] }))
                )
            )
        );

        // First run — seed all existing SMS as seen, send nothing
        if (!seenInitialised) {
            await seedSeenSms(smsResults);
            return [];
        }

        // Filter to only new SMS
        const seen = loadSeenSms();
        const newMessages = [];

        for (const { number, rangeName, smsList } of smsResults) {
            const country      = extractCountry(rangeName);
            const countryEmoji = getCountryEmoji(country);

            for (const smsText of smsList) {
                const msgId = makeMsgId(number, smsText);
                if (seen.has(msgId)) continue;

                const otp = extractOTP(smsText);
                newMessages.push({
                    id:        msgId,
                    phone:     number,
                    otp:       otp || null,
                    service:   extractService(smsText),
                    message:   smsText,
                    timestamp: new Date().toISOString(),
                    country:   `${countryEmoji} ${country}`,
                    range:     rangeName,
                    hasOtp:    !!otp,
                });

                seen.add(msgId);
            }
        }

        if (newMessages.length > 0) {
            saveSeenSms(seen);
            console.log(`🆕 ${newMessages.length} new SMS`);
        }

        return newMessages;

    } catch (err) {
        console.error('fetchAllSms error:', err.message);
        return [];
    }
}

// ─── MY NUMBERS via Live SMS API (fast, no pagination) ──────
// Uses /portal/live/my_sms to get termination_id per range,
// then /portal/live/getNumbers to get all numbers as clean JSON
async function getMyNumbers(forceRefresh = false) {
    if (!forceRefresh) {
        try {
            const cache = JSON.parse(fs.readFileSync(NUMBERS_CACHE_FILE, 'utf8'));
            if (Date.now() - cache.timestamp < NUMBERS_CACHE_TTL) {
                console.log(`✅ Cached numbers (${cache.numbers.length})`);
                return cache.numbers;
            }
        } catch (e) {}
    }

    return withPageLock(async () => {
        const page = getPage();
        if (!page) return [];

        console.log('📥 Fetching numbers via Live SMS API...');

        // ── Step 1: Fetch Live SMS page HTML in background (no navigation) ──
        // We fetch the page as HTML using the browser context so CF cookies are included,
        // then parse the accordion to extract termination_id per range name
        const liveHtml = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            return res.ok ? res.text() : null;
        }, LIVE_SMS_PAGE_URL);

        if (!liveHtml) {
            console.log('⚠️ Could not fetch Live SMS page');
            return [];
        }

        // Parse accordion: <a data-id="553671">IVORY COAST 6518</a>
        const $ = cheerio.load(liveHtml);
        const ranges = [];
        $('#accordion a[data-id]').each((_, el) => {
            const id   = $(el).attr('data-id');
            const name = $(el).text().trim();
            if (id && name) ranges.push({ id, name });
        });

        if (ranges.length === 0) {
            console.log('⚠️ No ranges found on Live SMS page');
            return [];
        }

        console.log(`📋 Found ${ranges.length} range(s): ${ranges.map(r => r.name).join(', ')}`);

        // ── Step 2: Fetch numbers for each range in parallel ──
        const seenNums = new Map();

        await Promise.all(ranges.map(async ({ id, name }) => {
            try {
                const text = await pagePost(LIVE_NUMBERS_URL, { termination_id: id });
                const json = JSON.parse(text);
                const nums = json
                    .map(item => String(item.Number))
                    .filter(n => /^\d{7,15}$/.test(n));

                nums.forEach(num => {
                    if (!seenNums.has(num)) {
                        seenNums.set(num, [num, name]);
                    }
                });

                console.log(`  📱 ${name}: ${nums.length} number(s)`);
            } catch (err) {
                console.error(`  ❌ Failed to fetch numbers for ${name}:`, err.message);
            }
        }));

        console.log(`✅ ${seenNums.size} total numbers fetched`);

        // Navigate back to SMS page
        await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await refreshSession().catch(() => {});

        const allNumbers = [...seenNums.values()]; // [ [num, rangeName], ... ]
        if (allNumbers.size > 0) {
            fs.writeFileSync(NUMBERS_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), numbers: allNumbers }));
        }

        return allNumbers
    });
}


async function getCountryRanges(forceRefresh = false) {
    const numbers = await getMyNumbers(forceRefresh);
    return numbers.reduce((acc, [num, range]) => {
        if (!acc[range]) acc[range] = num;
        return acc;
    }, {});
}

async function getNumbersByRange() {
    const numbers = await getMyNumbers(true);
    return numbers.reduce((acc, [num, range]) => {
        (acc[range] = acc[range] || []).push(num);
        return acc;
    }, {});
}

async function detectNewRanges(currentRanges) {
    try {
        let known = [];
        try { known = JSON.parse(fs.readFileSync(KNOWN_RANGES_FILE, 'utf8')); } catch (e) {}
        const newRanges = currentRanges.filter(r => !known.includes(r));
        if (newRanges.length > 0 || known.length === 0) {
            fs.writeFileSync(KNOWN_RANGES_FILE, JSON.stringify([...new Set([...known, ...currentRanges])]));
        }
        return newRanges;
    } catch (e) { return []; }
}

module.exports = {
    fetchSmsRanges, fetchNumbersForRange, fetchSmsForNumber,
    fetchAllSms, getMyNumbers, getCountryRanges,
    getNumbersByRange, detectNewRanges, escapeHtml,
};
