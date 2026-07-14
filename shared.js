(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    if (root)
        root.WizmageShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_SETTINGS = Object.freeze({
        paused: false,
        noEye: false,
        noPattern: false,
        blackList: false,
        closeOnClick: false,
        maxSafe: 32,
        alwaysBlock: false,
        blockTarget: 'all'
    });

    function legacyUnwantedToBlockTarget(unwanted) {
        const value = String(unwanted || '').toLowerCase().trim();
        if (/^(women?|a woman|females?)$/.test(value)) return 'women';
        if (/^(men|man|a man|males?)$/.test(value)) return 'men';
        if (/^(people|person|a person|crowd|a crowd|crowd of people)$/.test(value)) return 'people';
        return 'all';
    }

    function normalizeSettings(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const normalized = Object.assign({}, DEFAULT_SETTINGS, source);
        if (!source.blockTarget)
            normalized.blockTarget = legacyUnwantedToBlockTarget(normalized.unwanted);
        if (!['all', 'men', 'women', 'people'].includes(normalized.blockTarget))
            normalized.blockTarget = 'all';
        normalized.maxSafe = Number(normalized.maxSafe) || DEFAULT_SETTINGS.maxSafe;
        if (normalized.maxSafe < 1 || normalized.maxSafe > 1000)
            normalized.maxSafe = DEFAULT_SETTINGS.maxSafe;
        for (const key of ['paused', 'noEye', 'noPattern', 'blackList', 'closeOnClick', 'alwaysBlock', 'pausedForTab', 'excludedForTab', 'excluded', 'allowSafeDomain'])
            normalized[key] = toBoolean(normalized[key]);
        return normalized;
    }

    function toBoolean(value) {
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
        }
        return !!value;
    }

    function isFilteringActive(settings) {
        if (!settings || settings.paused || settings.pausedForTab)
            return false;
        return (!settings.blackList && !settings.excluded && !settings.excludedForTab)
            || (settings.blackList && (settings.excluded || settings.excludedForTab));
    }

    function parseUrl(value, base) {
        try {
            return new URL(value, base || undefined);
        } catch (err) {
            return null;
        }
    }

    function normalizeHost(value) {
        return String(value || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
    }

    function hostMatches(host, entry) {
        host = normalizeHost(host);
        entry = normalizeHost(entry);
        return !!entry && (host === entry || host.endsWith('.' + entry));
    }

    function entryParts(entry) {
        const raw = String(entry || '').trim();
        if (!raw)
            return null;
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
        const withoutWildcard = hasScheme
            ? raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)\*\./i, '$1')
            : raw.replace(/^\*\./, '');
        const candidate = hasScheme ? withoutWildcard : 'https://' + withoutWildcard.replace(/^\/+/, '');
        const parsed = parseUrl(candidate);
        if (!parsed || !parsed.hostname)
            return null;
        const authorityEnd = hasScheme
            ? raw.indexOf('/', raw.indexOf('://') + 3)
            : raw.indexOf('/');
        return {
            raw,
            parsed,
            hasScheme,
            hasExplicitSuffix: authorityEnd !== -1 || raw.includes('?') || raw.includes('#')
        };
    }

    function urlMatchesEntry(url, entry) {
        const candidate = parseUrl(url);
        const parts = entryParts(entry);
        if (!candidate || !parts)
            return false;
        if (!hostMatches(candidate.hostname, parts.parsed.hostname))
            return false;
        if (parts.hasScheme && candidate.protocol.toLowerCase() !== parts.parsed.protocol.toLowerCase())
            return false;
        if ((parts.hasScheme || parts.parsed.port) && candidate.port !== parts.parsed.port)
            return false;
        if (!parts.hasExplicitSuffix)
            return true;
        const entrySuffix = (parts.parsed.pathname + parts.parsed.search + parts.parsed.hash).toLowerCase();
        const candidateSuffix = (candidate.pathname + candidate.search + candidate.hash).toLowerCase();
        return candidateSuffix.startsWith(entrySuffix);
    }

    function isValidUrlListEntry(entry) {
        return !!entryParts(entry);
    }

    function urlMatchesList(url, list) {
        return Array.isArray(list) && list.some(entry => urlMatchesEntry(url, entry));
    }

    function domainMatchesList(domain, list) {
        return Array.isArray(list) && list.some(entry => {
            const parts = entryParts(entry);
            return !!parts && hostMatches(domain, parts.parsed.hostname);
        });
    }

    function extractCssUrls(value) {
        const urls = [];
        const regex = /\burl\(\s*(['"]?)(.*?)\1\s*\)/gi;
        let match;
        while ((match = regex.exec(String(value || ''))) !== null) {
            const url = match[2].trim();
            if (url && !urls.includes(url))
                urls.push(url);
        }
        return urls;
    }

    function resolveUrl(value, base) {
        if (!value)
            return '';
        const parsed = parseUrl(value, base);
        return parsed ? parsed.href : String(value);
    }

    function candidateKey(kind, urls, extra) {
        return [kind, ...(urls || []).map(String).sort(), extra || ''].join('|');
    }

    function isImageLikeUrl(value) {
        const url = String(value || '').toLowerCase();
        return url.startsWith('data:image/')
            || /\.(?:apng|avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)(?:[?#].*)?$/.test(url);
    }

    function isRemoteImageCandidate(value, maxDataChars, maxUrlChars) {
        const candidate = String(value || '');
        maxDataChars = Number(maxDataChars) || (512 * 1024);
        maxUrlChars = Number(maxUrlChars) || (32 * 1024);
        if (/^data:image\//i.test(candidate))
            return candidate.length <= maxDataChars;
        if (candidate.length > maxUrlChars)
            return false;
        const parsed = parseUrl(candidate);
        return !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    }

    function renderedSize(element) {
        if (!element || !element.getBoundingClientRect)
            return { width: 0, height: 0 };
        const rect = element.getBoundingClientRect();
        return { width: Math.abs(rect.width || 0), height: Math.abs(rect.height || 0) };
    }

    function sizeNeedsBlocking(width, height, maxSafe, force) {
        if (force)
            return true;
        maxSafe = Number(maxSafe) || DEFAULT_SETTINGS.maxSafe;
        return width <= 0 || height <= 0 || width > maxSafe || height > maxSafe;
    }

    return {
        DEFAULT_SETTINGS,
        normalizeSettings,
        legacyUnwantedToBlockTarget,
        isFilteringActive,
        parseUrl,
        normalizeHost,
        hostMatches,
        isValidUrlListEntry,
        urlMatchesEntry,
        urlMatchesList,
        domainMatchesList,
        extractCssUrls,
        resolveUrl,
        candidateKey,
        isImageLikeUrl,
        isRemoteImageCandidate,
        renderedSize,
        sizeNeedsBlocking
    };
});
