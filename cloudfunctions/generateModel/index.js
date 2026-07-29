// generateModel -- Phase 2 pipeline: photo -> Hunyuan 3D -> GLB.
//
// Uses Tencent's TokenHub platform (OpenAI-style REST + Bearer auth), NOT the
// tencentcloud CAM SDK: TokenHub issues a single API key instead of a
// SecretId/SecretKey pair.
//   submit: POST https://tokenhub.tencentmaas.com/v1/api/3d/submit
//   query:  POST https://tokenhub.tencentmaas.com/v1/api/3d/query
//
// Generation takes ~90s and cloud functions cap at 60s, so this is an
// action-dispatch function driven by client-side polling:
//
//   { action: 'submit', imageFileID }
//     -> { ok, jobId }                          real generation submitted
//     -> { ok, stub: true, modelFileID }        stub fallback (no API key)
//   { action: 'query', jobId }
//     -> { ok, status: 'processing' }
//     -> { ok, status: 'done', modelFileID }    GLB fetched + stored in models/
//     -> { ok: false, error }
//   { action: 'diagnose' }                      credential shape, no secrets
//
// The API key comes from the TOKENHUB_API_KEY environment variable (console:
// 云函数 -> 配置 -> 环境变量), never from code. Without it, 'submit' falls back
// to uploading the bundled placeholder GLB so the app still works in dev.
//
// Phase 2 TODO (later passes): mesh simplification + precomputed convex hull
// alongside the GLB (see miniprogram/utils/proxy-shape.js), and cleanup of
// old captures/ and models/ files.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const TOKENHUB_BASE = 'https://tokenhub.tencentmaas.com/v1/api/3d';
// "hy-3d-express" is the rapid tier (~90s), the best fit for an interactive
// mini-program flow; "hy-3d-3.0"/"hy-3d-3.1" are the higher-quality/slower
// professional tiers. Overridable per-call via event.model for testing.
const DEFAULT_MODEL = 'hy-3d-express';

function apiKey() {
  // Trim: pasting into the console's env-var field easily picks up stray
  // whitespace, which would corrupt the Authorization header.
  return (process.env.TOKENHUB_API_KEY || '').trim();
}

function httpsPostJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            // leave json null; caller reports the raw text
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`download failed with status ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// TokenHub's docs only show text-to-3D ({ model, prompt }); the image field
// name for image-to-3D is not documented at this layer. The underlying
// Tencent API uses ImageUrl/ImageBase64 (PascalCase) while TokenHub's own
// fields are lowercase, so rather than guess once and burn a deploy+test
// cycle per guess, try the plausible spellings in order and log which one
// works. A rejected request creates no job, so this costs no credits.
// Once confirmed in the logs, this list can collapse to the single winner.
function imageFieldCandidates(imageUrl) {
  return [
    { name: 'image_url', body: { image_url: imageUrl } },
    { name: 'ImageUrl', body: { ImageUrl: imageUrl } },
    { name: 'image', body: { image: imageUrl } },
  ];
}

async function submit(event) {
  const imageFileID = event.imageFileID || '';
  if (!imageFileID) {
    return { ok: false, error: 'imageFileID is required' };
  }

  const key = apiKey();
  if (!key) {
    console.log('[generateModel] no TOKENHUB_API_KEY, using stub placeholder');
    const glbBuffer = fs.readFileSync(path.join(__dirname, 'placeholder.glb'));
    const uploadRes = await cloud.uploadFile({
      cloudPath: `models/${Date.now()}-${Math.floor(Math.random() * 1e6)}.glb`,
      fileContent: glbBuffer,
    });
    return { ok: true, stub: true, modelFileID: uploadRes.fileID };
  }

  // TokenHub fetches the image over HTTPS; turn the cloud-storage fileID into
  // a signed temporary URL it can reach.
  const tempRes = await cloud.getTempFileURL({ fileList: [imageFileID] });
  const item = tempRes.fileList && tempRes.fileList[0];
  if (!item || !item.tempFileURL) {
    return { ok: false, error: 'could not resolve image temp URL' };
  }

  const model = event.model || DEFAULT_MODEL;
  const attempts = [];
  for (const candidate of imageFieldCandidates(item.tempFileURL)) {
    const res = await httpsPostJson(
      `${TOKENHUB_BASE}/submit`,
      { model, ...candidate.body },
      { Authorization: `Bearer ${key}` }
    );
    const jobId = res.json && (res.json.id || res.json.Id);
    if (res.statusCode === 200 && jobId) {
      console.log(
        `[generateModel] submitted job ${jobId} using image field "${candidate.name}"`
      );
      return { ok: true, jobId, model, imageField: candidate.name };
    }
    console.log(
      `[generateModel] image field "${candidate.name}" rejected:`,
      res.statusCode,
      res.text && res.text.slice(0, 300)
    );
    attempts.push({
      field: candidate.name,
      statusCode: res.statusCode,
      body: res.text && res.text.slice(0, 300),
    });
  }

  return {
    ok: false,
    error: 'all image field name candidates were rejected by TokenHub',
    attempts,
  };
}

async function query(event) {
  const jobId = event.jobId || '';
  if (!jobId) {
    return { ok: false, error: 'jobId is required' };
  }
  const key = apiKey();
  if (!key) {
    return { ok: false, error: 'TOKENHUB_API_KEY missing on query' };
  }

  const res = await httpsPostJson(
    `${TOKENHUB_BASE}/query`,
    { model: event.model || DEFAULT_MODEL, id: jobId },
    { Authorization: `Bearer ${key}` }
  );
  if (res.statusCode !== 200 || !res.json) {
    return {
      ok: false,
      error: `query failed (${res.statusCode})`,
      body: res.text && res.text.slice(0, 300),
    };
  }

  const status = res.json.status;
  console.log('[generateModel] job', jobId, 'status:', status);

  if (status === 'failed' || status === 'FAIL') {
    return { ok: false, error: res.json.error || 'generation failed' };
  }
  if (status !== 'completed') {
    // queued / in_progress
    return { ok: true, status: 'processing', raw: status };
  }

  const files = res.json.data || [];
  const glb = files.find((f) => (f.type || '').toLowerCase() === 'glb') || files[0];
  if (!glb || !glb.url) {
    return { ok: false, error: 'no result file in completed response' };
  }

  // Persist into our own cloud storage: TokenHub's result URL is short-lived,
  // and the viewer wants a stable fileID.
  const glbBuffer = await downloadToBuffer(glb.url);
  const uploadRes = await cloud.uploadFile({
    cloudPath: `models/${jobId}.glb`,
    fileContent: glbBuffer,
  });
  return { ok: true, status: 'done', modelFileID: uploadRes.fileID };
}

// Reports the SHAPE of the configured key without revealing it.
function diagnose() {
  const raw = process.env.TOKENHUB_API_KEY;
  if (raw === undefined) {
    return { ok: true, diagnostic: true, state: 'TOKENHUB_API_KEY NOT SET' };
  }
  const trimmed = raw.trim();
  return {
    ok: true,
    diagnostic: true,
    apiKey: {
      length: trimmed.length,
      hasLeadingOrTrailingSpace: raw !== trimmed,
      isEmpty: trimmed.length === 0,
      // Key prefixes are conventional, not secret; helps confirm key type.
      startsWithSk: trimmed.startsWith('sk-'),
    },
    model: DEFAULT_MODEL,
    endpoint: TOKENHUB_BASE,
  };
}

exports.main = async (event) => {
  try {
    const action = (event && event.action) || 'submit';
    if (action === 'diagnose') {
      return diagnose();
    }
    if (action === 'submit') {
      return await submit(event || {});
    }
    if (action === 'query') {
      return await query(event || {});
    }
    return { ok: false, error: `unknown action: ${action}` };
  } catch (err) {
    console.error('[generateModel] error:', err);
    return { ok: false, error: (err && err.message) || String(err) };
  }
};
