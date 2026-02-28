const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const fs         = require('fs');
const path       = require('path');

const {
    BOT_TOKEN, GROUP_ID, ADMIN_PASSWORD, CHANNEL_LINK, PORT, FILE_CHANNEL_LINK,
    extractCountry, getCountryEmoji, isAdmin, maskPhone, PANEL_LINK, OTP_CHANNEL_LINK
} = require('./config');

const {
    initBrowser, isSessionValid, setSessionCookies,
} = require('./browser');

const {
    fetchAllSms, fetchSmsRanges, fetchNumbersForRange, fetchSmsForNumber,
    getMyNumbers, getCountryRanges, getNumbersByRange, detectNewRanges,
} = require('./fetcher');

// ============================================================
// STATE
// ============================================================
let bot = null;

/**
 * userSessions structure:
 * {
 *   [userId]: {
 *     country: 'IVORY COAST 4769',
 *     number:  '2250700000000',
 *     usedNumbers: [{ number: '...', time: 1234567890 }]
 *   }
 * }
 */
let userSessions = {};

const botStats = {
    startTime:           new Date(),
    totalOtpsSent:       0,
    lastCheck:           'Never',
    lastError:           null,
    isRunning:           false,
    consecutiveFailures: 0,
};

// ============================================================
// OTP HISTORY  (prevents sending the same OTP twice)
// ============================================================
const OTP_HISTORY_FILE = require('./config').OTP_HISTORY_FILE;

function loadOtpHistory() {
    try {
        if (fs.existsSync(OTP_HISTORY_FILE))
            return JSON.parse(fs.readFileSync(OTP_HISTORY_FILE, 'utf8'));
    } catch (e) {}
    return {};
}

function isOtpSent(msgId) {
    return !!loadOtpHistory()[msgId];
}

function markOtpSent(msgId, otp, fullMessage) {
    const history = loadOtpHistory();
    history[msgId] = { otp, fullMessage, timestamp: new Date().toISOString() };
    try { fs.writeFileSync(OTP_HISTORY_FILE, JSON.stringify(history, null, 2)); } catch (e) {}
}

// ============================================================
// MESSAGE FORMATTERS
// ============================================================
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatOtpMessage(data) {
    return (
        `✅ <b>New ${data.service} OTP Received</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏰ <b>Time:</b> ${new Date(data.timestamp).toLocaleString()}\n` +
        `🌍 <b>Country:</b> ${data.country}\n` +
        `🛠 <b>Service:</b> ${data.service}\n` +
        `📱 <b>Number:</b> ${maskPhone(data.phone)}\n` +
        `🔑 <b>OTP:</b> <code>${data.otp}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 <b>Message:</b>\n` +
        `<blockquote>${escapeHtml(data.message)}</blockquote>`
    );
}

// ============================================================
// KEYBOARDS
// ============================================================
function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📱 Get Number',            callback_data: 'get_number'  }],
            [
                { text: '📊 Status', callback_data: 'status' },
                { text: '📈 Stats',  callback_data: 'stats'  },
            ],
            [{ text: '🔍 Check OTPs Now',         callback_data: 'check'       }],
            [{ text: '🧪 Send Test OTP',           callback_data: 'test'        }],
            [{ text: '🔬 Debug: Fetch Raw SMS',    callback_data: 'test_fetch'  }],
        ],
    };
}

function numberAssignedKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔄 Change Number',  callback_data: 'change_number'  }],
            [{ text: '🌍 Change Country', callback_data: 'change_country' }],
            [{ text: '🏠 Main Menu',      callback_data: 'menu'           }],
        ],
    };
}

function otpActionButtons() {
    return {
        inline_keyboard: [[
            { text: '🚀 Panel',   url: PANEL_LINK },
            { text: '📢 Channel', url: CHANNEL_LINK },
        ],
         [
            { text: '📁 File Channel',   url: FILE_CHANNEL_LINK },
            { text: '🔑 OTP Channel',    url: OTP_CHANNEL_LINK },
         ]],
    };
}

