import { LOCAL_DIRECT_PATTERNS } from "./defaultSettings"
import type { ProxySettings } from "./types"

export const generatePacScript = (settings: ProxySettings) => {
  const proxyEndpoint = `PROXY ${settings.proxyHost}:${settings.proxyPort}`

  return `
function FindProxyForURL(url, host) {
  var normalizedHost = (host || "").toLowerCase();
  var localPatterns = ${JSON.stringify(LOCAL_DIRECT_PATTERNS)};
  var directPatterns = ${JSON.stringify(settings.directDomains)};
  var proxyPatterns = ${JSON.stringify(settings.proxyDomains)};
  var disableProxyDomainRouting = ${JSON.stringify(settings.disableProxyDomainRouting)};

  function matchPattern(value, pattern) {
    if (!pattern) {
      return false;
    }

    if (pattern.charAt(0) === ".") {
      var baseDomain = pattern.substring(1);
      return value === baseDomain || dnsDomainIs(value, pattern);
    }

    if (pattern.indexOf("*") !== -1) {
      return shExpMatch(value, pattern);
    }

    return value === pattern;
  }

  function matchesAny(value, patterns) {
    for (var index = 0; index < patterns.length; index += 1) {
      if (matchPattern(value, patterns[index])) {
        return true;
      }
    }

    return false;
  }

  function isLocalOrPrivate(value) {
    if (!value) {
      return true;
    }

    if (value === "localhost" || value === "::1" || value === "[::1]") {
      return true;
    }

    return matchesAny(value, localPatterns);
  }

  if (isLocalOrPrivate(normalizedHost)) {
    return "DIRECT";
  }

  if (matchesAny(normalizedHost, directPatterns)) {
    return "DIRECT";
  }

  if (disableProxyDomainRouting) {
    return ${JSON.stringify(proxyEndpoint)};
  }

  if (matchesAny(normalizedHost, proxyPatterns)) {
    return ${JSON.stringify(proxyEndpoint)};
  }

  return "DIRECT";
}
`.trim()
}
