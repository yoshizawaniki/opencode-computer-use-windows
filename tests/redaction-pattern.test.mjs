// Committed, re-runnable test for SENSITIVE_NAME_PATTERN itself — found by
// independent audit that this pattern had round-tripped between "too broad"
// (false-positived on "keyboard"/"Author") and "too narrow" (\b missed
// session_key/sessionKey) across two prior fixes, each verified only by
// throwaway manual checks. Pinning it here stops a third round trip.
import { SENSITIVE_NAME_PATTERN, splitIdentifierWords } from "../src/redaction.js";

function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

const re = new RegExp(SENSITIVE_NAME_PATTERN, "i");
const test = (name) => re.test(splitIdentifierWords(name));

const shouldMatch = [
  "password",
  "api_key",
  "apiKey",
  "session_key",
  "sessionKey",
  "licenseKey",
  "signing_key",
  "master_key",
  "encryptionKey",
  "pin_code",
  "pinCode",
  "authToken",
  "csrf-token",
  "secret_key",
  "auth",
  "pin",
  "key",
];
const shouldNotMatch = ["keyboard", "Author", "spinner", "monkey", "opinion", "keynote"];

for (const name of shouldMatch) {
  must(test(name), `"${name}" is recognized as a sensitive field name`);
}
for (const name of shouldNotMatch) {
  must(!test(name), `"${name}" is NOT a false-positive match`);
}

console.log("\nALL REDACTION PATTERN TESTS PASSED");
