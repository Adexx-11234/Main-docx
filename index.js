const { BOT_TOKEN, GROUP_ID, OTP_CHECK_INTERVAL } = require('./config');
const { initBrowser, loadCookies }                = require('./browser');
const {
    initBot, getBot,
    setupBotHandlers,
    backgroundMonitor,
    setupExpress,
} = require('./bot');

// ============================================================
// STARTUP
// ============================================================
async function main() {
    console.log('═══════════════════════════════════════');
    console.log('         🤖  NEXUSBOT  STARTING         ');
    console.log('═══════════════════════════════════════');

    // Validate required env vars
    if (!BOT_TOKEN) { console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env'); process.exit(1); }
    if (!GROUP_ID)  { console.error('❌ Missing TELEGRAM_GROUP_ID in .env');  process.exit(1); }

    // ── 1. Load saved cookies ──────────────────────────────
    loadCookies();

    // ── 2. Init Telegram bot + handlers ───────────────────
    const bot = initBot();
    setupBotHandlers();
    console.log('✅ Telegram bot polling started');

    // ── 3. Start Express admin server ─────────────────────
    setupExpress();

    // ── 4. Launch browser + login + CF bypass ─────────────
    console.log('🌐 Initializing browser...');
    const sessionReady = await initBrowser();

    // ── 5. Startup message to group ───────────────────────
    try {
        await bot.sendMessage(
            GROUP_ID,
            `🚀 <b>NEXUSBOT Started!</b>\n\n` +
            `${sessionReady
                ? '✅ Session ready — OTP monitor is active'
                : '⚠️ Session not ready — visit /admin to update cookies'
            }\n` +
            `🔁 Checking every ${OTP_CHECK_INTERVAL / 1000} seconds`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('Could not send startup message:', err.message);
    }

    // ── 6. Start background OTP monitor ───────────────────
    console.log('🔍 Starting OTP monitor...');
    backgroundMonitor();
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGTERM', () => {
    console.log('📴 SIGTERM received — shutting down...');
    const bot = getBot();
    if (bot) bot.stopPolling();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📴 SIGINT received — shutting down...');
    const bot = getBot();
    if (bot) bot.stopPolling();
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err.message);
    // Don't exit — let the monitor keep running
});

// ============================================================
// RUN
// ============================================================
main().catch(err => {
    console.error('💥 Fatal startup error:', err.message);
    process.exit(1);
});