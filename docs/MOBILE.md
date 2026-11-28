# Executive mobile app (A-050)

The executive app is in `apps/mobile`. It is built with React Native and Expo, and released to the Google Play Store and
the Apple App Store with Expo's build service (EAS). It uses the same accounts, permissions and data as the web CRM.

## 1. What it does

| Screen       | What the executive can do                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign in      | The same e-mail and password as the web. The phone stays signed in; the sign-in token is kept in the phone's secure store (Keychain / Keystore).                                                                                                                   |
| Today's work | Overdue tasks, tasks due today and the highest-priority open leads. Pull down to refresh.                                                                                                                                                                          |
| My leads     | Search by name, phone or lead number.                                                                                                                                                                                                                              |
| Lead         | Contact details, open tasks and the timeline. **Call now** dials. When the executive comes back to the app, it asks for the outcome, notes and the next follow-up, then completes the open call task (or logs a call) and creates the follow-up.                   |
| WhatsApp     | One button per situation (course details, college details, follow-up, fee details, general). WhatsApp opens on the phone with the approved template filled in, and the executive presses send. The CRM records it in the timeline as sent from the personal phone. |
| Push         | New notifications (lead assigned, SLA warnings, tasks and the rest) also arrive on the phone. Tapping one opens the lead.                                                                                                                                          |
| Offline      | The last loaded screens stay readable with an "Offline" banner. Calls and messages cannot be logged offline, and the app says so. Signing out deletes the saved copy.                                                                                              |

Personal WhatsApp needs an **approved WhatsApp template** for the situation, the same as quick messages (A-049). It
does not need the WhatsApp Business API. Delivery and read receipts are not tracked for messages sent from a personal
phone.

## 2. Accounts the organization needs

| Account                     | Used for                                     | Notes                                                                                                             |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Expo** (expo.dev)         | Cloud builds (EAS Build), store upload, push | Create an organization account so the app does not belong to one person. The free plan has a limited build queue. |
| **Apple Developer Program** | App Store and TestFlight                     | Annual fee. Enrol as an **organization**, which needs a D-U-N-S number and can take days to approve.              |
| **Google Play Console**     | Play Store                                   | One-time fee. Use an organization account. New personal accounts must run a closed test before production.        |

Check the current fees and conditions on each provider's site. They change, and this document does not track them.

## 3. One-time set-up

Run these on a computer with Node 20 or newer. A Mac is **not** needed, because EAS builds in the cloud.

```bash
cd apps/mobile
```

```bash
npm install
```

```bash
npx eas-cli@latest login
```

```bash
npx eas-cli@latest init
```

`eas init` creates the project on expo.dev and writes its id to `app.json` → `expo.extra.eas.projectId`, replacing
`REPLACE-WITH-EAS-PROJECT-ID`. **Push notifications do not work until this is set.**

Then edit `app.json` and `eas.json`:

1. `expo.name`: the name under the icon (now "CRM Executive").
2. `expo.ios.bundleIdentifier` and `expo.android.package`: a reverse domain you own, e.g. `com.yourcollege.crm`.
   **They cannot be changed after the first store release.**
3. `eas.json` → `build.production.env.EXPO_PUBLIC_API_URL`: the production web address followed by `/api/v1`,
   e.g. `https://crm.yourcollege.com/api/v1`. The `preview` build points at the demo deployment.
4. Replace the icons and splash image in `apps/mobile/assets` with the organization's (1024 × 1024 PNG icon).

## 4. Push notification credentials

- **Android (Firebase Cloud Messaging):** create a Firebase project and add an Android app with the same package name.
  In Firebase, go to Project settings → Service accounts and generate a private key (a JSON file). Upload it with
  `npx eas-cli@latest credentials` → Android → production → "Google Service Account" → FCM V1. **Do not commit the JSON
  file.**
- **iOS (APNs):** during the first iOS build, EAS offers to create the push key in the Apple account. Accept it.
- **API (optional, recommended):** on expo.dev, turn on "Enhanced security for push notifications" and create an access
  token. Set it as `EXPO_ACCESS_TOKEN` (sensitive) in the API project on Vercel. Without it, push still works.

The API sends pushes through Expo only when `NODE_ENV=production`. Other environments use a labelled sandbox that sends
nothing.

## 5. Test builds

```bash
npx eas-cli@latest build --profile preview --platform android
```

This builds an installable APK. Share the link from expo.dev with testers; no store is needed. For iPhones, build
`--platform ios`. Testers' devices must be registered first (`npx eas-cli@latest device:create`), or use TestFlight
(§6).

Test push notifications in a preview or production build on a real phone. Expo Go does not support them on Android.

## 6. Store release

```bash
npx eas-cli@latest build --profile production --platform all
```

```bash
npx eas-cli@latest submit --profile production --platform android
```

```bash
npx eas-cli@latest submit --profile production --platform ios
```

- **Google Play:** create the app in Play Console first and upload the first build by hand, as Google requires. Then
  `eas submit` uploads to the **internal** track (set in `eas.json`); promote it to production in Play Console.
  `eas submit` asks for a Google service account key with Play Console access.
- **App Store:** `eas submit` uploads to App Store Connect and TestFlight. Fill in the listing and send it for review.

Both stores ask for:

- a **privacy policy URL** (O-11);
- a data safety / privacy questionnaire. The app stores the sign-in token and a copy of recent screens on the phone,
  and it processes student names and phone numbers;
- a **review account**. Create a sales executive in a demo organization that has sample leads. Never give a real
  account to reviewers;
- screenshots.

The CRM is for staff only and has no public sign-up. Explain this in the review notes. Apple may suggest
"Unlisted app distribution" or Apple Business Manager for internal apps; both are acceptable.

## 7. Updating the app

1. Raise `expo.version` in `app.json` for a visible version change. Build numbers increase automatically
   (`autoIncrement`).
2. Build and submit again (§6).
3. API changes must stay backward compatible because older app versions stay installed. Push devices report
   `appVersion`, so you can see which versions are still in use.

## 8. Developer notes

- `npm run typecheck`, `npm test` (pure logic, Node's test runner) and `npm run export:web` (a smoke build of the web
  version) run in `apps/mobile`. The app is outside the pnpm workspace; root `pnpm lint` and `pnpm format:check`
  include its sources.
- `npx expo start` runs the app in Expo Go or a simulator. To use a local API from a phone, set
  `EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3000/api/v1`.
- The web version is only a preview: it keeps the sign-in token in memory (a reload signs out), has no push, and needs
  a same-origin proxy because the API does not allow cross-origin calls.
