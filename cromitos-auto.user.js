// ==UserScript==
// @name         Cromitos Auto
// @namespace    https://github.com/PoxiiTV/cromitos-auto
// @author       Poxi
// @license      MIT
// @version      1.0.0
// @description  Vende cromos y objetos de Steam en lote, y mantiene tus anuncios bien de precio. / Bulk-sell Steam cards and keep listings priced right.
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/market*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Design notes -- read these before changing anything.
 *
 * Steam Economy Enhancer broke because it read its data out of Steam's own
 * markup and injected its controls into Steam's own tables. When Valve shipped
 * the Market Beta UI in mid-2026, the selectors stopped matching and the
 * features went with them.
 *
 * So this script does two things differently, and they are the whole point:
 *
 *   1. Data comes from JSON endpoints, never from the rendered page.
 *   2. The UI is our own floating panel. We never inject into Steam's layout.
 *
 * A Steam redesign can therefore change how the page looks without taking this
 * script with it. There are two deliberate exceptions:
 *
 *   - parseMyListingsPage(): /market/mylistings returns the listing rows as an
 *     HTML blob and there is no JSON alternative for your own listings. Item
 *     identity still comes from the JSON `assets` and `hovers` fields; only the
 *     price is scraped, and it is sanity-checked against the order book before
 *     anything acts on it.
 *   - expandListingsOnPage(): showing every listing instead of ten at a time is
 *     inherently a change to Steam's page, so it is the one thing that writes
 *     into Steam's DOM. It fails quietly and changes nothing if the layout moves.
 *
 * On the Market Beta UI, inspected against a live account on 17 August 2026:
 * it is a RESTYLE, NOT A REWRITE. #tabContentsMyActiveMarketListingsRows,
 * .market_listing_row, the mylisting_<id> ids and MergeWithAssetArray are all
 * still there. What did change is the price cell -- see extractBuyerPrice(),
 * which is where that cost real money.
 *
 * Endpoints, verified working on 17 August 2026:
 *
 *   GET  /market/orderbook?q=Load&qp=[appid,"hash_name"]
 *        The good one. Full buy+sell depth, prices as integer cents, no
 *        item_nameid lookup needed. Works logged out.
 *   GET  /inventory/{steamid}/{appid}/{contextid}?l=english&count=2000
 *   GET  /market/mylistings?count=100&start=N
 *   POST /market/sellitem/          (price = what the SELLER receives, in cents)
 *   POST /market/removelisting/{listingid}
 *
 * Note: /market/itemordershistogram now answers {"success":104} and is dead.
 * If you find it referenced anywhere, that reference is stale.
 */

