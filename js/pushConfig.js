// Optional push server for reminders that arrive while the app is closed (see server/README.md).
// Leave both empty to keep the app fully local: everything push-related stays hidden.
// They can also be set (or overridden) in Settings › Reminders › Advanced, without editing code.
export const PUSH_SERVER_URL = 'https://daily-tracker-push.michael-matusik-jr.workers.dev'; // e.g. 'https://daily-tracker-push.yourname.workers.dev'
export const VAPID_PUBLIC_KEY = 'BLUUImAraYEnOXAgkaumD_1sm9xEfv9e0vqsmUdwx3T47-iXf9wk3UdU882945seztFLYXctviepwysKYvQTbLA'; // the public key printed by `npm run gen-vapid`
// The server's REGISTER_KEY is deliberately NOT configurable here (this file is public):
// enter it in Settings › Reminders › Advanced on each device.
