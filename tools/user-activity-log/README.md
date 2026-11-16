# User Activity Log

This Windows companion searches reservation documents locally for guests recorded in an Oracle `log.xml` report, then copies matching files into `Desktop\output`. Original reservation files are never moved, changed, or deleted.

## Supported reservation files

- Outlook: `.msg`
- Word: `.docx`
- Legacy Word: `.doc` (requires Microsoft Word installed on Windows)
- PDF: `.pdf`

## First-time setup

1. Make sure the reservation folder exists at:
   `L:\Common\Linked Documents\1-Reservation Data Long Beach\2026`
2. Download this repository folder `tools/user-activity-log` to the Windows computer that can access drive L:.
3. Install Python 3 for Windows if it is not already installed.
4. Double-click `start-agent.bat`. It installs the required Python packages and starts the local service.
5. Keep the black command window open while using the User Activity Log page in the website.

## Daily use

1. Open the website and select **User Activity Log**.
2. Upload the Oracle `log.xml` file.
3. Select the required `INS_CHAR_DATE` value (not the check-in date inside ACTION_DESCRIPTION).
4. Click **Search reservations and copy matches**.
5. Matching documents are copied to the Windows Desktop folder `output`.

The date folder is resolved as `<base>\YYYY\MM\DD`, for example `...\2026\11\16`. The year is taken from `INS_CHAR_DATE`.

## Important notes

- The local service listens only on `127.0.0.1:8765`; it does not expose the reservation drive to the internet.
- The local service allows the production origin `https://nationality.vercel.app` by default. If your deployed website uses another domain, set the Windows environment variable `USER_ACTIVITY_ALLOWED_ORIGINS` to that exact origin (for example `https://your-project.vercel.app`) before starting the BAT file.
- The XML report is sent from the browser to the local computer only. Reservation documents are read and copied locally and are not uploaded to the website.
- If a file with the same name already exists in `Desktop\output`, a numbered copy is created instead of overwriting it.
- Name matching requires the guest's first and last name (case-insensitive, punctuation-insensitive). Middle names are not required when present in the Oracle name.
- Files that cannot be read are skipped; legacy `.doc` files need Microsoft Word installed.
