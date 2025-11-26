'use strict';

const http = require('node:http');
const { URL, URLSearchParams } = require('node:url');
const { Readable } = require('node:stream');

const VOIP_BASE_URL = 'https://voip10.019mobile.co.il/pbx/';
const LOGIN_URL = new URL('login.php', VOIP_BASE_URL).toString();
const RECORDINGS_URL = new URL('simplecdrs.php', VOIP_BASE_URL).toString();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseCookies(rawCookies) {
  if (!rawCookies.length) {
    throw new Error('No cookies returned from login');
  }
  return rawCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function loginToCarrier() {
  const username = requireEnv('VOIP_USERNAME');
  const password = requireEnv('VOIP_PASSWORD');

  const body = new URLSearchParams({ username, password }).toString();
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    redirect: 'manual',
  });

  if (!response.ok && response.status !== 302) {
    throw new Error(`Login failed with status ${response.status}`);
  }

  const rawCookieHeader = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : response.headers.get('set-cookie')
      ? [response.headers.get('set-cookie')]
      : [];

  return parseCookies(rawCookieHeader);
}

async function fetchRecordingsPage(cookieHeader) {
  const response = await fetch(RECORDINGS_URL, {
    headers: {
      Cookie: cookieHeader,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recordings page (${response.status})`);
  }

  return response.text();
}

function stripTags(htmlFragment) {
  return htmlFragment.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractPhoneFromPath(pathname) {
  const match = pathname.match(/(\d{9,})/);
  return match ? match[1] : '';
}

function extractCells(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
    stripTags(match[1])
  );
}

function parseRecordingsTable(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const recordings = [];

  for (const [, rowHtml] of rows) {
    const linkMatch = rowHtml.match(/href=["']([^"']+\.(?:mp3|wav))["']/i);
    if (!linkMatch) {
      continue;
    }

    const fileUrl = new URL(linkMatch[1], VOIP_BASE_URL).toString();
    const phone = extractPhoneFromPath(linkMatch[1]) || extractPhoneFromPath(rowHtml);
    const cells = extractCells(rowHtml);
    const date = cells.length ? cells[0] : '';

    recordings.push({ phone, file_url: fileUrl, date });
  }

  return recordings;
}

async function getAccessToken() {
  const clientId = requireEnv('GOOGLE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_REFRESH_TOKEN');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh Google token (${response.status})`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('Google token response missing access_token');
  }

  return payload.access_token;
}

async function findOrCreateFolder(phone, accessToken) {
  const query = encodeURIComponent(
    `name = '${phone}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive&pageSize=1`;
  const listResponse = await fetch(listUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to look up Drive folder (${listResponse.status})`);
  }

  const listPayload = await listResponse.json();
  if (listPayload.files && listPayload.files.length) {
    return listPayload.files[0].id;
  }

  const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: phone,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create Drive folder (${createResponse.status})`);
  }

  const created = await createResponse.json();
  return created.id;
}

function guessMimeType(filename) {
  if (filename.toLowerCase().endsWith('.mp3')) {
    return 'audio/mpeg';
  }
  if (filename.toLowerCase().endsWith('.wav')) {
    return 'audio/wav';
  }
  return 'application/octet-stream';
}

function extractFilename(fileUrl, phone) {
  try {
    const pathname = new URL(fileUrl).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length) {
      return segments[segments.length - 1];
    }
  } catch (error) {
    // ignore and fall back
  }
  return `${phone || 'recording'}.mp3`;
}

async function downloadRecording(fileUrl, cookieHeader) {
  const response = await fetch(fileUrl, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });

  if (!response.ok) {
    throw new Error(`Failed to download recording (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadToDrive({ phone, fileUrl, cookieHeader }) {
  const accessToken = await getAccessToken();
  const folderId = await findOrCreateFolder(phone, accessToken);
  const recordingBuffer = await downloadRecording(fileUrl, cookieHeader);
  const filename = extractFilename(fileUrl, phone);
  const mimeType = guessMimeType(filename);

  const boundary = `boundary-${Date.now()}`;
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;

  const metadata = { name: filename, parents: [folderId] };
  const preamble = `${delimiter}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
    metadata
  )}\r\n${delimiter}\r\nContent-Type: ${mimeType}\r\n\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    recordingBuffer,
    Buffer.from(`\r\n${closeDelimiter}`, 'utf8'),
  ]);

  const uploadResponse = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: Readable.from(bodyBuffer),
    }
  );

  if (!uploadResponse.ok) {
    const message = await uploadResponse.text();
    throw new Error(
      `Failed to upload recording to Drive (${uploadResponse.status}): ${message}`
    );
  }

  const payload = await uploadResponse.json();
  return { id: payload.id, name: payload.name, parents: payload.parents };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleGetRecordings(res) {
  const cookieHeader = await loginToCarrier();
  const html = await fetchRecordingsPage(cookieHeader);
  const recordings = parseRecordingsTable(html);
  sendJson(res, 200, recordings);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(json);
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

async function handleUploadToDrive(req, res) {
  const body = await parseRequestBody(req);
  const { phone, file_url: fileUrl } = body;

  if (!phone || !fileUrl) {
    sendJson(res, 400, { error: 'phone and file_url are required' });
    return;
  }

  const cookieHeader = await loginToCarrier();
  const uploaded = await uploadToDrive({ phone, fileUrl, cookieHeader });
  sendJson(res, 200, { success: true, file: uploaded });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/recordings') {
      await handleGetRecordings(res);
      return;
    }

    if (req.method === 'POST' && req.url === '/upload-to-drive') {
      await handleUploadToDrive(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