(function () {
    'use strict';

    // Page context. With @grant none `window` is already the page's window;
    // the unsafeWindow branch keeps us working if a grant is ever added.
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    const ORIGIN = window.location.origin;

    /*
     * Shown in the panel footer, and it earns its place.
     *
     * Userscript managers check for updates on their own schedule -- daily by
     * default in Violentmonkey -- so after a fix is published you keep running
     * the old script until it gets round to noticing. That happened here, and
     * from the outside an old script looks exactly like a fix that did not
     * work: the same failure, in the same words, with the bug already fixed
     * upstream. An hour went into diagnosing a stale copy.
     *
     * Keep in step with @version above. `_check_version_matches_header` in
     * tests/run.js fails the suite if the two ever drift.
     */
    const VERSION = '1.0.0';

    // ---------------------------------------------------------------- config

    const SETTINGS_KEY = 'cromitos_auto_v1';

    const DEFAULTS = {
        lang: 'es',
        // Milliseconds between requests to Steam. Steam has had an IP-based
        // market rate limit since October 2022; going faster than about one
        // request a second earns a 429 that lasts several minutes.
        requestDelayMs: 1200,
        // Random extra delay on top, so the traffic is not metronomic.
        requestJitterMs: 400,
        // How long to wait out a 429 before retrying.
        rateLimitBackoffMs: 30000,
        maxRetries: 4,

        // Undercut the lowest competing listing by this many cents.
        undercutCents: 1,

        // A listing is YELLOW ("too low") when it sits at least this far below
        // the price it could be charging while still being the cheapest.
        // Both thresholds must be met, so cheap cards do not all go yellow.
        tooLowAbsCents: 2,
        tooLowPercent: 5,

        // Sell only items you own more than one of, keeping one of each.
        onlyDuplicates: false,

        // Put every listing on Steam's page rather than ten at a time.
        showAllOnPage: true,

        // Whether "mispriced" includes the too-cheap ones. Red is always in.
        includeLow: true,

        // Order books are cached for the session so a rescan is cheap.
        cacheOrderBooks: true,

        // Safety rail. No single run will touch more than this many items.
        maxItemsPerRun: 500
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
        } catch {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveSettings(s) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {
            /* private browsing, storage full -- settings just will not persist */
        }
    }

    let settings = loadSettings();

    // ----------------------------------------------------------------- i18n

    const I18N = {
        es: {
            brand: 'Cromitos Auto',
            titleInventory: 'Inventario',
            titleListings: 'Anuncios',
            collapse: 'Minimizar',
            ready: 'Listo',
            sellAll: 'Vender todo',
            sellDupes: 'Solo duplicados',
            stop: 'Detener',
            scan: 'Escanear anuncios',
            relist: 'Republicar',
            remove: 'Quitar mal puestos',
            undercut: 'Bajar del más barato',
            cents: 'cénts.',
            delay: 'Pausa entre peticiones',
            ms: 'ms',
            confirmNote: 'Cada anuncio hay que confirmarlo en la app de Steam.',
            showAll: 'Mostrar todos los anuncios en la página, no de 10 en 10',
            includeLow: 'Incluir los que están demasiado baratos (ámbar)',
            tooLowPct: 'Barato si baja más de',
            percent: '%',
            chipFair: 'bien',
            chipHigh: 'caros',
            chipLow: 'baratos',
            chipUnknown: 'sin datos',
            stopping: 'Parando tras la petición en curso…',
            noSteamId: 'No pude saber de quién es este inventario. ¿Estás conectado?',
            readingInv: 'Leyendo inventario…',
            readingInvOf: 'Leyendo inventario {app}/{ctx}…',
            readingInvCount: 'Leyendo inventario… {n} objetos',
            invSummary: '{all} objetos, {marketable} se pueden vender.',
            dupesKept: '{n} duplicados (me quedo con uno de cada).',
            runLimited: 'Esta pasada se limita a {n} objetos.',
            nothingToSell: 'No hay nada que vender.',
            failed: 'Falló',
            pricing: 'Tasando {groups} tipos ({n} a publicar)…',
            noPrice: '{name}: sin precio ({err})',
            noBook: '{name}: nadie compra ni vende, lo salto',
            listingN: 'Publicando {done} de {total}…',
            listedAt: 'Publicado {name} a {buyer} (tú recibes {seller})',
            sellDone: 'Hecho. Publicados {listed}, fallidos {failed}, saltados {skipped}. Si se venden todos, recibes {expected}.',
            confirmApp: 'Ahora abre la app de Steam y confirma los anuncios.',
            listedCount: 'Publicados {n}',
            loadingListings: 'Cargando todos los anuncios…',
            noListings: 'Sin anuncios',
            showingAll: 'Mostrando los {n} anuncios en la página.',
            expandFail: 'No pude expandir la página: {err}',
            loadListingsFail: 'No pude cargar los anuncios: {err}',
            listingsJustLoaded: '{n} anuncios de venta activos (recién cargados).',
            listingsCount: '{n} anuncios de venta activos.',
            readingListings: 'Leyendo anuncios…',
            readingListingsN: 'Leyendo anuncios… {n}/{total}',
            checkingN: 'Comprobando {n} objetos distintos…',
            checkingPrices: 'Comprobando precios… {n}/{total}',
            scanSummary: 'Bien {fair}, caros {high}, baratos {low}, sin datos {unknown}.',
            scanComplete: 'Escaneo listo',
            nothingMispriced: 'No hay nada mal puesto.',
            relistingN: 'Republicando {n} anuncios…',
            removingN: 'Quitando {n} anuncios…',
            removingProgress: 'Quitando {n}/{total}…',
            removedAt: 'Quitado {name} a {price}',
            removedCount: 'Quitados {n} anuncios.',
            removedStatus: 'Quitados {n}',
            waitingReturn: 'Esperando a que vuelvan al inventario…',
            waitingReturnLog: 'Esperando a que los objetos vuelvan al inventario…',
            cannotRelistId: 'No puedo republicar: no sé tu Steam ID en esta página',
            rereadInv: 'Releyendo inventario {app}/{ctx}…',
            expectedBack: '{name}: esperaba {count} de vuelta, encontré {found}',
            nothingBack: 'No volvió nada para republicar. Prueba a escanear en un minuto.',
            nothingToRelist: 'Nada que republicar',
            bootReady: 'Listo.',
            rateGiveUp: 'Steam te ha limitado (429); lo dejo',
            rateWait: 'Límite de peticiones. Espero {s}s…',
            invPrivate: 'No pude leer el inventario (¿está en público?)',
            stoppedPaging: 'Paré de paginar el inventario a las 40 páginas.',
            listingsFail: 'No pude leer tus anuncios del mercado',
            badJson: 'Steam devolvió una respuesta que no es JSON',
            noOrderBook: 'libro de órdenes no disponible',
            sellRefused: 'Steam rechazó el anuncio'
        },
        en: {
            brand: 'Cromitos Auto',
            titleInventory: 'Inventory',
            titleListings: 'Listings',
            collapse: 'Collapse',
            ready: 'Ready',
            sellAll: 'Sell everything',
            sellDupes: 'Duplicates only',
            stop: 'Stop',
            scan: 'Scan listings',
            relist: 'Relist',
            remove: 'Remove mispriced',
            undercut: 'Undercut lowest by',
            cents: 'cents',
            delay: 'Delay between requests',
            ms: 'ms',
            confirmNote: 'Every listing needs a confirmation in the Steam mobile app.',
            showAll: 'Show all listings on the page, not 10 at a time',
            includeLow: 'Include listings that are too low (amber)',
            tooLowPct: 'Too low if under by',
            percent: '%',
            chipFair: 'fair',
            chipHigh: 'high',
            chipLow: 'low',
            chipUnknown: 'unknown',
            stopping: 'Stopping after the current request…',
            noSteamId: 'Could not work out whose inventory this is — are you logged in?',
            readingInv: 'Reading inventory…',
            readingInvOf: 'Reading inventory {app}/{ctx}…',
            readingInvCount: 'Reading inventory… {n} items',
            invSummary: '{all} items, {marketable} marketable.',
            dupesKept: '{n} duplicates (one of each kept).',
            runLimited: 'Limiting this run to {n} items.',
            nothingToSell: 'Nothing to sell.',
            failed: 'Failed',
            pricing: 'Pricing {groups} distinct items ({n} to list)…',
            noPrice: '{name}: no price ({err})',
            noBook: '{name}: nobody is buying or selling, skipped',
            listingN: 'Listing {done} of {total}…',
            listedAt: 'Listed {name} at {buyer} (you get {seller})',
            sellDone: 'Done. Listed {listed}, failed {failed}, skipped {skipped}. If they all sell you receive {expected}.',
            confirmApp: 'Now open the Steam mobile app and confirm the listings.',
            listedCount: 'Listed {n}',
            loadingListings: 'Loading all listings…',
            noListings: 'No listings',
            showingAll: 'Showing all {n} listings on the page.',
            expandFail: 'Could not expand the page: {err}',
            loadListingsFail: 'Could not load all listings: {err}',
            listingsJustLoaded: '{n} active sell listings (just loaded).',
            listingsCount: '{n} active sell listings.',
            readingListings: 'Reading listings…',
            readingListingsN: 'Reading listings… {n}/{total}',
            checkingN: 'Checking {n} distinct items…',
            checkingPrices: 'Checking prices… {n}/{total}',
            scanSummary: 'Fair {fair}, too high {high}, too low {low}, unknown {unknown}.',
            scanComplete: 'Scan complete',
            nothingMispriced: 'Nothing is mispriced.',
            relistingN: 'Relisting {n} listings…',
            removingN: 'Removing {n} listings…',
            removingProgress: 'Removing {n}/{total}…',
            removedAt: 'Removed {name} at {price}',
            removedCount: 'Removed {n} listings.',
            removedStatus: 'Removed {n}',
            waitingReturn: 'Waiting for items to return to inventory…',
            waitingReturnLog: 'Waiting for the items to come back to the inventory…',
            cannotRelistId: 'Cannot relist: could not determine your Steam ID on this page',
            rereadInv: 'Re-reading inventory {app}/{ctx}…',
            expectedBack: '{name}: expected {count} back, found {found}',
            nothingBack: 'Nothing came back to relist. Try scanning again in a minute.',
            nothingToRelist: 'Nothing to relist',
            bootReady: 'Ready.',
            rateGiveUp: 'Rate limited by Steam (429), giving up',
            rateWait: 'Rate limited. Waiting {s}s…',
            invPrivate: 'Could not read the inventory (is it set to public?)',
            stoppedPaging: 'Stopped paging the inventory after 40 pages.',
            listingsFail: 'Could not read your market listings',
            badJson: 'Steam returned a non-JSON response',
            noOrderBook: 'order book unavailable',
            sellRefused: 'Steam refused the listing'
        }
    };

    function currentLang() {
        return settings.lang === 'en' ? 'en' : 'es';
    }

    function t(key, vars) {
        const pack = I18N[currentLang()] || I18N.es;
        let s = pack[key] || I18N.es[key] || key;
        if (vars) {
            s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
        }
        return s;
    }

    function applyLang() {
        if (!UI.panel) {
            return;
        }
        UI.panel.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        UI.panel.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.title = t(el.dataset.i18nTitle);
        });
        UI.panel.querySelectorAll('[data-lang]').forEach((el) => {
            el.classList.toggle('is-on', el.dataset.lang === currentLang());
        });
        if (typeof UI.onLang === 'function') {
            UI.onLang();
        }
    }

    function setLang(lang) {
        settings.lang = lang === 'en' ? 'en' : 'es';
        saveSettings(settings);
        applyLang();
    }

    // ----------------------------------------------------------------- utils

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function readCookie(name) {
        const parts = document.cookie.split(';');
        for (const part of parts) {
            const c = part.trim();
            if (c.startsWith(`${name}=`)) {
                return decodeURIComponent(c.substring(name.length + 1));
            }
        }
        return null;
    }

    function sessionId() {
        return readCookie('sessionid');
    }

    /*
     * Turn a Steam-rendered price into integer cents.
     *
     * Steam formats by locale, so this sees "0,35€", "$0.35", "1.234,56€" and
     * "1,234.56" and has to tell a decimal separator from a thousands one.
     * The rule: the last separator is a decimal separator only if exactly one
     * or two digits follow it. "1.234" is therefore 1234, not 1.23.
     *
     * Zero-decimal currencies (JPY, KRW, ...) would defeat that rule, so they
     * are listed explicitly and skip the inference. Whatever this returns is
     * cross-checked against the order book before we act on it -- see
     * classifyListing() -- so a misparse shows up as "unknown", not as a trade.
     */
    const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'IDR', 'VND', 'CLP', 'COP', 'CRC', 'UYU', 'TWD', 'KZT', 'UAH']);

    function parsePriceToCents(text) {
        if (text == null) {
            return null;
        }

        /*
         * Only the FIRST money-looking token, never the whole string.
         *
         * A beta-UI price cell holds "0,05€ (0,03€)" -- the buyer price and
         * then the seller price. Stripping non-digits from all of it and
         * parsing the result read a five-cent listing as 5003 cents, or
         * fifty euros three. Taking the first token is right for both the
         * one-price and two-price layouts.
         */
        const token = String(text).match(/\d[\d.,]*/);
        if (!token) {
            return null;
        }

        const cleaned = token[0].replace(/[.,]+$/, '');
        if (cleaned === '') {
            return null;
        }

        const digitsOnly = cleaned.replace(/[.,]/g, '');
        if (digitsOnly === '') {
            return null;
        }

        if (ZERO_DECIMAL_CURRENCIES.has(currencyCode())) {
            return parseInt(digitsOnly, 10);
        }

        const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
        if (lastSep === -1) {
            // No separator at all: a bare "35" is 35 whole units, not 35 cents.
            return parseInt(digitsOnly, 10) * 100;
        }

        const fraction = cleaned.substring(lastSep + 1);
        if (fraction.length < 1 || fraction.length > 2) {
            // Thousands separator, no decimal part.
            return parseInt(digitsOnly, 10) * 100;
        }

        const whole = cleaned.substring(0, lastSep).replace(/[.,]/g, '') || '0';
        return parseInt(whole, 10) * 100 + parseInt(fraction.padEnd(2, '0'), 10);
    }

    function currencyCode() {
        try {
            const id = W.g_rgWalletInfo && W.g_rgWalletInfo.wallet_currency;
            if (id && typeof W.GetCurrencyCode === 'function') {
                return W.GetCurrencyCode(id);
            }
        } catch {
            /* fall through */
        }
        return 'EUR';
    }

    function formatCents(cents) {
        if (cents == null || Number.isNaN(cents)) {
            return '--';
        }
        if (ZERO_DECIMAL_CURRENCIES.has(currencyCode())) {
            return `${cents} ${currencyCode()}`;
        }
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: currencyCode()
            }).format(cents / 100);
        } catch {
            return (cents / 100).toFixed(2);
        }
    }

    // ------------------------------------------------------------------- net

    /*
     * One serialized queue for every request this script makes, so the pacing
     * is global. Two features running at once still share one pipe to Steam,
     * which is the only way the rate limit stays respected.
     */
    const Net = {
        chain: Promise.resolve(),
        stopped: false,
        inFlight: 0,

        stop() {
            this.stopped = true;
        },

        reset() {
            this.stopped = false;
        },

        enqueue(fn) {
            const run = this.chain.then(async () => {
                if (this.stopped) {
                    throw new Error('stopped');
                }
                const result = await fn();
                await sleep(settings.requestDelayMs + Math.random() * settings.requestJitterMs);
                return result;
            });
            // Keep the chain alive even when a link rejects.
            this.chain = run.catch(() => {});
            return run;
        }
    };

    async function rawFetch(url, options = {}) {
        const init = {
            method: options.method || 'GET',
            credentials: 'include',
            headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {})
        };

        if (options.body) {
            init.body = options.body;
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }

        const response = await fetch(url, init);
        return response;
    }

    /*
     * A queued request with 429 handling. Returns parsed JSON, or null when
     * `tolerateEmpty` is set and the body is not JSON (some Steam endpoints
     * answer with an empty body on success).
     */
    async function request(url, options = {}) {
        return Net.enqueue(async () => {
            let attempt = 0;

            for (;;) {
                if (Net.stopped) {
                    throw new Error('stopped');
                }

                let response;
                try {
                    response = await rawFetch(url, options);
                } catch (e) {
                    if (attempt++ >= settings.maxRetries) {
                        throw new Error(`network error: ${e.message}`);
                    }
                    await sleep(2000 * attempt);
                    continue;
                }

                if (response.status === 429) {
                    if (attempt++ >= settings.maxRetries) {
                    throw new Error(t('rateGiveUp'));
                }
                UI.log(t('rateWait', { s: Math.round(settings.rateLimitBackoffMs / 1000) }), 'warn');
                    await sleep(settings.rateLimitBackoffMs);
                    continue;
                }

                if (response.status === 401 || response.status === 403) {
                    throw new Error(`not authorised (${response.status}) -- are you still logged in?`);
                }

                const text = await response.text();

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
                }

                if (!text) {
                    return options.tolerateEmpty ? null : {};
                }

                try {
                    return JSON.parse(text);
                } catch {
                    if (options.tolerateEmpty) {
                        return null;
                    }
                    throw new Error(t('badJson'));
                }
            }
        });
    }

    function formEncode(data) {
        return Object.keys(data)
            .filter((k) => data[k] !== undefined && data[k] !== null)
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(data[k])}`)
            .join('&');
    }

    // ------------------------------------------------------------------ fees

    /*
     * Steam's own fee maths, which we prefer to use directly when the page has
     * defined it. Our copy is a fallback and follows the December 2025 rule
     * change: twelve currencies round rather than floor, and both the Steam fee
     * and the publisher fee have a minimum.
     */
    const ROUNDING_CURRENCIES = new Set([
        'JPY', 'IDR', 'UAH', 'CLP', 'COP', 'TWD', 'KZT', 'CRC', 'UYU', 'KRW', 'VND'
    ]);

    function walletInfo() {
        return W.g_rgWalletInfo || null;
    }

    function publisherFeeFor(item) {
        const wi = walletInfo();
        if (item && item.market_fee != null) {
            return parseFloat(item.market_fee);
        }
        if (wi && wi.wallet_publisher_fee_percent_default != null) {
            return parseFloat(wi.wallet_publisher_fee_percent_default);
        }
        return 0.10;
    }

    function amountToSendForDesiredReceived(received, publisherFee) {
        if (typeof W.CalculateAmountToSendForDesiredReceivedAmount === 'function') {
            try {
                return W.CalculateAmountToSendForDesiredReceivedAmount(received, publisherFee, walletInfo());
            } catch {
                /* fall through to our own copy */
            }
        }

        const wi = walletInfo();
        if (!wi || !wi.wallet_fee) {
            return { amount: received, fees: 0, steam_fee: 0, publisher_fee: 0 };
        }

        const roundFee = ROUNDING_CURRENCIES.has(currencyCode()) ? Math.round : Math.floor;
        const minFee = parseInt(wi.wallet_fee_minimum, 10) || 1;
        const pf = publisherFee == null ? 0 : publisherFee;

        const steamFee = Math.max(
            roundFee(received * parseFloat(wi.wallet_fee_percent) + parseInt(wi.wallet_fee_base, 10)),
            minFee
        );
        const pubFee = pf > 0 ? Math.max(roundFee(received * pf), minFee) : 0;

        return {
            steam_fee: steamFee,
            publisher_fee: pubFee,
            fees: steamFee + pubFee,
            amount: received + steamFee + pubFee
        };
    }

    /*
     * Given what the buyer pays, what does the seller receive?
     *
     * Steam's fee function only runs the other way, so this searches for the
     * seller price whose buyer total is the one we want.
     *
     * Not every buyer price is reachable. With a 5% Steam fee and a 10%
     * publisher fee, both floored, a seller who receives 19 makes the buyer pay
     * 21 and a seller who receives 20 makes them pay 23 -- so 22 is a price no
     * listing can have. Roughly one buyer price in eight is a gap like that.
     *
     * When we land in a gap we must round DOWN, never up. Rounding up is the
     * dangerous direction: asked to undercut a 23-cent listing by a cent we
     * would list at 23 again and not undercut anything, which is exactly the
     * bug this function exists to avoid.
     */
    function priceBeforeFees(buyerPrice, item) {
        const wi = walletInfo();
        if (!wi || !wi.wallet_fee) {
            return buyerPrice;
        }

        const pf = publisherFeeFor(item);
        const amount = Math.round(buyerPrice);

        let estimate = parseInt(
            (amount - parseInt(wi.wallet_fee_base, 10)) /
                (parseFloat(wi.wallet_fee_percent) + pf + 1),
            10
        );
        if (!Number.isFinite(estimate) || estimate < 1) {
            estimate = 1;
        }

        let fees = amountToSendForDesiredReceived(estimate, pf);
        let undershot = false;

        for (let i = 0; i < 12 && fees.amount !== amount; i++) {
            if (fees.amount > amount) {
                if (undershot) {
                    // We stepped up from a price that was too low and landed
                    // above the target: the target is unreachable. Step back
                    // to the last value that did not overshoot.
                    estimate--;
                    break;
                }
                estimate--;
            } else {
                undershot = true;
                estimate++;
            }
            if (estimate < 1) {
                estimate = 1;
                break;
            }
            fees = amountToSendForDesiredReceived(estimate, pf);
        }

        estimate = Math.max(1, estimate);

        // Belt and braces: whatever the search did, never return a seller price
        // whose buyer total exceeds what we were asked for.
        while (estimate > 1 && amountToSendForDesiredReceived(estimate, pf).amount > amount) {
            estimate--;
        }

        return estimate;
    }

    // ---------------------------------------------------------- steam market

    const orderBookCache = new Map();

    // Comfortably more than any one scan needs -- a 500-listing account has
    // well under this many distinct items -- while still having a ceiling.
    const ORDER_BOOK_CACHE_MAX = 600;

    /*
     * Reshape an /market/orderbook response into the book the rest of the
     * script uses. Returns null when Steam does not know the item.
     *
     * THE NESTING IS THE TRAP, and it fails silently. The payload is
     *
     *     { data: { success: true, data: { amtMinSellOrder, ... } } }
     *
     * so `success` sits one level ABOVE the order figures. Version 1.0.0
     * unwrapped both levels and then tested `success` on the inner object,
     * where it is undefined -- so every item on every scan was rejected with
     * "order book unavailable" and the feature never worked once. Nothing
     * pointed at the nesting; it looked exactly like Steam being down.
     *
     * rgCompactSellOrders is a flat [price, qty, price, qty, ...] list in
     * ascending price order, already in integer cents and inclusive of fees --
     * that is, what a buyer pays.
     *
     * An item can legitimately succeed with no sellers at all: amtMinSellOrder
     * comes back null and rgCompactSellOrders as []. That is a real book with
     * an empty side, not a failure, and callers must not confuse the two.
     */
    function buildOrderBook(payload) {
        const outer = payload && payload.data;
        if (!outer || !outer.success || !outer.data) {
            return null;
        }

        const d = outer.data;

        const pairs = (flat) => {
            const out = [];
            const arr = Array.isArray(flat) ? flat : [];
            for (let i = 0; i + 1 < arr.length; i += 2) {
                out.push({ price: parseInt(arr[i], 10), quantity: parseInt(arr[i + 1], 10) });
            }
            return out;
        };

        return {
            lowestSell: d.amtMinSellOrder != null ? parseInt(d.amtMinSellOrder, 10) : null,
            highestBuy: d.amtMaxBuyOrder != null ? parseInt(d.amtMaxBuyOrder, 10) : null,
            sellOrders: pairs(d.rgCompactSellOrders),
            buyOrders: pairs(d.rgCompactBuyOrders),
            sellCount: d.cSellOrders,
            buyCount: d.cBuyOrders
        };
    }

    async function getOrderBook(appid, hashName, { bypassCache = false } = {}) {
        const key = `${appid}::${hashName}`;

        if (!bypassCache && settings.cacheOrderBooks && orderBookCache.has(key)) {
            return orderBookCache.get(key);
        }

        const qp = encodeURIComponent(JSON.stringify([Number(appid), hashName]));
        const url = `${ORIGIN}/market/orderbook?q=Load&qp=${qp}`;

        const book = buildOrderBook(await request(url));
        if (book == null) {
            throw new Error(t('noOrderBook'));
        }

        if (settings.cacheOrderBooks) {
            /*
             * Bounded, oldest-out. A book is not small -- the cheap trading
             * cards carry a couple of hundred price levels each -- and the
             * cache had nothing to evict it, so a long session over a large
             * inventory grew it for as long as the tab stayed open. A Map keeps
             * insertion order, so the first key is the oldest.
             */
            while (orderBookCache.size >= ORDER_BOOK_CACHE_MAX) {
                orderBookCache.delete(orderBookCache.keys().next().value);
            }
            orderBookCache.set(key, book);
        }
        return book;
    }

    function invalidateOrderBook(appid, hashName) {
        orderBookCache.delete(`${appid}::${hashName}`);
    }

    // Price is what the SELLER receives, in cents.
    async function sellItem(item, sellerPrice) {
        const url = `${ORIGIN}/market/sellitem/`;
        const body = formEncode({
            sessionid: sessionId(),
            appid: item.appid,
            contextid: item.contextid,
            assetid: item.assetid,
            amount: item.amount || 1,
            price: sellerPrice
        });

        const data = await request(url, {
            method: 'POST',
            body,
            headers: { Referer: `${ORIGIN}/id/me/inventory` }
        });

        if (!data || !data.success) {
            throw new Error((data && data.message) || t('sellRefused'));
        }
        return data;
    }

    async function removeListing(listingId) {
        const url = `${ORIGIN}/market/removelisting/${listingId}`;
        const body = formEncode({ sessionid: sessionId() });

        // A successful cancel answers with an empty body, not with JSON.
        await request(url, { method: 'POST', body, tolerateEmpty: true });
        return true;
    }

    // ------------------------------------------------------------- inventory

    function currentSteamId() {
        if (W.g_steamID) {
            return String(W.g_steamID);
        }
        if (W.g_rgProfileData && W.g_rgProfileData.steamid) {
            return String(W.g_rgProfileData.steamid);
        }
        const m = document.documentElement.innerHTML.match(/g_steamID\s*=\s*"(\d{17})"/);
        return m ? m[1] : null;
    }

    /*
     * Which inventory is on screen. Steam puts it in the URL fragment as
     * "#753_6"; g_ActiveInventory is the fallback and 753/6 (Steam community
     * items -- cards, backgrounds, emoticons) is the last resort, being far
     * and away the most common thing anyone bulk-sells.
     */
    function currentInventoryTarget() {
        const hash = window.location.hash.match(/#(\d+)_(\d+)/);
        if (hash) {
            return { appid: parseInt(hash[1], 10), contextid: hash[2] };
        }
        const inv = W.g_ActiveInventory;
        if (inv && inv.m_appid) {
            return { appid: parseInt(inv.m_appid, 10), contextid: String(inv.m_contextid) };
        }
        return { appid: 753, contextid: '6' };
    }

    /*
     * Fetch a whole inventory from the JSON endpoint, following pagination.
     * Returns flat items with the description merged in, which is the shape
     * the rest of the script expects.
     */
    async function fetchInventory(steamId, appid, contextid, onProgress) {
        const items = [];
        let startAssetId = null;
        let page = 0;

        for (;;) {
            let url = `${ORIGIN}/inventory/${steamId}/${appid}/${contextid}?l=english&count=2000`;
            if (startAssetId) {
                url += `&start_assetid=${startAssetId}`;
            }

            const data = await request(url);
            if (!data || !data.success) {
                throw new Error(t('invPrivate'));
            }

            const descriptions = new Map();
            for (const d of data.descriptions || []) {
                descriptions.set(`${d.classid}_${d.instanceid}`, d);
            }

            for (const asset of data.assets || []) {
                const d = descriptions.get(`${asset.classid}_${asset.instanceid}`);
                if (!d) {
                    continue;
                }
                items.push({
                    appid: asset.appid,
                    contextid: asset.contextid,
                    assetid: asset.assetid,
                    amount: parseInt(asset.amount, 10) || 1,
                    classid: asset.classid,
                    instanceid: asset.instanceid,
                    market_hash_name: d.market_hash_name,
                    name: d.name || d.market_hash_name,
                    marketable: d.marketable === 1 || d.marketable === true,
                    market_fee: d.market_fee,
                    icon_url: d.icon_url
                });
            }

            page++;
            if (onProgress) {
                onProgress(items.length, page);
            }

            /*
             * Stop unless the cursor actually moved.
             *
             * Paging is driven by whatever Steam hands back, so a response that
             * says "more items" while repeating last_assetid would have this
             * loop asking for the same page for ever -- hammering Steam from a
             * background tab with no way to stop it and no error to notice.
             * The page cap is the same guard for an ever-advancing cursor.
             */
            if (!data.more_items || !data.last_assetid || data.last_assetid === startAssetId) {
                return items;
            }
            if (page >= 40) {
                UI.log(t('stoppedPaging'), 'warn');
                return items;
            }

            startAssetId = data.last_assetid;
        }
    }

    /*
     * Keep one of each, list the rest. Grouping is by market_hash_name, since
     * that is what a Steam listing is actually keyed on -- two assets with the
     * same hash name are interchangeable to a buyer.
     */
    function filterDuplicates(items) {
        const seen = new Map();
        const out = [];

        for (const item of items) {
            const n = seen.get(item.market_hash_name) || 0;
            if (n >= 1) {
                out.push(item);
            }
            seen.set(item.market_hash_name, n + 1);
        }
        return out;
    }

    // -------------------------------------------------------------- listings

    /*
     * Read the active sell listings.
     *
     * /market/mylistings answers with JSON that carries the rows as an HTML
     * blob in `results_html`. There is no JSON-only route to your own listings,
     * so this is the single place the script parses markup -- and it takes as
     * little from it as it can:
     *
     *   - item identity (appid, contextid, assetid) comes from the `hovers`
     *     script text, which is generated code rather than layout;
     *   - the item name comes from the `assets` JSON;
     *   - only the price is scraped, and classifyListing() checks it against
     *     the order book before anything acts on it.
     */
    // listingid -> {appid, contextid, assetid}, read out of the `hovers` script
    // text. This is generated code rather than layout, so it survives redesigns
    // that would break a selector.
    function parseHovers(hovers) {
        const map = new Map();
        const re = /CreateItemHoverFromContainer\(\s*g_rgAssets\s*,\s*'mylisting_(\d+)_image'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*,\s*'(\d+)'/g;
        let m;
        while ((m = re.exec(hovers || '')) !== null) {
            map.set(m[1], { appid: m[2], contextid: m[3], assetid: m[4] });
        }
        return map;
    }

    /*
     * The buyer price out of one listing row.
     *
     * The markup changed with the 2026 Market Beta UI and the change is a trap,
     * because the old selector fails to a fallback that returns something
     * plausible-looking and wrong.
     *
     *   Old: two sibling spans, the buyer price carrying its own class.
     *        <span class="market_listing_price market_listing_price_with_fee">0,35€</span>
     *        <span class="market_listing_price market_listing_price_without_fee">0,30€</span>
     *
     *   Beta: ONE cell holding both, the seller price in brackets.
     *        <span class="market_listing_price">
     *          <span title="This is the price the buyer pays.">0,05€</span>
     *          <span title="This is how much you will receive.">(0,03€)</span>
     *        </span>
     *
     * So `market_listing_price_with_fee` no longer exists, and falling back to
     * `market_listing_price` yields the text "0,05€ (0,03€)" -- both numbers at
     * once. Read naively that is 5003 cents.
     *
     * Identifying the buyer price by its `title` would work today and break for
     * anyone whose Steam is not in English, so the rule is structural instead:
     * drop the bracketed part, take the first number that remains.
     *
     * That one rule covers BOTH layouts, which is why there is no special case
     * for the old one. `market_listing_price_with_fee` also carries the plain
     * `market_listing_price` class and comes first, so querySelector finds the
     * buyer price there too. A branch for it was written and then deleted: the
     * sabotage pass showed the tests could not tell whether it was present,
     * which is the definition of code that is not doing anything.
     */
    function extractBuyerPrice(row) {
        const cell = row.querySelector('.market_listing_price');
        if (!cell) {
            return null;
        }

        return parsePriceToCents(cell.textContent.replace(/\([^)]*\)/g, ' '));
    }

    /*
     * Item identity straight from the row's own cancel button, which the beta
     * UI renders as
     *
     *     RemoveMarketListing('mylisting', '<listingid>', <appid>, '<ctx>', '<assetid>')
     *
     * A fallback for when the `hovers` blob does not carry the listing. Being
     * inside the row rather than in a separate script, it is the sturdier of
     * the two -- but hovers stays primary because it is what older layouts have.
     */
    function identityFromRow(row) {
        const href = row.querySelector('.item_market_action_button')?.getAttribute('href') || '';
        const m = href.match(/RemoveMarketListing\(\s*'[^']*'\s*,\s*'(\d+)'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*,\s*'(\d+)'/);
        return m ? { appid: m[2], contextid: m[3], assetid: m[4] } : null;
    }

    // One page of /market/mylistings into listing objects. Split out from the
    // fetch loop so it can be tested against a captured payload.
    function parseMyListingsPage(data, assets) {
        const listings = [];
        const hoverMap = parseHovers(data.hovers);

        const doc = new DOMParser().parseFromString(
            `<table><tbody>${data.results_html || ''}</tbody></table>`,
            'text/html'
        );

        for (const row of doc.querySelectorAll('[id^="mylisting_"]')) {
            const listingId = row.id.replace('mylisting_', '');
            if (!/^\d+$/.test(listingId)) {
                continue;
            }

            // Listings still awaiting a mobile confirmation are not live yet
            // and cannot be cancelled through removelisting.
            const action = row.querySelector('.item_market_action_button');
            const href = (action && action.getAttribute('href')) || '';
            if (/CancelMarketListingConfirmation/i.test(href)) {
                continue;
            }

            const ident = hoverMap.get(listingId) || identityFromRow(row);
            if (!ident) {
                continue;
            }

            const desc =
                assets[ident.appid] &&
                assets[ident.appid][ident.contextid] &&
                assets[ident.appid][ident.contextid][ident.assetid];

            if (!desc || !desc.market_hash_name) {
                continue;
            }

            listings.push({
                listingId,
                appid: parseInt(ident.appid, 10),
                contextid: ident.contextid,
                assetid: ident.assetid,
                market_hash_name: desc.market_hash_name,
                name: desc.name || desc.market_hash_name,
                market_fee: desc.market_fee,
                buyerPrice: extractBuyerPrice(row)
            });
        }

        return listings;
    }

    // Returns { listings, pages, total }. The raw pages are kept so
    // expandListingsOnPage() can put every row on the page without fetching
    // the whole lot a second time.
    async function fetchMyListings(onProgress) {
        const listings = [];
        const pages = [];
        const assets = {};
        let start = 0;
        let total = null;

        for (;;) {
            const url = `${ORIGIN}/market/mylistings?count=100&start=${start}`;
            const data = await request(url);

            if (!data || !data.success) {
                throw new Error(t('listingsFail'));
            }

            if (total == null) {
                total = data.total_count || 0;
            }

            // assets[appid][contextid][assetid] -> description
            for (const appid of Object.keys(data.assets || {})) {
                assets[appid] = assets[appid] || {};
                for (const ctx of Object.keys(data.assets[appid])) {
                    assets[appid][ctx] = Object.assign(assets[appid][ctx] || {}, data.assets[appid][ctx]);
                }
            }

            pages.push(data);
            listings.push(...parseMyListingsPage(data, assets));

            start += 100;
            if (onProgress) {
                onProgress(listings.length, total);
            }

            if (start >= total || !data.results_html) {
                return { listings, pages, total: total || listings.length };
            }
        }
    }

    /*
     * Put every listing on Steam's own page, instead of ten at a time.
     *
     * This is the one place the script writes into Steam's DOM, and it only
     * exists because it is what the page is for. Everything else stays in our
     * own panel precisely so that a redesign cannot break it -- so this is
     * written to fail quietly and change nothing if the layout moves.
     *
     * It survived the Market Beta UI because the beta turned out to be a
     * restyle rather than a rewrite: #tabContentsMyActiveMarketListingsRows,
     * .market_listing_row and MergeWithAssetArray are all still there.
     *
     * Steam's pagination is hidden afterwards rather than left lying: it would
     * still say "Showing 1-10 of 55" over a list of 55, and clicking it would
     * quietly put the ten back.
     */
    function expandListingsOnPage(pages) {
        const container = document.getElementById('tabContentsMyActiveMarketListingsRows');
        if (!container) {
            return { ok: false, reason: 'Steam\'s listing container was not found on this page' };
        }

        const rows = [];
        for (const page of pages) {
            // Steam's own helper, so hover panels and images resolve for rows
            // that were never on this page.
            if (typeof W.MergeWithAssetArray === 'function' && page.assets) {
                try {
                    W.MergeWithAssetArray(page.assets);
                } catch {
                    /* cosmetic only -- the rows still render without it */
                }
            }

            const doc = new DOMParser().parseFromString(
                `<table><tbody>${page.results_html || ''}</tbody></table>`,
                'text/html'
            );
            rows.push(...doc.querySelectorAll('.market_listing_row'));
        }

        if (!rows.length) {
            return { ok: false, reason: 'no listing rows came back' };
        }

        // Steam sometimes repeats a listing across pages while one is being
        // created. Keep the first of each.
        const seen = new Set();
        container.innerHTML = '';
        let added = 0;

        for (const row of rows) {
            if (!row.id || seen.has(row.id)) {
                continue;
            }
            seen.add(row.id);
            container.appendChild(document.importNode(row, true));
            added++;
        }

        const paging = document.getElementById('tabContentsMyActiveMarketListings_ctn');
        if (paging) {
            paging.style.display = 'none';
        }

        return { ok: true, added };
    }

    // --------------------------------------------------------------- pricing

    const VERDICT = {
        FAIR: 'fair',
        HIGH: 'high',
        LOW: 'low',
        UNKNOWN: 'unknown'
    };

    /*
     * Items are keyed "<appid>::<market_hash_name>" and "<appid>::<contextid>::
     * <market_hash_name>". Splitting those back apart with a plain split()
     * and destructuring silently truncates any name that itself contains "::",
     * and a truncated name looks up the wrong order book -- or none, which
     * presents as "order book unavailable" for one item in a long list.
     *
     * Steam hash names are close to free-form, so rather than gamble on "::"
     * never appearing, take a fixed number of fields from the left and let the
     * name keep everything else.
     */
    function splitItemKey(key) {
        const parts = String(key).split('::');
        return { appid: parts[0], hashName: parts.slice(1).join('::') };
    }

    function splitContextKey(key) {
        const parts = String(key).split('::');
        return { appid: parts[0], contextid: parts[1], hashName: parts.slice(2).join('::') };
    }

    /*
     * Work out what the lowest competing listing is -- that is, the book with
     * our own listings taken out of it.
     *
     * This subtraction is the part that is easy to get wrong. If you hold the
     * cheapest listing, the raw lowestSell IS your own price, and comparing
     * against it would tell you you are perfectly placed no matter how far you
     * had undercut yourself.
     *
     * `myQuantities` maps price (cents) -> how many listings of ours sit there.
     */
    function lowestCompetingPrice(book, myQuantities) {
        for (const level of book.sellOrders) {
            const mine = myQuantities.get(level.price) || 0;
            if (level.quantity - mine > 0) {
                return level.price;
            }
        }
        return null;
    }

    /*
     * Colour one listing.
     *
     *   red    -- someone is cheaper than you, so you are not selling
     *   yellow -- you are cheapest, but by more than you needed to be
     *   green  -- you are cheapest by a sensible margin
     *
     * "unknown" means the scraped price did not correspond to any level in the
     * order book while sitting inside its range, which points at a parsing
     * problem rather than a pricing one. We refuse to act on those.
     */
    function classifyListing(listing, book, myQuantities) {
        const mine = listing.buyerPrice;

        if (mine == null || !book || !book.sellOrders.length) {
            return { verdict: VERDICT.UNKNOWN, reason: 'no order book' };
        }

        const levels = book.sellOrders.map((l) => l.price);
        const maxLevel = levels[levels.length - 1];
        if (!levels.includes(mine) && mine < maxLevel) {
            return { verdict: VERDICT.UNKNOWN, reason: 'price not found in book' };
        }

        const competing = lowestCompetingPrice(book, myQuantities);

        if (competing == null) {
            // Nobody else is selling this. Nothing to undercut.
            return {
                verdict: VERDICT.FAIR,
                competing: null,
                target: mine,
                reason: 'only listing'
            };
        }

        const target = Math.max(1, competing - settings.undercutCents);

        if (mine > competing) {
            return { verdict: VERDICT.HIGH, competing, target, reason: 'undercut by others' };
        }

        /*
         * STRICTLY below the best standing buy order, not "at or below".
         *
         * A listing priced exactly at the top buy order is about to be matched
         * and sold. That is a good outcome, not a mistake, and cancelling it
         * would be actively destructive -- Relist acts without confirmation, so
         * nothing would catch it.
         *
         * It is also a price this tool produces itself when the spread is
         * tight, which had the two halves contradicting each other: the pricer
         * created a listing the classifier immediately called mispriced, so
         * Relist would cancel and recreate the same listing indefinitely, at
         * the cost of a mobile confirmation every cycle.
         *
         * Strictly below the best bid remains a real signal: somebody is openly
         * offering more than you are asking.
         */
        if (book.highestBuy != null && mine < book.highestBuy) {
            return { verdict: VERDICT.LOW, competing, target, reason: 'under the top buy order' };
        }

        const gap = target - mine;
        const relative = target > 0 ? (gap / target) * 100 : 0;

        if (gap >= settings.tooLowAbsCents && relative >= settings.tooLowPercent) {
            return { verdict: VERDICT.LOW, competing, target, reason: 'cheaper than it needs to be' };
        }

        return { verdict: VERDICT.FAIR, competing, target, reason: 'lowest, sensibly priced' };
    }

    /*
     * The target buyer price for a fresh listing: `undercutCents` under the
     * cheapest thing on the shelf. When nothing is listed we fall back to the
     * top buy order, and when there is neither we cannot price it at all.
     *
     * The floor at the top buy order is the part worth explaining. Never sell
     * for less than somebody is already openly bidding: below that price the
     * listing is matched instantly anyway, so the only thing the extra
     * undercutting buys is a smaller payment. With a large undercut and a tight
     * spread the naive arithmetic went straight through the bid and out the
     * other side.
     *
     * It also keeps the pricer and classifyListing() agreeing with each other.
     * They disagreed once, and the result was Relist cancelling and recreating
     * the same listing for ever.
     */
    function targetPriceForNewListing(book) {
        if (book.lowestSell != null && book.lowestSell > 0) {
            let target = book.lowestSell - settings.undercutCents;

            if (book.highestBuy != null && book.highestBuy > 0) {
                target = Math.max(target, book.highestBuy);
            }

            // Never above the competition, whatever the floor did.
            target = Math.min(target, book.lowestSell);
            return Math.max(1, target);
        }

        if (book.highestBuy != null && book.highestBuy > 0) {
            return book.highestBuy;
        }
        return null;
    }

    /*
     * The seller price to send to Steam for a wanted buyer price.
     *
     * Not simply priceBeforeFees(), because that rounds DOWN through the gaps
     * that floored fees leave -- and rounding down can step straight past the
     * floor targetPriceForNewListing() just applied. Aiming at the top buy
     * order and landing a cent under it means selling instantly for less than
     * somebody was openly offering, and the classifier then correctly calls
     * the result too cheap, which is the churn loop again by a different route.
     *
     * So: convert, then check what Steam would actually bill the buyer, and
     * step up while that is under the bid and still under the competition.
     */
    function sellerPriceForTarget(buyerTarget, book, item) {
        let seller = priceBeforeFees(buyerTarget, item);

        const floor = book && book.highestBuy != null ? book.highestBuy : 0;
        const ceiling = book && book.lowestSell != null ? book.lowestSell : Infinity;
        const pf = publisherFeeFor(item);
        const buyerFor = (s) => amountToSendForDesiredReceived(s, pf).amount;

        // Bounded by the ceiling, so this cannot run away.
        for (let i = 0; i < 8 && buyerFor(seller) < floor && buyerFor(seller + 1) <= ceiling; i++) {
            seller++;
        }

        return seller;
    }

    // -------------------------------------------------------------------- UI

    const CSS = `
