// generateModel -- Phase 2 pipeline: photo -> Hunyuan 3D (混元生3D 极速版) -> GLB.
//
// Cloud functions cap out at 60s but generation takes ~1.5min, so this is an
// action-dispatch function driven by client-side polling:
//
//   { action: 'submit', imageFileID }
//     -> { ok, jobId }                          real generation submitted
//     -> { ok, stub: true, modelFileID }        stub fallback (no credentials)
//   { action: 'query', jobId }
//     -> { ok, status: 'processing' }           still WAIT/RUN
//     -> { ok, status: 'done', modelFileID }    GLB fetched + stored in models/
//     -> { ok: false, error }                   generation FAIL or other error
//
// Credentials come from the function's environment variables
// (TENCENT_SECRET_ID / TENCENT_SECRET_KEY, set in console: 云函数 -> 配置 ->
// 环境变量), never from code. If they are absent, 'submit' falls back to the
// original stub behavior (uploads the bundled placeholder GLB) so the app
// keeps working in dev environments without Tencent Cloud access.
//
// Phase 2 TODO (later passes): mesh simplification + precomputed convex hull
// alongside the GLB (see miniprogram/utils/proxy-shape.js), and cleanup of
// old captures/ and models/ files.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const AI3D_REGION = 'ap-guangzhou';

function makeAi3dClient() {
  // Trim: pasting into the console's env-var field easily picks up stray
  // whitespace/newlines, which Tencent Cloud rejects as an unknown SecretId.
  const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();
  if (!secretId || !secretKey) {
    return null;
  }
  const tencentcloud = require('tencentcloud-sdk-nodejs-ai3d');
  const Ai3dClient = tencentcloud.ai3d.v20250513.Client;
  return new Ai3dClient({
    credential: { secretId, secretKey },
    region: AI3D_REGION,
    profile: { httpProfile: { endpoint: 'ai3d.tencentcloudapi.com' } },
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

async function submit(event) {
  const imageFileID = event.imageFileID || '';
  if (!imageFileID) {
    return { ok: false, error: 'imageFileID is required' };
  }

  const client = makeAi3dClient();
  if (!client) {
    // Stub fallback: no Tencent Cloud credentials configured.
    console.log('[generateModel] no credentials, using stub placeholder');
    const glbBuffer = fs.readFileSync(path.join(__dirname, 'placeholder.glb'));
    const uploadRes = await cloud.uploadFile({
      cloudPath: `models/${Date.now()}-${Math.floor(Math.random() * 1e6)}.glb`,
      fileContent: glbBuffer,
    });
    return { ok: true, stub: true, modelFileID: uploadRes.fileID };
  }

  // Hunyuan takes an image URL; convert the cloud-storage fileID into a
  // temporary HTTPS URL it can fetch.
  const tempRes = await cloud.getTempFileURL({ fileList: [imageFileID] });
  const item = tempRes.fileList && tempRes.fileList[0];
  if (!item || !item.tempFileURL) {
    return { ok: false, error: 'could not resolve image temp URL' };
  }

  const submitRes = await client.SubmitHunyuanTo3DRapidJob({
    ImageUrl: item.tempFileURL,
    ResultFormat: 'GLB',
  });
  console.log('[generateModel] submitted job:', submitRes.JobId);
  return { ok: true, jobId: submitRes.JobId };
}

async function query(event) {
  const jobId = event.jobId || '';
  if (!jobId) {
    return { ok: false, error: 'jobId is required' };
  }

  const client = makeAi3dClient();
  if (!client) {
    return { ok: false, error: 'credentials missing on query' };
  }

  const res = await client.QueryHunyuanTo3DRapidJob({ JobId: jobId });
  const status = res.Status;
  console.log('[generateModel] job', jobId, 'status:', status);

  // Documented status values: WAIT / RUN / FAIL / DONE.
  if (status === 'FAIL') {
    return { ok: false, error: res.ErrorMessage || 'generation failed' };
  }
  if (status !== 'DONE') {
    return { ok: true, status: 'processing' };
  }

  const files = res.ResultFile3Ds || [];
  const glbFile = files.find((f) => (f.Type || '').toUpperCase() === 'GLB') || files[0];
  if (!glbFile || !glbFile.Url) {
    return { ok: false, error: 'no result file in DONE response' };
  }

  // Persist the (short-lived) result URL into our own cloud storage so the
  // viewer gets a stable fileID and the asset survives past Hunyuan's URL
  // expiry.
  const glbBuffer = await downloadToBuffer(glbFile.Url);
  const uploadRes = await cloud.uploadFile({
    cloudPath: `models/${jobId}.glb`,
    fileContent: glbBuffer,
  });
  return { ok: true, status: 'done', modelFileID: uploadRes.fileID };
}

// Reports the SHAPE of the configured credentials without ever revealing
// them: length, the (non-secret, universal) AKID prefix, and whitespace
// detection -- stray whitespace from copy-pasting into the console env-var
// field is a common cause of "SecretId is not found".
function diagnose() {
  const id = process.env.TENCENT_SECRET_ID;
  const key = process.env.TENCENT_SECRET_KEY;
  const shape = (v) =>
    v === undefined
      ? 'NOT SET'
      : {
          length: v.length,
          hasLeadingOrTrailingSpace: v !== v.trim(),
          hasInnerWhitespace: /\s/.test(v.trim()),
          isEmpty: v.trim().length === 0,
        };
  return {
    ok: true,
    diagnostic: true,
    secretId: {
      ...(typeof shape(id) === 'string' ? { state: shape(id) } : shape(id)),
      // SecretId is an identifier (not a secret) and always starts with
      // "AKID"; reporting whether that holds is safe and highly diagnostic.
      startsWithAKID: id ? id.trim().startsWith('AKID') : false,
      expectedLength: 36,
    },
    secretKey: typeof shape(key) === 'string' ? { state: shape(key) } : shape(key),
    expectedSecretKeyLength: 32,
    region: AI3D_REGION,
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
