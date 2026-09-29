/**
 * Secret removal.
 *
 * An export meant to live in a git repository must never carry a secret. The rule here is a
 * name rule, applied to column names and, recursively, to every key of every JSON value stored
 * in a column: if the name looks like a secret, the value is replaced by the marker below.
 *
 * A name rule is deliberate. A value rule would have to guess, and guessing wrong once is
 * enough to publish a credential. The cost is that a harmless field whose name happens to
 * match is redacted too; that cost is visible in the output and recoverable, the other is not.
 */

export const REDACTED = "[redacted]";

/**
 * Names whose value is never written out. Matched case-insensitively, anywhere in the name,
 * except where anchored.
 */
const SECRET_NAME = /(secret|password|passwd|credential|passphrase|private_key|privkey|api[_-]?key|(^|_)token($|_)|(^|_)key($|_))/i;

/** True when a column name or JSON key must have its value removed. */
export function isSecretName(name) {
	return SECRET_NAME.test(String(name));
}

/**
 * Walk a value and redact every entry whose key looks like a secret.
 * Arrays keep their shape; scalars are returned untouched.
 */
export function redact(value, keyName) {
	if (keyName !== undefined && isSecretName(keyName)) {
		return REDACTED;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redact(item));
	}
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = redact(value[key], key);
		}
		return out;
	}
	return value;
}