// ============================================================
// HELPERS — number assignment
// ============================================================
function getAvailablePool(rangeNumbers, session) {
    const oneHourAgo    = Date.now() - 60 * 60 * 1000;
    const recentlyUsed  = (session.usedNumbers || [])
        .filter(u => u.time > oneHourAgo)
        .map(u => u.number);
    const currentlyTaken = Object.values(userSessions)
        .map(s => s.number)
        .filter(Boolean);

    // Prefer numbers not used in last hour and not taken right now
    const preferred = rangeNumbers.filter(
        n => !recentlyUsed.includes(n) && !currentlyTaken.includes(n)
    );
    // Fallback: any number not currently taken
    const fallback = rangeNumbers.filter(n => !currentlyTaken.includes(n));

    return preferred.length > 0 ? preferred : fallback;
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function updateSession(userId, rangeName, assignedNumber) {
    const session     = userSessions[userId] || {};
    const oneHourAgo  = Date.now() - 60 * 60 * 1000;
    const prevUsed    = (session.usedNumbers || []).filter(u => u.time > oneHourAgo);

    userSessions[userId] = {
        country:     rangeName,
        number:      assignedNumber,
        usedNumbers: [...prevUsed, { number: assignedNumber, time: Date.now() }],
    };
}

function findUserWithNumber(phone) {
    for (const [userId, session] of Object.entries(userSessions)) {
        if (session.number === phone) return userId;
    }
    return null;
}

// ============================================================
// SEND OTP TO GROUP (and DM the assigned user if any)
// ============================================================
async function sendOtpToGroup(data) {
    try {
        if (isOtpSent(data.id)) return false;

        const msg = formatOtpMessage(data);

        // Send to group
        await bot.sendMessage(GROUP_ID, msg, {
            parse_mode:   'HTML',
            reply_markup: otpActionButtons(),
        });

        // DM the user who has this number assigned
        const assignedUser = findUserWithNumber(data.phone);
        if (assignedUser) {
            try {
                await bot.sendMessage(assignedUser, msg, { parse_mode: 'HTML' });
                await bot.sendMessage(
                    assignedUser,
                    `🔑 Your OTP: <code>${data.otp}</code>\n✅ Number session cleared — request a new number anytime.`,
                    { parse_mode: 'HTML' }
                );
                delete userSessions[assignedUser];
                console.log(`✅ OTP DMed to user ${assignedUser} — session cleared`);
            } catch (e) {
                console.error(`Could not DM user ${assignedUser}:`, e.message);
            }
        }

        markOtpSent(data.id, data.otp, data.message);
        botStats.totalOtpsSent++;
        console.log(`✅ OTP sent: ${data.otp} | ${data.service} | ${data.country}`);
        return true;

    } catch (err) {
        console.error('Failed to send OTP:', err.message);
        return false;
    }
}

// ============================================================
// ALERT NEW RANGES
// ============================================================
async function alertNewRanges(newRanges) {
    try {
        const lines = newRanges.map(r => {
            const emoji = getCountryEmoji(extractCountry(r));
            return `${emoji} <b>${r}</b>`;
        }).join('\n');

        await bot.sendMessage(GROUP_ID,
            `🆕 <b>New Range(s) Detected!</b>\n\n${lines}`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}
}

// ============================================================
// BOT HANDLERS
// ============================================================
function setupBotHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        await bot.sendMessage(
            msg.chat.id,
            '🏠 <b>Welcome to NEXUSBOT!</b>\n\nI monitor IVASMS for new OTPs and forward them instantly.',
            { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
        );
    });

    // Callback queries
    bot.on('callback_query', async (query) => {
        const chatId    = query.message.chat.id;
        const userId    = query.from.id;
        const data      = query.data;
        const messageId = query.message.message_id;

        await bot.answerCallbackQuery(query.id).catch(() => {});

        // Helper to edit the current message
        const edit = (text, keyboard) => bot.editMessageText(text, {
            chat_id:      chatId,
            message_id:   messageId,
            parse_mode:   'HTML',
            reply_markup: keyboard || mainMenuKeyboard(),
        });

        // ── MAIN MENU ──────────────────────────────────────
        if (data === 'menu') {
            await edit('🏠 <b>Main Menu</b>\n\nChoose an option:');

        // ── GET NUMBER / CHANGE COUNTRY ────────────────────
        } else if (data === 'get_number' || data === 'change_country') {

            // ADMIN → send txt files per range
            if (isAdmin(userId)) {
                await edit('👑 <b>Admin: Fetching all numbers by range...</b>');
                try {
                    const grouped    = await getNumbersByRange();
                    const rangeNames = Object.keys(grouped);

                    if (rangeNames.length === 0) {
                        await edit('⚠️ No numbers found.');
                        return;
                    }

                    await edit(`✅ Sending ${rangeNames.length} file(s)...`);

                    for (const rangeName of rangeNames) {
                        const nums     = grouped[rangeName];
                        const content  = `Range: ${rangeName}\nTotal: ${nums.length}\n\n${nums.join('\n')}`;
                        const fileName = `${rangeName.replace(/\s+/g, '_')}.txt`;
                        const tmpPath  = path.join(__dirname, fileName);
                        fs.writeFileSync(tmpPath, content);

                        await bot.sendDocument(chatId, tmpPath, {
                            caption:      `${getCountryEmoji(extractCountry(rangeName))} <b>${rangeName}</b> — ${nums.length} numbers`,
                            parse_mode:   'HTML',
                        });

                        fs.unlinkSync(tmpPath);
                        await new Promise(r => setTimeout(r, 300));
                    }

                    await bot.sendMessage(chatId, '✅ <b>All range files sent!</b>',
                        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                    );
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ Error: ${err.message}`,
                        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                    );
                }
                return;
            }

            // NORMAL USER → show country selector
            await edit('🌍 <b>Loading available countries...</b>');

            const ranges    = await getCountryRanges();
            const rangeKeys = Object.keys(ranges);

            if (rangeKeys.length === 0) {
                await edit('⚠️ <b>No numbers available right now.</b>\n\nTry again later.');
                return;
            }

            const keyboard = [];
            let row = [];
            for (const rangeName of rangeKeys.slice(0, 20)) {
                const emoji = getCountryEmoji(extractCountry(rangeName));
                const safe  = `country_${rangeName}`.replace(/[^\x20-\x7E]/g, '').substring(0, 64);
                if (safe === 'country_') continue;
                row.push({ text: `${emoji} ${rangeName}`, callback_data: safe });
                if (row.length === 2) { keyboard.push(row); row = []; }
            }
            if (row.length > 0) keyboard.push(row);
            keyboard.push([{ text: '🔄 Refresh Numbers', callback_data: 'refresh_numbers' }]);
            keyboard.push([{ text: '🏠 Main Menu',       callback_data: 'menu'            }]);

            await edit('🌍 <b>Select Country:</b>', { inline_keyboard: keyboard });

        // ── REFRESH NUMBERS ────────────────────────────────
        } else if (data === 'refresh_numbers') {
            await edit('🔄 <b>Refreshing numbers cache...</b>');
            const ranges = await getCountryRanges(true);
            const count  = Object.keys(ranges).length;
            await edit(`✅ <b>Refreshed! Found ${count} country ranges.</b>`);

        // ── COUNTRY SELECTED ───────────────────────────────
        } else if (data.startsWith('country_')) {
            const rangeName    = data.replace('country_', '');
            const numbers      = await getMyNumbers();
            const rangeNumbers = numbers
                .filter(row => row.length >= 2 && row[1].replace(/[^\x20-\x7E]/g, '') === rangeName)
                .map(row => row[0]);

            if (rangeNumbers.length === 0) {
                await edit('⚠️ <b>No numbers available for this range.</b>');
                return;
            }

            const session = userSessions[userId] || {};
            const pool    = getAvailablePool(rangeNumbers, session);

            if (pool.length === 0) {
                await edit('⚠️ <b>All numbers are currently in use.</b>\n\nTry again shortly.');
                return;
            }

            const assignedNumber = pickRandom(pool);
            updateSession(userId, rangeName, assignedNumber);

            const emoji = getCountryEmoji(extractCountry(rangeName));
            await edit(
                `✅ <b>Number Assigned!</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `${emoji} <b>Range:</b> ${rangeName}\n` +
                `📱 <b>Number:</b> <code>${assignedNumber}</code>\n` +
                `🟢 <b>Status:</b> Ready to receive OTP\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Use this number to register. Your OTP will be sent to you automatically!`,
                numberAssignedKeyboard()
            );

        // ── CHANGE NUMBER (same country) ───────────────────
        } else if (data === 'change_number') {
            const session    = userSessions[userId] || {};
            const rangeName  = session.country;
            const currentNum = session.number;

            if (!rangeName) {
                await edit('⚠️ No country selected. Please select a country first.');
                return;
            }

            const numbers      = await getMyNumbers();
            const rangeNumbers = numbers
                .filter(row => row.length >= 2 && row[1].replace(/[^\x20-\x7E]/g, '') === rangeName)
                .map(row => row[0]);

            const pool = getAvailablePool(
                rangeNumbers.filter(n => n !== currentNum),
                session
            );

            if (pool.length === 0) {
                await edit('⚠️ <b>No other numbers available right now.</b>', numberAssignedKeyboard());
                return;
            }

            const assignedNumber = pickRandom(pool);
            updateSession(userId, rangeName, assignedNumber);

            const emoji = getCountryEmoji(extractCountry(rangeName));
            await edit(
                `🔄 <b>New Number Assigned!</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `${emoji} <b>Range:</b> ${rangeName}\n` +
                `📱 <b>Number:</b> <code>${assignedNumber}</code>\n` +
                `🟢 <b>Status:</b> Ready to receive OTP\n` +
                `━━━━━━━━━━━━━━━━━━━━`,
                numberAssignedKeyboard()
            );

        // ── CHECK OTPs NOW ─────────────────────────────────
        } else if (data === 'check') {
            await edit('🔍 <b>Checking for new OTPs...</b>');
            const messages = await fetchAllSms();
            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) { await sendOtpToGroup(msg); sent++; }
            }
            await edit(
                sent > 0
                    ? `✅ <b>Found and forwarded ${sent} new OTP(s)!</b>`
                    : '📭 <b>No new OTPs found.</b>\n\nChecking automatically every 10 seconds.'
            );

        // ── STATUS ─────────────────────────────────────────
        } else if (data === 'status') {
            const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
            await edit(
                `📊 <b>NEXUSBOT Status</b>\n\n` +
                `⏱ <b>Uptime:</b> ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                `📨 <b>OTPs Sent:</b> ${botStats.totalOtpsSent}\n` +
                `🕐 <b>Last Check:</b> ${botStats.lastCheck}\n` +
                `🔐 <b>Session:</b> ${isSessionValid() ? '🟢 Valid' : '🔴 Invalid'}\n` +
                `🟢 <b>Monitor:</b> ${botStats.isRunning ? 'Running' : 'Stopped'}\n` +
                `👥 <b>Active Sessions:</b> ${Object.keys(userSessions).length}\n` +
                `❌ <b>Last Error:</b> ${botStats.lastError || 'None'}`
            );

        // ── STATS ──────────────────────────────────────────
        } else if (data === 'stats') {
            const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
            await edit(
                `📈 <b>Detailed Statistics</b>\n\n` +
                `⏱ <b>Started:</b> ${botStats.startTime.toLocaleString()}\n` +
                `⏱ <b>Uptime:</b> ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                `📨 <b>Total OTPs Sent:</b> ${botStats.totalOtpsSent}\n` +
                `🕐 <b>Last Check:</b> ${botStats.lastCheck}\n` +
                `🔁 <b>Check Interval:</b> Every 10 seconds\n` +
                `👥 <b>Active Sessions:</b> ${Object.keys(userSessions).length}\n` +
                `🟢 <b>Monitor Running:</b> ${botStats.isRunning ? 'Yes' : 'No'}`
            );

        // ── TEST OTP ───────────────────────────────────────
        } else if (data === 'test') {
            await sendOtpToGroup({
                id:        'test_' + Date.now(),
                phone:     '5841620932',
                otp:       '947444',
                service:   'WhatsApp',
                country:   '🇻🇪 Venezuela',
                timestamp: new Date().toISOString(),
                message:   '# Your WhatsApp code 947-444\nDont share this code with others\n4sgLq1p5sV6',
            });
            await edit('✅ <b>Test OTP sent to the group!</b>');

        // ── DEBUG: FETCH RAW SMS ───────────────────────────
        } else if (data === 'test_fetch') {
            await edit('🔍 <b>Fetching raw SMS from portal...</b>');

            try {
                const ranges = await fetchSmsRanges();

                if (ranges.length === 0) {
                    await edit('⚠️ No ranges found — try again in a moment.');
                    return;
                }

                // Pick random range
                const randomRange = pickRandom(ranges);
                await bot.sendMessage(chatId,
                    `📡 Range picked: <b>${randomRange}</b>\nFetching numbers...`,
                    { parse_mode: 'HTML' }
                );

                const numbers = await fetchNumbersForRange(randomRange);

                if (numbers.length === 0) {
                    await bot.sendMessage(chatId,
                        `⚠️ No numbers found in <b>${randomRange}</b>\nCheck console for raw HTML.`,
                        { parse_mode: 'HTML' }
                    );
                    return;
                }

                await bot.sendMessage(chatId,
                    `📱 <b>${numbers.length} number(s) found:</b>\n<code>${numbers.join('\n')}</code>`,
                    { parse_mode: 'HTML' }
                );

                // Pick random number and fetch SMS
                const randomNumber = pickRandom(numbers);
                await bot.sendMessage(chatId,
                    `🔍 Fetching SMS for: <code>${randomNumber}</code>`,
                    { parse_mode: 'HTML' }
                );

                const smsList = await fetchSmsForNumber(randomNumber, randomRange);

                if (smsList.length === 0) {
                    await bot.sendMessage(chatId,
                        `📭 No SMS found for <code>${randomNumber}</code>\n\nCheck console for raw HTML output.`,
                        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                    );
                    return;
                }

                for (const sms of smsList) {
                    await bot.sendMessage(chatId,
                        `📨 <b>Raw SMS:</b>\n<blockquote>${sms}</blockquote>`,
                        { parse_mode: 'HTML' }
                    );
                }

                await bot.sendMessage(chatId,
                    `✅ Done! Found <b>${smsList.length}</b> SMS message(s).`,
                    { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                );

            } catch (err) {
                await bot.sendMessage(chatId,
                    `❌ Error: <code>${err.message}</code>`,
                    { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                );
            }
        }
    });
}

// ============================================================
// BACKGROUND OTP MONITOR
// ============================================================
async function backgroundMonitor() {
    botStats.isRunning = true;
    console.log('🔍 Background OTP monitor started');

    while (botStats.isRunning) {
        try {
            console.log('Checking for new OTPs...');
            const messages = await fetchAllSms();
            botStats.lastCheck = new Date().toLocaleString();

            // Alert on new ranges
            const rangesThisCycle = [...new Set(messages.map(m => m.range).filter(Boolean))];
            if (rangesThisCycle.length > 0) {
                const newRanges = await detectNewRanges(rangesThisCycle);
                if (newRanges.length > 0) await alertNewRanges(newRanges);
            }

            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) {
                    await sendOtpToGroup(msg);
                    sent++;
                }
            }

            if (sent > 0) console.log(`📨 Sent ${sent} new OTP(s)`);
            else          console.log('No new OTPs found');

            botStats.consecutiveFailures = 0;
            await new Promise(r => setTimeout(r, 10000));

        } catch (err) {
            console.error('Monitor error:', err.message);
            botStats.lastError = err.message;
            botStats.consecutiveFailures++;

            if (botStats.consecutiveFailures >= 5) {
                console.warn('⚠️ 5 consecutive failures — reinitializing browser...');
                await initBrowser();
                botStats.consecutiveFailures = 0;
            } else {
                await new Promise(r => setTimeout(r, 30000));
            }
        }
    }
}

// ============================================================
// EXPRESS SERVER (admin panel + API endpoints)
// ============================================================
function setupExpress() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Health check
    app.get('/', (req, res) => {
        const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
        res.json({
            status:        'running',
            bot:           'NEXUSBOT',
            uptime:        `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            totalOtpsSent: botStats.totalOtpsSent,
            lastCheck:     botStats.lastCheck,
            sessionValid:  isSessionValid(),
        });
    });

    // Detailed status
    app.get('/status', (req, res) => {
        const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
        res.json({
            uptime:         `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            totalOtpsSent:  botStats.totalOtpsSent,
            lastCheck:      botStats.lastCheck,
            isRunning:      botStats.isRunning,
            sessionValid:   isSessionValid(),
            lastError:      botStats.lastError,
            activeSessions: Object.keys(userSessions).length,
        });
    });

    // Update cookies from admin panel
    app.post('/update-cookies', (req, res) => {
        const { password, cookies } = req.body;
        if (password !== ADMIN_PASSWORD)
            return res.status(403).json({ error: 'Invalid password' });
        if (!cookies || !Array.isArray(cookies))
            return res.status(400).json({ error: 'Invalid cookies format' });

        setSessionCookies(cookies);
        initBrowser().then(() =>
            res.json({ success: true, message: `Updated ${cookies.length} cookies`, sessionValid: isSessionValid() })
        );
    });

    // Trigger OTP check manually
    app.get('/check', async (req, res) => {
        try {
            const messages = await fetchAllSms();
            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) { await sendOtpToGroup(msg); sent++; }
            }
            res.json({ success: true, found: messages.length, sent });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Force re-login
    app.get('/relogin', async (req, res) => {
        try {
            const result = await initBrowser();
            res.json({ success: result, sessionValid: isSessionValid() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Refresh numbers cache
    app.get('/refresh-numbers', async (req, res) => {
        try {
            const numbers = await getMyNumbers(true);
            res.json({ success: true, count: numbers.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Admin panel HTML
    app.get('/admin', (req, res) => {
        res.send(`<!DOCTYPE html>
<html>
<head>
    <title>NEXUSBOT Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
            min-height:100vh; padding:20px;
            display:flex; align-items:center; justify-content:center;
        }
        .container {
            background:white; border-radius:16px;
            box-shadow:0 20px 60px rgba(0,0,0,0.3);
            max-width:800px; width:100%; padding:40px;
        }
        h1 { color:#333; margin-bottom:30px; font-size:24px; }
        .status {
            background:#f8f9fa; padding:15px; border-radius:8px;
            margin-bottom:20px; line-height:1.9; font-size:14px;
        }
        label { font-size:13px; color:#666; font-weight:600; }
        input, textarea {
            width:100%; padding:12px; margin:6px 0 16px;
            border:2px solid #e0e0e0; border-radius:8px; font-size:14px;
            transition:border-color .2s;
        }
        input:focus, textarea:focus { outline:none; border-color:#667eea; }
        button {
            background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
            color:white; border:none; padding:14px; border-radius:8px;
            width:100%; cursor:pointer; font-size:16px; font-weight:600;
            margin-top:4px; transition:opacity .2s;
        }
        button:hover { opacity:.9; }
        .btn-danger {
            background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);
            margin-top:10px;
        }
        .alert {
            padding:14px; margin-top:16px; border-radius:8px; display:none;
            font-size:14px;
        }
        .success { background:#d4edda; color:#155724; border:1px solid #c3e6cb; }
        .error   { background:#f8d7da; color:#721c24; border:1px solid #f5c6cb; }
    </style>
</head>
<body>
<div class="container">
    <h1>🤖 NEXUSBOT Admin Panel</h1>

    <div class="status" id="status">⏳ Loading status...</div>

    <label>Admin Password</label>
    <input type="password" id="password" placeholder="Enter admin password">

    <label>Cookies (JSON array)</label>
    <textarea id="cookies" rows="10" placeholder='Paste cookies JSON array here...'></textarea>

    <button onclick="updateCookies()">🔄 Update Cookies</button>
    <button class="btn-danger" onclick="relogin()">🔁 Force Re-Login</button>

    <div class="alert" id="alert"></div>
</div>
<script>
    async function loadStatus() {
        try {
            const res = await fetch('/status');
            const d   = await res.json();
            document.getElementById('status').innerHTML =
                '🔐 Session: '   + (d.sessionValid ? '✅ Valid'  : '❌ Invalid') +
                '<br>📨 OTPs Sent: ' + d.totalOtpsSent +
                '<br>🕐 Last Check: ' + d.lastCheck +
                '<br>👥 Active Sessions: ' + d.activeSessions +
                '<br>🟢 Monitor: ' + (d.isRunning ? 'Running' : 'Stopped') +
                (d.lastError ? '<br>❌ Last Error: ' + d.lastError : '');
        } catch (e) {
            document.getElementById('status').textContent = '⚠️ Could not load status';
        }
    }

    async function showAlert(msg, success) {
        const el = document.getElementById('alert');
        el.className = 'alert ' + (success ? 'success' : 'error');
        el.textContent = msg;
        el.style.display = 'block';
    }

    async function updateCookies() {
        try {
            const cookies = JSON.parse(document.getElementById('cookies').value);
            const res = await fetch('/update-cookies', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    password: document.getElementById('password').value,
                    cookies,
                }),
            });
            const data = await res.json();
            showAlert(res.ok ? '✅ ' + data.message : '❌ ' + data.error, res.ok);
            if (res.ok) setTimeout(loadStatus, 3000);
        } catch (err) {
            showAlert('❌ ' + err.message, false);
        }
    }

    async function relogin() {
        showAlert('🔁 Re-login started — browser will open...', true);
        const res  = await fetch('/relogin');
        const data = await res.json();
        showAlert(data.success ? '✅ Re-login successful!' : '❌ Re-login failed', data.success);
        setTimeout(loadStatus, 2000);
    }

    loadStatus();
    setInterval(loadStatus, 10000);
</script>
</body>
</html>`);
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server running on port ${PORT}`);
        console.log(`📝 Admin panel: http://localhost:${PORT}/admin`);
    });

    return app;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    setupBotHandlers,
    backgroundMonitor,
    setupExpress,
    sendOtpToGroup,
    alertNewRanges,
    botStats,
    initBot: () => {
        bot = new TelegramBot(BOT_TOKEN, { polling: true });
        return bot;
    },
    getBot: () => bot,
};
