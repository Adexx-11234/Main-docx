require('dotenv').config();
const path = require('path');

// ============================================================
// ENVIRONMENT
// ============================================================
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID       = process.env.TELEGRAM_GROUP_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const CHANNEL_LINK   = process.env.CHANNEL_LINK   || 'https://t.me/yourchannel';
const DEV_LINK       = process.env.DEV_LINK       || 'https://t.me/yourdev';
const PORT           = process.env.PORT            || 5000;
const PANEL_LINK        = process.env.PANEL_LINK        || 'https://t.me';
const FILE_CHANNEL_LINK = process.env.FILE_CHANNEL_LINK || 'https://t.me';
const OTP_CHANNEL_LINK  = process.env.OTP_CHANNEL_LINK  || 'https://t.me';
// ============================================================
// ADMIN IDS
// ============================================================
const ADMIN_IDS = [1774315698];

// ============================================================
// URLS
// ============================================================
const BASE_URL        = 'https://www.ivasms.com';
const PORTAL_URL      = `${BASE_URL}/portal/sms/received`;
const NUMBERS_PAGE_URL = `${BASE_URL}/portal/numbers`;
const IVAS_EMAIL    = process.env.IVAS_EMAIL    || '';
const IVAS_PASSWORD = process.env.IVAS_PASSWORD || '';
const LOGIN_URL     = `${BASE_URL}/login`;
const LIVE_NUMBERS_URL  = '/portal/live/getNumbers';
const LIVE_SMS_PAGE_URL = `${BASE_URL}/portal/live/my_sms`;

// ============================================================
// FILE PATHS
// ============================================================
const COOKIES_FILE      = path.join(__dirname, 'cookies.json');
const OTP_HISTORY_FILE  = path.join(__dirname, 'otp_history.json');
const NUMBERS_CACHE_FILE = path.join(__dirname, 'numbers_cache.json');
const KNOWN_RANGES_FILE  = path.join(__dirname, 'known_ranges.json');
const SEEN_SMS_FILE      = path.join(__dirname, 'seen_sms.json');

// ============================================================
// TIMING
// ============================================================
const OTP_CHECK_INTERVAL  = 10000;          // 10 seconds
const NUMBERS_CACHE_TTL   = 10 * 60 * 1000; // 10 minutes
const DATE_RANGE_DAYS_BACK = 7;

// ============================================================
// SERVICE DETECTION PATTERNS
// ============================================================
const SERVICE_PATTERNS = {
    WhatsApp:  /whatsapp|wa\.me|wassap|whtsapp/i,
    Facebook:  /facebook|fb\.me|fb\-|meta/i,
    Telegram:  /telegram|t\.me|telegrambot/i,
    Google:    /google|gmail|goog|g\.co|accounts\.google/i,
    Twitter:   /twitter|x\.com|twtr/i,
    Instagram: /instagram|insta\b|ig\b/i,
    Apple:     /apple|icloud|appleid/i,
    Amazon:    /amazon|amzn/i,
    Microsoft: /microsoft|msft|outlook|hotmail/i,
    PayPal:    /paypal/i,
    Netflix:   /netflix/i,
    Uber:      /\buber\b/i,
    TikTok:    /tiktok/i,
    LinkedIn:  /linkedin/i,
    Spotify:   /spotify/i,
    Lalamove:  /lalamove/i,
};

