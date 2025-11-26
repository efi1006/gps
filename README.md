# Automatic Recording Fetcher and Google Drive Uploader

This lightweight HTTP service logs into the 019 PBX portal, scrapes available call recordings, and can upload a selected recording to Google Drive. It is dependency-free and uses only Node.js built-ins so it can run in restricted environments.

## Prerequisites

Set the required environment variables before starting the server:

- `VOIP_USERNAME` / `VOIP_PASSWORD` – Credentials for `https://voip10.019mobile.co.il/pbx/login.php`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` – OAuth 2.0 credentials with Drive file scope access.
- `PORT` (optional) – Port for the HTTP server, defaults to `3000`.

## Running

```bash
node server.js
```

## Endpoints

### `GET /recordings`
Logs in to the PBX portal, parses the recordings table from `simplecdrs.php`, and returns a JSON array:

```json
[
  {
    "phone": "0522222222",
    "file_url": "https://voip10.019mobile.co.il/pbx/recordings/0522222222_call1.mp3",
    "date": "2025-11-26"
  }
]
```

### `POST /upload-to-drive`
Uploads a specific recording to Google Drive, creating a folder named after the phone number if needed.

**Body**
```json
{
  "phone": "0522222222",
  "file_url": "https://voip10.019mobile.co.il/pbx/recordings/0522222222_call1.mp3"
}
```

**Response**
```json
{
  "success": true,
  "file": {
    "id": "<drive file id>",
    "name": "0522222222_call1.mp3",
    "parents": ["<folder id>"]
  }
}
```

## Notes

- The HTML parsing assumes each table row contains a link to an MP3/WAV recording; the first `<td>` value is treated as the call date/time if present.
- Recordings are buffered in memory before upload; for very large files consider adapting the code to stream uploads instead.
- The Drive token is refreshed for each request using the provided refresh token.
