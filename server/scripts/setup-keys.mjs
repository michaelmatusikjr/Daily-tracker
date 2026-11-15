// Prints fresh keys for the push server (base64url). Run: npm run setup-keys
//  - VAPID public key: goes in wrangler.toml [vars] and in the app's settings.
//  - VAPID private key and register key are SECRETS: store them with `npx wrangler secret put …`.
import { webcrypto as crypto } from 'node:crypto';
import { b64urlEncode, b64urlDecode } from '../src/b64.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const pub = new Uint8Array([4, ...b64urlDecode(jwk.x), ...b64urlDecode(jwk.y)]);
const registerKey = b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
console.log('VAPID_PUBLIC_KEY  (put in wrangler.toml [vars] and in the app’s settings):');
console.log(b64urlEncode(pub));
console.log('\nVAPID_PRIVATE_KEY (secret! run: npx wrangler secret put VAPID_PRIVATE_KEY):');
console.log(jwk.d);
console.log('\nREGISTER_KEY      (secret! run: npx wrangler secret put REGISTER_KEY; also paste it into the app’s settings):');
console.log(registerKey);
