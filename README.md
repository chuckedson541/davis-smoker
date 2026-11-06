# Davis Smoker (Android)

The smoker log as an Android app. Every phone keeps working with no signal and syncs through a shared Google Sheet when it can. Nobody needs a Claude account.

## 1. Set up the shared Google Sheet (once, on Chuck's account)

1. Go to **sheets.new** and name the sheet **Davis Smoker Data**.
2. **Extensions → Apps Script.** Delete what's there, paste in everything from `google-sheet/Code.gs`, and click **Save**.
3. **Deploy → New deployment.** Click the gear next to "Select type" and pick **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**, then **Authorize access** and pick your Google account. Google warns that the app isn't verified, because you wrote it yourself: click **Advanced → Go to Davis Smoker (unsafe)** → **Allow**.
5. Copy the **Web app URL** (it ends in `/exec`).

## 2. Install the app

1. Download the latest `DavisSmoker-N.apk` from this repository's **Releases** page on the phone.
2. Open it. If Android asks, allow your browser or Files app to **install unknown apps**.
3. Open **Davis Smoker**, tap the sync button at the top right, pick your name, paste the Web app URL into **Sheet link**, and tap **Save & connect**.
4. Tap **Copy link to text Max and Ben** and text it to them. They do steps 1–3 on their phones.

Updates install over the old app; nothing is lost.

## How the data works

- Everything you enter is saved on the phone first, then sent to the Sheet. The button at the top shows **Synced**, **N waiting** (no signal) or **Offline**.
- Phones check the Sheet every 15 seconds while the app is open.
- The Sheet's **docs** tab holds the app's records; don't edit it by hand. The **Readable: Sales**, **Readable: Cooks** and **Readable: Stock** tabs are rebuilt after every change for you to read, sort or print.
- Anyone with the Web app URL can read and change the log, so only send it to family.

## Building

Every push to `main` builds the app on GitHub (see `.github/workflows/build-apk.yml`) and posts it on the Releases page. To build on a computer instead, open the folder in Android Studio and choose **Build → Build APK(s)**.

The app screens are `app/src/main/assets/index.html`; the Android wrapper is `MainActivity.java`.