// ============================================================
// COUNTRY FLAGS
// ============================================================
const COUNTRY_FLAGS = {
    'Nigeria':'🇳🇬', 'Benin':'🇧🇯',     'Ghana':'🇬🇭',    'Kenya':'🇰🇪',
    'USA':'🇺🇸',     'UK':'🇬🇧',         'France':'🇫🇷',   'Germany':'🇩🇪',
    'India':'🇮🇳',   'China':'🇨🇳',       'Brazil':'🇧🇷',   'Canada':'🇨🇦',
    'Ivory':'🇨🇮',   'Cote':'🇨🇮',        "Cote d'Ivoire":'🇨🇮',
    'Algeria':'🇩🇿', 'Madagascar':'🇲🇬',  'Senegal':'🇸🇳',  'Cameroon':'🇨🇲',
    'Tanzania':'🇹🇿','Uganda':'🇺🇬',      'Ethiopia':'🇪🇹', 'Egypt':'🇪🇬',
    'Morocco':'🇲🇦', 'Russia':'🇷🇺',      'Ukraine':'🇺🇦',  'Poland':'🇵🇱',
    'Indonesia':'🇮🇩','Philippines':'🇵🇭','Vietnam':'🇻🇳',  'Thailand':'🇹🇭',
    'Malaysia':'🇲🇾','Pakistan':'🇵🇰',    'Bangladesh':'🇧🇩','Mexico':'🇲🇽',
    'Colombia':'🇨🇴','Argentina':'🇦🇷',   'Chile':'🇨🇱',    'Peru':'🇵🇪',
    'Venezuela':'🇻🇪','South Africa':'🇿🇦','Sudan':'🇸🇩',   'Mozambique':'🇲🇿',
    'Angola':'🇦🇴',  'Zimbabwe':'🇿🇼',    'Zambia':'🇿🇲',   'Rwanda':'🇷🇼',
    'Malawi':'🇲🇼',  'Togo':'🇹🇬',        'Mali':'🇲🇱',     'Niger':'🇳🇪',
    'Burkina':'🇧🇫', 'Guinea':'🇬🇳',      'Gabon':'🇬🇦',    'Congo':'🇨🇬',
    'Chad':'🇹🇩',    'Somalia':'🇸🇴',     'Libya':'🇱🇾',    'Tunisia':'🇹🇳',
    'Saudi':'🇸🇦',   'UAE':'🇦🇪',         'Iraq':'🇮🇶',     'Iran':'🇮🇷',
    'Turkey':'🇹🇷',  'Israel':'🇮🇱',      'Jordan':'🇯🇴',   'Lebanon':'🇱🇧',
    'Syria':'🇸🇾',   'Yemen':'🇾🇪',       'Afghanistan':'🇦🇫','Nepal':'🇳🇵',
    'Myanmar':'🇲🇲', 'Cambodia':'🇰🇭',    'Sri Lanka':'🇱🇰','Taiwan':'🇹🇼',
    'South Korea':'🇰🇷','Japan':'🇯🇵',    'Australia':'🇦🇺','New Zealand':'🇳🇿',
    'Spain':'🇪🇸',   'Italy':'🇮🇹',       'Portugal':'🇵🇹', 'Netherlands':'🇳🇱',
    'Belgium':'🇧🇪', 'Sweden':'🇸🇪',      'Norway':'🇳🇴',   'Denmark':'🇩🇰',
    'Finland':'🇫🇮', 'Switzerland':'🇨🇭', 'Austria':'🇦🇹',  'Romania':'🇷🇴',
    'Hungary':'🇭🇺', 'Czech':'🇨🇿',       'Slovakia':'🇸🇰', 'Bulgaria':'🇧🇬',
    'Serbia':'🇷🇸',  'Croatia':'🇭🇷',     'Greece':'🇬🇷',   'Bolivia':'🇧🇴',
    'Ecuador':'🇪🇨', 'Paraguay':'🇵🇾',    'Uruguay':'🇺🇾',  'Cuba':'🇨🇺',
    'Haiti':'🇭🇹',   'Dominican':'🇩🇴',   'Guatemala':'🇬🇹','Honduras':'🇭🇳',
    'Nicaragua':'🇳🇮','Costa':'🇨🇷',      'Panama':'🇵🇦',   'Jamaica':'🇯🇲',
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/** Extract first word of range name as country e.g. "IVORY COAST 4769" → "IVORY" */
function extractCountry(rangeName) {
    if (!rangeName) return 'Unknown';
    return rangeName.trim().split(' ')[0] || 'Unknown';
}

/** Get flag emoji for a country name */
function getCountryEmoji(countryName) {
    if (!countryName) return '🌍';
    for (const [key, emoji] of Object.entries(COUNTRY_FLAGS)) {
        if (countryName.toLowerCase().includes(key.toLowerCase())) return emoji;
    }
    return '🌍';
}

/** Detect which service an SMS is from */
function extractService(message) {
    if (!message) return 'Unknown';
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
        if (pattern.test(message)) return service;
    }
    return 'Unknown';
}

/** Extract OTP code from SMS text */
function extractOTP(text) {
    if (!text) return null;
    // First try: numbers with hyphens (e.g., 179-997)
    const hyphenMatch = text.match(/\b(\d{3,4})-(\d{3,4})\b/);
    if (hyphenMatch) return hyphenMatch[1] + hyphenMatch[2]; // Return without hyphen
    
    // Second try: plain numbers
    const match = text.match(/\b(\d{4,8})\b/);
    return match ? match[1] : null;
}

/** Check if a user ID is an admin */
function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
}

// ─── HTML ESCAPE (prevents Telegram 400 on special chars) ────
function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Get date range for SMS queries
 * Returns both YYYY-MM-DD (for POST requests) and d-m-y (for input display)
 */
function getDateRange() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - DATE_RANGE_DAYS_BACK);

    // YYYY-MM-DD for POST body
    function fmtPost(d) {
        const year  = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day   = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // d-m-y for the datepicker input fields on the page
    function fmtDisplay(d) {
        return `${d.getDate()}-${d.getMonth() + 1}-${String(d.getFullYear()).slice(-2)}`;
    }

    return {
        from:        fmtPost(start),    // e.g. "2026-02-20"
        to:          fmtPost(today),    // e.g. "2026-02-28"
        fromDisplay: fmtDisplay(start), // e.g. "20-2-26"
        toDisplay:   fmtDisplay(today), // e.g. "28-2-26"
    };
}

/** Mask phone number for display e.g. 2347037100300 → 2347***0300 */
function maskPhone(phone) {
    if (!phone || phone.length <= 6) return phone;
    return phone.substring(0, 4) + '***' + phone.slice(-4);
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    // Env
    BOT_TOKEN, GROUP_ID, ADMIN_PASSWORD, CHANNEL_LINK, DEV_LINK, PORT, PANEL_LINK, FILE_CHANNEL_LINK, OTP_CHANNEL_LINK,
    // Admin
    ADMIN_IDS,
    // URLs
    BASE_URL, PORTAL_URL, NUMBERS_PAGE_URL, IVAS_EMAIL, IVAS_PASSWORD, LOGIN_URL, LIVE_SMS_PAGE_URL, LIVE_NUMBERS_URL, 
    // Files
    COOKIES_FILE, OTP_HISTORY_FILE, NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE, SEEN_SMS_FILE, 
    // Timing
    OTP_CHECK_INTERVAL, NUMBERS_CACHE_TTL,
    // Data
    SERVICE_PATTERNS, COUNTRY_FLAGS,
    // Functions
    extractCountry, getCountryEmoji, extractService,
    extractOTP, isAdmin, getDateRange, maskPhone, escapeHtml,
};
