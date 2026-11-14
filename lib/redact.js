/**
 * Response redaction.
 *
 * An API can echo a credential back in its response body — in an error message,
 * a debug field, or a reflection of the request. The key lives on the Host, so
 * the model never sees the request, but it does see the response, which is
 * exactly the channel that would leak it.
 *
 * Two passes, cheapest and most certain first:
 *
 *   1. **Literal** — replace any value the caller is actually holding. This is
 *      exact, needs no guessing, and catches the case that matters: the key the
 *      user stored is the key that came back.
 *   2. **Pattern** — replace anything shaped like a credential from a known
 *      issuer, which catches tokens the plugin never stored (a token in a
 *      linked account's profile, a secret in another service's payload).
 *
 * Deliberately not a security boundary against a determined attacker: it is a
 * guardrail against the ordinary accident of a key landing in a transcript.
 */
export const REDACTED = '[REDACTED]';

/** Shapes that are unambiguous credentials from a specific issuer. */
export const DEFAULT_PATTERNS = Object.freeze([
  'gh[pousr]_[A-Za-z0-9]{20,}',            // GitHub classic
  'github_pat_[A-Za-z0-9_]{20,}',          // GitHub fine-grained
  'ghs_[A-Za-z0-9]{20,}',                  // GitHub App server token
  'npm_[A-Za-z0-9]{30,}',                  // npm automation
  'sk-[A-Za-z0-9_-]{20,}',                 // OpenAI-style
  'xox[abprs]-[A-Za-z0-9-]{10,}',          // Slack
  'AKIA[0-9A-Z]{16}',                      // AWS access key id
  'ASIA[0-9A-Z]{16}',                      // AWS temporary key id
  'AIza[0-9A-Za-z_-]{35}',                 // Google API key
  'glpat-[A-Za-z0-9_-]{20,}',              // GitLab
  'hvs\\.[A-Za-z0-9_-]{20,}',              // Vault
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
]);

/** Compile a list of source strings into one alternation. */
function compilePatterns(patterns) {
  const compiled = [];
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source, 'gu'));
    } catch {
      // A user-supplied pattern that does not compile is skipped rather than
      // allowed to break every call.
    }
  }
  return compiled;
}

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Build a redactor.
 * @param options.enabled - when false, `redact` returns its input.
 * @param options.patterns - extra or replacement patterns; `DEFAULT_PATTERNS` by default.
 * @param options.replaceWith - the replacement token.
 */
export function createRedactor(options = {}) {
  const enabled = options.enabled !== false;
  const patterns = Array.isArray(options.patterns) && options.patterns.length > 0
    ? options.patterns
    : [...DEFAULT_PATTERNS];
  const replacement = typeof options.replaceWith === 'string' && options.replaceWith.length > 0
    ? options.replaceWith
    : REDACTED;
  const compiled = enabled ? compilePatterns(patterns) : [];

  /**
   * Redact one string.
   * @param input - the text.
   * @param secrets - values to remove verbatim, in addition to the patterns.
   */
  function redactString(input, secrets) {
    if (!enabled || typeof input !== 'string' || input.length === 0) return input;
    let output = input;

    for (const secret of secrets ?? []) {
      // Very short values would match everywhere and destroy the payload; a
      // real credential is long, and a short one is not worth redacting.
      if (typeof secret !== 'string' || secret.length < 8) continue;
      if (!output.includes(secret)) continue;
      output = output.split(secret).join(replacement);
    }

    for (const pattern of compiled) {
      // A global regex carries lastIndex between calls; reset it so a hit on
      // one call does not skip the start of the next.
      pattern.lastIndex = 0;
      output = output.replace(pattern, replacement);
    }
    return output;
  }

  /**
   * Redact a parsed body: strings are cleaned, and keys are cleaned too, since
   * a credential can appear as a property name in a reflection.
   */
  function redactValue(value, secrets, depth = 0) {
    if (!enabled) return value;
    if (depth > 12) return value; // bound recursion on pathological payloads
    if (typeof value === 'string') return redactString(value, secrets);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
    if (value !== null && typeof value === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        output[redactString(key, secrets)] = redactValue(item, secrets, depth + 1);
      }
      return output;
    }
    return value;
  }

  return { enabled, redactString, redactValue, patterns };
}
