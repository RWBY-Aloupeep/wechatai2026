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

// Per TokenHub's docs, "HY-3D-Express 请求的具体参数与 提交混元生3D 极速版任务
// 接口一致" -- i.e. body params follow SubmitHunyuanTo3DRapidJob, which
// documents PascalCase ImageUrl / ImageBase64 / ResultFormat / EnablePBR.
// TokenHub's own example nonetheless shows lowercase `model` and `prompt`,
// so the exact casing at the gateway is ambiguous; `model` is certainly
// TokenHub's own routing param. PascalCase (the authoritative spelling) is
// tried first, with lowercase variants as fallback. Each candidate carries a
// casing-matched ResultFormat so we always get a single-file GLB rather than
// relying on the undocumented default (the underlying docs show OBJ results
// arriving as .zip bundles). A rejected request creates no job, so probing
// costs no credits; once the logs confirm a winner this list can collapse.
function urlFieldCandidates(imageUrl) {
  return [
    { name: 'ImageUrl', body: { ImageUrl: imageUrl, ResultFormat: 'GLB' } },
    { name: 'image_url', body: { image_url: imageUrl, result_format: 'GLB' } },
    // OpenAI vision style, in case TokenHub mirrors it here too.
    { name: 'image_url.url', body: { image_url: { url: imageUrl } } },
    { name: 'image', body: { image: imageUrl } },
  ];
}

function base64FieldCandidates(imageBase64) {
  return [
    { name: 'ImageBase64', body: { ImageBase64: imageBase64, ResultFormat: 'GLB' } },
    { name: 'image_base64', body: { image_base64: imageBase64, result_format: 'GLB' } },
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

  const tryCandidates = async (candidates) => {
    for (const candidate of candidates) {
      const res = await httpsPostJson(
        `${TOKENHUB_BASE}/submit`,
        { model, ...candidate.body },
        { Authorization: `Bearer ${key}` }
      );
      // TokenHub returns `id`; the underlying Rapid job returns `JobId`.
      const jobId =
        res.json && (res.json.id || res.json.Id || res.json.JobId);
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
    return null;
  };

  const viaUrl = await tryCandidates(urlFieldCandidates(item.tempFileURL));
  if (viaUrl) {
    return viaUrl;
  }

  // Only pay the download+encode cost if every URL-shaped field was rejected
  // (e.g. if this endpoint accepts inline data only).
  console.log('[generateModel] URL fields all rejected, trying base64');
  const imgBuffer = await downloadToBuffer(item.tempFileURL);
  const viaBase64 = await tryCandidates(
    base64FieldCandidates(imgBuffer.toString('base64'))
  );
  if (viaBase64) {
    return viaBase64;
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

  // Accept either response shape: TokenHub's documented lowercase
  // (status: queued/in_progress/completed, data[].type/url) or the underlying
  // Rapid-job PascalCase (Status: WAIT/RUN/FAIL/DONE, ResultFile3Ds[].Type/Url).
  const status = String(res.json.status || res.json.Status || '').toUpperCase();
  console.log('[generateModel] job', jobId, 'status:', status);

  if (status === 'FAIL' || status === 'FAILED') {
    return {
      ok: false,
      error:
        res.json.ErrorMessage || res.json.error || 'generation failed',
      code: res.json.ErrorCode,
    };
  }
  if (status !== 'DONE' && status !== 'COMPLETED') {
    // WAIT / RUN / queued / in_progress
    return { ok: true, status: 'processing', raw: status };
  }

  const files = res.json.data || res.json.ResultFile3Ds || [];
  const pickType = (f) => String(f.type || f.Type || '').toUpperCase();
  const glb = files.find((f) => pickType(f) === 'GLB') || files[0];
  const glbUrl = glb && (glb.url || glb.Url);
  if (!glbUrl) {
    return {
      ok: false,
      error: 'no result file in completed response',
      raw: JSON.stringify(res.json).slice(0, 300),
    };
  }
  // OBJ results arrive as .zip bundles (obj + mtl + textures); a zip would
  // need unpacking before the viewer could load it, so fail loudly rather
  // than storing a zip under a .glb name.
  if (glbUrl.split('?')[0].toLowerCase().endsWith('.zip')) {
    return {
      ok: false,
      error: `result is a .zip bundle (type ${pickType(glb)}), not a plain GLB`,
    };
  }

  // Persist into our own cloud storage: the result URL is short-lived, and
  // the viewer wants a stable fileID.
  const glbBuffer = await downloadToBuffer(glbUrl);
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