.smh-panel{
  --ca-bg:#070810;--ca-txt:#eef0f7;--ca-dim:#9aa0b6;--ca-faint:#666c84;
  --ca-glass:rgba(255,255,255,.045);--ca-glass-hi:rgba(255,255,255,.085);
  --ca-stroke:rgba(255,255,255,.10);--ca-stroke-soft:rgba(255,255,255,.06);
  --ca-from:#2f7bff;--ca-mid:#7b5cff;--ca-to:#e23aff;
  --ca-grad:linear-gradient(105deg,var(--ca-from) 0%,var(--ca-mid) 48%,var(--ca-to) 100%);
  --ca-green:#54e6a6;--ca-red:#ff5577;--ca-amber:#ffc861;
  --ca-ease:cubic-bezier(.23,1,.32,1);
  position:fixed;right:18px;bottom:18px;width:400px;max-height:82vh;display:flex;flex-direction:column;
  color:var(--ca-txt);
  background:linear-gradient(180deg,rgba(22,24,38,.86),rgba(12,13,24,.9));
  backdrop-filter:blur(28px) saturate(160%);-webkit-backdrop-filter:blur(28px) saturate(160%);
  border:1px solid var(--ca-stroke);border-radius:20px;
  box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(123,92,255,.12),inset 0 1px 0 rgba(255,255,255,.06);
  font:13px/1.45 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;
  z-index:2147483000;overflow:hidden;isolation:isolate
}
.smh-panel::before{
  content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(120% 70% at 12% -20%,rgba(47,123,255,.22),transparent 55%),
             radial-gradient(90% 60% at 110% 110%,rgba(226,58,255,.16),transparent 50%)
}
.smh-head,.smh-body,.smh-foot{position:relative;z-index:1}
.smh-head{
  display:flex;align-items:center;gap:10px;padding:12px 14px 11px;
  border-bottom:1px solid var(--ca-stroke-soft);cursor:move;user-select:none
}
.smh-logo{
  width:28px;height:28px;border-radius:9px;flex:0 0 auto;
  background:var(--ca-grad);display:grid;place-items:center;
  box-shadow:0 8px 18px -8px rgba(123,92,255,.9)
}
.smh-logo svg{width:16px;height:16px;display:block}
.smh-brand{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.smh-brand strong{font-size:13.5px;font-weight:800;letter-spacing:.01em;color:#fff;line-height:1.15}
.smh-brand span{font-size:11px;color:var(--ca-dim);font-weight:600}
.smh-langs{display:flex;gap:4px;background:var(--ca-glass);border:1px solid var(--ca-stroke);border-radius:999px;padding:3px}
.smh-langs button{
  font:700 10px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.04em;
  border:none;background:transparent;color:var(--ca-dim);cursor:pointer;
  padding:5px 8px;border-radius:999px;transition:background .16s var(--ca-ease),color .16s var(--ca-ease)
}
.smh-langs button.is-on{background:var(--ca-grad);color:#fff}
@media (hover:hover) and (pointer:fine){
  .smh-langs button:hover:not(.is-on){color:var(--ca-txt);background:var(--ca-glass-hi)}
}
.smh-min{
  width:30px;height:30px;border-radius:10px;border:1px solid var(--ca-stroke);
  background:var(--ca-glass);color:var(--ca-dim);cursor:pointer;
  display:grid;place-items:center;padding:0;transition:background .16s var(--ca-ease),color .16s var(--ca-ease),transform .12s var(--ca-ease)
}
.smh-min svg{width:14px;height:14px;display:block}
@media (hover:hover) and (pointer:fine){
  .smh-min:hover{background:var(--ca-glass-hi);color:#fff}
}
.smh-min:active{transform:scale(.97)}
.smh-body{padding:12px 14px 10px;overflow:auto;flex:1}
.smh-panel.smh-collapsed .smh-body,.smh-panel.smh-collapsed .smh-foot{display:none}
.smh-row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.smh-btn{
  flex:1;min-width:118px;min-height:38px;padding:8px 12px;border:1px solid var(--ca-stroke);
  border-radius:12px;cursor:pointer;background:var(--ca-glass);color:var(--ca-txt);
  font:700 12.5px/1.2 "Segoe UI",system-ui,sans-serif;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  transition:background .16s var(--ca-ease),border-color .16s var(--ca-ease),transform .12s var(--ca-ease),filter .16s var(--ca-ease)
}
.smh-btn svg{width:14px;height:14px;flex:0 0 auto}
@media (hover:hover) and (pointer:fine){
  .smh-btn:hover:not(:disabled){background:var(--ca-glass-hi);border-color:rgba(255,255,255,.18)}
}
.smh-btn:active:not(:disabled){transform:scale(.97)}
.smh-btn:disabled{opacity:.42;cursor:not-allowed}
.smh-btn.smh-go{background:var(--ca-grad);border:none;color:#fff;box-shadow:0 8px 18px -8px rgba(123,92,255,.75)}
@media (hover:hover) and (pointer:fine){
  .smh-btn.smh-go:hover:not(:disabled){filter:brightness(1.08);background:var(--ca-grad)}
}
.smh-btn.smh-danger{background:rgba(255,85,119,.16);border-color:rgba(255,85,119,.35);color:#ff9eb0}
@media (hover:hover) and (pointer:fine){
  .smh-btn.smh-danger:hover:not(:disabled){background:rgba(255,85,119,.24);color:#fff}
}
.smh-btn.smh-stop{background:rgba(255,85,119,.18);border-color:rgba(255,85,119,.4);color:#ffb3c6}
.smh-opt{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;color:var(--ca-dim);font-weight:600}
.smh-opt input[type=checkbox]{
  appearance:none;-webkit-appearance:none;width:16px;height:16px;margin:0;flex:0 0 auto;
  border-radius:5px;border:1.5px solid var(--ca-stroke);background:var(--ca-glass);cursor:pointer;
  display:grid;place-items:center;transition:background .16s var(--ca-ease),border-color .16s var(--ca-ease)
}
.smh-opt input[type=checkbox]:checked{background:var(--ca-mid);border-color:var(--ca-mid)}
.smh-opt input[type=checkbox]:checked::after{content:"";width:8px;height:5px;border:2px solid #fff;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
.smh-opt input[type=number]{
  width:68px;background:rgba(0,0,0,.28);border:1px solid var(--ca-stroke);color:var(--ca-txt);
  padding:6px 8px;border-radius:10px;font:600 12px/1 "Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums
}
.smh-opt input[type=number]:focus{outline:2px solid rgba(123,92,255,.45);outline-offset:1px}
.smh-note{
  display:flex;gap:8px;align-items:flex-start;margin:10px 0 4px;padding:10px 11px;
  border-radius:12px;background:rgba(47,123,255,.1);border:1px solid rgba(47,123,255,.22);
  color:#8bbeff;font-size:12px;line-height:1.45;font-weight:600
}
.smh-note svg{width:15px;height:15px;flex:0 0 auto;margin-top:1px}
.smh-sum{display:flex;gap:6px;margin:10px 0}
.smh-chip{
  flex:1;text-align:center;padding:7px 4px;border-radius:12px;font-size:13px;font-weight:800;color:#fff;
  background:var(--ca-glass);border:1px solid var(--ca-stroke)
}
.smh-chip small{display:block;font-weight:600;font-size:10px;opacity:.8;letter-spacing:.02em;margin-top:1px}
.smh-fair{background:rgba(84,230,166,.14);border-color:rgba(84,230,166,.28);color:var(--ca-green)}
.smh-high{background:rgba(255,85,119,.14);border-color:rgba(255,85,119,.28);color:#ff9eb0}
.smh-low{background:rgba(255,200,97,.14);border-color:rgba(255,200,97,.28);color:var(--ca-amber)}
.smh-unknown{background:var(--ca-glass);color:var(--ca-dim)}
.smh-list{
  max-height:230px;overflow:auto;border:1px solid var(--ca-stroke);border-radius:14px;margin-top:8px;
  background:rgba(0,0,0,.18)
}
.smh-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--ca-stroke-soft);font-size:12px}
.smh-item:last-child{border-bottom:none}
.smh-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px rgba(255,255,255,.04)}
.smh-item span.smh-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;color:var(--ca-txt)}
.smh-item span.smh-pr{font-variant-numeric:tabular-nums;color:var(--ca-dim);font-weight:650}
.smh-log{
  margin-top:10px;max-height:150px;overflow:auto;background:rgba(0,0,0,.28);border:1px solid var(--ca-stroke-soft);
  border-radius:14px;padding:8px 10px;font:11.5px/1.55 ui-monospace,Consolas,monospace;color:var(--ca-dim)
}
.smh-log div{white-space:pre-wrap;word-break:break-word}
.smh-log .smh-e{color:#ff9eb0}.smh-log .smh-w{color:var(--ca-amber)}.smh-log .smh-s{color:var(--ca-green)}
.smh-foot{
  padding:8px 14px 10px;border-top:1px solid var(--ca-stroke-soft);font-size:11px;color:var(--ca-faint);
  display:flex;justify-content:space-between;align-items:center;font-weight:650
}
.smh-status{color:var(--ca-dim)}
.smh-ver{color:var(--ca-faint);font-variant-numeric:tabular-nums}
.smh-bar{height:4px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin-top:8px}
.smh-bar i{display:block;height:100%;background:var(--ca-grad);width:0;transition:width .2s var(--ca-ease);border-radius:inherit}
.smh-body::-webkit-scrollbar,.smh-list::-webkit-scrollbar,.smh-log::-webkit-scrollbar{width:8px}
.smh-body::-webkit-scrollbar-thumb,.smh-list::-webkit-scrollbar-thumb,.smh-log::-webkit-scrollbar-thumb{
  background:var(--ca-mid);border-radius:8px;border:2px solid transparent;background-clip:padding-box
}
@media (prefers-reduced-motion:reduce){
  .smh-btn,.smh-min,.smh-langs button,.smh-bar i{transition:none}
}
`;

    const ICO = {
        card: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3" fill="#fff" fill-opacity=".95"/><rect x="8" y="7" width="8" height="5" rx="1.2" fill="#7b5cff"/><rect x="8" y="14" width="8" height="1.6" rx=".8" fill="#2f7bff" fill-opacity=".55"/></svg>',
        minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
        spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6.2 6.2l2.1 2.1M15.7 15.7l2.1 2.1M17.8 6.2l-2.1 2.1M8.3 15.7l-2.1 2.1"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>',
        scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>',
        relist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8"/><path d="M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16"/><path d="M4 20v-4h4"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
        stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>'
    };

    const UI = {
        panel: null,
        logEl: null,
        barEl: null,
        statusEl: null,
        busy: false,
        onLang: null,

        init(subtitleKey, bodyBuilder) {
            const style = document.createElement('style');
            style.textContent = CSS;
            document.head.appendChild(style);

            const panel = document.createElement('div');
            panel.className = 'smh-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', 'Cromitos Auto');
            panel.innerHTML = `
                <div class="smh-head">
                    <div class="smh-logo">${ICO.card}</div>
                    <div class="smh-brand">
                        <strong>Cromitos Auto</strong>
                        <span data-i18n="${subtitleKey}">${t(subtitleKey)}</span>
                    </div>
                    <div class="smh-langs" role="group" aria-label="Language">
                        <button type="button" data-lang="es" class="${currentLang() === 'es' ? 'is-on' : ''}">ES</button>
                        <button type="button" data-lang="en" class="${currentLang() === 'en' ? 'is-on' : ''}">EN</button>
                    </div>
                    <button class="smh-min" type="button" data-i18n-title="collapse" title="${t('collapse')}">${ICO.minus}</button>
                </div>
                <div class="smh-body"></div>
                <div class="smh-foot">
                    <span class="smh-status" data-i18n="ready">${t('ready')}</span>
                    <span class="smh-ver" title="Cromitos Auto">v${VERSION}</span>
                </div>
            `;
            document.body.appendChild(panel);

            this.panel = panel;
            this.statusEl = panel.querySelector('.smh-status');

            panel.querySelectorAll('[data-lang]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setLang(btn.dataset.lang);
                });
            });

            panel.querySelector('.smh-min').addEventListener('click', () => {
                panel.classList.toggle('smh-collapsed');
            });
            this.makeDraggable(panel, panel.querySelector('.smh-head'));

            const body = panel.querySelector('.smh-body');
            bodyBuilder(body);

            const bar = document.createElement('div');
            bar.className = 'smh-bar';
            bar.innerHTML = '<i></i>';
            body.appendChild(bar);
            this.barEl = bar.querySelector('i');

            const log = document.createElement('div');
            log.className = 'smh-log';
            body.appendChild(log);
            this.logEl = log;
        },

        makeDraggable(panel, handle) {
            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

            handle.addEventListener('mousedown', (e) => {
                if (e.target.closest('button')) {
                    return;
                }
                dragging = true;
                const r = panel.getBoundingClientRect();
                sx = e.clientX;
                sy = e.clientY;
                ox = r.left;
                oy = r.top;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.left = `${ox}px`;
                panel.style.top = `${oy}px`;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) {
                    return;
                }
                panel.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
                panel.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
            });

            document.addEventListener('mouseup', () => {
                dragging = false;
            });
        },

        log(message, kind) {
            if (!this.logEl) {
                return;
            }
            const line = document.createElement('div');
            line.className = kind === 'error' ? 'smh-e' : kind === 'warn' ? 'smh-w' : kind === 'ok' ? 'smh-s' : '';
            const t = new Date().toLocaleTimeString();
            line.textContent = `[${t}] ${message}`;
            this.logEl.appendChild(line);

            /*
             * Keep the log bounded. Selling a large inventory writes a line per
             * item, and a market page that is left open all evening accumulates
             * them with nothing to trim it -- thousands of nodes for scrollback
             * nobody reads. The last few hundred lines are all anyone wants.
             */
            while (this.logEl.childElementCount > 400) {
                this.logEl.removeChild(this.logEl.firstChild);
            }

            this.logEl.scrollTop = this.logEl.scrollHeight;
        },

        status(text) {
            if (this.statusEl) {
                this.statusEl.removeAttribute('data-i18n');
                this.statusEl.textContent = text;
            }
        },

        progress(done, total) {
            if (this.barEl) {
                this.barEl.style.width = total > 0 ? `${Math.min(100, (done / total) * 100)}%` : '0';
            }
        }
    };

    function button(i18nKey, className, svg) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `smh-btn ${className || ''}`;
        if (svg) {
            b.insertAdjacentHTML('afterbegin', svg);
        }
        const span = document.createElement('span');
        span.dataset.i18n = i18nKey;
        span.textContent = t(i18nKey);
        b.appendChild(span);
        return b;
    }

    function checkboxOption(i18nKey, key) {
        const wrap = document.createElement('label');
        wrap.className = 'smh-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(settings[key]);
        cb.addEventListener('change', () => {
            settings[key] = cb.checked;
            saveSettings(settings);
        });
        const span = document.createElement('span');
        span.dataset.i18n = i18nKey;
        span.textContent = t(i18nKey);
        wrap.appendChild(cb);
        wrap.appendChild(span);
        return wrap;
    }

    function numberOption(labelKey, key, suffixKey) {
        const wrap = document.createElement('label');
        wrap.className = 'smh-opt';
        const lab = document.createElement('span');
        lab.dataset.i18n = labelKey;
        lab.textContent = t(labelKey);
        const input = document.createElement('input');
        input.type = 'number';
        input.value = settings[key];
        input.min = '0';
        input.addEventListener('change', () => {
            const v = parseInt(input.value, 10);
            if (!Number.isNaN(v) && v >= 0) {
                settings[key] = v;
                saveSettings(settings);
            }
        });
        wrap.appendChild(lab);
        wrap.appendChild(input);
        if (suffixKey) {
            const suf = document.createElement('span');
            suf.dataset.i18n = suffixKey;
            suf.textContent = t(suffixKey);
            wrap.appendChild(suf);
        }
        return wrap;
    }

    // ------------------------------------------------------- inventory page

    function initInventoryPage() {
        let running = false;
        let sellBtn, dupBtn, stopBtn;

        UI.init('titleInventory', (body) => {
            const row = document.createElement('div');
            row.className = 'smh-row';

            sellBtn = button('sellAll', 'smh-go', ICO.spark);
            dupBtn = button('sellDupes', '', ICO.copy);
            stopBtn = button('stop', 'smh-stop', ICO.stop);
            stopBtn.disabled = true;

            row.appendChild(sellBtn);
            row.appendChild(dupBtn);
            body.appendChild(row);

            const row2 = document.createElement('div');
            row2.className = 'smh-row';
            row2.appendChild(stopBtn);
            body.appendChild(row2);

            body.appendChild(numberOption('undercut', 'undercutCents', 'cents'));
            body.appendChild(numberOption('delay', 'requestDelayMs', 'ms'));

            const note = document.createElement('div');
            note.className = 'smh-note';
            note.insertAdjacentHTML('afterbegin', ICO.info);
            const noteText = document.createElement('span');
            noteText.dataset.i18n = 'confirmNote';
            noteText.textContent = t('confirmNote');
            note.appendChild(noteText);
            body.appendChild(note);

            sellBtn.addEventListener('click', () => run(false));
            dupBtn.addEventListener('click', () => run(true));
            stopBtn.addEventListener('click', () => {
                Net.stop();
                UI.log(t('stopping'), 'warn');
            });
        });

        function setRunning(on) {
            running = on;
            sellBtn.disabled = on;
            dupBtn.disabled = on;
            stopBtn.disabled = !on;
        }

        async function run(onlyDuplicates) {
            if (running) {
                return;
            }

            Net.reset();
            setRunning(true);
            UI.progress(0, 1);

            try {
                const steamId = currentSteamId();
                if (!steamId) {
                    throw new Error(t('noSteamId'));
                }

                const target = currentInventoryTarget();
                UI.status(t('readingInv'));
                UI.log(t('readingInvOf', { app: target.appid, ctx: target.contextid }));

                const all = await fetchInventory(steamId, target.appid, target.contextid, (n) => {
                    UI.status(t('readingInvCount', { n }));
                });

                let items = all.filter((i) => i.marketable);
                UI.log(t('invSummary', { all: all.length, marketable: items.length }));

                if (onlyDuplicates) {
                    items = filterDuplicates(items);
                    UI.log(t('dupesKept', { n: items.length }));
                }

                if (items.length > settings.maxItemsPerRun) {
                    UI.log(t('runLimited', { n: settings.maxItemsPerRun }), 'warn');
                    items = items.slice(0, settings.maxItemsPerRun);
                }

                if (!items.length) {
                    UI.log(t('nothingToSell'), 'warn');
                    UI.status(t('nothingToSell'));
                    return;
                }

                await sellItems(items);
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status(t('failed'));
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }
    }

    /*
     * Price and list a batch of items.
     *
     * Items are grouped by hash name so that twelve copies of one card cost one
     * order book lookup rather than twelve -- which matters a great deal when
     * the rate limit is the binding constraint.
     */
    async function sellItems(items) {
        const groups = new Map();
        for (const item of items) {
            if (!groups.has(item.market_hash_name)) {
                groups.set(item.market_hash_name, []);
            }
            groups.get(item.market_hash_name).push(item);
        }

        let done = 0;
        let listed = 0;
        let failed = 0;
        let skipped = 0;
        let expected = 0;

        UI.log(t('pricing', { groups: groups.size, n: items.length }));

        for (const [hashName, group] of groups) {
            if (Net.stopped) {
                break;
            }

            let book;
            try {
                book = await getOrderBook(group[0].appid, hashName);
            } catch (e) {
                UI.log(t('noPrice', { name: hashName, err: e.message }), 'warn');
                skipped += group.length;
                done += group.length;
                UI.progress(done, items.length);
                continue;
            }

            const buyerPrice = targetPriceForNewListing(book);
            if (buyerPrice == null) {
                UI.log(t('noBook', { name: hashName }), 'warn');
                skipped += group.length;
                done += group.length;
                UI.progress(done, items.length);
                continue;
            }

            const sellerPrice = sellerPriceForTarget(buyerPrice, book, group[0]);

            for (const item of group) {
                if (Net.stopped) {
                    break;
                }

                UI.status(t('listingN', { done: done + 1, total: items.length }));

                try {
                    await sellItem(item, sellerPrice);
                    listed++;
                    expected += sellerPrice;
                    UI.log(
                        t('listedAt', {
                            name: item.name,
                            buyer: formatCents(buyerPrice),
                            seller: formatCents(sellerPrice)
                        }),
                        'ok'
                    );
                } catch (e) {
                    failed++;
                    UI.log(`${item.name}: ${e.message}`, 'error');
                }

                done++;
                UI.progress(done, items.length);
            }
        }

        UI.log(
            t('sellDone', {
                listed,
                failed,
                skipped,
                expected: formatCents(expected)
            }),
            'ok'
        );
        UI.log(t('confirmApp'), 'warn');
        UI.status(t('listedCount', { n: listed }));

        return { listed, failed, skipped, expected };
    }

    // ---------------------------------------------------------- market page

    function initMarketPage() {
        let running = false;
        let expanding = false;
        let scanned = [];
        let scanBtn, removeBtn, relistBtn, stopBtn, listEl, summaryEl;

        /*
         * Listings fetched a moment ago, so pressing Scan straight after the
         * page has expanded itself does not ask Steam for the same thing twice.
         * Two minutes is long enough to cover "the page loaded and I clicked",
         * and short enough that a listing sold in the meantime is not acted on.
         * Cleared outright whenever we remove or relist anything.
         */
        let recent = null;
        const RECENT_MS = 120000;

        function cacheListings(data) {
            recent = { data, at: Date.now() };
        }

        function takeRecentListings() {
            if (recent && Date.now() - recent.at < RECENT_MS) {
                return recent.data;
            }
            return null;
        }

        UI.init('titleListings', (body) => {
            const row = document.createElement('div');
            row.className = 'smh-row';
            scanBtn = button('scan', 'smh-go', ICO.scan);
            stopBtn = button('stop', 'smh-stop', ICO.stop);
            stopBtn.disabled = true;
            row.appendChild(scanBtn);
            row.appendChild(stopBtn);
            body.appendChild(row);

            summaryEl = document.createElement('div');
            summaryEl.className = 'smh-sum';
            summaryEl.style.display = 'none';
            body.appendChild(summaryEl);

            const row2 = document.createElement('div');
            row2.className = 'smh-row';
            relistBtn = button('relist', 'smh-go', ICO.relist);
            removeBtn = button('remove', 'smh-danger', ICO.trash);
            relistBtn.disabled = true;
            removeBtn.disabled = true;
            row2.appendChild(relistBtn);
            row2.appendChild(removeBtn);
            body.appendChild(row2);

            body.appendChild(checkboxOption('showAll', 'showAllOnPage'));
            body.appendChild(checkboxOption('includeLow', 'includeLow'));
            body.appendChild(numberOption('undercut', 'undercutCents', 'cents'));
            body.appendChild(numberOption('tooLowPct', 'tooLowPercent', 'percent'));

            listEl = document.createElement('div');
            listEl.className = 'smh-list';
            listEl.style.display = 'none';
            body.appendChild(listEl);

            scanBtn.addEventListener('click', () => scan());
            removeBtn.addEventListener('click', () => act(false));
            relistBtn.addEventListener('click', () => act(true));
            stopBtn.addEventListener('click', () => {
                Net.stop();
                UI.log(t('stopping'), 'warn');
            });

            UI.onLang = () => {
                if (scanned.length) {
                    render();
                }
            };
        });

        /*
         * Show every listing as soon as the page opens, rather than making the
         * whole table wait on a scan it has nothing to do with. Expanding the
         * page and judging prices are separate jobs: the first is one request
         * and instant, the second is one request per distinct item and takes
         * minutes under the rate limit.
         */
        async function autoExpand() {
            if (!settings.showAllOnPage || running || expanding) {
                return;
            }

            /*
             * Tracked separately from `running`, which belongs to the buttons.
             * Pressing Scan the instant the page loads used to start a second
             * fetch of the same listings while this one was still in the air:
             * the cache had nothing in it yet, so neither run could reuse the
             * other's work, and the page got expanded twice.
             */
            expanding = true;

            try {
                UI.status(t('loadingListings'));
                const data = await fetchMyListings();
                cacheListings(data);

                if (!data.listings.length) {
                    UI.status(t('noListings'));
                    return;
                }

                const expanded = expandListingsOnPage(data.pages);
                if (expanded.ok) {
                    UI.log(t('showingAll', { n: expanded.added }), 'ok');
                    UI.status(`${expanded.added}`);
                } else {
                    UI.log(t('expandFail', { err: expanded.reason }), 'warn');
                    UI.status(t('ready'));
                }
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(t('loadListingsFail', { err: e.message }), 'warn');
                    UI.status(t('ready'));
                }
            } finally {
                expanding = false;
            }
        }

        function setRunning(on) {
            running = on;
            scanBtn.disabled = on;
            stopBtn.disabled = !on;
            const haveTargets = !on && scanned.some((s) => actionable(s));
            removeBtn.disabled = !haveTargets;
            relistBtn.disabled = !haveTargets;
        }

        function actionable(entry) {
            if (entry.verdict === VERDICT.HIGH) {
                return true;
            }
            return entry.verdict === VERDICT.LOW && settings.includeLow;
        }

        function render() {
            const counts = { fair: 0, high: 0, low: 0, unknown: 0 };
            for (const e of scanned) {
                counts[e.verdict]++;
            }

            summaryEl.style.display = 'flex';
            summaryEl.innerHTML = `
                <div class="smh-chip smh-fair">${counts.fair}<small data-i18n="chipFair">${t('chipFair')}</small></div>
                <div class="smh-chip smh-high">${counts.high}<small data-i18n="chipHigh">${t('chipHigh')}</small></div>
                <div class="smh-chip smh-low">${counts.low}<small data-i18n="chipLow">${t('chipLow')}</small></div>
                <div class="smh-chip smh-unknown">${counts.unknown}<small data-i18n="chipUnknown">${t('chipUnknown')}</small></div>
            `;

            const colors = { fair: '#54e6a6', high: '#ff5577', low: '#ffc861', unknown: '#666c84' };
            const order = { high: 0, low: 1, unknown: 2, fair: 3 };

            listEl.style.display = 'block';
            listEl.innerHTML = '';

            for (const e of [...scanned].sort((a, b) => order[a.verdict] - order[b.verdict])) {
                const el = document.createElement('div');
                el.className = 'smh-item';
                el.title = `${e.reason}${e.target != null ? ` -- suggested ${formatCents(e.target)}` : ''}`;
                el.innerHTML = `
                    <i class="smh-dot" style="background:${colors[e.verdict]}"></i>
                    <span class="smh-nm"></span>
                    <span class="smh-pr">${formatCents(e.listing.buyerPrice)}${
                        e.target != null && e.target !== e.listing.buyerPrice
                            ? ` &rarr; ${formatCents(e.target)}`
                            : ''
                    }</span>
                `;
                el.querySelector('.smh-nm').textContent = e.listing.name;
                listEl.appendChild(el);
            }
        }

        async function scan() {
            if (running) {
                return;
            }

            Net.reset();
            setRunning(true);
            scanned = [];
            UI.progress(0, 1);

            try {
                // The page expansion on load has almost certainly just fetched
                // these; no reason to make Steam send them again.
                let data = takeRecentListings();

                if (data) {
                    UI.log(t('listingsJustLoaded', { n: data.listings.length }));
                } else {
                    UI.status(t('readingListings'));
                    data = await fetchMyListings((n, total) => {
                        UI.status(t('readingListingsN', { n, total }));
                    });
                    cacheListings(data);
                    UI.log(t('listingsCount', { n: data.listings.length }));
                }

                const { listings, pages } = data;
                if (!listings.length) {
                    UI.status(t('noListings'));
                    return;
                }

                // Only if the page has not already been expanded for us.
                if (settings.showAllOnPage) {
                    const expanded = expandListingsOnPage(pages);
                    if (expanded.ok) {
                        UI.log(t('showingAll', { n: expanded.added }), 'ok');
                    } else {
                        UI.log(t('expandFail', { err: expanded.reason }), 'warn');
                    }
                }

                // How many listings we hold at each price, per item. This is
                // what lets lowestCompetingPrice() take us out of our own book.
                const mineByItem = new Map();
                for (const l of listings) {
                    const key = `${l.appid}::${l.market_hash_name}`;
                    if (!mineByItem.has(key)) {
                        mineByItem.set(key, new Map());
                    }
                    const m = mineByItem.get(key);
                    m.set(l.buyerPrice, (m.get(l.buyerPrice) || 0) + 1);
                }

                const uniqueItems = [...new Set(listings.map((l) => `${l.appid}::${l.market_hash_name}`))];
                UI.log(t('checkingN', { n: uniqueItems.length }));

                const books = new Map();
                let i = 0;
                for (const key of uniqueItems) {
                    if (Net.stopped) {
                        break;
                    }
                    const { appid, hashName } = splitItemKey(key);
                    try {
                        books.set(key, await getOrderBook(appid, hashName));
                    } catch (e) {
                        UI.log(`${hashName}: ${e.message}`, 'warn');
                    }
                    i++;
                    UI.progress(i, uniqueItems.length);
                    UI.status(t('checkingPrices', { n: i, total: uniqueItems.length }));
                }

                for (const listing of listings) {
                    const key = `${listing.appid}::${listing.market_hash_name}`;
                    const book = books.get(key);
                    const verdict = classifyListing(listing, book, mineByItem.get(key) || new Map());
                    scanned.push(Object.assign({ listing }, verdict));
                }

                render();

                const counts = scanned.reduce((a, e) => {
                    a[e.verdict] = (a[e.verdict] || 0) + 1;
                    return a;
                }, {});
                UI.log(
                    t('scanSummary', {
                        fair: counts.fair || 0,
                        high: counts.high || 0,
                        low: counts.low || 0,
                        unknown: counts.unknown || 0
                    }),
                    'ok'
                );
                UI.status(t('scanComplete'));
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status(t('failed'));
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }

        /*
         * Remove the mispriced listings, and optionally list them again.
         *
         * Relisting has to be done in that order and with a pause in between,
         * because cancelling a listing returns the item to your inventory with
         * a NEW asset id. The old id is gone, so the only way to find the item
         * again is to re-read the inventory and match on market_hash_name.
         */
        async function act(relist) {
            if (running) {
                return;
            }

            const targets = scanned.filter(actionable);
            if (!targets.length) {
                UI.log(t('nothingMispriced'), 'warn');
                return;
            }

            Net.reset();
            setRunning(true);
            UI.progress(0, 1);

            // Whatever we cached is about to stop being true.
            recent = null;

            try {
                UI.log(t(relist ? 'relistingN' : 'removingN', { n: targets.length }));

                let removed = 0;
                const wanted = new Map();

                for (const entry of targets) {
                    if (Net.stopped) {
                        break;
                    }

                    try {
                        await removeListing(entry.listing.listingId);
                        removed++;

                        const key = `${entry.listing.appid}::${entry.listing.contextid}::${entry.listing.market_hash_name}`;
                        wanted.set(key, (wanted.get(key) || 0) + 1);

                        // Our own listing has just left the book, so anything
                        // cached for it is now wrong.
                        invalidateOrderBook(entry.listing.appid, entry.listing.market_hash_name);

                        UI.log(t('removedAt', { name: entry.listing.name, price: formatCents(entry.listing.buyerPrice) }), 'ok');
                    } catch (e) {
                        UI.log(`${entry.listing.name}: ${e.message}`, 'error');
                    }

                    UI.progress(removed, targets.length);
                    UI.status(t('removingProgress', { n: removed, total: targets.length }));
                }

                UI.log(t('removedCount', { n: removed }), 'ok');

                if (!relist || Net.stopped) {
                    UI.status(t('removedStatus', { n: removed }));
                    scanned = [];
                    return;
                }

                // Steam needs a moment to put the items back.
                UI.status(t('waitingReturn'));
                UI.log(t('waitingReturnLog'));
                await sleep(5000);

                const steamId = currentSteamId();
                if (!steamId) {
                    throw new Error(t('cannotRelistId'));
                }

                const contexts = new Set([...wanted.keys()].map((k) => k.split('::').slice(0, 2).join('::')));
                const returned = [];

                for (const ctx of contexts) {
                    const [appid, contextid] = ctx.split('::', 2);
                    UI.log(t('rereadInv', { app: appid, ctx: contextid }));
                    const inv = await fetchInventory(steamId, appid, contextid);
                    returned.push(...inv.filter((i) => i.marketable));
                }

                // Match by name and take as many as we removed. Assets with the
                // same hash name are interchangeable, so which copy we pick up
                // does not matter -- only that we relist the right number.
                const toList = [];
                const byName = new Map();
                for (const item of returned) {
                    const key = `${item.appid}::${item.contextid}::${item.market_hash_name}`;
                    if (!byName.has(key)) {
                        byName.set(key, []);
                    }
                    byName.get(key).push(item);
                }

                for (const [key, count] of wanted) {
                    const pool = byName.get(key) || [];
                    if (pool.length < count) {
                        UI.log(
                            t('expectedBack', { name: key.split('::')[2], count, found: pool.length }),
                            'warn'
                        );
                    }
                    toList.push(...pool.slice(0, count));
                }

                if (!toList.length) {
                    UI.log(t('nothingBack'), 'warn');
                    UI.status(t('nothingToRelist'));
                    return;
                }

                await sellItems(toList);
                scanned = [];
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status(t('failed'));
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }

        autoExpand();
    }

    // ------------------------------------------------------------ test hook

    /*
     * The test harness sets window.__SMH_TEST__ before loading this file and
     * reads the internals back out of it. In a browser the global is undefined
     * and this block does nothing at all.
     */
    if (W.__SMH_TEST__) {
        Object.assign(W.__SMH_TEST__, {
            VERDICT,
            parsePriceToCents,
            formatCents,
            amountToSendForDesiredReceived,
            priceBeforeFees,
            buildOrderBook,
            lowestCompetingPrice,
            classifyListing,
            targetPriceForNewListing,
            sellerPriceForTarget,
            splitItemKey,
            splitContextKey,
            filterDuplicates,
            parseHovers,
            parseMyListingsPage,
            extractBuyerPrice,
            identityFromRow,
            expandListingsOnPage,
            VERSION,
            // For the visual harness in tests/panel.html only.
            renderMarketPanel: () => initMarketPage(),
            renderInventoryPanel: () => initInventoryPage(),
            getSettings: () => settings,
            patchSettings: (patch) => Object.assign(settings, patch),
            resetSettings: () => {
                settings = Object.assign({}, DEFAULTS);
            }
        });
        return;
    }

    // ----------------------------------------------------------------- boot

    function isLoggedIn() {
        return Boolean(W.g_steamID || W.g_bLoggedIn || W.g_rgWalletInfo);
    }

    function boot() {
        const href = window.location.href;
        const onInventory = /steamcommunity\.com\/(id|profiles)\/[^/]+\/inventory/.test(href);
        const onMarketHome = /steamcommunity\.com\/market\/?($|\?|#)/.test(href);

        if (!onInventory && !onMarketHome) {
            return;
        }

        if (!isLoggedIn()) {
            return;
        }

        if (onInventory) {
            initInventoryPage();
        } else {
            initMarketPage();
        }

        UI.log(t('bootReady'), 'ok');
    }

    // Steam sets up its globals after DOM ready, so give it a beat.
    if (document.readyState === 'complete') {
        setTimeout(boot, 800);
    } else {
        window.addEventListener('load', () => setTimeout(boot, 800));
    }
})();
