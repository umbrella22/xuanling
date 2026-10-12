// Lossy credential masking belongs only to emitted probe evidence. Never use
// these copies for authentication, requests, or canonical graph/document data.
const credentialMask = '<redacted>'

function redactAuthorizationValue(value) {
  // Keep the header's scheme and whitespace, but not its credential payload.
  const parts = /^([ \t]*[!#$%&'*+.^`|~\w-]+[ \t]+)(\S[\s\S]*?)([ \t]*)$/.exec(value)
  return parts ? `${parts[1]}${credentialMask}${parts[3]}` : value
}

function isDiagnosticQuotedHeader(text, offset, length) {
  const before = text.slice(0, offset)
  const line = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1)
  // Quoted authorization keys inside ordinary JSON records remain domain
  // fields. Recognize a diagnostic headers map, a standalone header entry,
  // or a header-only diagnostic object, not arbitrary serialized domain data.
  return !line.includes('{')
    || /(?:["']headers["']|\bheaders)[ \t]*[:=][ \t]*\{[^{}]*$/i.test(before)
    || (/\{[ \t]*$/.test(before) && /^[ \t]*\}/.test(text.slice(offset + length)))
}

export function redactProbeEvidenceText(text) {
  if (typeof text !== 'string') return text
  const locators = text.replace(/https?:\/\/[^\s"'<>`]+/gi, (locator) => {
    const fragmentAt = locator.indexOf('#')
    const beforeFragment = fragmentAt < 0 ? locator : locator.slice(0, fragmentAt)
    const fragment = fragmentAt < 0 ? '' : locator.slice(fragmentAt)
    const queryAt = beforeFragment.indexOf('?')
    if (queryAt < 0) return locator
    // Do not parse/re-encode URLs: route spelling, other query values, fragment,
    // exact key casing and encoded credential bytes must retain their meaning.
    return beforeFragment.slice(0, queryAt + 1)
      + beforeFragment.slice(queryAt + 1).replace(/(^|&)((?:token|authToken)=)([^&]*)/g,
        (match, delimiter, key, value) => value ? `${delimiter}${key}${credentialMask}` : match)
      + fragment
  })
  // Match exact diagnostic header names, not X-Authorization or ordinary
  // domain keys. Quoted diagnostic objects and line-style headers are both
  // emitted by upstream errors. Delimiters/adjacent metadata stay in place.
  return locators
    .replace(/(?<![\w-])((["'])authorization\2[ \t]*:[ \t]*)(["'])([^\r\n]*?)\3/gi,
      (match, field, _keyQuote, valueQuote, value, offset, original) => isDiagnosticQuotedHeader(original, offset, match.length)
        ? `${field}${valueQuote}${redactAuthorizationValue(value)}${valueQuote}` : match)
    .replace(/(?<![\w"'-])(authorization[ \t]*:[ \t]*)(["'])([^\r\n]*?)\2/gi,
      (_match, field, quote, value) => `${field}${quote}${redactAuthorizationValue(value)}${quote}`)
    .replace(/(?<![\w"'-])(authorization[ \t]*:[ \t]*)([^\r\n"',;)}\]]*)/gi,
      (_match, field, value) => {
        // Basic/Bearer credentials are a single token; keep diagnostic text
        // following that token rather than treating it as header payload.
        const parts = /^([ \t]*(?:Basic|Bearer)[ \t]+)(\S+)([\s\S]*)$/i.exec(value)
        return `${field}${parts ? `${parts[1]}${credentialMask}${parts[3]}` : redactAuthorizationValue(value)}`
      })
}

export function stringifyProbeEvidence(report, space = 2) {
  const headerMaps = new WeakSet()
  return JSON.stringify(report, function (key, value) {
    if (key.toLowerCase() === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) headerMaps.add(value)
    if (typeof value !== 'string') return value
    // A header map is a diagnostic representation; an arbitrary domain field
    // called token/authToken/authorization is not. No source object is mutated.
    const text = headerMaps.has(this) && key.toLowerCase() === 'authorization'
      ? redactAuthorizationValue(value) : value
    return redactProbeEvidenceText(text)
  }, space)
}
