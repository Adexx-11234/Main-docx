const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const {
    NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE, NUMBERS_CACHE_TTL, NUMBERS_PAGE_URL,
    PORTAL_URL, extractOTP, extractService, extractCountry, getCountryEmoji, getDateRange,
} = require('./config');

const { getCsrfToken, getPage, isPageReady, ensureOnSmsPage, setCsrfToken, refreshSession } = require('./browser');

const SEEN_SMS_FILE = path.join(__dirname, 'seen_sms.json');

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
    if (!isPageReady()) return [];

    try {
        const ranges = await fetchSmsRanges();
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

        // Filter to only new SMS
        const seen = loadSeenSms();
        const newMessages = [];

        for (const { number, rangeName, smsList } of smsResults) {
            const country = extractCountry(rangeName);
            const countryEmoji = getCountryEmoji(country);

            for (const smsText of smsList) {
                const msgId = makeMsgId(number, smsText);
                if (seen.has(msgId)) continue;

                const otp = extractOTP(smsText);
                newMessages.push({
                    id: msgId,
                    phone: number,
                    otp: otp || null,
                    service: extractService(smsText),
                    message: smsText,
                    timestamp: new Date().toISOString(),
                    country: `${countryEmoji} ${country}`,
                    range: rangeName,
                    hasOtp: !!otp,
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

// ─── MY NUMBERS (cached, paginated) ─────────────────────────
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

        console.log('📥 Fetching numbers...');
        const allNumbers = [];

        await page.goto(NUMBERS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        try { await page.select('select[name*="length"]', '100'); await new Promise(r => setTimeout(r, 1500)); } catch (e) {}

        const scrape = async () => {
            const $ = cheerio.load(await page.content());
            $('table tbody tr').each((_, row) => {
                const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
                if (cells.length >= 3 && /^\d{7,15}$/.test(cells[1]) && cells[2]?.trim()
                    && !allNumbers.some(n => n[0] === cells[1])) {
                    allNumbers.push([cells[1].trim(), cells[2].trim()]);
                }
            });
        };

        await scrape();
        for (let p = 1; p < 20; p++) {
            if (await page.$('#MyNumber_next.disabled')) break;
            const next = await page.$('#MyNumber_next');
            if (!next) break;
            await next.click();
            await new Promise(r => setTimeout(r, 1500));
            await scrape();
        }

        console.log(`✅ ${allNumbers.length} numbers fetched`);

        await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await refreshSession().catch(() => {});

        if (allNumbers.length > 0) {
            fs.writeFileSync(NUMBERS_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), numbers: allNumbers }));
        }

        return allNumbers;
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
    getNumbersByRange, detectNewRanges,
};