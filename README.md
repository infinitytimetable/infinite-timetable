# Infinity Timetable

Offline school timetable software for Windows.

This repository publishes updates. Each release holds the Windows installer
(`InfinityTimetable-Setup-<version>.exe`). Installed copies of Infinity Timetable
check here once a day and offer new versions to the school.

Updating keeps all timetables, settings and the licence.

## Publishing a new version

1. Upload the school installer, `InfinityTimetable-Setup-<version>.exe` (never the Seller Setup).
2. Edit `latest.json`: set `version`, `setup` (the exact file name) and `notes`.
3. Commit. Schools see the update within a day.

## Android app

The Android app is built automatically on GitHub from the `android` folder whenever it changes.
Download the latest APK: https://github.com/infinitytimetable/infinite-timetable/releases/download/android/InfinityTimetable.apk

To build a new Android version: update `android/version.txt` and `android/app/src/main/assets/app/index.html`, then commit.
The build needs the repository secret `ANDROID_KEY_PASSWORD` (the signing key password, kept privately by the seller).
