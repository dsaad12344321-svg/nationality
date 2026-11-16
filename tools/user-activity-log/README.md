# User Activity Log

This Windows companion searches reservation documents locally for guests recorded in an Oracle `log.xml` report, then copies matching files into `Desktop\\output`. Original reservation files are never moved, changed, or deleted.

## Download the standalone Windows EXE

The repository builds a Windows x64 executable automatically through GitHub Actions.

1. Open the repository's **Actions** tab.
2. Select **Build User Activity Log EXE**.
3. Open the latest successful run.
4. Download the `UserActivityLog-Windows-x64` artifact ZIP.
5. Extract `UserActivityLog.exe` from the ZIP.

No separate Python installation or BAT file is needed on the target Windows computer.

## First-time use

1. Make sure the reservation folder exists at:
   `L:\\Common\\Linked Documents\\1-Reservation Data Long Beach\\2026`
2. Copy `UserActivityLog.exe` to the Windows computer that can access drive L:.
3. Double-click `UserActivityLog.exe`. Windows may show a SmartScreen warning because this is an unsigned, locally built executable; only run the file downloaded from this repository's Actions artifact.
4. Keep its console window open while using the User Activity Log page in the website.

## Daily use

1. Open the website and select **User Activity Log**.
2. Upload the Oracle `log.xml` file.
3. Select the required `INS_CHAR_DATE` value (not the check-in date inside ACTION_DESCRIPTION).
4. Click **Search reservations and copy matches**.
5. Matching documents are copied to the Windows Desktop folder `output`.

The date folder is resolved as `<base>\\YYYY\\MM\\DD`, for example `...\\2026\\11\\16`. The year is taken from `INS_CHAR_DATE`.

## Supported reservation files

- Outlook: `.msg`
- Word: `.docx`
- Legacy Word: `.doc` (requires Microsoft Word installed on Windows)
- PDF: `.pdf`

## Important notes

- The local service listens only on `127.0.0.1:8765`; it does not expose the reservation drive to the internet.
- The local service allows the production origin `https://nationality.vercel.app` by default. If your deployed website uses another domain, set the Windows environment variable `USER_ACTIVITY_ALLOWED_ORIGINS` to that exact origin before starting the executable.
- The XML report is sent from the browser to the local computer only. Reservation documents are read and copied locally and are not uploaded to the website.
- If a file with the same name already exists in `Desktop\\output`, a numbered copy is created instead of overwriting it.
- Name matching requires the guest's first and last name (case-insensitive, punctuation-insensitive). Middle names are not required when present in the Oracle name.
- Files that cannot be read are skipped; legacy `.doc` files need Microsoft Word installed.
- The EXE build is unsigned. Windows SmartScreen may ask for confirmation the first time it runs.
