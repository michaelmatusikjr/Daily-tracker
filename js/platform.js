// What kind of device/browser is this? One place for the invite flow (setup.js) to choose which steps to show,
// so each person only sees instructions for their own device. Feature detection first; the user agent only
// where features can't tell (iOS/iPadOS, in-app browsers, the browser's name).
// Tests can force a context: window.__platformOverride = { os: 'android', ... } (merged over the detected one).
import { isStandalone, canInstall } from './pwa.js';

const IOS_PUSH = [16, 4]; // web push exists from iOS/iPadOS 16.4, and only for installed apps

export function platformContext() {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints > 1;
  // iPadOS reports as a Mac: a "Mac" with a touch screen is an iPad.
  const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && touch);
  const os = ios ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Macintosh|Mac OS X/.test(ua) ? 'mac' : /Linux|X11|CrOS/.test(ua) ? 'linux' : 'other';
  const m = /OS (\d+)[_.](\d+)/.exec(ua);
  const iosVersion = ios && m && !/Macintosh/.test(ua) ? [Number(m[1]), Number(m[2])] : null; // iPadOS-as-Mac hides its version
  const browser = /CriOS|Chrome\//.test(ua) && !/EdgiOS|EdgA|Edg\//.test(ua) ? 'chrome'
    : /EdgiOS|EdgA|Edg\//.test(ua) ? 'edge' : /FxiOS|Firefox\//.test(ua) ? 'firefox' : /SamsungBrowser/.test(ua) ? 'samsung'
    : /OPiOS|OPR\//.test(ua) ? 'opera' : /Safari\//.test(ua) ? 'safari' : 'other';
  const standalone = isStandalone();
  // Web views inside other apps (Instagram, Facebook, Gmail, LinkedIn…): no install, no push.
  const inAppBrowser = !standalone && (/FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|MicroMessenger|TikTok|Line\/|Twitter|GSA\/|; wv\)/i.test(ua)
    || (ios && !/Safari\//.test(ua)));
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const oldIos = ios && !!iosVersion && (iosVersion[0] < IOS_PUSH[0] || (iosVersion[0] === IOS_PUSH[0] && iosVersion[1] < IOS_PUSH[1]));
  const ctx = {
    os, browser, standalone, inAppBrowser, iosVersion, oldIos,
    // Can this device receive reminders with the app closed (once installed, where that is required)?
    canPush: hasPush && !oldIos && !inAppBrowser,
    canInstallPrompt: canInstall(),
    // iPhone/iPad browser tab on an iOS that has web push: it only works from the Home Screen app.
    needsInstallForPush: ios && !standalone && !oldIos && !inAppBrowser,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
  const o = typeof window !== 'undefined' && window.__platformOverride;
  return o ? { ...ctx, ...o } : ctx;
}

/** Does the invite flow have to start with a "go somewhere else first" screen? */
export const needsGate = (c = platformContext()) => c.inAppBrowser || c.needsInstallForPush;
/** Is an optional "Add to Home screen" step useful here? (iPhone/iPad people install in the gate instead.) */
export const offersInstall = (c = platformContext()) => !c.standalone && !c.inAppBrowser && c.os !== 'ios' && (c.os === 'android' || c.canInstallPrompt);
